import express from 'express';
import { assertWriteOrigin, httpError } from './adminAuth.js';
import { jsonError, readSession } from './dashboardAuth.js';
import {
  ensureQuizUser,
  getGambaDisplayName,
  getGambaLeaderboard,
  getUserLink,
  loadAllUsersForSettlement,
  saveAllUsersFromSettlement,
  updateUserBettingState,
  withWalletLock,
} from './clubDatabase.js';
import {
  collectEventSettlementResults,
  formatOdds,
  getEntry,
  getEventPhase,
  isEventBettable,
  parlayPayout,
  placeBet,
  placeParlay,
  placePickem,
  placeTournamentParlay,
  settleAdvancePickems,
} from './eventGambling.js';
import { refreshBetsBoardForEvent } from './eventService.js';
import { getEvent, listEvents } from './eventStorage.js';
import { getChain, listChains } from './gambaChains.js';
import { getTournament, listTournaments, setAdvanceResults } from './gambaTournaments.js';
import { isBotOwner } from './adminRole.js';

const writes = new Map();
const WRITE_LIMIT = 20;
const WRITE_WINDOW_MS = 60_000;

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

function publicName(name) {
  const value = String(name || '').trim();
  if (!value || value.toLowerCase() === 'trainer') return 'Anonymous Trainer';
  return value;
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

function publicEvent(event, users = null) {
  if (!event) return null;
  const winner = event.winner != null ? getEntry(event, event.winner) : null;
  const phase = getEventPhase(event);
  const results = phase === 'settled' && users ? resultRows(event, users) : [];
  return {
    id: event.id,
    name: event.name,
    phase,
    startsAt: event.startsAt || null,
    endsAt: event.endsAt || null,
    settledAt: event.settledAt || null,
    winner: event.winner ?? null,
    winnerName: winner?.name || null,
    winnerOdds: winner?.odds ?? null,
    entries: (event.entries || []).map(publicEntry),
    results,
  };
}

function resultRows(event, users) {
  const rows = collectEventSettlementResults(users, event.id, event.settlementResults).map((row) => ({
    name: publicName(row.displayName),
    won: Boolean(row.won),
    netGain: row.netGain ?? 0,
    payout: row.totalPayout || 0,
    wagered: row.totalWagered || 0,
    entryNumber: row.entryNumber ?? null,
    entryName: row.entryName || '',
  }));
  for (const user of Object.values(users || {})) {
    for (const item of user.betHistory || []) {
      if (item.kind !== 'parlay') continue;
      const leg = (item.legs || []).find((entry) => entry.eventId === event.id);
      if (!leg) continue;
      const won = item.result === 'win';
      const wagered = item.amount || 0;
      const payout = item.payout || 0;
      rows.push({
        name: publicName(user.trainerName),
        won,
        netGain: won ? payout - wagered : -wagered,
        payout,
        wagered,
        entryNumber: leg.entryNumber ?? null,
        entryName: leg.entryName || '',
      });
    }
  }
  rows.sort((a, b) => Number(b.won) - Number(a.won) || b.netGain - a.netGain);
  return rows;
}

function publishedEvents() {
  const events = listEvents().filter((event) => listedEvent(event) && event.listing !== 'tournament');
  const users = events.some((event) => getEventPhase(event) === 'settled')
    ? loadAllUsersForSettlement()
    : null;
  return events
    .map((event) => publicEvent(event, users))
    .sort((a, b) => phaseRank(a.phase) - phaseRank(b.phase) || String(a.name).localeCompare(String(b.name)));
}

function listedEvent(event) {
  return Boolean(event && event.id);
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
    name: publicName(getGambaDisplayName(link)),
    carrots: link.gambaCoins ?? 0,
    wins: link.gambaWins || 0,
    losses: link.gambaLosses || 0,
    record: link.gambaWr || null,
    openTickets: link.openTickets || [],
    openParlays: (link.openParlays || []).map(publicParlay),
    openPickems: (link.openPickems || []).map(publicPickem),
    history: history.slice(-200).reverse().map(publicHistory),
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
    openPickems: (link.openPickems || []).map((card) => ({
      ...card,
      legs: (card.legs || []).map((leg) => ({ ...leg })),
      payouts: [...(card.payouts || [])],
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
    openPickems: user.openPickems,
    betHistory: user.betHistory,
  });
}

function publicPickem(card) {
  const correct = (card.legs || []).filter((leg) => leg.status === 'won').length;
  const pending = (card.legs || []).some((leg) => leg.status === 'open');
  const multiplier = pending ? Number(card.payouts?.[card.legs.length]) || 0 : Number(card.payouts?.[correct]) || 0;
  return {
    pickemId: card.pickemId,
    tournamentId: card.tournamentId || null,
    tournamentName: card.tournamentName || null,
    roundId: card.roundId || null,
    roundLabel: card.roundLabel || '',
    stake: card.stake,
    payouts: card.payouts || [],
    payoutIfPerfect: Math.floor((card.stake || 0) * (Number(card.payouts?.[card.legs?.length]) || 0)),
    multiplier,
    placedAt: card.placedAt,
    legs: (card.legs || []).map((leg) => ({
      kind: leg.kind || 'match',
      slotId: leg.slotId || null,
      slotLabel: leg.slotLabel || '',
      eventId: leg.eventId,
      eventName: leg.eventName,
      entryNumber: leg.entryNumber,
      entryName: leg.entryName,
      status: leg.status || 'open',
    })),
  };
}

function publicRound(round, withEvents) {
  const events = withEvents
    ? (round.eventIds || []).map((eventId) => {
      const event = getEvent(eventId);
      return event
        ? publicEvent(event)
        : { id: eventId, name: 'That race is gone', phase: 'closed', startsAt: null, endsAt: null, winner: null, winnerName: null, winnerOdds: null, entries: [], results: [] };
    })
    : undefined;
  const phases = (events || (round.eventIds || []).map((eventId) => getEvent(eventId)).filter(Boolean).map((event) => ({ phase: getEventPhase(event) })))
    .map((event) => event.phase);
  const state = !phases.length
    ? 'empty'
    : phases.every((phase) => phase === 'settled')
      ? 'settled'
      : phases.some((phase) => phase === 'open')
        ? 'open'
        : 'waiting';
  return {
    id: round.id,
    label: round.label,
    eventIds: round.eventIds || [],
    pickemPayouts: round.pickemPayouts || [],
    advanceSlots: (round.advanceSlots || []).map((slot) => ({
      id: slot.id,
      label: slot.label,
      eventIds: slot.eventIds || [],
      hint: slot.hint || '',
    })),
    advanceResults: round.advanceResults || {},
    state,
    ...(events ? { events } : {}),
  };
}

function publicTournamentSummary(tournament) {
  return {
    id: tournament.id,
    name: tournament.name,
    rounds: (tournament.rounds || []).map((round) => publicRound(round, false)),
  };
}

function publicTournamentDetail(tournament) {
  return {
    id: tournament.id,
    name: tournament.name,
    rounds: (tournament.rounds || []).map((round) => publicRound(round, true)),
  };
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
          : { id: eventId, name: 'That race is gone', phase: 'closed', startsAt: null, endsAt: null, winner: null, winnerName: null, winnerOdds: null, entries: [], results: [] };
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
        name: publicName(req.gambaSession.globalName || req.gambaSession.username || trainer.name),
        owner: isBotOwner(req.gambaSession.discordId),
      });
    } catch (error) {
      jsonError(res, error);
    }
  });

  router.get('/events', (_req, res) => {
    try {
      res.json({ events: publishedEvents() });
    } catch (error) {
      jsonError(res, error);
    }
  });

  router.get('/events/:id', (req, res) => {
    try {
      const event = getEvent(req.params.id);
      if (!event || !listedEvent(event)) return res.status(404).json({ error: 'That race is gone.' });
      const users = getEventPhase(event) === 'settled' ? loadAllUsersForSettlement() : null;
      res.json({ event: publicEvent(event, users) });
    } catch (error) {
      jsonError(res, error);
    }
  });

  router.get('/leaderboard', (_req, res) => {
    try {
      const rows = getGambaLeaderboard({ limit: 50 }).map((entry, index) => ({
        rank: index + 1,
        discordId: entry.discordUserId,
        name: publicName(getGambaDisplayName(entry)),
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

  router.get('/tournaments', (_req, res) => {
    try {
      res.json({ tournaments: listTournaments().map(publicTournamentSummary) });
    } catch (error) {
      jsonError(res, error);
    }
  });

  router.get('/tournaments/:id', (req, res) => {
    try {
      const tournament = getTournament(req.params.id);
      if (!tournament) return res.status(404).json({ error: 'That tournament is gone.' });
      res.json({ tournament: publicTournamentDetail(tournament) });
    } catch (error) {
      jsonError(res, error);
    }
  });

  router.post('/tournaments/:id/chain', async (req, res) => {
    try {
      assertWriteOrigin(req);
      limitWrites(req.gambaSession.discordId);
      const stake = Number(req.body?.stake);
      const rawLegs = Array.isArray(req.body?.legs) ? req.body.legs : [];
      const placed = await withWalletLock(() => {
        const tournament = getTournament(req.params.id);
        if (!tournament) return { ok: false, error: 'That tournament is gone.' };
        const picks = rawLegs.map((leg) => ({
          event: getEvent(leg?.eventId),
          entryNumber: Number(leg?.entryNumber),
        }));
        const user = cloneWallet(walletFrom(req.gambaSession));
        const result = placeTournamentParlay(user, tournament, picks, stake);
        if (!result.ok) return result;
        saveWallet(req.gambaSession.discordId, user);
        return { ok: true, carrots: user.gambaCoins, parlay: publicParlay(result.parlay) };
      });
      if (!placed.ok) return res.status(400).json({ error: placed.error });
      res.json(placed);
    } catch (error) {
      jsonError(res, error);
    }
  });

  router.post('/tournaments/:id/pickem', async (req, res) => {
    try {
      assertWriteOrigin(req);
      limitWrites(req.gambaSession.discordId);
      const roundId = String(req.body?.roundId || '');
      const stake = Number(req.body?.stake);
      const rawLegs = Array.isArray(req.body?.legs) ? req.body.legs : [];
      const placed = await withWalletLock(() => {
        const tournament = getTournament(req.params.id);
        if (!tournament) return { ok: false, error: 'That tournament is gone.' };
        const round = (tournament.rounds || []).find((item) => item.id === roundId);
        if (!round) return { ok: false, error: 'That round is gone.' };
        const picks = rawLegs.map((leg) => (
          leg?.kind === 'advance' || leg?.slotId
            ? {
              kind: 'advance',
              slotId: String(leg.slotId || ''),
              eventId: String(leg.eventId || ''),
              entryNumber: Number(leg.entryNumber),
            }
            : {
              kind: 'match',
              event: getEvent(leg?.eventId),
              entryNumber: Number(leg?.entryNumber),
            }
        ));
        const user = cloneWallet(walletFrom(req.gambaSession));
        const result = placePickem(user, tournament, round, picks, stake);
        if (!result.ok) return result;
        saveWallet(req.gambaSession.discordId, user);
        return { ok: true, carrots: user.gambaCoins, pickem: publicPickem(result.pickem) };
      });
      if (!placed.ok) return res.status(400).json({ error: placed.error });
      res.json(placed);
    } catch (error) {
      jsonError(res, error);
    }
  });

  router.post('/tournaments/:id/advances', async (req, res) => {
    try {
      assertWriteOrigin(req);
      if (!isBotOwner(req.gambaSession.discordId)) return res.status(403).json({ error: 'Only the owner can confirm advances.' });
      const roundId = String(req.body?.roundId || '');
      const results = req.body?.results && typeof req.body.results === 'object' ? req.body.results : {};
      const tournament = setAdvanceResults(req.params.id, roundId, results);
      const round = (tournament.rounds || []).find((item) => item.id === roundId);
      await withWalletLock(() => {
        const users = loadAllUsersForSettlement();
        settleAdvancePickems(users, {
          tournamentId: tournament.id,
          roundId,
          advanceResults: round?.advanceResults || {},
        });
        saveAllUsersFromSettlement(users);
      });
      res.json({ tournament: publicTournamentDetail(tournament) });
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
