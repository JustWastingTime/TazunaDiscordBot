// Bracket pick'em: a free game that lives only on the dashboard (/gamba/brackets).
// Players fill in a whole double-elimination bracket before it locks; owners
// enter results match by match and everyone is scored per correct pick.
// Nothing here posts to Discord.
import fs from 'fs';
import path from 'path';
import { DATA_DIR } from './dataDir.js';
import { httpError } from './adminAuth.js';

const BRACKETS_PATH = path.join(DATA_DIR, 'gamba-brackets.json');
export const BRACKET_SIZES = [4, 8, 16];
const MAX_POINTS = 100;
const MAX_CARROTS = 10000;
const MAX_NAME = 60;
const MAX_TEAM_NAME = 40;

// ---------------------------------------------------------------------------
// Storage

function readStore() {
  try {
    const data = JSON.parse(fs.readFileSync(BRACKETS_PATH, 'utf8'));
    return { brackets: Array.isArray(data?.brackets) ? data.brackets : [] };
  } catch (err) {
    if (err.code === 'ENOENT') return { brackets: [] };
    throw err;
  }
}

function writeStore(store) {
  fs.mkdirSync(path.dirname(BRACKETS_PATH), { recursive: true });
  const tmp = `${BRACKETS_PATH}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(store, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, BRACKETS_PATH);
}

function updateBracket(id, change) {
  const store = readStore();
  const index = store.brackets.findIndex((bracket) => bracket.id === String(id || ''));
  if (index < 0) throw httpError(404, 'That bracket is gone.');
  const next = change(structuredClone(store.brackets[index]));
  store.brackets[index] = next;
  writeStore(store);
  return next;
}

export function listBrackets() {
  return readStore().brackets;
}

export function getBracket(id) {
  const key = String(id || '');
  return listBrackets().find((bracket) => bracket.id === key) || null;
}

export function deleteBracket(id) {
  const store = readStore();
  const key = String(id || '');
  const next = store.brackets.filter((bracket) => bracket.id !== key);
  if (next.length === store.brackets.length) throw httpError(404, 'That bracket is gone.');
  store.brackets = next;
  writeStore(store);
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Structure

/**
 * Double elimination for 4, 8 or 16 teams. Teams meet in seed order
 * (1 v 2, 3 v 4, ...). Matches are numbered in play order, and losers that
 * drop from the upper bracket take the top slot of their lower match.
 * For 8 teams this is: upper 1-4, lower 5-6, upper 7-8, lower 9-10,
 * upper final 11, lower 12, lower final 13, grand final 14.
 */
export function buildDoubleElimination(teamIds) {
  const size = teamIds.length;
  if (!BRACKET_SIZES.includes(size)) throw httpError(400, `A bracket needs ${BRACKET_SIZES.join(', ')} teams.`);
  const upperRounds = Math.log2(size);
  const matches = [];
  const upper = []; // upper[r] = match ids in upper round r (1-based)
  const lower = []; // lower[r] = match ids in lower round r (1-based)
  const add = (side, round, slots) => {
    const number = matches.length + 1;
    const id = `m${number}`;
    matches.push({ id, number, side, round, slots });
    return id;
  };
  const team = (teamId) => ({ type: 'team', teamId });
  const winner = (matchId) => ({ type: 'winner', matchId });
  const loser = (matchId) => ({ type: 'loser', matchId });
  const pairs = (list, make) => {
    const out = [];
    for (let i = 0; i < list.length; i += 2) out.push(make(list[i], list[i + 1]));
    return out;
  };

  const lowerRound = (round) => {
    if (round === 1) {
      // Losers of upper round 1 play each other.
      lower[1] = pairs(upper[1], (a, b) => add('lower', 1, [loser(a), loser(b)]));
    } else if (round % 2 === 0) {
      // Losers dropping from upper round (round / 2 + 1) meet the lower winners.
      // Every other drop is reversed so early opponents don't meet again straight away.
      const drops = [...upper[round / 2 + 1]];
      if ((round / 2) % 2 === 1) drops.reverse();
      lower[round] = lower[round - 1].map((prev, i) => add('lower', round, [loser(drops[i]), winner(prev)]));
    } else {
      lower[round] = pairs(lower[round - 1], (a, b) => add('lower', round, [winner(a), winner(b)]));
    }
  };

  upper[1] = pairs(teamIds, (a, b) => add('upper', 1, [team(a), team(b)]));
  lowerRound(1);
  for (let r = 2; r <= upperRounds; r += 1) {
    upper[r] = pairs(upper[r - 1], (a, b) => add('upper', r, [winner(a), winner(b)]));
    if (r > 2) lowerRound(2 * r - 3);
    lowerRound(2 * r - 2);
  }
  const lowerRounds = 2 * (upperRounds - 1);
  add('final', 1, [winner(upper[upperRounds][0]), winner(lower[lowerRounds][0])]);

  const upperFinal = upper[upperRounds][0];
  const lowerFinal = lower[lowerRounds][0];
  return matches.map((match) => ({
    ...match,
    label: matchLabel(match, { upperRounds, lowerRounds, upperFinal, lowerFinal }),
    points: defaultPoints(match, { upperFinal, lowerFinal }),
  }));
}

function matchLabel(match, { upperRounds, lowerRounds, upperFinal, lowerFinal }) {
  if (match.side === 'final') return 'Grand final';
  if (match.id === upperFinal) return 'Upper final';
  if (match.id === lowerFinal) return 'Lower final';
  if (match.side === 'upper') return upperRounds > 1 ? `Upper round ${match.round}` : 'Upper final';
  return lowerRounds > 1 ? `Lower round ${match.round}` : 'Lower final';
}

function defaultPoints(match, { upperFinal, lowerFinal }) {
  if (match.side === 'final') return 3;
  if (match.id === upperFinal || match.id === lowerFinal) return 2;
  return 1;
}

// ---------------------------------------------------------------------------
// Resolving who plays where

function matchById(bracket) {
  return new Map((bracket.matches || []).map((match) => [match.id, match]));
}

/**
 * Who sits in each slot of a match, given a map of match id -> winning team id.
 * The map can be real results or a player's picks. Unknown slots are null.
 */
export function slotTeams(bracket, winners, matchId, byId = matchById(bracket)) {
  const match = byId.get(matchId);
  if (!match) return [null, null];
  return match.slots.map((slot) => resolveSlot(bracket, winners, slot, byId));
}

function resolveSlot(bracket, winners, slot, byId) {
  if (!slot) return null;
  if (slot.type === 'team') return slot.teamId || null;
  const won = winners?.[slot.matchId] || null;
  if (slot.type === 'winner') return won;
  if (slot.type === 'loser') {
    if (!won) return null;
    const [a, b] = slotTeams(bracket, winners, slot.matchId, byId);
    if (won === a) return b;
    if (won === b) return a;
    return null;
  }
  return null;
}

/**
 * Drop any winner that is no longer one of the two teams in its match, in play
 * order, so a changed early pick clears the later picks that depended on it.
 */
export function cleanWinners(bracket, winners) {
  const byId = matchById(bracket);
  const clean = {};
  const ordered = [...(bracket.matches || [])].sort((a, b) => a.number - b.number);
  for (const match of ordered) {
    const pick = winners?.[match.id];
    if (!pick) continue;
    const teams = slotTeams(bracket, clean, match.id, byId);
    if (teams.includes(String(pick))) clean[match.id] = String(pick);
  }
  return clean;
}

/** Can this team still end up in that slot, given the real results so far? */
function canReach(bracket, results, slot, teamId, byId) {
  if (slot.type === 'team') return slot.teamId === teamId;
  const done = results[slot.matchId];
  const source = byId.get(slot.matchId);
  if (!source) return false;
  if (slot.type === 'winner') {
    if (done) return done === teamId;
    return source.slots.some((inner) => canReach(bracket, results, inner, teamId, byId));
  }
  if (done) return resolveSlot(bracket, results, slot, byId) === teamId;
  return source.slots.some((inner) => canReach(bracket, results, inner, teamId, byId));
}

/**
 * Score a player's picks against the real results.
 * status per match: correct, wrong, dead (that team can no longer play it), open, none.
 */
export function scorePicks(bracket, picks) {
  const byId = matchById(bracket);
  const results = bracket.results || {};
  let points = 0;
  let correct = 0;
  let wrong = 0;
  let maxPoints = 0;
  const status = {};
  for (const match of bracket.matches || []) {
    const pick = picks?.[match.id] || null;
    const result = results[match.id] || null;
    const worth = Number(match.points) || 0;
    if (!pick) {
      status[match.id] = result ? 'wrong' : 'none';
      if (result) wrong += 1;
      continue;
    }
    if (result) {
      if (result === pick) {
        status[match.id] = 'correct';
        points += worth;
        maxPoints += worth;
        correct += 1;
      } else {
        status[match.id] = 'wrong';
        wrong += 1;
      }
      continue;
    }
    const alive = match.slots.some((slot) => canReach(bracket, results, slot, pick, byId));
    status[match.id] = alive ? 'open' : 'dead';
    if (alive) maxPoints += worth;
  }
  return { points, correct, wrong, maxPoints, status };
}

export function isLocked(bracket, now = Date.now()) {
  if (bracket.locked) return true;
  if (Object.keys(bracket.results || {}).length) return true;
  const at = Date.parse(bracket.locksAt || '');
  return Number.isFinite(at) && now >= at;
}

export function bracketStatus(bracket, now = Date.now()) {
  const final = (bracket.matches || []).find((match) => match.side === 'final');
  if (final && bracket.results?.[final.id]) return 'finished';
  return isLocked(bracket, now) ? 'locked' : 'open';
}

export function champion(bracket) {
  const final = (bracket.matches || []).find((match) => match.side === 'final');
  return final ? bracket.results?.[final.id] || null : null;
}

// ---------------------------------------------------------------------------
// Owner edits

function slugify(value, fallback) {
  const base = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
  return base || fallback;
}

function cleanText(value, max) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function cleanLockTime(value) {
  if (value == null || value === '') return null;
  const at = Date.parse(String(value));
  if (!Number.isFinite(at)) throw httpError(400, 'That lock time is not a date.');
  return new Date(at).toISOString();
}

/**
 * Create or edit a bracket. Teams and points can change until the first pick
 * comes in; after that only the names, lock time and points can change, so
 * nobody's picks point at a team that moved.
 */
export function saveBracket(input) {
  const source = input && typeof input === 'object' ? input : {};
  const store = readStore();
  const name = cleanText(source.name, MAX_NAME);
  if (!name) throw httpError(400, 'Give the bracket a name.');

  const previous = source.id ? store.brackets.find((bracket) => bracket.id === String(source.id)) : null;
  if (source.id && !previous) throw httpError(404, 'That bracket is gone.');

  const teamsIn = Array.isArray(source.teams) ? source.teams : [];
  if (!BRACKET_SIZES.includes(teamsIn.length)) {
    throw httpError(400, `A bracket needs ${BRACKET_SIZES.join(', ')} teams.`);
  }
  const teamNames = teamsIn.map((team) => cleanText(typeof team === 'string' ? team : team?.name, MAX_TEAM_NAME));
  if (teamNames.some((teamName) => !teamName)) throw httpError(400, 'Every team needs a name.');
  const lowered = teamNames.map((teamName) => teamName.toLowerCase());
  if (new Set(lowered).size !== lowered.length) throw httpError(400, 'Team names need to be different.');

  const hasEntries = Object.keys(previous?.entries || {}).length > 0;
  let teams;
  let matches;
  if (previous && hasEntries) {
    if (teamNames.length !== previous.teams.length) {
      throw httpError(400, 'People already made picks, so the number of teams can not change.');
    }
    // Keep team ids (and so everyone's picks); only the names change.
    teams = previous.teams.map((team, index) => ({ ...team, name: teamNames[index] }));
    matches = previous.matches;
  } else {
    teams = teamNames.map((teamName, index) => ({ id: `t${index + 1}`, name: teamName, seed: index + 1 }));
    matches = buildDoubleElimination(teams.map((team) => team.id));
  }

  const pointsIn = source.points && typeof source.points === 'object' ? source.points : {};
  const carrotsIn = source.carrots && typeof source.carrots === 'object' ? source.carrots : {};
  matches = matches.map((match) => {
    const next = { ...match, carrots: Number(match.carrots) || 0 };
    if (pointsIn[match.id] !== undefined) {
      const value = Math.trunc(Number(pointsIn[match.id]));
      if (!Number.isFinite(value) || value < 0 || value > MAX_POINTS) {
        throw httpError(400, `Points per match go from 0 to ${MAX_POINTS}.`);
      }
      next.points = value;
    }
    if (carrotsIn[match.id] !== undefined) {
      const value = Math.trunc(Number(carrotsIn[match.id]));
      if (!Number.isFinite(value) || value < 0 || value > MAX_CARROTS) {
        throw httpError(400, `Carrots per match go from 0 to ${MAX_CARROTS.toLocaleString('en-US')}.`);
      }
      next.carrots = value;
    }
    return next;
  });

  let id = previous?.id;
  if (!id) {
    const taken = new Set(store.brackets.map((bracket) => bracket.id));
    const root = slugify(name, 'bracket').slice(0, 36);
    id = root;
    for (let n = 2; taken.has(id); n += 1) id = `${root}-${n}`;
  }

  const bracket = {
    id,
    name,
    format: 'double',
    teams,
    matches,
    locksAt: source.locksAt !== undefined ? cleanLockTime(source.locksAt) : previous?.locksAt ?? null,
    locked: previous?.locked ?? false,
    results: previous?.results || {},
    entries: previous?.entries || {},
    createdAt: previous?.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  if (previous) store.brackets[store.brackets.indexOf(previous)] = bracket;
  else store.brackets.push(bracket);
  writeStore(store);
  return bracket;
}

export function setBracketLock(id, locked) {
  return updateBracket(id, (bracket) => {
    if (!locked && Object.keys(bracket.results || {}).length) {
      throw httpError(400, 'Results are already in, so picks can not reopen.');
    }
    bracket.locked = Boolean(locked);
    // Reopening also drops a lock time that already passed.
    if (!locked && bracket.locksAt && Date.parse(bracket.locksAt) <= Date.now()) bracket.locksAt = null;
    bracket.updatedAt = new Date().toISOString();
    return bracket;
  });
}

/**
 * Set or clear the winner of one match. Later results that no longer fit
 * (the team that moved on changed) are cleared too. Returns the bracket and
 * the list of match ids whose result changed.
 */
export function setMatchResult(id, matchId, teamId) {
  let changed = [];
  const bracket = updateBracket(id, (current) => {
    const match = (current.matches || []).find((item) => item.id === String(matchId || ''));
    if (!match) throw httpError(404, 'That match is not in this bracket.');
    const before = { ...(current.results || {}) };
    const next = { ...before };
    if (teamId == null || teamId === '') {
      delete next[match.id];
    } else {
      const teams = slotTeams(current, before, match.id);
      if (teams.some((team) => !team)) throw httpError(400, 'Enter the earlier results first. Both teams for that match are not known yet.');
      if (!teams.includes(String(teamId))) throw httpError(400, 'That team is not in this match.');
      next[match.id] = String(teamId);
    }
    const results = cleanWinners(current, next);
    const ids = new Set([...Object.keys(before), ...Object.keys(results)]);
    changed = [...ids].filter((key) => before[key] !== results[key]);
    current.results = results;
    current.locked = true;
    current.updatedAt = new Date().toISOString();
    return current;
  });
  return { bracket, changed };
}

// ---------------------------------------------------------------------------
// Player picks

export function savePicks(id, session, picksIn) {
  return updateBracket(id, (bracket) => {
    if (isLocked(bracket)) throw httpError(400, 'Picks are locked for this bracket.');
    const raw = picksIn && typeof picksIn === 'object' ? picksIn : {};
    const known = new Set((bracket.matches || []).map((match) => match.id));
    const asked = {};
    for (const [matchId, teamId] of Object.entries(raw)) {
      if (known.has(matchId) && teamId) asked[matchId] = String(teamId);
    }
    const picks = cleanWinners(bracket, asked);
    const key = String(session.discordId);
    bracket.entries = { ...(bracket.entries || {}) };
    if (!Object.keys(picks).length) {
      delete bracket.entries[key];
    } else {
      bracket.entries[key] = {
        name: cleanText(session.globalName || session.username || 'Trainer', MAX_NAME),
        picks,
        paid: bracket.entries[key]?.paid || {},
        updatedAt: new Date().toISOString(),
      };
    }
    return bracket;
  });
}

export function standings(bracket) {
  const total = (bracket.matches || []).length;
  const rows = Object.entries(bracket.entries || {}).map(([discordId, entry]) => {
    const score = scorePicks(bracket, entry.picks || {});
    return {
      discordId,
      name: entry.name || 'Trainer',
      points: score.points,
      correct: score.correct,
      wrong: score.wrong,
      maxPoints: score.maxPoints,
      carrots: carrotsWon(entry),
      picked: Object.keys(entry.picks || {}).length,
      complete: Object.keys(entry.picks || {}).length === total,
      champion: entry.picks?.[(bracket.matches || []).find((match) => match.side === 'final')?.id] || null,
      updatedAt: entry.updatedAt || null,
    };
  });
  rows.sort((a, b) => b.points - a.points || b.maxPoints - a.maxPoints || b.correct - a.correct || a.name.localeCompare(b.name));
  let rank = 0;
  let last = null;
  return rows.map((row, index) => {
    const key = `${row.points}:${row.maxPoints}:${row.correct}`;
    if (key !== last) rank = index + 1;
    last = key;
    return { rank, ...row };
  });
}

// ---------------------------------------------------------------------------
// Carrots

/**
 * Bring every player's carrot payouts in line with the current results and
 * carrot amounts. Each entry remembers what it was paid per match, so a
 * corrected result takes back the old payout and pays the new winners.
 * `usersById` is the wallet map from loadAllUsersForSettlement; it is changed
 * in place. Returns the updated bracket (not yet saved) and the wallet moves.
 */
export function reconcileCarrots(bracket, usersById) {
  const results = bracket.results || {};
  const moves = [];
  const entries = {};
  for (const [discordId, entry] of Object.entries(bracket.entries || {})) {
    const paid = { ...(entry.paid || {}) };
    const user = usersById[discordId];
    for (const match of bracket.matches || []) {
      const hit = results[match.id] && entry.picks?.[match.id] === results[match.id];
      const owed = hit ? Math.max(0, Number(match.carrots) || 0) : 0;
      const had = Number(paid[match.id]) || 0;
      if (owed === had || !user) continue;
      const delta = owed - had;
      user.gambaCoins = Math.max(0, (Number(user.gambaCoins) || 0) + delta);
      if (owed) paid[match.id] = owed;
      else delete paid[match.id];
      moves.push({ discordId, matchId: match.id, delta });
    }
    entries[discordId] = { ...entry, paid };
  }
  return { bracket: { ...bracket, entries }, moves };
}

export function carrotsWon(entry) {
  return Object.values(entry?.paid || {}).reduce((sum, value) => sum + (Number(value) || 0), 0);
}

/** Save a bracket that reconcileCarrots changed (only the entries move). */
export function saveBracketEntries(bracket) {
  return updateBracket(bracket.id, (current) => {
    current.entries = bracket.entries;
    return current;
  });
}
