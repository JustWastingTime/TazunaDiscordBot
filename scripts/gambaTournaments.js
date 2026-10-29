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

function cleanPayouts(values, slotCount) {
  const source = Array.isArray(values) ? values : [];
  const payouts = [];
  for (let correct = 0; correct <= slotCount; correct += 1) {
    const value = Number(source[correct]);
    payouts.push(Number.isFinite(value) && value > 0 ? Math.min(PICKEM_MAX_MULTIPLIER, value) : 0);
  }
  if (payouts.every((value) => value === 0) && slotCount > 0) payouts[slotCount] = 5;
  return payouts;
}

function cleanAdvanceSlots(raw, eventIds) {
  const slotsIn = Array.isArray(raw) ? raw : [];
  if (slotsIn.length > MAX_RACES) throw httpError(400, `A round can have ${MAX_RACES} advance slots.`);
  const seen = new Set();
  return slotsIn.map((slot, index) => {
    const label = String(slot?.label || '').trim();
    if (!label) throw httpError(400, 'Each advance slot needs a name.');
    const pool = [...new Set((Array.isArray(slot?.eventIds) ? slot.eventIds : []).map((eventId) => String(eventId).trim()).filter(Boolean))];
    if (!pool.length) throw httpError(400, `${label} needs at least one race in its pool.`);
    for (const eventId of pool) {
      if (!eventIds.includes(eventId)) throw httpError(400, `${label} can only use races in this round.`);
    }
    let id = slugify(slot?.id || label, `advance-${index + 1}`);
    const root = id.slice(0, 32);
    let n = 2;
    while (seen.has(id)) {
      id = `${root}-${n}`;
      n += 1;
    }
    seen.add(id);
    return {
      id,
      label,
      eventIds: pool,
      hint: String(slot?.hint || '').trim().slice(0, 120),
    };
  });
}

function cleanAdvanceResults(raw, slots) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const results = {};
  for (const slot of slots) {
    const row = source[slot.id];
    if (!row || typeof row !== 'object') continue;
    const eventId = String(row.eventId || '');
    const entryNumber = Number(row.entryNumber);
    if (!slot.eventIds.includes(eventId) || !Number.isFinite(entryNumber)) continue;
    const event = getEvent(eventId);
    const entry = (event?.entries || []).find((item) => item.number === entryNumber);
    if (!entry) continue;
    results[slot.id] = { eventId, entryNumber, entryName: entry.name };
  }
  return results;
}

export function setAdvanceResults(tournamentId, roundId, results) {
  const store = readStore();
  const index = store.tournaments.findIndex((tournament) => tournament.id === String(tournamentId || ''));
  if (index < 0) throw httpError(404, 'Tournament not found.');
  const tournament = store.tournaments[index];
  const roundIndex = (tournament.rounds || []).findIndex((round) => round.id === String(roundId || ''));
  if (roundIndex < 0) throw httpError(404, 'That round is gone.');
  const round = tournament.rounds[roundIndex];
  const slots = round.advanceSlots || [];
  if (!slots.length) throw httpError(400, 'That round has no advance slots.');
  const cleaned = cleanAdvanceResults(results, slots);
  if (Object.keys(cleaned).length !== slots.length) {
    throw httpError(400, 'Pick the horse that filled every advance slot.');
  }
  tournament.rounds[roundIndex] = { ...round, advanceResults: cleaned };
  store.tournaments[index] = tournament;
  writeStore(store);
  return store.tournaments[index];
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
  const previous = existing.find((tournament) => tournament.id === id);
  const rounds = roundsIn.map((round, index) => {
    const label = String(round?.label || '').trim();
    if (!label) throw httpError(400, 'Each round needs a name.');
    const roundId = slugify(round?.id || label, `round-${index + 1}`);
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
    const advanceSlots = cleanAdvanceSlots(round?.advanceSlots, eventIds);
    const previousRound = (previous?.rounds || []).find((item) => item.id === roundId);
    const incomingResults = round?.advanceResults !== undefined ? round.advanceResults : previousRound?.advanceResults;
    const slotCount = eventIds.length + advanceSlots.length;
    return {
      id: roundId,
      label,
      eventIds,
      advanceSlots,
      advanceResults: cleanAdvanceResults(incomingResults, advanceSlots),
      pickemPayouts: slotCount ? cleanPayouts(round?.pickemPayouts, slotCount) : [0],
    };
  });
  const roundIds = new Set(rounds.map((round) => round.id));
  if (roundIds.size !== rounds.length) throw httpError(400, 'Round names need to be different.');
  return {
    id,
    name,
    rounds,
    posts: Array.isArray(previous?.posts) ? previous.posts : [],
  };
}
