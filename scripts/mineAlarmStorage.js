import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.resolve(__dirname, '..', 'data');
const STATE_PATH = path.join(DATA_DIR, 'mine-alarm.json');

/**
 * @typedef {{ messageId: string }} MineBoard
 * @typedef {{ endAt: number, channelId: string, minutes?: number }} MineTimer
 * @typedef {{ channelId: string, userId: string, deleteAt: number }} MineNotice
 * @typedef {{
 *   boards: Record<string, MineBoard>,
 *   timers: Record<string, MineTimer>,
 *   notices: Record<string, MineNotice>,
 * }} GuildMineState
 */

function ensureDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function readJson(filePath, fallback) {
  ensureDataDir();
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    throw err;
  }
}

function writeJson(filePath, data) {
  ensureDataDir();
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

function emptyGuildState() {
  return {
    boards: {},
    timers: {},
    notices: {},
  };
}

/**
 * Migrate legacy single-board guild state to multi-board shape.
 * @param {object} entry
 * @returns {GuildMineState}
 */
function normalizeGuildEntry(entry) {
  if (!entry || typeof entry !== 'object') return emptyGuildState();

  const timers = entry.timers && typeof entry.timers === 'object' ? entry.timers : {};
  const notices = entry.notices && typeof entry.notices === 'object' ? entry.notices : {};

  if (entry.boards && typeof entry.boards === 'object') {
    return {
      boards: entry.boards,
      timers,
      notices,
    };
  }

  // Legacy: { board: { channelId, messageId }, timers, notices }
  const boards = {};
  if (entry.board?.channelId && entry.board?.messageId) {
    boards[String(entry.board.channelId)] = {
      messageId: String(entry.board.messageId),
    };
  }

  return { boards, timers, notices };
}

function loadStore() {
  const raw = readJson(STATE_PATH, { guilds: {} });
  return {
    guilds: raw?.guilds && typeof raw.guilds === 'object' ? raw.guilds : {},
  };
}

function saveStore(store) {
  writeJson(STATE_PATH, store);
}

/**
 * @param {string} guildId
 * @returns {GuildMineState}
 */
export function getGuildMineState(guildId) {
  const store = loadStore();
  return normalizeGuildEntry(store.guilds[String(guildId)]);
}

/**
 * @param {string} guildId
 * @param {GuildMineState} state
 */
export function saveGuildMineState(guildId, state) {
  const store = loadStore();
  store.guilds[String(guildId)] = {
    boards: state.boards && typeof state.boards === 'object' ? state.boards : {},
    timers: state.timers && typeof state.timers === 'object' ? state.timers : {},
    notices: state.notices && typeof state.notices === 'object' ? state.notices : {},
  };
  saveStore(store);
}

/**
 * @returns {Array<{ guildId: string, state: GuildMineState }>}
 */
export function listGuildMineStates() {
  const store = loadStore();
  return Object.entries(store.guilds).map(([guildId, entry]) => ({
    guildId,
    state: normalizeGuildEntry(entry),
  }));
}

/**
 * @param {GuildMineState} state
 * @param {string} channelId
 */
export function getBoard(state, channelId) {
  return state.boards?.[String(channelId)] ?? null;
}

/**
 * @param {GuildMineState} state
 * @returns {string[]}
 */
export function listBoardChannelIds(state) {
  return Object.keys(state.boards || {});
}

/**
 * Timers belonging to a specific mine board channel.
 * @param {GuildMineState} state
 * @param {string} channelId
 */
export function timersForChannel(state, channelId) {
  const cid = String(channelId);
  const out = {};
  for (const [userId, timer] of Object.entries(state.timers || {})) {
    if (String(timer.channelId) === cid) out[userId] = timer;
  }
  return out;
}
