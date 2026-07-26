import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.resolve(__dirname, '..', 'data');
const STATE_PATH = path.join(DATA_DIR, 'mine-alarm.json');

/**
 * @typedef {{ channelId: string, messageId: string }} MineBoard
 * @typedef {{ endAt: number, channelId: string }} MineTimer
 * @typedef {{ channelId: string, userId: string, deleteAt: number }} MineNotice
 * @typedef {{
 *   board: MineBoard | null,
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
    board: null,
    timers: {},
    notices: {},
  };
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
  const entry = store.guilds[String(guildId)];
  if (!entry || typeof entry !== 'object') return emptyGuildState();
  return {
    board: entry.board ?? null,
    timers: entry.timers && typeof entry.timers === 'object' ? entry.timers : {},
    notices: entry.notices && typeof entry.notices === 'object' ? entry.notices : {},
  };
}

/**
 * @param {string} guildId
 * @param {GuildMineState} state
 */
export function saveGuildMineState(guildId, state) {
  const store = loadStore();
  store.guilds[String(guildId)] = {
    board: state.board ?? null,
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
    state: {
      board: entry?.board ?? null,
      timers: entry?.timers && typeof entry.timers === 'object' ? entry.timers : {},
      notices: entry?.notices && typeof entry.notices === 'object' ? entry.notices : {},
    },
  }));
}
