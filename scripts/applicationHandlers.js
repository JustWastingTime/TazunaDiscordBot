import {
  InteractionResponseFlags,
  InteractionResponseType,
} from 'discord-interactions';
import { sendChannelMessage, editChannelMessage, deleteChannelMessage } from './quizDiscord.js';
import { DiscordRequest } from './utils.js';
import { getGuildClubs } from './clubDatabase.js';
import { formatIntWithCommas, resolveClubTargetInfo } from './clubService.js';
import {
  createApplication,
  getApplication,
  getApplicationChannel,
  listResolvedApplications,
  newApplicationId,
  setApplicationChannel,
  updateApplicationStatus,
} from './applicationStorage.js';

const ADMINISTRATOR = 0x8n;

// ─── Custom ID constants ───────────────────────────────────────────────────────
export const APP_OPEN_MODAL_ID   = 'app_open_modal';
export const APP_MODAL_ID        = 'app_modal_submit';
export const APP_APPROVE_PREFIX  = 'app_approve:';
export const APP_REJECT_PREFIX   = 'app_reject:';
export const APP_WAITLIST_PREFIX = 'app_waitlist:';
export const APP_CANCEL_PREFIX   = 'app_cancel:';

// ─── Helpers ──────────────────────────────────────────────────────────────────
function isAdmin(member) {
  if (!member?.permissions) return false;
  try { return (BigInt(member.permissions) & ADMINISTRATOR) === ADMINISTRATOR; } catch { return false; }
}

function ephemeral(content) {
  return {
    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
    data: { flags: InteractionResponseFlags.EPHEMERAL, content },
  };
}

function resolveModalValue(components, customId) {
  for (const row of components ?? []) {
    for (const comp of row.components ?? []) {
      if (comp.custom_id === customId) return comp.value ?? null;
    }
  }
  return null;
}

async function fetchGuildName(guildId) {
  try {
    const res = await DiscordRequest(`guilds/${guildId}`, { method: 'GET' });
    const guild = await res.json();
    return guild?.name || 'this server';
  } catch {
    return 'this server';
  }
}

/** Resolve display clubs + daily targets from /club registerclub data. */
async function resolveRegisteredClubs(guildId) {
  const guildClubs = getGuildClubs(guildId);
  const clubs = [];

  for (const club of guildClubs) {
    const name = String(club.circleName || club.circleId || '').trim();
    if (!name) continue;

    let dailyTargetValue = null;
    let dailyTarget = null;
    try {
      const info = await resolveClubTargetInfo(guildId, club.circleId, null);
      if (info?.dailyTarget != null && Number.isFinite(info.dailyTarget)) {
        dailyTargetValue = Math.round(info.dailyTarget);
        dailyTarget = formatIntWithCommas(dailyTargetValue);
      }
    } catch (err) {
      console.error(`[applicationHandlers] target resolve failed for ${club.circleId}:`, err.message);
    }

    clubs.push({
      name,
      circleId: String(club.circleId),
      dailyTarget,
      dailyTargetValue,
    });
  }

  clubs.sort((a, b) => (b.dailyTargetValue ?? -1) - (a.dailyTargetValue ?? -1));
  return clubs;
}

function clubNamesForModal(clubs) {
  return ['Any', ...clubs.map((c) => c.name)];
}

// ─── Main channel message ─────────────────────────────────────────────────────
function buildMainEmbed(guildName, clubs, resolvedApps) {
  const clubLines = clubs.map((c) => {
    const target = c.dailyTarget ? ` — Daily target: **${c.dailyTarget}**` : ' — Daily target: _Not set_';
    return `• **${c.name}**${target}`;
  }).join('\n') || '_No clubs registered_';

  const rosterSections = clubs.map((c) => {
    const approved = resolvedApps
      .filter((a) => a.club === c.name && a.status === 'approved')
      .map((a) => `✅ ${a.ign}`);
    const waitlisted = resolvedApps
      .filter((a) => a.club === c.name && a.status === 'waitlisted')
      .map((a) => `⏳ ${a.ign}`);
    const lines = [...approved, ...waitlisted];
    return `**${c.name}**\n${lines.length ? lines.join('\n') : '_No applicants yet_'}`;
  });

  const anyApproved = resolvedApps
    .filter((a) => a.club === 'Any' && a.status === 'approved')
    .map((a) => `✅ ${a.ign}`);
  const anyWaitlisted = resolvedApps
    .filter((a) => a.club === 'Any' && a.status === 'waitlisted')
    .map((a) => `⏳ ${a.ign}`);
  const anyLines = [...anyApproved, ...anyWaitlisted];
  if (anyLines.length) {
    rosterSections.push(`**Any**\n${anyLines.join('\n')}`);
  }

  const description = [
    `Welcome to **${guildName}**!`,
    '',
    '__Clubs available__',
    clubLines,
    '',
    'If you are a new applicant please click **Apply** and select the club of your choice.',
    '',
    '─────────────────────────',
    rosterSections.join('\n\n') || '_No applicants yet_',
  ].join('\n');

  return {
    content: description,
    components: [
      {
        type: 1,
        components: [
          {
            type: 2,
            style: 1,
            custom_id: APP_OPEN_MODAL_ID,
            label: 'Apply',
            emoji: { name: '📝' },
          },
        ],
      },
    ],
  };
}

// ─── Application post message ─────────────────────────────────────────────────
const APP_STATUS_META = {
  pending:    { label: 'Pending',    emoji: '🟡', color: 0xF1C40F },
  approved:   { label: 'Approved',   emoji: '✅', color: 0x2ECC71 },
  rejected:   { label: 'Rejected',   emoji: '❌', color: 0xE74C3C },
  waitlisted: { label: 'Waitlisted', emoji: '⏳', color: 0x3498DB },
  cancelled:  { label: 'Cancelled',  emoji: '🚫', color: 0x95A5A6 },
};

function buildApplicationMessage(app, { decidedBy = null } = {}) {
  const meta = APP_STATUS_META[app.status] ?? { label: app.status, emoji: '📋', color: 0xF1C40F };
  const isPending = app.status === 'pending';

  const fields = [
    { name: 'IGN', value: `\`${app.ign}\``, inline: true },
    { name: 'Game ID', value: `\`${app.gameId}\``, inline: true },
    { name: 'Club', value: app.club, inline: true },
    { name: 'Applicant', value: `<@${app.applicantId}>`, inline: true },
    { name: 'Status', value: `${meta.emoji} **${meta.label}**`, inline: true },
  ];

  if (app.reason) {
    fields.push({ name: 'Reason', value: app.reason.slice(0, 1024), inline: false });
  }

  const embed = {
    color: meta.color,
    title: `${meta.emoji} Club Application`,
    fields,
    timestamp: app.createdAt || new Date().toISOString(),
  };

  if (decidedBy) {
    embed.footer = { text: `${meta.label} by admin` };
    embed.description = `Decision by <@${decidedBy}>`;
  }

  const adminButtons = isPending ? [
    { type: 2, style: 3, custom_id: `${APP_APPROVE_PREFIX}${app.id}`, label: 'Approve' },
    { type: 2, style: 4, custom_id: `${APP_REJECT_PREFIX}${app.id}`, label: 'Reject' },
    { type: 2, style: 2, custom_id: `${APP_WAITLIST_PREFIX}${app.id}`, label: 'Waitlist' },
  ] : [];

  const cancelButton = isPending
    ? [{ type: 2, style: 2, custom_id: `${APP_CANCEL_PREFIX}${app.id}`, label: 'Cancel' }]
    : [];

  const rows = [];
  if (adminButtons.length) rows.push({ type: 1, components: adminButtons });
  if (cancelButton.length) rows.push({ type: 1, components: cancelButton });

  return { content: '', embeds: [embed], components: rows };
}

// ─── Refresh main channel message ────────────────────────────────────────────
export async function refreshMainMessage(guildId) {
  const config = getApplicationChannel(guildId);
  if (!config?.channelId || !config?.messageId) return;

  const clubs = await resolveRegisteredClubs(guildId);
  const resolvedApps = listResolvedApplications(guildId);
  const payload = buildMainEmbed(config.guildName, clubs, resolvedApps);
  try {
    await editChannelMessage(config.channelId, config.messageId, payload);
  } catch (err) {
    console.error('[applicationHandlers] refreshMainMessage failed:', err.message);
  }
}

// ─── Command handler: /setapplicationchannel ──────────────────────────────────
export async function handleSetApplicationChannelCommand(req) {
  const guildId = req.body.guild_id;
  if (!guildId) return ephemeral('❌ This command can only be used in a server.');
  if (!isAdmin(req.body.member)) return ephemeral('❌ Only admins can use this command.');

  const registered = getGuildClubs(guildId);
  if (!registered.length) {
    return ephemeral('❌ No clubs are registered on this server. Run `/club registerclub` first.');
  }

  const channelId = req.body.channel_id;

  return {
    deferred: true,
    ephemeral: true,
    run: async (sendFollowup) => {
      const guildName = await fetchGuildName(guildId);
      const clubs = await resolveRegisteredClubs(guildId);
      if (!clubs.length) {
        await sendFollowup({
          flags: InteractionResponseFlags.EPHEMERAL,
          content: '❌ No clubs are registered on this server. Run `/club registerclub` first.',
        });
        return;
      }

      const resolvedApps = listResolvedApplications(guildId);
      const payload = buildMainEmbed(guildName, clubs, resolvedApps);

      let message;
      try {
        message = await sendChannelMessage(channelId, payload);
      } catch (err) {
        console.error('[applicationHandlers] post failed:', err.message);
        await sendFollowup({
          flags: InteractionResponseFlags.EPHEMERAL,
          content: `❌ Couldn't post in <#${channelId}>. Make sure I have **View Channel**, **Send Messages**, and **Embed Links** there.`,
        });
        return;
      }

      setApplicationChannel(guildId, {
        channelId,
        messageId: message.id,
        guildName,
      });

      await sendFollowup({
        flags: InteractionResponseFlags.EPHEMERAL,
        content: `✅ Application channel set in <#${channelId}> with **${clubs.length}** registered club(s).`,
      });
    },
  };
}

// ─── Button: open application modal ──────────────────────────────────────────
export async function handleOpenApplicationModal(req) {
  const guildId = req.body.guild_id;
  if (!guildId) return ephemeral('❌ This can only be used in a server.');

  const config = getApplicationChannel(guildId);
  if (!config) return ephemeral('❌ Application channel not configured.');

  const clubs = await resolveRegisteredClubs(guildId);
  if (!clubs.length) {
    return ephemeral('❌ No clubs are registered on this server. An admin must run `/club registerclub` first.');
  }

  const clubOptions = clubNamesForModal(clubs);

  return {
    type: InteractionResponseType.MODAL,
    data: {
      custom_id: APP_MODAL_ID,
      title: 'Club Application',
      components: [
        {
          type: 1,
          components: [{
            type: 4,
            custom_id: 'app_ign',
            label: 'IGN (In-Game Name)',
            style: 1,
            required: true,
            max_length: 100,
          }],
        },
        {
          type: 1,
          components: [{
            type: 4,
            custom_id: 'app_id',
            label: 'Game ID (numbers only)',
            style: 1,
            required: true,
            max_length: 30,
            placeholder: 'e.g. 1234567890',
          }],
        },
        {
          type: 1,
          components: [{
            type: 4,
            custom_id: 'app_club',
            label: `Club (${clubOptions.join(', ')})`.slice(0, 45),
            style: 1,
            required: true,
            max_length: 100,
            placeholder: clubOptions.join(' / ').slice(0, 100),
          }],
        },
        {
          type: 1,
          components: [{
            type: 4,
            custom_id: 'app_reason',
            label: 'Reason for applying (optional)',
            style: 2,
            required: false,
            max_length: 500,
          }],
        },
      ],
    },
  };
}

// ─── Modal submit: application ────────────────────────────────────────────────
export async function handleApplicationModalSubmit(req) {
  const guildId = req.body.guild_id;
  const applicantId = req.body.member?.user?.id || req.body.user?.id;
  if (!guildId || !applicantId) return ephemeral('❌ Could not identify you or this server.');

  const config = getApplicationChannel(guildId);
  if (!config) return ephemeral('❌ Application channel is not configured.');

  const clubs = await resolveRegisteredClubs(guildId);
  if (!clubs.length) {
    return ephemeral('❌ No clubs are registered on this server.');
  }

  const components = req.body.data.components;
  const ign    = (resolveModalValue(components, 'app_ign') ?? '').trim();
  const rawId  = (resolveModalValue(components, 'app_id') ?? '').trim();
  const club   = (resolveModalValue(components, 'app_club') ?? '').trim();
  const reason = (resolveModalValue(components, 'app_reason') ?? '').trim();

  if (!ign) return ephemeral('❌ IGN is required.');
  if (!/^\d+$/.test(rawId)) return ephemeral('❌ Game ID must contain numbers only.');

  const validClubs = clubNamesForModal(clubs);
  const matchedClub = validClubs.find((v) => v.toLowerCase() === club.toLowerCase());
  if (!matchedClub) {
    return ephemeral(`❌ Invalid club. Choose one of: ${validClubs.join(', ')}`);
  }

  const appId = newApplicationId();
  const draft = {
    id: appId,
    guildId,
    channelId: config.channelId,
    messageId: null,
    applicantId,
    ign,
    gameId: rawId,
    club: matchedClub,
    reason: reason || null,
    status: 'pending',
    createdAt: new Date().toISOString(),
  };

  const payload = buildApplicationMessage(draft);

  return {
    deferred: true,
    ephemeral: true,
    run: async (sendFollowup) => {
      let message;
      try {
        message = await sendChannelMessage(config.channelId, payload);
      } catch (err) {
        console.error('[applicationHandlers] app post failed:', err.message);
        await sendFollowup({
          flags: InteractionResponseFlags.EPHEMERAL,
          content: '❌ Failed to post your application. Please try again.',
        });
        return;
      }

      createApplication({ ...draft, messageId: message.id });

      await sendFollowup({
        flags: InteractionResponseFlags.EPHEMERAL,
        content: `✅ Your application has been submitted! You'll be notified when a decision is made.`,
      });
    },
  };
}

// ─── Button: admin decision ───────────────────────────────────────────────────
export async function handleApplicationDecision(req, appId, decision) {
  const guildId = req.body.guild_id;
  const actorId = req.body.member?.user?.id || req.body.user?.id;

  if (!guildId) return ephemeral('❌ Server only.');

  if (!isAdmin(req.body.member)) {
    return ephemeral('❌ Only admins can approve/reject/waitlist applications.');
  }

  const app = getApplication(appId);
  if (!app) return ephemeral('❌ Application not found.');
  if (app.guildId !== String(guildId)) return ephemeral('❌ Application not found in this server.');
  if (app.status !== 'pending') return ephemeral(`❌ This application is already **${app.status}**.`);

  const updated = updateApplicationStatus(appId, decision);

  const decisionLabel = { approved: '✅ Approved', rejected: '❌ Rejected', waitlisted: '⏳ Waitlisted' }[decision] ?? decision;

  const updatedPayload = buildApplicationMessage(updated, { decidedBy: actorId });

  try {
    await editChannelMessage(app.channelId, app.messageId, updatedPayload);
  } catch (err) {
    console.error('[applicationHandlers] edit app message failed:', err.message);
  }

  try {
    await sendChannelMessage(app.channelId, {
      content: `<@${app.applicantId}> Your application has been **${decision}**. This message will be deleted in 15 minutes.`,
    }).then(async (notifMsg) => {
      setTimeout(async () => {
        try { await deleteChannelMessage(app.channelId, notifMsg.id); } catch {}
        try { await deleteChannelMessage(app.channelId, app.messageId); } catch {}
      }, 15 * 60 * 1000);
    });
  } catch (err) {
    console.error('[applicationHandlers] ping applicant failed:', err.message);
  }

  if (decision === 'approved' || decision === 'waitlisted') {
    await refreshMainMessage(guildId);
  }

  return {
    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
    data: { flags: InteractionResponseFlags.EPHEMERAL, content: `${decisionLabel} the application from **${app.ign}**.` },
  };
}

// ─── Button: cancel (applicant only) ─────────────────────────────────────────
export async function handleApplicationCancel(req, appId) {
  const guildId = req.body.guild_id;
  const actorId = req.body.member?.user?.id || req.body.user?.id;

  if (!guildId) return ephemeral('❌ Server only.');

  const app = getApplication(appId);
  if (!app) return ephemeral('❌ Application not found.');
  if (app.guildId !== String(guildId)) return ephemeral('❌ Application not found in this server.');
  if (app.applicantId !== String(actorId)) return ephemeral('❌ Only the applicant can cancel their own application.');
  if (app.status !== 'pending') return ephemeral(`❌ This application is already **${app.status}**.`);

  const updated = updateApplicationStatus(appId, 'cancelled');
  const updatedPayload = buildApplicationMessage(updated);

  try {
    await editChannelMessage(app.channelId, app.messageId, updatedPayload);
  } catch (err) {
    console.error('[applicationHandlers] edit app message (cancel) failed:', err.message);
  }

  setTimeout(async () => {
    try { await deleteChannelMessage(app.channelId, app.messageId); } catch {}
  }, 15 * 60 * 1000);

  return ephemeral('✅ Your application has been cancelled.');
}

// ─── Router helpers ───────────────────────────────────────────────────────────
export function isApplicationChannelCommand(name) {
  return name === 'setapplicationchannel';
}

export function parseApplicationComponent(customId) {
  if (customId === APP_OPEN_MODAL_ID) return { action: 'open_modal' };
  if (customId?.startsWith(APP_APPROVE_PREFIX))  return { action: 'approve',   appId: customId.slice(APP_APPROVE_PREFIX.length) };
  if (customId?.startsWith(APP_REJECT_PREFIX))   return { action: 'reject',    appId: customId.slice(APP_REJECT_PREFIX.length) };
  if (customId?.startsWith(APP_WAITLIST_PREFIX)) return { action: 'waitlist',  appId: customId.slice(APP_WAITLIST_PREFIX.length) };
  if (customId?.startsWith(APP_CANCEL_PREFIX))   return { action: 'cancel',    appId: customId.slice(APP_CANCEL_PREFIX.length) };
  return null;
}

export function isApplicationModalSubmit(customId) {
  return customId === APP_MODAL_ID;
}
