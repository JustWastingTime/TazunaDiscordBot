import {
  InteractionResponseFlags,
  InteractionResponseType,
} from 'discord-interactions';
import { editChannelMessage, sendChannelMessage } from './quizDiscord.js';
import {
  closeSignup,
  createSignup,
  listOpenSignups,
  newSignupId,
  toggleRegistrant,
} from './signupStorage.js';

const BOT_OWNER_IDS = new Set(
  String(process.env.BOT_OWNER_IDS || process.env.BOT_OWNER_ID || '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean),
);

const SIGNUP_CUSTOM_ID_PREFIX = 'signup-toggle:';

function ephemeral(content) {
  return {
    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
    data: { flags: InteractionResponseFlags.EPHEMERAL, content },
  };
}

function isOwnerGuild(guildId) {
  const ownerGuildId = String(process.env.BOT_OWNER_GUILD_ID || '').trim();
  return Boolean(guildId && ownerGuildId && String(guildId) === ownerGuildId);
}

function getOptionValue(req, name) {
  const value = req.body.data.options?.find((opt) => opt.name === name)?.value;
  if (value === undefined || value === null) return undefined;
  return value;
}

function resolveDisplayName(req) {
  const member = req.body.member;
  const user = member?.user || req.body.user;
  return (
    member?.nick ||
    member?.display_name ||
    user?.global_name ||
    user?.username ||
    'Unknown'
  );
}

function formatRegistrants(registrants) {
  if (!registrants?.length) {
    return 'Registrants:\n_Nobody yet_';
  }
  const lines = registrants.map((r, i) => `${i + 1}. ${r.displayName}`);
  return `Registrants:\n${lines.join('\n')}`;
}

function endsAtUnix(signup) {
  return Math.floor(new Date(signup.endsAt).getTime() / 1000);
}

export function buildSignupMessagePayload(signup) {
  const open = signup.status === 'open' && Date.now() < new Date(signup.endsAt).getTime();
  const statusLine = open
    ? `Signup closes <t:${endsAtUnix(signup)}:R> (<t:${endsAtUnix(signup)}:f>)`
    : '🔒 **Signup closed**';

  return {
    content: [
      `**${signup.name}**`,
      statusLine,
      '',
      formatRegistrants(signup.registrants),
    ].join('\n'),
    components: [
      {
        type: 1,
        components: [
          {
            type: 2,
            style: open ? 1 : 2,
            custom_id: `${SIGNUP_CUSTOM_ID_PREFIX}${signup.id}`,
            label: open ? 'Sign Up / Cancel' : 'Signup Closed',
            disabled: !open,
          },
        ],
      },
    ],
  };
}

export async function refreshSignupMessage(signup) {
  if (!signup?.channelId || !signup?.messageId) return;
  await editChannelMessage(
    signup.channelId,
    signup.messageId,
    buildSignupMessagePayload(signup),
  );
}

export async function handleSignupCommand(req) {
  const guildId = req.body.guild_id;
  const userId = req.body.member?.user?.id || req.body.user?.id;

  if (!isOwnerGuild(guildId)) {
    return ephemeral('❌ This command is not available in this server.');
  }
  if (!userId || !BOT_OWNER_IDS.has(userId)) {
    return ephemeral('❌ Only the bot owner can use `/signup`.');
  }

  const name = String(getOptionValue(req, 'name') || '').trim();
  const channelId = getOptionValue(req, 'at');
  const hours = Number(getOptionValue(req, 'hours'));

  if (!name) return ephemeral('❌ Provide a signup name.');
  if (!channelId) return ephemeral('❌ Pick a channel to post in.');
  if (!Number.isFinite(hours) || hours < 1) {
    return ephemeral('❌ Hours must be at least 1.');
  }

  return {
    deferred: true,
    ephemeral: true,
    run: async (sendFollowup) => {
      const signupId = newSignupId();
      const endsAt = new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();
      const draft = {
        id: signupId,
        name,
        status: 'open',
        endsAt,
        registrants: [],
      };

      let message;
      try {
        message = await sendChannelMessage(channelId, buildSignupMessagePayload(draft));
      } catch (err) {
        console.error('signup post failed:', err.message);
        await sendFollowup({
          flags: InteractionResponseFlags.EPHEMERAL,
          content:
            `❌ Couldn't post in <#${channelId}>. Make sure I have **View Channel**, **Send Messages**, and **Embed Links** there.`,
        });
        return;
      }

      createSignup({
        id: signupId,
        name,
        guildId,
        channelId,
        messageId: message.id,
        hours,
        endsAt,
        createdBy: userId,
      });

      await sendFollowup({
        flags: InteractionResponseFlags.EPHEMERAL,
        content:
          `✅ Signup **${name}** posted in <#${channelId}> for **${hours}** hour${hours === 1 ? '' : 's'}.`,
      });
    },
  };
}

export function handleSignupComponent(customId) {
  if (!customId?.startsWith(SIGNUP_CUSTOM_ID_PREFIX)) return null;
  const signupId = customId.slice(SIGNUP_CUSTOM_ID_PREFIX.length);
  if (!signupId) return null;
  return { signupId };
}

export async function handleSignupToggleClick(req, signupId) {
  const guildId = req.body.guild_id;
  if (!guildId) return ephemeral('❌ This button can only be used in a server.');

  const userId = req.body.member?.user?.id || req.body.user?.id;
  if (!userId) return ephemeral('❌ Could not identify you.');

  const displayName = resolveDisplayName(req);
  const result = toggleRegistrant(signupId, userId, displayName);

  if (result.expired) {
    const closed = closeSignup(signupId) || result.signup;
    try {
      await refreshSignupMessage(closed);
    } catch (err) {
      console.error('signup expire refresh failed:', err.message);
    }
    return ephemeral('❌ This signup has closed.');
  }

  if (!result.ok) {
    return ephemeral(`❌ ${result.error}`);
  }

  try {
    await refreshSignupMessage(result.signup);
  } catch (err) {
    console.error('signup toggle refresh failed:', err.message);
    return ephemeral(
      result.action === 'signed_up'
        ? '✅ Signed up, but failed to update the message.'
        : '✅ Cancelled, but failed to update the message.',
    );
  }

  return ephemeral(
    result.action === 'signed_up'
      ? `✅ You signed up for **${result.signup.name}**.`
      : `✅ You cancelled your signup for **${result.signup.name}**.`,
  );
}

export async function closeDueSignups() {
  const now = Date.now();
  const closed = [];

  for (const signup of listOpenSignups()) {
    const endsAt = new Date(signup.endsAt).getTime();
    if (!Number.isFinite(endsAt) || now < endsAt) continue;

    const updated = closeSignup(signup.id);
    if (!updated) continue;

    try {
      await refreshSignupMessage(updated);
    } catch (err) {
      console.error(`signup close refresh failed (${signup.id}):`, err.message);
    }
    closed.push(updated);
  }

  return closed;
}

export function isSignupCommand(name) {
  return name === 'signup';
}

export function dispatchSignupCommand(req) {
  return handleSignupCommand(req);
}
