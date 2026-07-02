import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getUmaApiKey } from './clubService.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.resolve(__dirname, '..', 'data');
const CACHE_PATH = path.join(DATA_DIR, 'schedule-cache.json');
const UMA_BASE_URL = 'https://uma.moe';
const RESOURCES_ENDPOINT = `${UMA_BASE_URL}/resources`;
const MANIFEST_CHECK_INTERVAL_MS = 5 * 60 * 1000;

const cacheState = {
  loaded: false,
  manifestVersion: '',
  manifestMarker: '',
  manifestSha256: '',
  generatedAt: '',
  lastCheckedAt: 0,
  events: [],
};

function ensureDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function loadDiskCache() {
  if (cacheState.loaded) return;
  cacheState.loaded = true;
  try {
    const parsed = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'));
    cacheState.manifestVersion = String(parsed.manifestVersion || '');
    cacheState.manifestMarker = String(parsed.manifestMarker || '');
    cacheState.manifestSha256 = String(parsed.manifestSha256 || '');
    cacheState.generatedAt = String(parsed.generatedAt || '');
    cacheState.lastCheckedAt = Number(parsed.lastCheckedAt || 0);
    cacheState.events = Array.isArray(parsed.events) ? parsed.events : [];
  } catch (err) {
    if (err?.code !== 'ENOENT') {
      console.warn('[Schedule] Failed to load disk cache:', err.message);
    }
  }
}

function saveDiskCache() {
  ensureDataDir();
  const payload = {
    manifestVersion: cacheState.manifestVersion,
    manifestMarker: cacheState.manifestMarker,
    manifestSha256: cacheState.manifestSha256,
    generatedAt: cacheState.generatedAt,
    lastCheckedAt: cacheState.lastCheckedAt,
    events: cacheState.events,
  };
  fs.writeFileSync(CACHE_PATH, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function getUmaHeaders() {
  const apiKey = getUmaApiKey();
  if (!apiKey) return {};
  return {
    'X-API-Key': apiKey,
    Authorization: `Bearer ${apiKey}`,
  };
}

async function fetchJson(url) {
  const res = await fetch(url, { headers: getUmaHeaders() });
  if (!res.ok) {
    throw new Error(`Request failed (${res.status}) for ${url}`);
  }
  return res.json();
}

function findTimelineResourcePath(manifest) {
  const artifacts = Array.isArray(manifest?.artifacts)
    ? manifest.artifacts
    : Object.values(manifest?.artifacts || {});
  const timeline = artifacts.find((entry) => entry?.name === 'banner_timeline.json');
  if (timeline?.current_path) return timeline.current_path;
  if (timeline?.path) return timeline.path;
  return '/resources/current/banner_timeline.json.gz';
}

function toAbsoluteUmaUrl(maybePath) {
  if (!maybePath) return '';
  if (/^https?:\/\//i.test(maybePath)) return maybePath;
  const clean = String(maybePath).replace(/^\/+/, '');
  return `${UMA_BASE_URL}/${clean}`;
}

function normalizeTimelineEvent(raw, index) {
  const title = String(raw?.title || raw?.event_name || '').trim();
  if (!title) return null;

  const id = String(raw?.id || `${title}:${raw?.global_release_date || index}`);
  const startAt = raw?.global_release_date ? String(raw.global_release_date) : '';
  const endAt = raw?.estimated_end_date ? String(raw.estimated_end_date) : startAt;
  const imageUrl = toAbsoluteUmaUrl(raw?.image_path || raw?.image || '');

  const relatedNames = [
    ...(Array.isArray(raw?.related_characters) ? raw.related_characters : []),
    ...(Array.isArray(raw?.related_support_card_names) ? raw.related_support_card_names : []),
  ];

  const type = String(raw?.type || 'event');
  const source = String(raw?.source || '');
  const tags = Array.isArray(raw?.tags) ? raw.tags : [];
  const searchable = [title, type, source, ...tags, ...relatedNames]
    .join(' ')
    .toLowerCase();

  return {
    id,
    title,
    type,
    source,
    tags,
    startAt,
    endAt,
    isConfirmed: Boolean(raw?.is_confirmed),
    imageUrl,
    searchable,
  };
}

function toTimestamp(iso) {
  if (!iso) return Number.NaN;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : Number.NaN;
}

function overlapsMonth(event, monthStartMs, monthEndMs) {
  const startMs = toTimestamp(event.startAt);
  if (!Number.isFinite(startMs)) return false;
  const endMs = Number.isFinite(toTimestamp(event.endAt)) ? toTimestamp(event.endAt) : startMs;
  return startMs < monthEndMs && endMs >= monthStartMs;
}

function sortEvents(events) {
  return [...events].sort((a, b) => {
    const timeDiff = toTimestamp(a.startAt) - toTimestamp(b.startAt);
    if (timeDiff !== 0) return timeDiff;
    return a.title.localeCompare(b.title);
  });
}

async function refreshScheduleCacheIfNeeded(force = false) {
  loadDiskCache();

  const nowMs = Date.now();
  if (
    !force &&
    cacheState.events.length > 0 &&
    nowMs - cacheState.lastCheckedAt < MANIFEST_CHECK_INTERVAL_MS
  ) {
    return cacheState;
  }

  try {
    const manifest = await fetchJson(RESOURCES_ENDPOINT);
    const manifestVersion = String(manifest?.version || '');
    const manifestMarker = String(manifest?.master?.marker || '');
    const manifestSha256 = String(manifest?.master?.sha256 || '');
    const isSameManifest = (
      manifestVersion &&
      manifestVersion === cacheState.manifestVersion &&
      manifestMarker === cacheState.manifestMarker &&
      manifestSha256 === cacheState.manifestSha256
    );

    cacheState.lastCheckedAt = nowMs;

    if (isSameManifest && cacheState.events.length > 0) {
      saveDiskCache();
      return cacheState;
    }

    const timelinePath = findTimelineResourcePath(manifest);
    const timelineUrl = toAbsoluteUmaUrl(timelinePath);
    const timeline = await fetchJson(timelineUrl);
    const rawEvents = Array.isArray(timeline?.events) ? timeline.events : [];
    const normalized = rawEvents
      .map((event, index) => normalizeTimelineEvent(event, index))
      .filter(Boolean);

    cacheState.manifestVersion = manifestVersion;
    cacheState.manifestMarker = manifestMarker;
    cacheState.manifestSha256 = manifestSha256;
    cacheState.generatedAt = String(manifest?.generated_at || '');
    cacheState.events = sortEvents(normalized);
    saveDiskCache();
  } catch (err) {
    if (cacheState.events.length === 0) throw err;
    console.warn('[Schedule] Using stale cached data:', err.message);
    cacheState.lastCheckedAt = nowMs;
    saveDiskCache();
  }

  return cacheState;
}

export async function getCurrentMonthSchedule(query = '', now = new Date()) {
  const state = await refreshScheduleCacheIfNeeded(false);
  const baseDate = now instanceof Date ? now : new Date(now);
  const monthStartMs = Date.UTC(baseDate.getUTCFullYear(), baseDate.getUTCMonth(), 1);
  const monthEndMs = Date.UTC(baseDate.getUTCFullYear(), baseDate.getUTCMonth() + 1, 1);

  const monthEvents = state.events.filter((event) => overlapsMonth(event, monthStartMs, monthEndMs));
  const terms = String(query || '').trim().toLowerCase().split(/\s+/).filter(Boolean);
  const matches = terms.length === 0
    ? monthEvents
    : monthEvents.filter((event) => terms.every((term) => event.searchable.includes(term)));

  const selected = matches[0] || monthEvents[0] || null;
  const monthLabel = new Intl.DateTimeFormat('en-US', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(baseDate);

  return {
    monthLabel,
    query: String(query || '').trim(),
    monthEvents,
    matches,
    selected,
    generatedAt: state.generatedAt,
  };
}

export async function getCurrentMonthEventById(eventId, now = new Date()) {
  const view = await getCurrentMonthSchedule('', now);
  const selected = view.monthEvents.find((event) => event.id === String(eventId)) || view.monthEvents[0] || null;
  return { ...view, selected };
}

export async function buildScheduleAutocompleteChoices(query = '', limit = 25) {
  const view = await getCurrentMonthSchedule(query);
  const source = view.matches.length > 0 ? view.matches : view.monthEvents;
  return source.slice(0, limit).map((event) => ({
    name: event.title.length > 100 ? `${event.title.slice(0, 97)}...` : event.title,
    value: event.title.length > 100 ? event.title.slice(0, 100) : event.title,
  }));
}
