import {
  InteractionResponseFlags,
  InteractionResponseType,
} from 'discord-interactions';
import { isGuildAdmin } from './clubHandlers.js';
import { isPremiumGuild } from './clubDatabase.js';
import { getGuildMineState } from './mineAlarmStorage.js';
import {
  BOARD_START_ID,
  BOARD_STOP_ID,
  DEFAULT_MINUTES,
  MAX_MINUTES,
  MINE_ALARM_COIN_REWARD,
  RESTART_CUSTOM_ID_PREFIX,
  awardMineAlarmCoins,
  deleteNoticeMessage,
  setupMineChannel,
  startTimer,
  stopTimer,
} from './mineAlarmService.js';

const MINE_ALARM_COMMANDS = new Set(['setminechannel', 'starttimer', 'stoptimer']);

function ephemeral(content) {
  return {
    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
    data: { flags: InteractionResponseFlags.EPHEMERAL, content },
  };
}

function getOptionValue(req, name) {
  const value = req.body.data.options?.find((opt) => opt.name === name)?.value;
  if (value === undefined || value === null) return undefined;
  return value;
}

function resolveUserId(req) {
  return req.body.member?.user?.id || req.body.user?.id || null;
}

function resolveDisplayName(req) {
  const member = req.body.member;
  const user = member?.user || req.body.user;
  return (
    member?.nick ||
    member?.display_name ||
    user?.global_name ||
    user?.username ||
    'Trainer'
  );
}

function requirePremium(guildId) {
  if (!guildId || !isPremiumGuild(guildId)) {
    return ephemeral('Only available on premium servers.');
  }
  return null;
}

function requireBoard(guildId) {
  const state = getGuildMineState(guildId);
  if (!state.board?.channelId) {
    return {
      denied: ephemeral(
        'No mines board is set up yet. An admin needs to run `/setminechannel` first.',
      ),
      state: null,
    };
  }
  return { denied: null, state };
}

function coinRewardLine(awarded) {
  if (!awarded) return '';
  return `\n+**${MINE_ALARM_COIN_REWARD}** GambaCoins.`;
}

export function isMineAlarmCommand(name) {
  return MINE_ALARM_COMMANDS.has(name);
}

export function handleMineAlarmComponent(customId) {
  if (customId === BOARD_START_ID) return { action: 'start' };
  if (customId === BOARD_STOP_ID) return { action: 'stop' };
  if (customId?.startsWith(RESTART_CUSTOM_ID_PREFIX)) {
    const ownerId = customId.slice(RESTART_CUSTOM_ID_PREFIX.length);
    if (!ownerId) return null;
    return { action: 'restart', ownerId };
  }
  return null;
}

export async function handleSetMineChannel(req) {
  const guildId = req.body.guild_id;
  const channelId = req.body.channel_id;

  if (!guildId || !channelId) {
    return ephemeral('❌ This command can only be used in a server channel.');
  }

  const premiumDenied = requirePremium(guildId);
  if (premiumDenied) return premiumDenied;

  if (!isGuildAdmin(req.body.member)) {
    return ephemeral('❌ Only server administrators can use `/setminechannel`.');
  }

  return {
    deferred: true,
    ephemeral: true,
    run: async (sendFollowup) => {
      try {
        const result = await setupMineChannel(guildId, channelId);
        await sendFollowup({
          flags: InteractionResponseFlags.EPHEMERAL,
          content: result.updated
            ? 'Updated the mines board in this channel.'
            : 'Mines board posted in this channel. It will update when timers change.',
        });
      } catch (err) {
        console.error('setminechannel failed:', err.message ?? err);
        await sendFollowup({
          flags: InteractionResponseFlags.EPHEMERAL,
          content:
            `❌ Couldn't post in <#${channelId}>. Make sure I have **View Channel**, **Send Messages**, and **Manage Messages** there.`,
        });
      }
    },
  };
}

export async function handleStartTimer(req) {
  const guildId = req.body.guild_id;
  const userId = resolveUserId(req);

  if (!guildId) {
    return ephemeral('❌ This command can only be used in a server.');
  }
  if (!userId) return ephemeral('❌ Could not identify you.');

  const premiumDenied = requirePremium(guildId);
  if (premiumDenied) return premiumDenied;

  const { denied, state } = requireBoard(guildId);
  if (denied) return denied;

  const rawMinutes = getOptionValue(req, 'minutes');
  const minutes =
    rawMinutes === undefined ? DEFAULT_MINUTES : Number(rawMinutes);

  if (!Number.isFinite(minutes) || minutes < 1 || minutes > MAX_MINUTES) {
    return ephemeral(`❌ Minutes must be between **1** and **${MAX_MINUTES}**.`);
  }

  const { timer, minutes: usedMinutes } = await startTimer(
    guildId,
    userId,
    state.board.channelId,
    minutes,
  );
  const awarded = awardMineAlarmCoins(userId, resolveDisplayName(req), guildId);
  const unix = Math.floor(timer.endAt / 1000);

  return ephemeral(
    `Timer started for **${usedMinutes}** minute${usedMinutes === 1 ? '' : 's'}. ` +
      `Done <t:${unix}:R>.${coinRewardLine(awarded)}`,
  );
}

export async function handleStopTimer(req) {
  const guildId = req.body.guild_id;
  const userId = resolveUserId(req);

  if (!guildId) {
    return ephemeral('❌ This command can only be used in a server.');
  }
  if (!userId) return ephemeral('❌ Could not identify you.');

  const premiumDenied = requirePremium(guildId);
  if (premiumDenied) return premiumDenied;

  const stopped = await stopTimer(guildId, userId);
  return ephemeral(
    stopped ? 'Your mine timer was cancelled.' : 'You do not have an active mine timer.',
  );
}

export async function handleMineBoardStart(req) {
  const guildId = req.body.guild_id;
  const userId = resolveUserId(req);

  if (!guildId) return ephemeral('❌ This button can only be used in a server.');
  if (!userId) return ephemeral('❌ Could not identify you.');

  const premiumDenied = requirePremium(guildId);
  if (premiumDenied) return premiumDenied;

  const { denied, state } = requireBoard(guildId);
  if (denied) return denied;

  const { timer, minutes } = await startTimer(
    guildId,
    userId,
    state.board.channelId,
    DEFAULT_MINUTES,
  );
  const awarded = awardMineAlarmCoins(userId, resolveDisplayName(req), guildId);
  const unix = Math.floor(timer.endAt / 1000);

  return ephemeral(
    `Timer started for **${minutes}** minutes. Done <t:${unix}:R>.${coinRewardLine(awarded)}`,
  );
}

export async function handleMineBoardStop(req) {
  const guildId = req.body.guild_id;
  const userId = resolveUserId(req);

  if (!guildId) return ephemeral('❌ This button can only be used in a server.');
  if (!userId) return ephemeral('❌ Could not identify you.');

  const premiumDenied = requirePremium(guildId);
  if (premiumDenied) return premiumDenied;

  const stopped = await stopTimer(guildId, userId);
  return ephemeral(
    stopped ? 'Your mine timer was cancelled.' : 'You do not have an active mine timer.',
  );
}

export async function handleMineRestart(req, ownerId) {
  const guildId = req.body.guild_id;
  const userId = resolveUserId(req);

  if (!guildId) return ephemeral('❌ This button can only be used in a server.');
  if (!userId) return ephemeral('❌ Could not identify you.');

  if (String(userId) !== String(ownerId)) {
    return ephemeral('Only the person who owned that timer can restart it.');
  }

  const premiumDenied = requirePremium(guildId);
  if (premiumDenied) return premiumDenied;

  const { denied, state } = requireBoard(guildId);
  if (denied) return denied;

  const { timer, minutes } = await startTimer(
    guildId,
    userId,
    state.board.channelId,
    DEFAULT_MINUTES,
  );
  const awarded = awardMineAlarmCoins(userId, resolveDisplayName(req), guildId);
  const unix = Math.floor(timer.endAt / 1000);

  const messageId = req.body.message?.id;
  if (messageId) {
    await deleteNoticeMessage(guildId, messageId);
  }

  return ephemeral(
    `Restarted your mine timer (**${minutes}** minutes). Done <t:${unix}:R>.${coinRewardLine(awarded)}`,
  );
}

export async function dispatchMineAlarmCommand(req) {
  const name = req.body.data?.name;
  switch (name) {
    case 'setminechannel':
      return handleSetMineChannel(req);
    case 'starttimer':
      return handleStartTimer(req);
    case 'stoptimer':
      return handleStopTimer(req);
    default:
      return null;
  }
}

export async function handleMineAlarmClick(req, action) {
  switch (action.action) {
    case 'start':
      return handleMineBoardStart(req);
    case 'stop':
      return handleMineBoardStop(req);
    case 'restart':
      return handleMineRestart(req, action.ownerId);
    default:
      return ephemeral('❌ Unknown mine alarm action.');
  }
}
