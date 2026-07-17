import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.resolve(__dirname, '..', 'data');
const EVENTS_DIR = path.resolve(__dirname, '..', 'assets', 'events');
const RUNTIME_PATH = path.join(DATA_DIR, 'event-runtime.json');
const CHANNELS_PATH = path.join(DATA_DIR, 'event-channels.json');
const POSTS_PATH = path.join(DATA_DIR, 'event-posts.json');

let definitionCache = null;
let definitionCacheMtime = 0;

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

function loadRuntimeStore() {
  return readJson(RUNTIME_PATH, {});
}

function saveRuntimeStore(store) {
  writeJson(RUNTIME_PATH, store);
}

function normalizeDefinition(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const entries = Array.isArray(raw.entries) ? raw.entries : raw.horses;
  if (!raw.id || !raw.name || !Array.isArray(entries) || !entries.length) return null;

  const threadIdRaw = raw.threadID ?? raw.threadId ?? raw.thread_id ?? null;
  const threadId = threadIdRaw != null && String(threadIdRaw).trim()
    ? String(threadIdRaw).trim()
    : null;

  return {
    id: String(raw.id),
    name: String(raw.name),
    type: String(raw.type || 'horse_race'),
    status: String(raw.status || 'scheduled'),
    startsAt: raw.startsAt || raw.cutoffAt || null,
    endsAt: raw.endsAt || raw.cutoffAt || null,
    availability: String(raw.availability || 'all'),
    guildIds: Array.isArray(raw.guildIds) ? raw.guildIds.map(String) : [],
    threadId,
    entries: entries.map((entry) => ({
      number: Number(entry.number),
      name: String(entry.name),
      ageSex: entry.ageSex ? String(entry.ageSex) : '',
      jockey: entry.jockey ? String(entry.jockey) : '',
      odds: Number(entry.odds),
    })),
  };
}

function mergeEvent(definition, runtime = {}) {
  const status = runtime.status || definition.status || 'scheduled';
  return {
    ...definition,
    status,
    winner: runtime.winner ?? null,
    settledAt: runtime.settledAt ?? null,
    settlementResults: Array.isArray(runtime.settlementResults) ? runtime.settlementResults : null,
    closedAt: runtime.closedAt ?? null,
    postedAt: runtime.postedAt ?? null,
    entries: definition.entries,
  };
}

function loadDefinitionFiles() {
  if (!fs.existsSync(EVENTS_DIR)) return [];

  const files = fs.readdirSync(EVENTS_DIR).filter((file) => file.endsWith('.json'));
  let latestMtime = 0;
  const definitions = [];

  for (const file of files) {
    const filePath = path.join(EVENTS_DIR, file);
    const stat = fs.statSync(filePath);
    latestMtime = Math.max(latestMtime, stat.mtimeMs);
    const raw = readJson(filePath, null);
    const definition = normalizeDefinition(raw);
    if (definition) definitions.push(definition);
  }

  if (!definitionCache || latestMtime !== definitionCacheMtime) {
    definitionCache = definitions.sort((a, b) => a.id.localeCompare(b.id));
    definitionCacheMtime = latestMtime;
  }

  return definitionCache;
}

export function reloadEventDefinitions() {
  definitionCache = null;
  definitionCacheMtime = 0;
  return loadDefinitionFiles();
}

export function listEventDefinitions() {
  return loadDefinitionFiles();
}

export function getEventDefinition(eventId) {
  return loadDefinitionFiles().find((event) => event.id === String(eventId)) || null;
}

export function resolveEventId(query) {
  const q = String(query || '').trim();
  if (!q) return null;

  const byId = getEventDefinition(q);
  if (byId) return byId.id;

  const lower = q.toLowerCase();
  const events = loadDefinitionFiles();
  const exactName = events.find((event) => event.name.toLowerCase() === lower);
  if (exactName) return exactName.id;

  const partial = events.find(
    (event) =>
      event.id.toLowerCase() === lower || event.name.toLowerCase().includes(lower),
  );
  return partial?.id ?? null;
}

export function getEvent(eventId) {
  const definition = getEventDefinition(eventId);
  if (!definition) return null;
  const runtime = loadRuntimeStore()[String(eventId)] || {};
  return mergeEvent(definition, runtime);
}

export function listEvents() {
  const runtime = loadRuntimeStore();
  return loadDefinitionFiles().map((definition) =>
    mergeEvent(definition, runtime[definition.id] || {}),
  );
}

export function listUnsettledEvents() {
  return listEvents().filter((event) => event.status !== 'settled');
}

export function listSettleableEvents() {
  return listEvents().filter((event) => event.status !== 'settled');
}

export function listCatchUpEvents() {
  return listUnsettledEvents().filter((event) => ['open', 'closed'].includes(event.status));
}

export function isEventAvailableToGuild(event, guildId) {
  if (!event) return false;
  if (event.availability === 'all') return true;
  if (event.availability === 'guilds') {
    return event.guildIds.map(String).includes(String(guildId));
  }
  return true;
}

export function patchEventRuntime(eventId, patch) {
  const store = loadRuntimeStore();
  const key = String(eventId);
  store[key] = {
    ...(store[key] || {}),
    ...patch,
  };
  saveRuntimeStore(store);
  return getEvent(eventId);
}

export function getEventChannels() {
  const data = readJson(CHANNELS_PATH, []);
  return Array.isArray(data) ? data : [];
}

export function setEventChannel(guildId, channelId) {
  const channels = getEventChannels().filter((entry) => String(entry.guildId) !== String(guildId));
  channels.push({
    guildId: String(guildId),
    channelId: String(channelId),
    setAt: new Date().toISOString(),
  });
  writeJson(CHANNELS_PATH, channels);
  return channels[channels.length - 1];
}

export function getEventChannel(guildId) {
  return getEventChannels().find((entry) => String(entry.guildId) === String(guildId)) || null;
}

export function getEligibleEventChannels(event) {
  return getEventChannels().filter((entry) => isEventAvailableToGuild(event, entry.guildId));
}

/**
 * Resolve where an event should be posted/refreshed.
 * If the event defines `threadID`, post into that thread instead of the
 * guild's main event channel. Duplicate destinations are collapsed so a
 * shared thread is only posted once.
 */
export function getEventPostTargets(event) {
  const channels = getEligibleEventChannels(event);
  if (!channels.length) return [];

  const targets = channels.map((entry) => ({
    guildId: String(entry.guildId),
    channelId: String(event.threadId || entry.channelId),
  }));

  const seenChannels = new Set();
  return targets.filter((target) => {
    if (seenChannels.has(target.channelId)) return false;
    seenChannels.add(target.channelId);
    return true;
  });
}

export function resolveEventPostChannelId(event, guildId, fallbackChannelId = null) {
  const post = getEventPost(guildId, event.id);
  if (post?.channelId) return String(post.channelId);
  if (event.threadId) return String(event.threadId);
  if (fallbackChannelId) return String(fallbackChannelId);
  const subscribed = getEventChannel(guildId);
  return subscribed?.channelId ? String(subscribed.channelId) : null;
}

export function getEventPosts() {
  const data = readJson(POSTS_PATH, []);
  return Array.isArray(data) ? data : [];
}

export function saveEventPosts(posts) {
  writeJson(POSTS_PATH, posts);
}

export function getEventPost(guildId, eventId) {
  return (
    getEventPosts().find(
      (entry) =>
        String(entry.guildId) === String(guildId) && String(entry.eventId) === String(eventId),
    ) || null
  );
}

export function upsertEventPost(record) {
  const posts = getEventPosts().filter(
    (entry) =>
      !(
        String(entry.guildId) === String(record.guildId) &&
        String(entry.eventId) === String(record.eventId)
      ),
  );
  posts.push({
    guildId: String(record.guildId),
    eventId: String(record.eventId),
    channelId: String(record.channelId),
    horseMessages: record.horseMessages || [],
    betsMessageId: record.betsMessageId || null,
    updatedAt: new Date().toISOString(),
  });
  saveEventPosts(posts);
  return posts[posts.length - 1];
}
