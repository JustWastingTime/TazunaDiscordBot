import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { httpError } from './adminAuth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GUILDS_PATH = path.resolve(__dirname, '..', 'data', 'gamba-guilds.json');

function readStore() {
  try {
    const data = JSON.parse(fs.readFileSync(GUILDS_PATH, 'utf8'));
    return { guilds: Array.isArray(data?.guilds) ? data.guilds : [] };
  } catch (err) {
    if (err.code === 'ENOENT') return { guilds: [] };
    throw err;
  }
}

function writeStore(store) {
  fs.mkdirSync(path.dirname(GUILDS_PATH), { recursive: true });
  fs.writeFileSync(GUILDS_PATH, `${JSON.stringify(store, null, 2)}\n`, 'utf8');
}

function sortGuilds(guilds) {
  return guilds.slice().sort((a, b) => a.label.localeCompare(b.label) || a.id.localeCompare(b.id));
}

function cleanGuild(raw) {
  const id = String(raw?.id || '').trim();
  const label = String(raw?.label || '').trim();
  if (!/^\d{17,20}$/.test(id)) throw httpError(400, 'A guild id is the long number from Discord.');
  if (!label || label.length > 48) throw httpError(400, 'Give the guild a name of 48 characters or fewer.');
  return { id, label };
}

export function listGuildLabels() {
  return sortGuilds(readStore().guilds);
}

export function saveGuildLabels(input) {
  const incoming = Array.isArray(input) ? input : [];
  if (!incoming.length) throw httpError(400, 'Name the guild.');
  const store = readStore();
  for (const raw of incoming) {
    const cleaned = cleanGuild(raw);
    const index = store.guilds.findIndex((guild) => guild.id === cleaned.id);
    if (index >= 0) store.guilds[index] = cleaned;
    else store.guilds.push(cleaned);
  }
  store.guilds = sortGuilds(store.guilds);
  writeStore(store);
  return store.guilds;
}

export function deleteGuildLabel(id) {
  const key = String(id || '').trim();
  if (!/^\d{17,20}$/.test(key)) throw httpError(400, 'A guild id is the long number from Discord.');
  const store = readStore();
  const next = store.guilds.filter((guild) => guild.id !== key);
  if (next.length === store.guilds.length) throw httpError(404, 'That guild is not remembered.');
  store.guilds = next;
  writeStore(store);
  return { ok: true };
}
