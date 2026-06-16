import {
  InteractionResponseFlags,
  InteractionResponseType,
} from 'discord-interactions';
import {
  BEG_DONATION_AMOUNTS,
  awardGambaCoins,
  ensureQuizUser,
  getGambaDisplayName,
  getGambaLeaderboard,
  getUserLink,
  transferGambaCoins,
} from './clubDatabase.js';
import { enrichGambaLeaderboardEntries } from './clubService.js';
import { handleGambacoinSetEventChannel } from './eventHandlers.js';

const BOT_OWNER_IDS = new Set(
  String(process.env.BOT_OWNER_IDS || process.env.BOT_OWNER_ID || '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean),
);

function ephemeral(content) {
  return {
    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
    data: { flags: InteractionResponseFlags.EPHEMERAL, content },
  };
}

function guildRequiredResponse() {
  return ephemeral('❌ This command can only be used in a server.');
}

function resolveSubcommand(req) {
  return req.body.data.options?.find((opt) => opt.type === 1)?.name ?? null;
}

function getSubcommandOptions(req) {
  const subcommand = req.body.data.options?.find((opt) => opt.type === 1);
  return subcommand?.options ?? [];
}

function getOptionValue(req, name) {
  const value = getSubcommandOptions(req).find((opt) => opt.name === name)?.value;
  if (value === undefined || value === null) return undefined;
  return value;
}

function getOptionUserId(req, name) {
  const opt = getSubcommandOptions(req).find((o) => o.name === name);
  return opt?.value ?? null;
}

function formatCoins(amount) {
  return Math.trunc(amount).toLocaleString('en-US');
}

function rankLabel(rank) {
  if (rank === 1) return '🥇';
  if (rank === 2) return '🥈';
  if (rank === 3) return '🥉';
  return `\`${rank}.\``;
}

function buildLeaderboardEmbed(entries, { scopeLabel, totalCount }) {
  if (!entries.length) {
    return {
      color: 0xfee75c,
      title: '🏆 GambaCoin Leaderboard',
      description: `_No registered wallets yet for **${scopeLabel}**._\nUse \`/register\` or join a quiz to get a wallet.`,
      timestamp: new Date().toISOString(),
    };
  }

  const lines = entries.map((entry, index) => {
    const rank = index + 1;
    const name = entry.displayName || getGambaDisplayName(entry);
    return `${rankLabel(rank)} **${name}** — ${formatCoins(entry.gambaCoins ?? 0)} coins`;
  });

  if (lines.length > 3) lines.splice(3, 0, '');

  return {
    color: 0xfee75c,
    title: '🏆 GambaCoin Leaderboard',
    description: lines.join('\n'),
    footer: {
      text: `${scopeLabel} · ${totalCount} wallet${totalCount === 1 ? '' : 's'}`,
    },
    timestamp: new Date().toISOString(),
  };
}

function buildBegEmbed(displayName, message) {
  return {
    color: 0xfaa61a,
    author: { name: `${displayName} is begging for GambaCoins` },
    description: message,
    footer: { text: 'Tap a button below to donate coins' },
  };
}

export function buildBegDonationRows(beggarId) {
  return [
    {
      type: 1,
      components: BEG_DONATION_AMOUNTS.map((amount) => ({
        type: 2,
        style: 2,
        custom_id: `gamba-donate:${beggarId}:${amount}`,
        label: `Donate ${amount}`,
      })),
    },
  ];
}

function resolveDiscordDisplayName(req, userId) {
  const resolved = req.body.data?.resolved;
  const member = resolved?.members?.[userId];
  if (member?.nick) return member.nick;
  const user = resolved?.users?.[userId];
  if (user?.global_name) return user.global_name;
  if (user?.username) return user.username;
  return 'Trainer';
}

function requireWallet(userId, displayName, guildId) {
  const link = getUserLink(userId);
  if (link) return { ok: true, link };
  const created = ensureQuizUser(userId, displayName, guildId);
  return { ok: true, link: created.link };
}

export async function handleGambacoinGive(req) {
  const guildId = req.body.guild_id;
  if (!guildId) return guildRequiredResponse();

  const userId = req.body.member?.user?.id || req.body.user?.id;
  const displayName = req.body.member?.display_name || req.body.member?.user?.username || 'Trainer';
  const targetUserId = getOptionUserId(req, 'player');
  const amount = getOptionValue(req, 'value');

  if (!targetUserId) return ephemeral('❌ Mention a player to give coins to.');
  if (String(targetUserId) === String(userId)) {
    return ephemeral('❌ You cannot give coins to yourself.');
  }
  if (!amount || Number(amount) < 1) return ephemeral('❌ Enter a positive coin amount.');

  const wallet = requireWallet(userId, displayName, guildId);
  if (!wallet.ok) return ephemeral(wallet.error);

  const recipientName = resolveDiscordDisplayName(req, targetUserId);
  requireWallet(targetUserId, recipientName, guildId);

  const result = transferGambaCoins(userId, targetUserId, amount);
  if (!result.ok) return ephemeral(`❌ ${result.error}`);

  return ephemeral(
    `✅ Gave **${formatCoins(result.amount)}** GambaCoins to <@${targetUserId}>. ` +
      `Your balance is now **${formatCoins(result.sender.gambaCoins ?? 0)}**.`,
  );
}

export async function handleGambacoinBeg(req) {
  const guildId = req.body.guild_id;
  if (!guildId) return guildRequiredResponse();

  const userId = req.body.member?.user?.id || req.body.user?.id;
  const displayName = req.body.member?.display_name || req.body.member?.user?.username || 'Trainer';
  const message = String(getOptionValue(req, 'message') ?? '').trim();

  if (!message) return ephemeral('❌ Please include a begging message.');

  const wallet = requireWallet(userId, displayName, guildId);
  if (!wallet.ok) return ephemeral(wallet.error);

  return {
    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
    data: {
      embeds: [buildBegEmbed(displayName, message)],
      components: buildBegDonationRows(userId),
    },
  };
}

export async function handleGambacoinLeaderboard(req) {
  const guildId = req.body.guild_id;
  if (!guildId) return guildRequiredResponse();

  const scope = getOptionValue(req, 'scope') ?? 'server';
  const useGuild = scope !== 'global';
  const scopeLabel = useGuild ? 'This server' : 'Global';
  const board = getGambaLeaderboard({
    guildId: useGuild ? guildId : null,
    limit: 25,
  });
  const enrichedBoard = await enrichGambaLeaderboardEntries(board);
  const totalCount = getGambaLeaderboard({
    guildId: useGuild ? guildId : null,
    limit: Number.MAX_SAFE_INTEGER,
  }).length;

  return {
    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
    data: {
      embeds: [buildLeaderboardEmbed(enrichedBoard, { scopeLabel, totalCount })],
    },
  };
}

export async function handleGambacoinAward(req) {
  const guildId = req.body.guild_id;
  const userId = req.body.member?.user?.id || req.body.user?.id;
  const ownerGuildId = String(process.env.BOT_OWNER_GUILD_ID || '').trim();

  if (!guildId || !ownerGuildId || guildId !== ownerGuildId) {
    return ephemeral('❌ This command is not available in this server.');
  }
  if (!userId || !BOT_OWNER_IDS.has(userId)) {
    return ephemeral('❌ Only the bot owner can use `/gambacoin award`.');
  }

  const targetUserId = getOptionUserId(req, 'user');
  const amount = getOptionValue(req, 'amount');
  if (!targetUserId) return ephemeral('❌ Pick a user to award.');
  if (!amount || Number(amount) < 1) return ephemeral('❌ Enter a positive coin amount.');

  const result = awardGambaCoins(targetUserId, amount);
  if (!result.ok) return ephemeral(`❌ ${result.error}`);

  const recipientName = result.recipient.trainerName || 'Trainer';
  return ephemeral(
    `✅ Awarded **${formatCoins(result.amount)}** GambaCoins to **${recipientName}**. ` +
      `Their balance is now **${formatCoins(result.recipient.gambaCoins ?? 0)}**.`,
  );
}

export async function handleGambaDonateClick(req, beggarId, amount) {
  const guildId = req.body.guild_id;
  if (!guildId) return ephemeral('❌ This button can only be used in a server.');

  const userId = req.body.member?.user?.id || req.body.user?.id;
  const displayName = req.body.member?.display_name || req.body.member?.user?.username || 'Trainer';

  if (userId === beggarId) {
    return ephemeral('❌ You cannot donate to yourself.');
  }
  if (!BEG_DONATION_AMOUNTS.includes(amount)) {
    return ephemeral('❌ Invalid donation amount.');
  }

  const wallet = requireWallet(userId, displayName, guildId);
  if (!wallet.ok) return ephemeral(wallet.error);

  const result = transferGambaCoins(userId, beggarId, amount);
  if (!result.ok) return ephemeral(`❌ ${result.error}`);

  const recipientName = result.recipient.trainerName || 'Trainer';
  return ephemeral(
    `✅ You donated **${formatCoins(result.amount)}** GambaCoins to **${recipientName}**.`,
  );
}

export function handleGambaDonateComponent(customId) {
  if (!customId?.startsWith('gamba-donate:')) return null;
  const [, beggarId, amountStr] = customId.split(':');
  const amount = Number.parseInt(amountStr, 10);
  if (!beggarId || !Number.isFinite(amount)) return null;
  return { beggarId, amount };
}

export function dispatchGambacoinCommand(req) {
  const subcommand = resolveSubcommand(req);
  switch (subcommand) {
    case 'give':
      return handleGambacoinGive(req);
    case 'beg':
      return handleGambacoinBeg(req);
    case 'leaderboard':
      return handleGambacoinLeaderboard(req);
    case 'seteventchannel':
      return handleGambacoinSetEventChannel(req);
    case 'award':
      return handleGambacoinAward(req);
    default:
      return null;
  }
}

export function isGambacoinCommand(name) {
  return name === 'gambacoin';
}
