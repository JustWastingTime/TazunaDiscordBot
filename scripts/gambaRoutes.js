import express from 'express';
import { assertWriteOrigin, httpError } from './adminAuth.js';
import { jsonError, readSession } from './dashboardAuth.js';
import {
  ensureQuizUser,
  getGambaDisplayName,
  getGambaLeaderboard,
  getUserLink,
  updateUserBettingState,
  withWalletLock,
} from './clubDatabase.js';
import {
  formatOdds,
  getEntry,
  getEventPhase,
  isEventBettable,
  parlayPayout,
  placeBet,
  placeParlay,
} from './eventGambling.js';
import { refreshBetsBoardForEvent } from './eventService.js';
import { getEvent, listEvents } from './eventStorage.js';
import { getChain, listChains } from './gambaChains.js';

const writes = new Map();
const WRITE_LIMIT = 20;
const WRITE_WINDOW_MS = 60_000;
const SETTLED_WINDOW_MS = 21 * 24 * 60 * 60 * 1000;

function sessionName(session) {
  return session.globalName || session.username || 'Trainer';
}

function requireSession(req) {
  const session = readSession(req);
  if (!session?.discordId) throw httpError(401, 'Discord login required.');
  return session;
}

function limitWrites(discordId) {
  const now = Date.now();
  const recent = (writes.get(discordId) || []).filter((ts) => now - ts < WRITE_WINDOW_MS);
  if (recent.length >= WRITE_LIMIT) throw httpError(429, 'Too many tickets. Wait a minute and try again.');
  recent.push(now);
  writes.set(discordId, recent);
}

function publicEntry(entry) {
  return {
    number: entry.number,
    name: entry.name,
    ageSex: entry.ageSex || '',
    jockey: entry.jockey || '',
    odds: entry.odds,
  };
}

function publicEvent(event) {
  if (!event) return null;
  const winner = event.winner != null ? getEntry(event, event.winner) : null;
  return {
    id: event.id,
    name: event.name,
    phase: getEventPhase(event),
    startsAt: event.startsAt || null,
    endsAt: event.endsAt || null,
    winner: event.winner ?? null,
    winnerName: winner?.name || null,
    entries: (event.entries || []).map(publicEntry),
  };
}

function listedEvent(event) {
  const phase = getEventPhase(event);
  if (phase !== 'settled') return true;
  const at = Date.parse(event.settledAt || '');
  if (!Number.isFinite(at)) return true;
  return Date.now() - at < SETTLED_WINDOW_MS;
}

function publicHistory(entry) {
  return {
    kind: entry.kind || 'single',
    parlayId: entry.parlayId || null,
    eventId: entry.eventId || null,
    eventName: entry.eventName || '',
    entryNumber: entry.entryNumber ?? null,
    entryName: entry.entryName || '',
    legs: Array.isArray(entry.legs) ? entry.legs : null,
    amount: entry.amount || 0,
    oddsAtBet: entry.oddsAtBet ?? null,
    result: entry.result || null,
    payout: entry.payout || 0,
    settledAt: entry.settledAt || null,
    placedAt: entry.placedAt || null,
  };
}

function publicParlay(parlay) {
  return {
    parlayId: parlay.parlayId,
    chainId: parlay.chainId || null,
    chainName: parlay.chainName || null,
    stake: parlay.stake,
    combinedOdds: parlay.combinedOdds,
    payoutIfHit: parlayPayout(parlay.stake, parlay.legs || []),
    placedAt: parlay.placedAt,
    legs: (parlay.legs || []).map((leg) => ({
      eventId: leg.eventId,
      eventName: leg.eventName,
      entryNumber: leg.entryNumber,
      entryName: leg.entryName,
      oddsAtBet: leg.oddsAtBet,
      status: leg.status || 'open',
    })),
  };
}

function publicTrainer(link) {
  const history = Array.isArray(link.betHistory) ? link.betHistory : [];
  return {
    discordId: link.discordUserId,
    name: getGambaDisplayName(link),
    carrots: link.gambaCoins ?? 0,
    wins: link.gambaWins || 0,
    losses: link.gambaLosses || 0,
    record: link.gambaWr || null,
    openTickets: link.openTickets || [],
    openParlays: (link.openParlays || []).map(publicParlay),
    history: history.slice(-50).reverse().map(publicHistory),
  };
}

function walletFrom(session) {
  return ensureQuizUser(session.discordId, sessionName(session)).link;
}

function cloneWallet(link) {
  return {
    trainerName: link.trainerName,
    gambaCoins: link.gambaCoins ?? 0,
    gambaWins: link.gambaWins || 0,
    gambaLosses: link.gambaLosses || 0,
    gambaWr: link.gambaWr || null,
    openTickets: [...(link.openTickets || [])],
    openParlays: (link.openParlays || []).map((parlay) => ({
      ...parlay,
      legs: (parlay.legs || []).map((leg) => ({ ...leg })),
    })),
    betHistory: [...(link.betHistory || [])],
  };
}

function saveWallet(discordId, user) {
  updateUserBettingState(discordId, {
    trainerName: user.trainerName,
    gambaCoins: user.gambaCoins,
    openTickets: user.openTickets,
    openParlays: user.openParlays,
    betHistory: user.betHistory,
  });
}

function publicChainSummary(chain) {
  return {
    id: chain.id,
    name: chain.name,
    stages: (chain.stages || []).map((stage) => ({
      id: stage.id,
      label: stage.label,
      eventIds: stage.eventIds || [],
    })),
  };
}

function publicChainDetail(chain) {
  return {
    ...publicChainSummary(chain),
    stages: (chain.stages || []).map((stage) => ({
      id: stage.id,
      label: stage.label,
      eventIds: stage.eventIds || [],
      events: (stage.eventIds || []).map((eventId) => {
        const event = getEvent(eventId);
        return event
          ? publicEvent(event)
          : { id: eventId, name: 'That race is gone', phase: 'closed', startsAt: null, endsAt: null, winner: null, winnerName: null, entries: [] };
      }),
    })),
  };
}

export function mountGamba(app) {
  const router = express.Router();
  router.use(express.json({ limit: '64kb' }));

  router.use((req, _res, next) => {
    req.gambaSession = requireSession(req);
    next();
  });

  router.get('/me', async (req, res) => {
    try {
      const trainer = await withWalletLock(() => publicTrainer(walletFrom(req.gambaSession)));
      res.json({
        authenticated: true,
        discordId: req.gambaSession.discordId,
        username: req.gambaSession.username,
        globalName: req.gambaSession.globalName || null,
        avatar: req.gambaSession.avatar || null,
        ...trainer,
        name: req.gambaSession.globalName || req.gambaSession.username || trainer.name,
      });
    } catch (error) {
      jsonError(res, error);
    }
  });

  router.get('/events', (_req, res) => {
    try {
      const events = listEvents()
        .filter(listedEvent)
        .map(publicEvent)
        .sort((a, b) => phaseRank(a.phase) - phaseRank(b.phase) || String(a.name).localeCompare(String(b.name)));
      res.json({ events });
    } catch (error) {
      jsonError(res, error);
    }
  });

  router.get('/leaderboard', (_req, res) => {
    try {
      const rows = getGambaLeaderboard({ limit: 50 }).map((entry, index) => ({
        rank: index + 1,
        discordId: entry.discordUserId,
        name: getGambaDisplayName(entry),
        carrots: entry.gambaCoins ?? 0,
        wins: entry.gambaWins || 0,
        losses: entry.gambaLosses || 0,
        record: entry.gambaWr || null,
      }));
      res.json({ rows });
    } catch (error) {
      jsonError(res, error);
    }
  });

  router.get('/trainers/:discordId', (req, res) => {
    try {
      const link = getUserLink(req.params.discordId);
      if (!link || link.gambaCoins == null) return res.status(404).json({ error: 'That trainer has no carrots yet.' });
      res.json(publicTrainer(link));
    } catch (error) {
      jsonError(res, error);
    }
  });

  router.get('/chains', (_req, res) => {
    try {
      res.json({ chains: listChains().map(publicChainSummary) });
    } catch (error) {
      jsonError(res, error);
    }
  });

  router.get('/chains/:id', (req, res) => {
    try {
      const chain = getChain(req.params.id);
      if (!chain) return res.status(404).json({ error: 'That meet is gone.' });
      res.json({ chain: publicChainDetail(chain) });
    } catch (error) {
      jsonError(res, error);
    }
  });

  router.post('/bets', async (req, res) => {
    try {
      assertWriteOrigin(req);
      limitWrites(req.gambaSession.discordId);
      const eventId = String(req.body?.eventId || '');
      const entryNumber = Number(req.body?.entryNumber);
      const amount = Number(req.body?.amount);
      const placed = await withWalletLock(() => {
        const link = walletFrom(req.gambaSession);
        const event = getEvent(eventId);
        if (!event || !isEventBettable(event)) return { ok: false, error: 'That race already closed.' };
        const user = cloneWallet(link);
        const result = placeBet(user, event, entryNumber, amount, { custom: true });
        if (!result.ok) return result;
        saveWallet(req.gambaSession.discordId, user);
        return {
          ok: true,
          carrots: user.gambaCoins,
          ticket: result.ticket,
          payoutIfHit: parlayPayout(result.ticket.amount, [{ oddsAtBet: result.ticket.oddsAtBet }]),
        };
      });
      if (!placed.ok) return res.status(400).json({ error: placed.error });
      refreshBetsBoardForEvent(eventId).catch((err) => {
        console.error('Failed to refresh bets board:', err.message);
      });
      res.json(placed);
    } catch (error) {
      jsonError(res, error);
    }
  });

  router.post('/parlays', async (req, res) => {
    try {
      assertWriteOrigin(req);
      limitWrites(req.gambaSession.discordId);
      const chainId = req.body?.chainId ? String(req.body.chainId) : null;
      const stake = Number(req.body?.stake);
      const rawLegs = Array.isArray(req.body?.legs) ? req.body.legs : [];
      const placed = await withWalletLock(() => {
        const link = walletFrom(req.gambaSession);
        const chain = chainId ? getChain(chainId) : null;
        if (chainId && !chain) return { ok: false, error: 'That meet is gone.' };
        const picks = rawLegs.map((leg) => ({
          event: getEvent(leg?.eventId),
          entryNumber: Number(leg?.entryNumber),
        }));
        const user = cloneWallet(link);
        const result = placeParlay(user, picks, stake, { chain });
        if (!result.ok) return result;
        saveWallet(req.gambaSession.discordId, user);
        return {
          ok: true,
          carrots: user.gambaCoins,
          parlay: publicParlay(result.parlay),
          payoutIfHit: result.payoutIfHit,
        };
      });
      if (!placed.ok) return res.status(400).json({ error: placed.error });
      const eventIds = rawLegs.map((leg) => String(leg?.eventId || '')).filter(Boolean);
      for (const eventId of eventIds) {
        refreshBetsBoardForEvent(eventId).catch((err) => {
          console.error('Failed to refresh bets board:', err.message);
        });
      }
      res.json({ ...placed, oddsLabel: formatOdds(placed.parlay?.combinedOdds) });
    } catch (error) {
      jsonError(res, error);
    }
  });

  router.use((error, _req, res, _next) => {
    jsonError(res, error);
  });

  app.use('/api/gamba', router);
}

function phaseRank(phase) {
  if (phase === 'open') return 0;
  if (phase === 'closed') return 1;
  if (phase === 'scheduled') return 2;
  return 3;
}
