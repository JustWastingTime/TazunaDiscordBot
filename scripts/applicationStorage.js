import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.resolve(__dirname, '..', 'data');
const APP_CHANNEL_PATH = path.join(DATA_DIR, 'application-channels.json');
const APPLICATIONS_PATH = path.join(DATA_DIR, 'applications.json');

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

// ─── Application Channel Config ───────────────────────────────────────────────
// Structure: { [guildId]: { channelId, messageId, guildName } }
// Clubs always come from getGuildClubs (registered via /club registerclub).

function loadAppChannels() {
  return readJson(APP_CHANNEL_PATH, {});
}

function saveAppChannels(store) {
  writeJson(APP_CHANNEL_PATH, store);
}

export function setApplicationChannel(guildId, { channelId, messageId, guildName }) {
  const store = loadAppChannels();
  store[String(guildId)] = { channelId, messageId, guildName };
  saveAppChannels(store);
}

export function getApplicationChannel(guildId) {
  const store = loadAppChannels();
  return store[String(guildId)] ?? null;
}

export function updateApplicationChannelMessage(guildId, messageId) {
  const store = loadAppChannels();
  const entry = store[String(guildId)];
  if (!entry) return false;
  entry.messageId = messageId;
  saveAppChannels(store);
  return true;
}

// ─── Applications ─────────────────────────────────────────────────────────────
// Structure: { [applicationId]: { id, guildId, channelId, messageId, applicantId, ign, gameId, club, reason, status, createdAt } }
// status: 'pending' | 'approved' | 'rejected' | 'waitlisted' | 'cancelled'

function loadApplications() {
  return readJson(APPLICATIONS_PATH, {});
}

function saveApplications(store) {
  writeJson(APPLICATIONS_PATH, store);
}

export function newApplicationId() {
  return `app_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export function createApplication({ id, guildId, channelId, messageId, applicantId, ign, gameId, club, reason }) {
  const store = loadApplications();
  store[id] = {
    id,
    guildId: String(guildId),
    channelId: String(channelId),
    messageId: String(messageId),
    applicantId: String(applicantId),
    ign,
    gameId: String(gameId),
    club,
    reason: reason || null,
    status: 'pending',
    createdAt: new Date().toISOString(),
  };
  saveApplications(store);
  return store[id];
}

export function getApplication(id) {
  const store = loadApplications();
  return store[id] ?? null;
}

export function updateApplicationStatus(id, status) {
  const store = loadApplications();
  if (!store[id]) return null;
  store[id].status = status;
  store[id].resolvedAt = new Date().toISOString();
  saveApplications(store);
  return store[id];
}

export function updateApplicationMessageId(id, messageId) {
  const store = loadApplications();
  if (!store[id]) return null;
  store[id].messageId = String(messageId);
  saveApplications(store);
  return store[id];
}

export function listGuildApplications(guildId) {
  const store = loadApplications();
  return Object.values(store).filter((app) => app.guildId === String(guildId));
}

export function listActiveApplications(guildId) {
  return listGuildApplications(guildId).filter((app) => app.status === 'pending');
}

export function listResolvedApplications(guildId) {
  return listGuildApplications(guildId).filter(
    (app) => app.status === 'approved' || app.status === 'waitlisted',
  );
}

/** Remove approved/waitlisted applications from the roster (pending kept). Returns count cleared. */
export function clearResolvedApplications(guildId) {
  const store = loadApplications();
  const gid = String(guildId);
  let cleared = 0;

  for (const [id, app] of Object.entries(store)) {
    if (app.guildId !== gid) continue;
    if (app.status !== 'approved' && app.status !== 'waitlisted') continue;
    delete store[id];
    cleared += 1;
  }

  if (cleared) saveApplications(store);
  return cleared;
}
