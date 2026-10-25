import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { httpError } from './adminAuth.js';
import { getEvent } from './eventStorage.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CHAINS_PATH = path.resolve(__dirname, '..', 'data', 'gamba-chains.json');

function readStore() {
  try {
    const data = JSON.parse(fs.readFileSync(CHAINS_PATH, 'utf8'));
    return { chains: Array.isArray(data?.chains) ? data.chains : [] };
  } catch (err) {
    if (err.code === 'ENOENT') return { chains: [] };
    throw err;
  }
}

function writeStore(store) {
  fs.mkdirSync(path.dirname(CHAINS_PATH), { recursive: true });
  fs.writeFileSync(CHAINS_PATH, `${JSON.stringify(store, null, 2)}\n`, 'utf8');
}

function slugify(value, fallback) {
  const base = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
  return base || fallback;
}

export function listChains() {
  return readStore().chains;
}

export function getChain(id) {
  const key = String(id || '');
  return listChains().find((chain) => chain.id === key) || null;
}

export function saveChain(input) {
  const store = readStore();
  const cleaned = cleanChain(input, store.chains);
  const index = store.chains.findIndex((chain) => chain.id === cleaned.id);
  if (index >= 0) store.chains[index] = cleaned;
  else store.chains.push(cleaned);
  writeStore(store);
  return cleaned;
}

export function deleteChain(id) {
  const store = readStore();
  const key = String(id || '');
  const next = store.chains.filter((chain) => chain.id !== key);
  if (next.length === store.chains.length) throw httpError(404, 'Meet not found.');
  store.chains = next;
  writeStore(store);
  return { ok: true };
}

function cleanChain(input, existing) {
  const source = input && typeof input === 'object' ? input : {};
  const name = String(source.name || '').trim();
  if (!name) throw httpError(400, 'Meet needs a name.');
  const requested = slugify(source.id, '');
  const taken = new Set(existing.map((chain) => chain.id).filter((chainId) => chainId !== requested));
  let id = requested || slugify(name, 'meet');
  const root = id.slice(0, 36);
  let n = 2;
  while (taken.has(id)) {
    id = `${root}-${n}`;
    n += 1;
    if (n > 40) throw httpError(400, 'Could not name that meet.');
  }
  if (!/^[a-z0-9][a-z0-9-]{0,40}$/.test(id)) throw httpError(400, 'Meet id should be short letters and numbers.');

  const stagesIn = Array.isArray(source.stages) ? source.stages : [];
  if (stagesIn.length < 2 || stagesIn.length > 6) {
    throw httpError(400, 'A meet needs 2 to 6 stages.');
  }
  const usedEvents = new Set();
  const stages = stagesIn.map((stage, index) => {
    const label = String(stage?.label || '').trim();
    if (!label) throw httpError(400, 'Each stage needs a name.');
    const eventIds = [...new Set((Array.isArray(stage?.eventIds) ? stage.eventIds : []).map((eventId) => String(eventId).trim()).filter(Boolean))];
    if (!eventIds.length) throw httpError(400, `${label} needs at least one race.`);
    for (const eventId of eventIds) {
      if (!getEvent(eventId)) throw httpError(400, `Unknown race ${eventId}.`);
      if (usedEvents.has(eventId)) throw httpError(400, 'A race can only sit in one stage.');
      usedEvents.add(eventId);
    }
    return {
      id: slugify(stage?.id || label, `stage-${index + 1}`),
      label,
      eventIds,
    };
  });
  const stageIds = new Set(stages.map((stage) => stage.id));
  if (stageIds.size !== stages.length) throw httpError(400, 'Stage names need to be different.');
  return { id, name, stages };
}
