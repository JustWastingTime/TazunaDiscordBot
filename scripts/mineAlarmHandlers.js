import {
  InteractionResponseFlags,
  InteractionResponseType,
} from 'discord-interactions';
import { isTazunaAdmin, tazunaAdminDenied } from './adminRole.js';
import { isPremiumGuild } from './clubDatabase.js';
import { getBoard, getGuildMineState, listBoardChannelIds } from './mineAlarmStorage.js';
import {
  BOARD_START_ID,
  BOARD_STOP_ID,
  DEFAULT_MINUTES,
  MAX_MINUTES,
  RESTART_CUSTOM_ID_PREFIX,
  deleteNoticeMessage,
  resolveMineChannelId,
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

function requirePremium(guildId) {
  if (!guildId || !isPremiumGuild(guildId)) {
    return ephemeral('Only available on premium servers.');
  }
  return null;
}

function requireMineChannel(guildId, currentChannelId) {
  const resolved = resolveMineChannelId(guildId, currentChannelId);
  if (resolved.error === 'none') {
    return {
      denied: ephemeral(
        'No mines board is set up yet. An admin needs to run `/setminechannel` first.',
      ),
      channelId: null,
    };
  }
  if (resolved.error === 'ambiguous') {
    const mentions = listBoardChannelIds(resolved.state)
      .map((id) => `<#${id}>`)
      .join(', ');
    return {
      denied: ephemeral(
        `This server has multiple mine channels (${mentions}). Run this in one of those channels, or use the board buttons.`,
      ),
      channelId: null,
    };
  }
  return { denied: null, channelId: resolved.channelId };
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

  if (!(await isTazunaAdmin(guildId, req.body.member))) {
    return ephemeral(tazunaAdminDenied('use `/setminechannel`'));
  }

  return {
    deferred: true,
    ephemeral: true,
    run: async (sendFollowup) => {
      try {
        const result = await setupMineChannel(guildId, channelId);
        const boardCount = listBoardChannelIds(getGuildMineState(guildId)).length;
        const multiHint =
          boardCount > 1
            ? ` This server now has **${boardCount}** mine channels.`
            : '';
        await sendFollowup({
          flags: InteractionResponseFlags.EPHEMERAL,
          content: result.updated
            ? `Updated the mines board in this channel.${multiHint}`
            : `Mines board posted in this channel. It will update when timers change.${multiHint}`,
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
  const currentChannelId = req.body.channel_id;

  if (!guildId) {
    return ephemeral('❌ This command can only be used in a server.');
  }
  if (!userId) return ephemeral('❌ Could not identify you.');

  const premiumDenied = requirePremium(guildId);
  if (premiumDenied) return premiumDenied;

  const { denied, channelId } = requireMineChannel(guildId, currentChannelId);
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
    channelId,
    minutes,
  );
  const unix = Math.floor(timer.endAt / 1000);
  const rewardHint =
    usedMinutes >= DEFAULT_MINUTES
      ? ''
      : ` Coins are only awarded for full **${DEFAULT_MINUTES}**-minute sessions.`;

  return ephemeral(
    `Timer started for **${usedMinutes}** minute${usedMinutes === 1 ? '' : 's'}. ` +
      `Done <t:${unix}:R>.${rewardHint}`,
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
  const channelId = req.body.channel_id;

  if (!guildId) return ephemeral('❌ This button can only be used in a server.');
  if (!userId) return ephemeral('❌ Could not identify you.');
  if (!channelId || !getBoard(getGuildMineState(guildId), channelId)) {
    return ephemeral(
      'No mines board is set up in this channel. An admin needs to run `/setminechannel` here.',
    );
  }

  const premiumDenied = requirePremium(guildId);
  if (premiumDenied) return premiumDenied;

  const { timer, minutes } = await startTimer(
    guildId,
    userId,
    channelId,
    DEFAULT_MINUTES,
  );
  const unix = Math.floor(timer.endAt / 1000);

  return ephemeral(
    `Timer started for **${minutes}** minutes. Done <t:${unix}:R>.`,
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
  const channelId = req.body.channel_id;

  if (!guildId) return ephemeral('❌ This button can only be used in a server.');
  if (!userId) return ephemeral('❌ Could not identify you.');

  if (String(userId) !== String(ownerId)) {
    return ephemeral('Only the person who owned that timer can restart it.');
  }

  const premiumDenied = requirePremium(guildId);
  if (premiumDenied) return premiumDenied;

  if (!channelId || !getBoard(getGuildMineState(guildId), channelId)) {
    return ephemeral(
      'No mines board is set up in this channel. An admin needs to run `/setminechannel` here.',
    );
  }

  const { timer, minutes } = await startTimer(
    guildId,
    userId,
    channelId,
    DEFAULT_MINUTES,
  );
  const unix = Math.floor(timer.endAt / 1000);

  const messageId = req.body.message?.id;
  if (messageId) {
    await deleteNoticeMessage(guildId, messageId);
  }

  return ephemeral(
    `Restarted your mine timer (**${minutes}** minutes). Done <t:${unix}:R>.`,
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
