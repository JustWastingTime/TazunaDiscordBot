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
    targetTier: club.targetTier ?? null,
  }));
}

export function setGuildClubTarget(guildId, circleId, targetTier) {
  const store = loadGuildClubs();
  const key = String(guildId);
  const clubs = Array.isArray(store[key]) ? store[key] : [];
  const club = clubs.find((item) => String(item.circleId) === String(circleId));
  if (!club) return false;

  club.targetTier = String(targetTier).trim();
  saveGuildClubs(store);
  return true;
}

export function getGuildClubTarget(guildId, circleId) {
  const clubs = getGuildClubs(guildId);
  const club = clubs.find((item) => String(item.circleId) === String(circleId));
  return club?.targetTier ?? null;
}

export function isGuildClubRegistered(guildId, circleId) {
  return getGuildClubs(guildId).some((club) => String(club.circleId) === String(circleId));
}

function mergeGuildIds(existingGuildIds, ...guildIds) {
  const merged = new Set(
    (Array.isArray(existingGuildIds) ? existingGuildIds : [])
      .map((guildId) => String(guildId))
      .filter(Boolean),
  );
  for (const guildId of guildIds) {
    if (guildId != null && guildId !== '') merged.add(String(guildId));
  }
  return [...merged];
}

function trackUserGuildActivity(user, guildId) {
  if (!user || guildId == null || guildId === '') return;
  user.activeGuildIds = mergeGuildIds(user.activeGuildIds, guildId);
}

export const STARTING_GAMBA_COINS = 1000;

export function upsertUserLink({
  discordUserId,
  viewerId,
  trainerName,
  circleId,
  circleName,
  registeredGuildId = null,
}) {
  const store = loadUserLinks();
  const key = String(discordUserId);
  const existing = store[key];

  const registeredGid =
    registeredGuildId != null && registeredGuildId !== ''
      ? String(registeredGuildId)
      : (existing?.registeredGuildId ?? null);

  store[key] = {
    discordUserId: key,
    viewerId: String(viewerId),
    trainerName,
    umaTrainerName: trainerName,
    circleId: String(circleId),
    circleName: circleName ?? null,
    linkedAt: existing?.linkedAt ?? new Date().toISOString(),
    registeredGuildId: registeredGid,
    activeGuildIds: mergeGuildIds(existing?.activeGuildIds, registeredGid),
    gambaCoins: existing?.gambaCoins ?? STARTING_GAMBA_COINS,
    gambaWr: existing?.gambaWr ?? null,
    gambaWins: existing?.gambaWins ?? 0,
    gambaLosses: existing?.gambaLosses ?? 0,
    openTickets: existing?.openTickets ?? [],
    betHistory: existing?.betHistory ?? [],
    quizCorrect: existing?.quizCorrect ?? 0,
    quizWrong: existing?.quizWrong ?? 0,
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

export function upsertLeaderboardChannel({
  guildId,
  circleId,
  channelId,
  messageId,
  circleLastUpdated = null,
  embedHash = null,
}) {
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
    lastUpdatedAt: Date.now(),
    lastDailyKey: null,
    lastEmbedHash: embedHash,
    lastCircleUpdatedAt: circleLastUpdated,
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
  if (patch.lastCircleUpdatedAt !== undefined) entry.lastCircleUpdatedAt = patch.lastCircleUpdatedAt;
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

function formatQuizAccuracy(correct, wrong) {
  const total = (correct || 0) + (wrong || 0);
  if (total <= 0) return null;
  const pct = Math.round((correct / total) * 100);
  return `${pct}% (${correct}/${total})`;
}

export function formatGambaWr(wins, losses) {
  const total = (wins || 0) + (losses || 0);
  if (total <= 0) return null;
  const pct = Math.round((wins / total) * 100);
  return `${pct}% (${wins}/${total})`;
}

function normalizeUserRecord(link, discordUserId) {
  return {
    discordUserId: String(link.discordUserId ?? discordUserId),
    viewerId: link.viewerId != null && link.viewerId !== '' ? String(link.viewerId) : null,
    trainerName: link.trainerName ?? null,
    umaTrainerName: link.umaTrainerName ?? null,
    circleId: link.circleId != null ? String(link.circleId) : '',
    circleName: link.circleName ?? null,
    linkedAt: link.linkedAt ?? null,
    registeredGuildId: link.registeredGuildId ?? null,
    activeGuildIds: Array.isArray(link.activeGuildIds)
      ? link.activeGuildIds.map(String)
      : [],
    gambaCoins: link.gambaCoins ?? null,
    gambaWr: link.gambaWr ?? null,
    gambaWins: link.gambaWins ?? 0,
    gambaLosses: link.gambaLosses ?? 0,
    openTickets: Array.isArray(link.openTickets) ? link.openTickets : [],
    betHistory: Array.isArray(link.betHistory) ? link.betHistory : [],
    quizCorrect: link.quizCorrect ?? 0,
    quizWrong: link.quizWrong ?? 0,
    quizAccuracy: link.quizAccuracy ?? null,
  };
}

export function isUmaLinked(link) {
  return Boolean(link?.viewerId);
}

export function getUserLink(discordUserId) {
  const store = loadUserLinks();
  const link = store[String(discordUserId)];
  if (!link) return null;
  return normalizeUserRecord(link, discordUserId);
}

export function getUserLinkByViewerId(viewerId) {
  const id = String(viewerId ?? '').trim();
  if (!id) return null;

  const store = loadUserLinks();
  for (const [discordUserId, link] of Object.entries(store)) {
    if (String(link.viewerId) === id) {
      return normalizeUserRecord(link, discordUserId);
    }
  }
  return null;
}

export function buildFestProfileData(link) {
  if (!link) return null;
  return {
    gambaCoins: link.gambaCoins,
    gambaWr: link.gambaWr,
    quizAccuracy: link.quizAccuracy,
    openTickets: link.openTickets,
    betHistory: link.betHistory,
  };
}

export function getGambaDisplayName(entry) {
  return entry?.umaTrainerName || entry?.trainerName || 'Trainer';
}

export function setUmaTrainerName(discordUserId, trainerName) {
  const name = String(trainerName || '').trim();
  if (!name) return null;

  const store = loadUserLinks();
  const key = String(discordUserId);
  const user = store[key];
  if (!user) return null;

  user.umaTrainerName = name;
  user.trainerName = name;
  saveUserLinks(store);
  return normalizeUserRecord(user, key);
}

export function ensureQuizUser(discordUserId, displayName, guildId = null) {
  const store = loadUserLinks();
  const key = String(discordUserId);
  const existing = store[key];
  const isNew = !existing;

  if (!existing) {
    store[key] = {
      discordUserId: key,
      viewerId: null,
      trainerName: displayName || 'Trainer',
      umaTrainerName: null,
      circleId: '',
      circleName: null,
      linkedAt: new Date().toISOString(),
      registeredGuildId: guildId ? String(guildId) : null,
      activeGuildIds: mergeGuildIds([], guildId),
      gambaCoins: STARTING_GAMBA_COINS,
      gambaWr: null,
      gambaWins: 0,
      gambaLosses: 0,
      openTickets: [],
      betHistory: [],
      quizCorrect: 0,
      quizWrong: 0,
      quizAccuracy: null,
    };
  } else {
    trackUserGuildActivity(existing, guildId);
    if (displayName && !isUmaLinked(existing)) existing.trainerName = displayName;
    if (guildId && !existing.registeredGuildId) existing.registeredGuildId = String(guildId);
    if (existing.quizCorrect == null) existing.quizCorrect = 0;
    if (existing.quizWrong == null) existing.quizWrong = 0;
    if (existing.gambaWins == null) existing.gambaWins = 0;
    if (existing.gambaLosses == null) existing.gambaLosses = 0;
    if (!Array.isArray(existing.openTickets)) existing.openTickets = [];
    if (!Array.isArray(existing.betHistory)) existing.betHistory = [];
  }

  saveUserLinks(store);
  const link = normalizeUserRecord(store[key], key);
  return { isNew, link, umaLinked: isUmaLinked(link) };
}

export function recordQuizAnswer(discordUserId, correct) {
  const store = loadUserLinks();
  const key = String(discordUserId);
  const user = store[key];
  if (!user) return null;

  if (correct) user.quizCorrect = (user.quizCorrect || 0) + 1;
  else user.quizWrong = (user.quizWrong || 0) + 1;

  user.quizAccuracy = formatQuizAccuracy(user.quizCorrect, user.quizWrong);
  saveUserLinks(store);
  return normalizeUserRecord(user, key);
}

export function addGambaCoins(discordUserId, amount) {
  const store = loadUserLinks();
  const key = String(discordUserId);
  const user = store[key];
  if (!user) return null;

  const delta = Math.trunc(amount);
  if (!Number.isFinite(delta) || delta <= 0) return normalizeUserRecord(user, key);

  user.gambaCoins = (user.gambaCoins ?? 0) + delta;
  saveUserLinks(store);
  return { link: normalizeUserRecord(user, key), added: delta };
}

export const BEG_DONATION_AMOUNTS = [5, 10, 25, 50];

export function listGambaWalletUsers() {
  const store = loadUserLinks();
  return Object.entries(store).map(([discordUserId, link]) =>
    normalizeUserRecord(link, discordUserId),
  );
}

export function hasGambaWallet(discordUserId) {
  return Boolean(getUserLink(discordUserId));
}

function matchesGambaGuildScope(entry, guildId) {
  const gid = String(guildId);
  if (entry.registeredGuildId === gid) return true;
  if (entry.activeGuildIds?.includes(gid)) return true;

  const circleId = entry.circleId;
  if (!circleId) return false;

  return getGuildClubs(gid).some((club) => String(club.circleId) === String(circleId));
}

export function findGambaPlayersByName(query, { guildId = null } = {}) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return [];

  let entries = listGambaWalletUsers();
  if (guildId) {
    entries = entries.filter((entry) => matchesGambaGuildScope(entry, guildId));
  }

  const exact = entries.filter(
    (entry) => getGambaDisplayName(entry).toLowerCase() === q,
  );
  if (exact.length) return exact;

  return entries.filter((entry) =>
    getGambaDisplayName(entry).toLowerCase().includes(q),
  );
}

export function transferGambaCoins(fromId, toId, amount) {
  const delta = Math.trunc(amount);
  if (!Number.isFinite(delta) || delta <= 0) {
    return { ok: false, error: 'Amount must be a positive whole number.' };
  }
  if (String(fromId) === String(toId)) {
    return { ok: false, error: 'You cannot give coins to yourself.' };
  }

  const store = loadUserLinks();
  const fromKey = String(fromId);
  const toKey = String(toId);
  const sender = store[fromKey];
  const recipient = store[toKey];

  if (!sender) return { ok: false, error: 'Register first with `/register` or join a quiz to get a wallet.' };
  if (!recipient) return { ok: false, error: 'That player does not have a GambaCoin wallet yet.' };

  const balance = sender.gambaCoins ?? 0;
  if (delta > balance) {
    return {
      ok: false,
      error: `Not enough coins. You have **${balance.toLocaleString('en-US')}**.`,
    };
  }

  sender.gambaCoins = balance - delta;
  recipient.gambaCoins = (recipient.gambaCoins ?? 0) + delta;
  saveUserLinks(store);

  return {
    ok: true,
    amount: delta,
    sender: normalizeUserRecord(sender, fromKey),
    recipient: normalizeUserRecord(recipient, toKey),
  };
}

export function awardGambaCoins(discordUserId, amount) {
  const delta = Math.trunc(amount);
  if (!Number.isFinite(delta) || delta <= 0) {
    return { ok: false, error: 'Amount must be a positive whole number.' };
  }

  const store = loadUserLinks();
  const key = String(discordUserId);
  const user = store[key];
  if (!user) {
    return { ok: false, error: 'That user does not have a GambaCoin wallet yet.' };
  }

  user.gambaCoins = (user.gambaCoins ?? 0) + delta;
  saveUserLinks(store);

  return {
    ok: true,
    amount: delta,
    recipient: normalizeUserRecord(user, key),
  };
}

export function getGambaLeaderboard({ guildId = null, limit = 25 } = {}) {
  let entries = listGambaWalletUsers().filter((entry) => entry.gambaCoins != null);
  if (guildId) {
    entries = entries.filter((entry) => matchesGambaGuildScope(entry, guildId));
  }

  return entries
    .sort(
      (a, b) =>
        (b.gambaCoins ?? 0) - (a.gambaCoins ?? 0) ||
        String(getGambaDisplayName(a)).localeCompare(String(getGambaDisplayName(b)), undefined, {
          sensitivity: 'base',
        }),
    )
    .slice(0, limit);
}

export function getGambaUserRank(discordUserId, { guildId = null } = {}) {
  const board = getGambaLeaderboard({ guildId, limit: Number.MAX_SAFE_INTEGER });
  const idx = board.findIndex((entry) => entry.discordUserId === String(discordUserId));
  return idx >= 0 ? idx + 1 : null;
}

export function updateUserBettingState(discordUserId, patch) {
  const store = loadUserLinks();
  const key = String(discordUserId);
  const user = store[key];
  if (!user) return null;

  if (patch.trainerName) user.trainerName = patch.trainerName;
  if (patch.gambaCoins != null) user.gambaCoins = patch.gambaCoins;
  if (patch.openTickets) user.openTickets = patch.openTickets;
  if (patch.betHistory) user.betHistory = patch.betHistory;

  saveUserLinks(store);
  return normalizeUserRecord(user, key);
}

export function loadAllUsersForSettlement() {
  const store = loadUserLinks();
  return Object.fromEntries(
    Object.entries(store).map(([discordUserId, link]) => [
      discordUserId,
      normalizeUserRecord(link, discordUserId),
    ]),
  );
}

export function saveAllUsersFromSettlement(usersById) {
  const store = loadUserLinks();
  for (const [discordUserId, user] of Object.entries(usersById)) {
    if (!store[discordUserId]) continue;
    store[discordUserId].gambaCoins = user.gambaCoins;
    store[discordUserId].openTickets = user.openTickets || [];
    store[discordUserId].betHistory = user.betHistory || [];
    store[discordUserId].gambaWins = user.gambaWins ?? 0;
    store[discordUserId].gambaLosses = user.gambaLosses ?? 0;
    store[discordUserId].gambaWr = user.gambaWr ?? null;
    if (user.trainerName) store[discordUserId].trainerName = user.trainerName;
  }
  saveUserLinks(store);
}
