import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { httpError } from './adminAuth.js';
import { getEvent } from './eventStorage.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOURNAMENTS_PATH = path.resolve(__dirname, '..', 'data', 'gamba-tournaments.json');
const MAX_ROUNDS = 8;
const MAX_RACES = 12;
const PICKEM_MAX_MULTIPLIER = 20;

function readStore() {
  try {
    const data = JSON.parse(fs.readFileSync(TOURNAMENTS_PATH, 'utf8'));
    return { tournaments: Array.isArray(data?.tournaments) ? data.tournaments : [] };
  } catch (err) {
    if (err.code === 'ENOENT') return { tournaments: [] };
    throw err;
  }
}

function writeStore(store) {
  fs.mkdirSync(path.dirname(TOURNAMENTS_PATH), { recursive: true });
  fs.writeFileSync(TOURNAMENTS_PATH, `${JSON.stringify(store, null, 2)}\n`, 'utf8');
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

export function listTournaments() {
  return readStore().tournaments;
}

export function getTournament(id) {
  const key = String(id || '');
  return listTournaments().find((tournament) => tournament.id === key) || null;
}

export function tournamentsUsingEvent(eventId) {
  const key = String(eventId || '');
  return listTournaments().filter((tournament) =>
    (tournament.rounds || []).some((round) => (round.eventIds || []).map(String).includes(key)),
  );
}

export function saveTournament(input) {
  const store = readStore();
  const cleaned = cleanTournament(input, store.tournaments);
  const index = store.tournaments.findIndex((tournament) => tournament.id === cleaned.id);
  if (index >= 0) store.tournaments[index] = cleaned;
  else store.tournaments.push(cleaned);
  writeStore(store);
  return cleaned;
}

export function rememberTournamentPosts(id, posts) {
  const store = readStore();
  const index = store.tournaments.findIndex((tournament) => tournament.id === String(id || ''));
  if (index < 0) throw httpError(404, 'Tournament not found.');
  store.tournaments[index] = {
    ...store.tournaments[index],
    posts: Array.isArray(posts) ? posts : [],
  };
  writeStore(store);
  return store.tournaments[index];
}

export function deleteTournament(id) {
  const store = readStore();
  const key = String(id || '');
  const next = store.tournaments.filter((tournament) => tournament.id !== key);
  if (next.length === store.tournaments.length) throw httpError(404, 'Tournament not found.');
  store.tournaments = next;
  writeStore(store);
  return { ok: true };
}

function cleanPayouts(values, raceCount) {
  const source = Array.isArray(values) ? values : [];
  const payouts = [];
  for (let correct = 0; correct <= raceCount; correct += 1) {
    const value = Number(source[correct]);
    payouts.push(Number.isFinite(value) && value > 0 ? Math.min(PICKEM_MAX_MULTIPLIER, value) : 0);
  }
  if (payouts.every((value) => value === 0)) payouts[raceCount] = 5;
  return payouts;
}

function cleanTournament(input, existing) {
  const source = input && typeof input === 'object' ? input : {};
  const name = String(source.name || '').trim();
  if (!name) throw httpError(400, 'Tournament needs a name.');
  const requested = slugify(source.id, '');
  const taken = new Set(existing.map((tournament) => tournament.id).filter((id) => id !== requested));
  let id = requested || slugify(name, 'tournament');
  const root = id.slice(0, 36);
  let n = 2;
  while (taken.has(id)) {
    id = `${root}-${n}`;
    n += 1;
    if (n > 40) throw httpError(400, 'Could not name that tournament.');
  }
  if (!/^[a-z0-9][a-z0-9-]{0,40}$/.test(id)) throw httpError(400, 'Tournament id should be short letters and numbers.');

  const roundsIn = Array.isArray(source.rounds) ? source.rounds : [];
  if (!roundsIn.length || roundsIn.length > MAX_ROUNDS) {
    throw httpError(400, `A tournament needs 1 to ${MAX_ROUNDS} rounds.`);
  }
  const usedEvents = new Set();
  const claimedElsewhere = new Set();
  for (const tournament of existing) {
    if (tournament.id === id) continue;
    for (const round of tournament.rounds || []) {
      for (const eventId of round.eventIds || []) claimedElsewhere.add(String(eventId));
    }
  }
  const rounds = roundsIn.map((round, index) => {
    const label = String(round?.label || '').trim();
    if (!label) throw httpError(400, 'Each round needs a name.');
    const eventIds = [...new Set((Array.isArray(round?.eventIds) ? round.eventIds : []).map((eventId) => String(eventId).trim()).filter(Boolean))];
    if (eventIds.length > MAX_RACES) throw httpError(400, `${label} can hold ${MAX_RACES} races.`);
    for (const eventId of eventIds) {
      const event = getEvent(eventId);
      if (!event) throw httpError(400, `Unknown race ${eventId}.`);
      if (event.availability !== 'web' || event.listing !== 'tournament') {
        throw httpError(400, `${event.name} is a board race. Create it as a tournament race instead.`);
      }
      if (usedEvents.has(eventId)) throw httpError(400, 'A race can only sit in one round.');
      if (claimedElsewhere.has(eventId)) throw httpError(400, `${event.name} is already in another tournament.`);
      usedEvents.add(eventId);
    }
    return {
      id: slugify(round?.id || label, `round-${index + 1}`),
      label,
      eventIds,
      pickemPayouts: eventIds.length ? cleanPayouts(round?.pickemPayouts, eventIds.length) : [0],
    };
  });
  const roundIds = new Set(rounds.map((round) => round.id));
  if (roundIds.size !== rounds.length) throw httpError(400, 'Round names need to be different.');
  const previous = existing.find((tournament) => tournament.id === id);
  return {
    id,
    name,
    rounds,
    posts: Array.isArray(previous?.posts) ? previous.posts : [],
  };
}
