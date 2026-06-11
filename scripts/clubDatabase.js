import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.resolve(__dirname, '..', 'data');
const GUILD_CLUBS_PATH = path.join(DATA_DIR, 'guild-clubs.json');
const USER_LINKS_PATH = path.join(DATA_DIR, 'user-links.json');
const LEADERBOARD_CHANNELS_PATH = path.join(DATA_DIR, 'leaderboard-channels.json');
const PREMIUM_GUILDS_PATH = path.join(DATA_DIR, 'premium-guilds.json');

const PREMIUM_GUILD_IDS_ENV = new Set(
  String(process.env.PREMIUM_GUILD_IDS || '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean),
);

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

function loadGuildClubs() {
  return readJson(GUILD_CLUBS_PATH, {});
}

function saveGuildClubs(store) {
  writeJson(GUILD_CLUBS_PATH, store);
}

function loadUserLinks() {
  return readJson(USER_LINKS_PATH, {});
}

function saveUserLinks(store) {
  writeJson(USER_LINKS_PATH, store);
}

export function registerGuildClub(guildId, circleId, circleName) {
  const store = loadGuildClubs();
  const key = String(guildId);
  const clubs = Array.isArray(store[key]) ? store[key] : [];
  const id = String(circleId);
  const existing = clubs.find((club) => String(club.circleId) === id);

  if (existing) {
    existing.circleName = circleName ?? existing.circleName ?? null;
  } else {
    clubs.push({
      circleId: id,
      circleName: circleName ?? null,
      registeredAt: new Date().toISOString(),
    });
  }

  clubs.sort((a, b) => String(a.circleName ?? '').localeCompare(String(b.circleName ?? ''), undefined, {
    sensitivity: 'base',
  }));

  store[key] = clubs;
  saveGuildClubs(store);
}

export function unregisterGuildClub(guildId, circleId) {
  const store = loadGuildClubs();
  const key = String(guildId);
  const clubs = Array.isArray(store[key]) ? store[key] : [];
  const next = clubs.filter((club) => String(club.circleId) !== String(circleId));

  if (next.length === clubs.length) return false;

  if (next.length) store[key] = next;
  else delete store[key];

  saveGuildClubs(store);
  removeLeaderboardChannelsForClub(guildId, circleId);
  return true;
}

export function getGuildClubs(guildId) {
  const store = loadGuildClubs();
  const clubs = store[String(guildId)];
  if (!Array.isArray(clubs)) return [];

  return clubs.map((club) => ({
    circleId: String(club.circleId),
    circleName: club.circleName ?? null,
  }));
}

export function isGuildClubRegistered(guildId, circleId) {
  return getGuildClubs(guildId).some((club) => String(club.circleId) === String(circleId));
}

export const STARTING_GAMBA_COINS = 1000;

export function upsertUserLink({ discordUserId, viewerId, trainerName, circleId, circleName }) {
  const store = loadUserLinks();
  const key = String(discordUserId);
  const existing = store[key];

  store[key] = {
    discordUserId: key,
    viewerId: String(viewerId),
    trainerName,
    circleId: String(circleId),
    circleName: circleName ?? null,
    linkedAt: existing?.linkedAt ?? new Date().toISOString(),
    gambaCoins: existing?.gambaCoins ?? STARTING_GAMBA_COINS,
    gambaWr: existing?.gambaWr ?? null,
    quizAccuracy: existing?.quizAccuracy ?? null,
  };
  saveUserLinks(store);
  return { isNewUser: !existing };
}

function loadLeaderboardChannels() {
  const data = readJson(LEADERBOARD_CHANNELS_PATH, []);
  return Array.isArray(data) ? data : [];
}

function saveLeaderboardChannels(channels) {
  writeJson(LEADERBOARD_CHANNELS_PATH, channels);
}

function loadPremiumGuildStore() {
  const data = readJson(PREMIUM_GUILDS_PATH, { guildIds: [] });
  return Array.isArray(data?.guildIds) ? data : { guildIds: [] };
}

function savePremiumGuildStore(store) {
  writeJson(PREMIUM_GUILDS_PATH, store);
}

export function upsertLeaderboardChannel({ guildId, circleId, channelId, messageId }) {
  const channels = loadLeaderboardChannels();
  const g = String(guildId);
  const c = String(circleId);
  const next = channels.filter(
    (entry) => !(String(entry.guildId) === g && String(entry.circleId) === c),
  );
  next.push({
    guildId: g,
    circleId: c,
    channelId: String(channelId),
    messageId: String(messageId),
    lastUpdatedAt: null,
    lastDailyKey: null,
    lastEmbedHash: null,
    createdAt: new Date().toISOString(),
  });
  saveLeaderboardChannels(next);
}

export function removeLeaderboardChannelsForClub(guildId, circleId) {
  const channels = loadLeaderboardChannels();
  const g = String(guildId);
  const c = String(circleId);
  const next = channels.filter(
    (entry) => !(String(entry.guildId) === g && String(entry.circleId) === c),
  );
  if (next.length === channels.length) return false;
  saveLeaderboardChannels(next);
  return true;
}

export function getAllLeaderboardChannels() {
  return loadLeaderboardChannels();
}

export function removeLeaderboardChannel(guildId, circleId) {
  return removeLeaderboardChannelsForClub(guildId, circleId);
}

export function updateLeaderboardChannelState(guildId, circleId, patch) {
  const channels = loadLeaderboardChannels();
  const g = String(guildId);
  const c = String(circleId);
  const entry = channels.find(
    (item) => String(item.guildId) === g && String(item.circleId) === c,
  );
  if (!entry) return false;

  if (patch.lastUpdatedAt !== undefined) entry.lastUpdatedAt = patch.lastUpdatedAt;
  if (patch.lastDailyKey !== undefined) entry.lastDailyKey = patch.lastDailyKey;
  if (patch.lastEmbedHash !== undefined) entry.lastEmbedHash = patch.lastEmbedHash;
  saveLeaderboardChannels(channels);
  return true;
}

export function isPremiumGuild(guildId) {
  const id = String(guildId);
  if (PREMIUM_GUILD_IDS_ENV.has(id)) return true;
  const store = loadPremiumGuildStore();
  return store.guildIds.map(String).includes(id);
}

export function setGuildPremium(guildId, enabled) {
  const store = loadPremiumGuildStore();
  const id = String(guildId);
  const ids = new Set(store.guildIds.map(String));
  if (enabled) ids.add(id);
  else ids.delete(id);
  store.guildIds = [...ids].sort();
  savePremiumGuildStore(store);
  return enabled;
}

export function getUserLink(discordUserId) {
  const store = loadUserLinks();
  const link = store[String(discordUserId)];
  if (!link) return null;

  return {
    discordUserId: String(link.discordUserId ?? discordUserId),
    viewerId: String(link.viewerId),
    trainerName: link.trainerName,
    circleId: String(link.circleId ?? ''),
    circleName: link.circleName ?? null,
    linkedAt: link.linkedAt ?? null,
    gambaCoins: link.gambaCoins ?? null,
    gambaWr: link.gambaWr ?? null,
    quizAccuracy: link.quizAccuracy ?? null,
  };
}
