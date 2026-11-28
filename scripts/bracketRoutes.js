// /api/brackets: bracket pick'em for the Paddock's Brackets tab. Kept apart from
// /api/gamba so it never mixes with race betting. Nothing here talks to Discord.
import express from 'express';
import { assertWriteOrigin, httpError } from './adminAuth.js';
import { jsonError, readSession } from './dashboardAuth.js';
import { isBotOwner } from './adminRole.js';
import {
  ensureQuizUser,
  loadAllUsersForSettlement,
  saveAllUsersFromSettlement,
  withWalletLock,
} from './clubDatabase.js';
import {
  bracketStatus,
  carrotsWon,
  champion,
  deleteBracket,
  getBracket,
  isLocked,
  listBrackets,
  reconcileCarrots,
  saveBracket,
  saveBracketEntries,
  savePicks,
  scorePicks,
  setBracketLock,
  setMatchResult,
  standings,
} from './gambaBrackets.js';

const writes = new Map();
const WRITE_LIMIT = 30;
const WRITE_WINDOW_MS = 60_000;

function limitWrites(discordId) {
  const now = Date.now();
  const recent = (writes.get(discordId) || []).filter((ts) => now - ts < WRITE_WINDOW_MS);
  if (recent.length >= WRITE_LIMIT) throw httpError(429, 'Too many saves. Wait a minute and try again.');
  recent.push(now);
  writes.set(discordId, recent);
}

function requireSession(req) {
  const session = readSession(req);
  if (!session?.discordId) throw httpError(401, 'Log in with Discord to make picks.');
  return session;
}

function requireOwner(req) {
  const session = requireSession(req);
  if (!isBotOwner(session.discordId)) throw httpError(403, 'Only the owner can run brackets.');
  return session;
}

function teamName(bracket, teamId) {
  return (bracket.teams || []).find((team) => team.id === teamId)?.name || null;
}

function publicSummary(bracket) {
  const winner = champion(bracket);
  return {
    id: bracket.id,
    name: bracket.name,
    status: bracketStatus(bracket),
    locksAt: bracket.locksAt || null,
    teamCount: (bracket.teams || []).length,
    matchCount: (bracket.matches || []).length,
    entryCount: Object.keys(bracket.entries || {}).length,
    resultCount: Object.keys(bracket.results || {}).length,
    carrotsPerfect: (bracket.matches || []).reduce((sum, match) => sum + (Number(match.carrots) || 0), 0),
    pointsPerfect: (bracket.matches || []).reduce((sum, match) => sum + (Number(match.points) || 0), 0),
    champion: winner ? { id: winner, name: teamName(bracket, winner) } : null,
    createdAt: bracket.createdAt || null,
  };
}

function publicDetail(bracket) {
  return {
    ...publicSummary(bracket),
    teams: bracket.teams || [],
    matches: (bracket.matches || []).map((match) => ({
      id: match.id,
      number: match.number,
      side: match.side,
      round: match.round,
      label: match.label,
      slots: match.slots,
      points: Number(match.points) || 0,
      carrots: Number(match.carrots) || 0,
    })),
    results: bracket.results || {},
  };
}

function entryView(bracket, discordId) {
  const entry = bracket.entries?.[discordId];
  if (!entry) return null;
  const score = scorePicks(bracket, entry.picks || {});
  return {
    discordId,
    name: entry.name || 'Trainer',
    picks: entry.picks || {},
    updatedAt: entry.updatedAt || null,
    carrots: carrotsWon(entry),
    ...score,
  };
}

function detailFor(bracket, session) {
  const discordId = session?.discordId ? String(session.discordId) : null;
  return {
    bracket: publicDetail(bracket),
    viewer: {
      loggedIn: Boolean(discordId),
      discordId,
      name: session ? session.globalName || session.username || null : null,
      owner: Boolean(discordId && isBotOwner(discordId)),
    },
    mine: discordId ? entryView(bracket, discordId) : null,
    standings: standings(bracket),
  };
}

/** Pay or take back carrots so every entry matches the current results. */
async function settle(bracket) {
  return withWalletLock(() => {
    const users = loadAllUsersForSettlement();
    const { bracket: next, moves } = reconcileCarrots(bracket, users);
    if (!moves.length) return bracket;
    saveAllUsersFromSettlement(users);
    return saveBracketEntries(next);
  });
}

export function mountBrackets(app) {
  const router = express.Router();
  router.use(express.json({ limit: '64kb' }));

  router.get('/', (req, res) => {
    try {
      const session = readSession(req);
      const discordId = session?.discordId ? String(session.discordId) : null;
      const brackets = listBrackets()
        .map((bracket) => ({
          ...publicSummary(bracket),
          joined: Boolean(discordId && bracket.entries?.[discordId]),
        }))
        .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
      res.json({
        brackets,
        viewer: {
          loggedIn: Boolean(discordId),
          discordId,
          name: session ? session.globalName || session.username || null : null,
          owner: Boolean(discordId && isBotOwner(discordId)),
        },
      });
    } catch (error) {
      jsonError(res, error);
    }
  });

  router.get('/:id', (req, res) => {
    try {
      const bracket = getBracket(req.params.id);
      if (!bracket) return res.status(404).json({ error: 'That bracket is gone.' });
      res.json(detailFor(bracket, readSession(req)));
    } catch (error) {
      jsonError(res, error);
    }
  });

  // Someone else's picks: hidden until picks lock so nobody can copy them.
  router.get('/:id/entries/:discordId', (req, res) => {
    try {
      const bracket = getBracket(req.params.id);
      if (!bracket) return res.status(404).json({ error: 'That bracket is gone.' });
      const session = readSession(req);
      const target = String(req.params.discordId);
      const self = session?.discordId && String(session.discordId) === target;
      if (!self && !isLocked(bracket) && !isBotOwner(session?.discordId)) {
        return res.status(403).json({ error: 'Picks stay hidden until the bracket locks.' });
      }
      const entry = entryView(bracket, target);
      if (!entry) return res.status(404).json({ error: 'That trainer has no picks here.' });
      res.json({ entry });
    } catch (error) {
      jsonError(res, error);
    }
  });

  router.put('/:id/picks', (req, res) => {
    try {
      assertWriteOrigin(req);
      const session = requireSession(req);
      limitWrites(session.discordId);
      // Make sure the player has a wallet, so carrots can land when results come in.
      ensureQuizUser(session.discordId, session.globalName || session.username || 'Trainer');
      const bracket = savePicks(req.params.id, session, req.body?.picks);
      res.json(detailFor(bracket, session));
    } catch (error) {
      jsonError(res, error);
    }
  });

  router.post('/', async (req, res) => {
    try {
      assertWriteOrigin(req);
      const session = requireOwner(req);
      const { id: _ignored, ...input } = req.body || {};
      const bracket = saveBracket(input);
      res.json(detailFor(bracket, session));
    } catch (error) {
      jsonError(res, error);
    }
  });

  router.put('/:id', async (req, res) => {
    try {
      assertWriteOrigin(req);
      const session = requireOwner(req);
      const saved = saveBracket({ ...(req.body || {}), id: req.params.id });
      const bracket = await settle(saved);
      res.json(detailFor(bracket, session));
    } catch (error) {
      jsonError(res, error);
    }
  });

  router.delete('/:id', (req, res) => {
    try {
      assertWriteOrigin(req);
      requireOwner(req);
      res.json(deleteBracket(req.params.id));
    } catch (error) {
      jsonError(res, error);
    }
  });

  router.post('/:id/lock', (req, res) => {
    try {
      assertWriteOrigin(req);
      const session = requireOwner(req);
      const bracket = setBracketLock(req.params.id, req.body?.locked !== false);
      res.json(detailFor(bracket, session));
    } catch (error) {
      jsonError(res, error);
    }
  });

  router.post('/:id/results', async (req, res) => {
    try {
      assertWriteOrigin(req);
      const session = requireOwner(req);
      const { bracket: saved, changed } = setMatchResult(req.params.id, req.body?.matchId, req.body?.teamId ?? null);
      const bracket = await settle(saved);
      res.json({ ...detailFor(bracket, session), changed });
    } catch (error) {
      jsonError(res, error);
    }
  });

  app.use('/api/brackets', router);
}
