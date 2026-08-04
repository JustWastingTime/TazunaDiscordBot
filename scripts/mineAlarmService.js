import {
  deleteChannelMessage,
  editChannelMessage,
  sendChannelMessage,
} from './quizDiscord.js';
import {
  addGambaCoins,
  ensureQuizUser,
} from './clubDatabase.js';
import {
  getBoard,
  getGuildMineState,
  listBoardChannelIds,
  listGuildMineStates,
  saveGuildMineState,
  timersForChannel,
} from './mineAlarmStorage.js';

export const DEFAULT_MINUTES = 50;
export const MAX_MINUTES = 50;
export const DONE_NOTICE_MINUTES = 30;
export const MINE_ALARM_COIN_REWARD = 10;

export const BOARD_START_ID = 'mine_board_start';
export const BOARD_STOP_ID = 'mine_board_stop';
export const RESTART_CUSTOM_ID_PREFIX = 'mine_restart:';

const EMPTY_TEXT = '_Nobody is in the mines right now._';
const MINE_EMOJI = '<a:minekraft:1530868447485890740>';

/** @type {Map<string, NodeJS.Timeout>} */
const pendingTimeouts = new Map();

/** @type {Map<string, NodeJS.Timeout>} */
const noticeDeleteTimeouts = new Map();

function timerKey(guildId, userId) {
  return `${guildId}:${userId}`;
}

function noticeKey(guildId, messageId) {
  return `${guildId}:${messageId}`;
}

function clearScheduled(guildId, userId) {
  const key = timerKey(guildId, userId);
  const existing = pendingTimeouts.get(key);
  if (existing) {
    clearTimeout(existing);
    pendingTimeouts.delete(key);
  }
}

export function clearNoticeDelete(guildId, messageId) {
  const key = noticeKey(guildId, messageId);
  const existing = noticeDeleteTimeouts.get(key);
  if (existing) {
    clearTimeout(existing);
    noticeDeleteTimeouts.delete(key);
  }
}

export function boardButtonRow() {
  return {
    type: 1,
    components: [
      {
        type: 2,
        style: 3,
        custom_id: BOARD_START_ID,
        label: `Start timer (${DEFAULT_MINUTES}m)`,
      },
      {
        type: 2,
        style: 2,
        custom_id: BOARD_STOP_ID,
        label: 'Stop timer',
      },
    ],
  };
}

export function restartButtonRow(userId) {
  return {
    type: 1,
    components: [
      {
        type: 2,
        style: 1,
        custom_id: `${RESTART_CUSTOM_ID_PREFIX}${userId}`,
        label: 'Restart timer',
      },
    ],
  };
}

export function buildBoardContent(timers) {
  const entries = Object.entries(timers).sort((a, b) => a[1].endAt - b[1].endAt);
  if (entries.length === 0) {
    return `**Currently in the mines**\n${EMPTY_TEXT}`;
  }

  const lines = entries.map(([userId, timer]) => {
    const unix = Math.floor(timer.endAt / 1000);
    return `${MINE_EMOJI} <@${userId}> — done <t:${unix}:R>`;
  });

  return `**Currently in the mines**\n${lines.join('\n')}`;
}

export function buildBoardPayload(timers) {
  return {
    content: buildBoardContent(timers),
    components: [boardButtonRow()],
  };
}

function isUnknownMessageError(err) {
  const message = String(err?.message || err || '');
  return message.includes('"code":10008') || message.includes('10008') || /unknown message/i.test(message);
}

function isChannelUnavailableError(err) {
  const message = String(err?.message || err || '');
  return (
    message.includes('50001') ||
    message.includes('50013') ||
    message.includes('10003') ||
    message.includes('50083')
  );
}

/**
 * Edit the board message, or post a new one if the stored message is gone.
 * Returns the latest messageId (or null if the board couldn't be updated).
 */
async function upsertBoardMessage(guildId, channelId, state = null) {
  const current = state || getGuildMineState(guildId);
  const cid = String(channelId);
  const board = getBoard(current, cid);
  const payload = buildBoardPayload(timersForChannel(current, cid));

  if (board?.messageId) {
    try {
      await editChannelMessage(cid, board.messageId, payload);
      return board.messageId;
    } catch (err) {
      if (!isUnknownMessageError(err)) throw err;
      console.warn(
        `Mine board message ${board.messageId} missing in guild ${guildId} channel ${cid}; recreating.`,
      );
    }
  }

  const message = await sendChannelMessage(cid, payload);
  current.boards[cid] = { messageId: String(message.id) };
  saveGuildMineState(guildId, current);
  return String(message.id);
}

export async function refreshBoard(guildId, channelId, state = null) {
  try {
    await upsertBoardMessage(guildId, channelId, state);
  } catch (err) {
    if (isChannelUnavailableError(err)) {
      console.warn(
        `Mine board channel unavailable (${guildId}/${channelId}):`,
        err.message ?? err,
      );
      return;
    }
    console.error(
      `Failed to refresh mine board (${guildId}/${channelId}):`,
      err.message ?? err,
    );
  }
}

async function refreshBoards(guildId, channelIds, state = null) {
  const current = state || getGuildMineState(guildId);
  const unique = [...new Set(channelIds.filter(Boolean).map(String))];
  await Promise.all(unique.map((channelId) => refreshBoard(guildId, channelId, current)));
}

export function awardMineAlarmCoins(userId, displayName, guildId) {
  ensureQuizUser(userId, displayName || 'Trainer', guildId);
  const result = addGambaCoins(userId, MINE_ALARM_COIN_REWARD);
  return result?.added ?? 0;
}

async function handleTimerExpired(guildId, userId, timer) {
  const state = getGuildMineState(guildId);
  const current = state.timers[userId];
  if (!current || current.endAt !== timer.endAt) return;

  delete state.timers[userId];
  saveGuildMineState(guildId, state);
  pendingTimeouts.delete(timerKey(guildId, userId));

  // Only full-length mine sessions earn coins (blocks short-timer farming).
  // Timers started before `minutes` was stored are treated as full sessions.
  const sessionMinutes =
    timer.minutes == null ? DEFAULT_MINUTES : Number(timer.minutes);
  const awarded =
    sessionMinutes >= DEFAULT_MINUTES
      ? awardMineAlarmCoins(userId, 'Trainer', guildId)
      : 0;

  await refreshBoard(guildId, timer.channelId, state);
  await notifyTimerDone(guildId, userId, timer.channelId, awarded);
}

async function notifyTimerDone(guildId, userId, channelId, awarded = 0) {
  const targetChannelId = String(channelId);
  const deleteAt = Date.now() + DONE_NOTICE_MINUTES * 60 * 1000;
  const rewardLine = awarded
    ? ` (+**${MINE_ALARM_COIN_REWARD}** GambaCoins)`
    : '';
  const content =
    `<@${userId}> your mines are done${rewardLine}! Restart below, or this message disappears ` +
    `<t:${Math.floor(deleteAt / 1000)}:R>.`;

  try {
    const message = await sendChannelMessage(targetChannelId, {
      content,
      components: [restartButtonRow(userId)],
    });

    const next = getGuildMineState(guildId);
    next.notices[message.id] = {
      channelId: targetChannelId,
      userId: String(userId),
      deleteAt,
    };
    saveGuildMineState(guildId, next);
    scheduleNoticeDelete(guildId, message.id, next.notices[message.id]);
  } catch (err) {
    console.error(`Failed to post mine done notice (${guildId}):`, err.message ?? err);
  }
}

export function scheduleNoticeDelete(guildId, messageId, notice) {
  clearNoticeDelete(guildId, messageId);

  const delay = Math.max(0, notice.deleteAt - Date.now());
  const timeout = setTimeout(() => {
    deleteNoticeMessage(guildId, messageId).catch((err) => {
      console.error('Failed to auto-delete mine done notice:', err.message ?? err);
    });
  }, delay);

  noticeDeleteTimeouts.set(noticeKey(guildId, messageId), timeout);
}

export async function deleteNoticeMessage(guildId, messageId) {
  clearNoticeDelete(guildId, messageId);

  const state = getGuildMineState(guildId);
  const notice = state.notices[messageId];
  if (!notice) return;

  delete state.notices[messageId];
  saveGuildMineState(guildId, state);

  await deleteChannelMessage(notice.channelId, messageId);
}

export function scheduleTimer(guildId, userId, timer) {
  clearScheduled(guildId, userId);

  const delay = Math.max(0, timer.endAt - Date.now());
  const timeout = setTimeout(() => {
    handleTimerExpired(guildId, userId, timer).catch((err) => {
      console.error('Error handling expired mine timer:', err);
    });
  }, delay);

  pendingTimeouts.set(timerKey(guildId, userId), timeout);
}

/**
 * Resolve which mine board channel a slash command should use.
 * Prefer the current channel if it has a board; otherwise the only board if exactly one exists.
 */
export function resolveMineChannelId(guildId, currentChannelId) {
  const state = getGuildMineState(guildId);
  const boards = listBoardChannelIds(state);
  if (!boards.length) return { channelId: null, state, error: 'none' };

  if (currentChannelId && getBoard(state, currentChannelId)) {
    return { channelId: String(currentChannelId), state, error: null };
  }

  if (boards.length === 1) {
    return { channelId: boards[0], state, error: null };
  }

  return { channelId: null, state, error: 'ambiguous' };
}

export async function startTimer(guildId, userId, channelId, minutes = DEFAULT_MINUTES) {
  const clamped = Math.min(MAX_MINUTES, Math.max(1, Math.trunc(minutes)));
  const endAt = Date.now() + clamped * 60 * 1000;
  const cid = String(channelId);

  const state = getGuildMineState(guildId);
  if (!getBoard(state, cid)) {
    throw new Error('No mines board in that channel.');
  }

  const previousChannelId = state.timers[String(userId)]?.channelId;
  state.timers[String(userId)] = {
    endAt,
    channelId: cid,
    minutes: clamped,
  };
  saveGuildMineState(guildId, state);

  scheduleTimer(guildId, String(userId), state.timers[String(userId)]);
  // Don't block slash/button acks on Discord edit latency.
  refreshBoards(guildId, [cid, previousChannelId], state).catch((err) => {
    console.error('Mine board refresh after startTimer failed:', err.message ?? err);
  });

  return { timer: state.timers[String(userId)], minutes: clamped };
}

export async function stopTimer(guildId, userId) {
  clearScheduled(guildId, userId);

  const state = getGuildMineState(guildId);
  const existing = state.timers[String(userId)];
  if (!existing) return false;

  delete state.timers[String(userId)];
  saveGuildMineState(guildId, state);
  refreshBoard(guildId, existing.channelId, state).catch((err) => {
    console.error('Mine board refresh after stopTimer failed:', err.message ?? err);
  });
  return true;
}

export async function setupMineChannel(guildId, channelId) {
  const state = getGuildMineState(guildId);
  const cid = String(channelId);
  const existing = getBoard(state, cid);
  const messageId = await upsertBoardMessage(guildId, cid, state);
  const updated = Boolean(existing?.messageId && existing.messageId === messageId);
  return { updated, board: { channelId: cid, messageId } };
}

/**
 * Catch any overdue timers/notices (backup for lost setTimeouts) and reschedule live ones.
 */
export async function processDueMineAlarms() {
  const now = Date.now();

  for (const { guildId, state } of listGuildMineStates()) {
    for (const [userId, timer] of Object.entries(state.timers)) {
      if (timer.endAt <= now) {
        await handleTimerExpired(guildId, userId, timer);
      } else if (!pendingTimeouts.has(timerKey(guildId, userId))) {
        scheduleTimer(guildId, userId, timer);
      }
    }

    for (const [messageId, notice] of Object.entries(state.notices)) {
      if (notice.deleteAt <= now) {
        await deleteNoticeMessage(guildId, messageId);
      } else if (!noticeDeleteTimeouts.has(noticeKey(guildId, messageId))) {
        scheduleNoticeDelete(guildId, messageId, notice);
      }
    }
  }
}

export async function resumeMineAlarmsOnBoot() {
  for (const { guildId, state } of listGuildMineStates()) {
    for (const [userId, timer] of Object.entries(state.timers)) {
      if (timer.endAt <= Date.now()) {
        await handleTimerExpired(guildId, userId, timer);
      } else {
        scheduleTimer(guildId, userId, timer);
      }
    }

    for (const [messageId, notice] of Object.entries(state.notices)) {
      if (notice.deleteAt <= Date.now()) {
        await deleteNoticeMessage(guildId, messageId);
      } else {
        scheduleNoticeDelete(guildId, messageId, notice);
      }
    }

    const fresh = getGuildMineState(guildId);
    await refreshBoards(guildId, listBoardChannelIds(fresh), fresh);
  }
}
