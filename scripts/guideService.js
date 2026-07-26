import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const GUIDES_PATH = path.resolve(__dirname, '..', 'assets', 'guides.json');

export function loadGuidesFromDisk() {
  try {
    const raw = JSON.parse(fs.readFileSync(GUIDES_PATH, 'utf8'));
    return Array.isArray(raw) ? raw : [];
  } catch (err) {
    if (err?.code === 'ENOENT') return [];
    throw err;
  }
}

export function normalizeGuide(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const id = String(entry.id || '').trim();
  const title = String(entry.title || entry.name || '').trim();
  const filename = String(entry.filename || entry.file || '').trim();
  if (!id || !title || !filename) return null;
  return {
    id,
    title,
    filename,
    aliases: Array.isArray(entry.aliases) ? entry.aliases.map(String) : [],
  };
}

export function getGuides(guidesCache = null) {
  const source = Array.isArray(guidesCache) && guidesCache.length
    ? guidesCache
    : loadGuidesFromDisk();
  return source.map(normalizeGuide).filter(Boolean);
}

export function findGuides(query, guidesCache = null) {
  const guides = getGuides(guidesCache);
  const terms = String(query || '')
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);

  if (!terms.length) return guides;

  return guides.filter((guide) =>
    terms.every(
      (term) =>
        guide.id.toLowerCase().includes(term) ||
        guide.title.toLowerCase().includes(term) ||
        guide.aliases.some((alias) => alias.toLowerCase().includes(term)),
    ),
  );
}

export function findGuideByIdOrQuery(query, guidesCache = null) {
  const guides = getGuides(guidesCache);
  const q = String(query || '').trim().toLowerCase();
  if (!q) return null;

  const byId = guides.find((guide) => guide.id.toLowerCase() === q);
  if (byId) return byId;

  const matches = findGuides(q, guides);
  return matches.length === 1 ? matches[0] : null;
}

export function buildGuideAutocompleteChoices(query, guidesCache = null) {
  const matches = findGuides(query, guidesCache);
  return matches.slice(0, 25).map((guide) => ({
    name: guide.title.length > 100 ? `${guide.title.slice(0, 97)}...` : guide.title,
    value: guide.id,
  }));
}
