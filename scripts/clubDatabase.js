import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.resolve(__dirname, '..', 'data');
const GUILD_CLUBS_PATH = path.join(DATA_DIR, 'guild-clubs.json');
const USER_LINKS_PATH = path.join(DATA_DIR, 'user-links.json');

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

export function upsertUserLink({ discordUserId, viewerId, trainerName, circleId, circleName }) {
  const store = loadUserLinks();
  store[String(discordUserId)] = {
    discordUserId: String(discordUserId),
    viewerId: String(viewerId),
    trainerName,
    circleId: String(circleId),
    circleName: circleName ?? null,
    linkedAt: new Date().toISOString(),
  };
  saveUserLinks(store);
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
  };
}
