import { randomUUID } from 'crypto';
import { formatGambaWr, getUserLink, listGambaWalletUsers } from './clubDatabase.js';
import { getEvent } from './eventStorage.js';

export const BET_AMOUNTS = [10, 50, 100, 500];
export const WEB_BET_MIN = 10;
export const WEB_BET_MAX = 10000;
export const PARLAY_MIN_LEGS = 2;
export const PARLAY_MAX_LEGS = 6;
export const PICKEM_MAX_MULTIPLIER = 20;
export const BET_HISTORY_LIMIT = 50;
export const PROFILE_HISTORY = 5;

export function formatCoins(amount) {
  return Math.trunc(amount).toLocaleString('en-US');
}

export function payout(amount, odds) {
  return Math.floor(amount * odds);
}

export function formatOdds(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  return String(Math.round(n * 100) / 100);
}

export function combinedOddsOf(legs) {
  return (legs || []).reduce((product, leg) => product * Number(leg.oddsAtBet), 1);
}

export function parlayPayout(stake, legs) {
  return Math.floor(Number(stake) * combinedOddsOf(legs));
}

function parlayUsingEvent(user, eventId) {
  return (user?.openParlays || []).find((parlay) =>
    (parlay.legs || []).some((leg) => leg.eventId === eventId && leg.status !== 'skipped'),
  ) || null;
}

function pickemUsingEvent(user, eventId) {
  return (user?.openPickems || []).find((card) =>
    (card.legs || []).some((leg) => (leg.kind || 'match') === 'match' && leg.eventId === eventId && leg.status === 'open'),
  ) || null;
}

function raceAlreadyCommitted(user, eventId) {
  if ((user.openTickets || []).some((ticket) => ticket.eventId === eventId)) {
    return 'That race is already on a single ticket.';
  }
  if (parlayUsingEvent(user, eventId)) return 'That race is already on another ticket.';
  if (pickemUsingEvent(user, eventId)) return 'That race is already on a pick\'em card.';
  return '';
}

export function formatCutoff(isoString) {
  const date = new Date(isoString);
  if (!Number.isFinite(date.getTime())) return '—';
  const unix = Math.floor(date.getTime() / 1000);
  return `<t:${unix}:f> · <t:${unix}:R>`;
}

export function getEntry(event, entryNumber) {
  return (event?.entries || []).find((entry) => entry.number === entryNumber) || null;
}

export function isEventBettable(event) {
  if (!event || event.status !== 'open') return false;
  const endsAt = new Date(event.endsAt).getTime();
  if (!Number.isFinite(endsAt)) return false;
  return Date.now() < endsAt;
}

export function getEventPhase(event) {
  if (!event) return 'closed';
  if (event.status === 'settled') return 'settled';
  if (event.status === 'scheduled') return 'scheduled';
  if (event.status === 'closed') return 'closed';
  if (isEventBettable(event)) return 'open';
  return 'closed';
}

export function getUserEventHorse(user, eventId) {
  const ticket = (user?.openTickets || []).find((item) => item.eventId === eventId);
  return ticket ? ticket.entryNumber : null;
}

export function getUserEventTickets(user, eventId) {
  return (user?.openTickets || []).filter((item) => item.eventId === eventId);
}

function trimHistory(history) {
  if (!Array.isArray(history)) return [];
  return history.slice(-BET_HISTORY_LIMIT);
}

export function placeBet(user, event, entryNumber, amount, { custom = false } = {}) {
  const entry = getEntry(event, entryNumber);
  if (!entry) return { ok: false, error: 'Entry not found.' };

  const delta = Math.trunc(amount);
  if (custom) {
    if (!Number.isFinite(delta) || delta < WEB_BET_MIN || delta > WEB_BET_MAX) {
      return { ok: false, error: `Use a whole number from ${WEB_BET_MIN} to ${formatCoins(WEB_BET_MAX)} carrots.` };
    }
  } else if (!BET_AMOUNTS.includes(delta)) {
    return { ok: false, error: 'Invalid bet amount.' };
  }

  const committed = raceAlreadyCommitted(user, event.id);
  if (committed && getUserEventHorse(user, event.id) == null) {
    return { ok: false, error: committed };
  }

  const lockedEntry = getUserEventHorse(user, event.id);
  if (lockedEntry != null && lockedEntry !== entryNumber) {
    const locked = getEntry(event, lockedEntry);
    return {
      ok: false,
      error: custom
        ? `You already picked #${lockedEntry} ${locked?.name || '?'} in this race.`
        : `You already bet on **#${lockedEntry} ${locked?.name || '?'}** for this event. You can only pick **one** horse per event.`,
    };
  }

  const balance = user.gambaCoins ?? 0;
  if (delta > balance) {
    return {
      ok: false,
      error: custom
        ? `Not enough carrots. You have ${formatCoins(balance)}.`
        : `Not enough GambaCoins. You have **${formatCoins(balance)}** but tried **${formatCoins(delta)}**.`,
    };
  }

  user.gambaCoins = balance - delta;
  const ticket = {
    ticketId: randomUUID(),
    eventId: event.id,
    eventName: event.name,
    entryNumber,
    entryName: entry.name,
    amount: delta,
    oddsAtBet: entry.odds,
    placedAt: new Date().toISOString(),
  };
  user.openTickets = [...(user.openTickets || []), ticket];

  return { ok: true, ticket, entry, user };
}

export function placeParlay(user, picks, stake, { chain = null } = {}) {
  const legs = Array.isArray(picks) ? picks : [];
  if (chain) {
    const stages = chain.stages || [];
    if (legs.length !== stages.length) {
      return { ok: false, error: 'Pick one horse in each stage.' };
    }
    const seenStages = new Set();
    for (const pick of legs) {
      const stage = stages.find((item) => (item.eventIds || []).map(String).includes(String(pick.event?.id)));
      if (!stage) return { ok: false, error: 'That race is not in this meet.' };
      if (seenStages.has(stage.id)) return { ok: false, error: 'Pick one race in each stage.' };
      seenStages.add(stage.id);
    }
    if (seenStages.size !== stages.length) {
      return { ok: false, error: 'Pick one horse in each stage.' };
    }
  } else if (legs.length < PARLAY_MIN_LEGS || legs.length > PARLAY_MAX_LEGS) {
    return { ok: false, error: `A parlay needs ${PARLAY_MIN_LEGS} to ${PARLAY_MAX_LEGS} races.` };
  }

  const seenEvents = new Set();
  const built = [];
  for (const pick of legs) {
    const event = pick.event;
    if (!event) return { ok: false, error: 'That race is gone.' };
    if (!isEventBettable(event)) return { ok: false, error: 'That race already closed.' };
    if (seenEvents.has(event.id)) return { ok: false, error: 'Pick one horse in each race.' };
    seenEvents.add(event.id);
    const entry = getEntry(event, pick.entryNumber);
    if (!entry) return { ok: false, error: 'Entry not found.' };
    const odds = Number(entry.odds);
    if (!Number.isFinite(odds) || odds <= 0) return { ok: false, error: 'That horse has no payout.' };
    const committed = raceAlreadyCommitted(user, event.id);
    if (committed) return { ok: false, error: `${event.name}: ${committed}` };
    built.push({
      eventId: event.id,
      eventName: event.name,
      entryNumber: entry.number,
      entryName: entry.name,
      oddsAtBet: odds,
      status: 'open',
    });
  }

  const delta = Math.trunc(stake);
  if (!Number.isFinite(delta) || delta < WEB_BET_MIN || delta > WEB_BET_MAX) {
    return { ok: false, error: `Use a whole number from ${WEB_BET_MIN} to ${formatCoins(WEB_BET_MAX)} carrots.` };
  }
  const balance = user.gambaCoins ?? 0;
  if (delta > balance) {
    return { ok: false, error: `Not enough carrots. You have ${formatCoins(balance)}.` };
  }

  const parlay = {
    parlayId: randomUUID(),
    chainId: chain?.id || null,
    chainName: chain?.name || null,
    stake: delta,
    combinedOdds: combinedOddsOf(built),
    legs: built,
    placedAt: new Date().toISOString(),
  };
  user.gambaCoins = balance - delta;
  user.openParlays = [...(user.openParlays || []), parlay];
  return { ok: true, parlay, payoutIfHit: parlayPayout(delta, built), user };
}

export function placeTournamentParlay(user, tournament, picks, stake) {
  const rounds = tournament?.rounds || [];
  const openRounds = rounds.filter((round) =>
    (round.eventIds || []).some((eventId) => isEventBettable(getEvent(eventId))),
  );
  if (openRounds.length < PARLAY_MIN_LEGS || openRounds.length > PARLAY_MAX_LEGS) {
    return { ok: false, error: `A chain needs ${PARLAY_MIN_LEGS} to ${PARLAY_MAX_LEGS} open rounds.` };
  }
  const chain = {
    id: tournament.id,
    name: tournament.name,
    stages: openRounds.map((round) => ({
      id: round.id,
      label: round.label,
      eventIds: (round.eventIds || []).filter((eventId) => isEventBettable(getEvent(eventId))),
    })),
  };
  return placeParlay(user, picks, stake, { chain });
}

export function placePickem(user, tournament, round, picks, stake) {
  const eventIds = (round?.eventIds || []).map(String);
  const slots = Array.isArray(round?.advanceSlots) ? round.advanceSlots : [];
  if (!eventIds.length) return { ok: false, error: 'That round has no matches.' };
  const legs = Array.isArray(picks) ? picks : [];
  const slotCount = eventIds.length + slots.length;
  if (legs.length !== slotCount) return { ok: false, error: 'Fill every match and every advance slot.' };
  const seen = new Set();
  const built = [];
  for (const pick of legs) {
    if (pick.kind === 'advance') continue;
    const event = pick.event || getEvent(pick.eventId);
    if (!event || !eventIds.includes(String(event.id))) return { ok: false, error: 'That race is not in this round.' };
    if (!isEventBettable(event)) return { ok: false, error: 'Every match in the round has to be open.' };
    if (seen.has(event.id)) return { ok: false, error: 'Pick one horse in each match.' };
    seen.add(event.id);
    const entry = getEntry(event, pick.entryNumber);
    if (!entry) return { ok: false, error: 'Entry not found.' };
    const committed = raceAlreadyCommitted(user, event.id);
    if (committed) return { ok: false, error: `${event.name}: ${committed}` };
    built.push({
      kind: 'match',
      eventId: event.id,
      eventName: event.name,
      entryNumber: entry.number,
      entryName: entry.name,
      status: 'open',
    });
  }
  if (seen.size !== eventIds.length) return { ok: false, error: 'Pick one horse in every match.' };
  for (const slot of slots) {
    const pick = legs.find((item) => item.kind === 'advance' && String(item.slotId) === slot.id);
    if (!pick) return { ok: false, error: `Pick who fills ${slot.label}.` };
    const event = getEvent(pick.eventId);
    if (!event || !(slot.eventIds || []).map(String).includes(String(event.id))) {
      return { ok: false, error: `${slot.label} has to come from its listed races.` };
    }
    if (!isEventBettable(event)) return { ok: false, error: 'Every match in the round has to be open.' };
    const entry = getEntry(event, pick.entryNumber);
    if (!entry) return { ok: false, error: 'Entry not found.' };
    built.push({
      kind: 'advance',
      slotId: slot.id,
      slotLabel: slot.label,
      eventId: event.id,
      eventName: event.name,
      entryNumber: entry.number,
      entryName: entry.name,
      status: 'open',
    });
  }
  for (const eventId of eventIds) {
    if (!isEventBettable(getEvent(eventId))) return { ok: false, error: 'Every match in the round has to be open.' };
  }

  const delta = Math.trunc(stake);
  if (!Number.isFinite(delta) || delta < WEB_BET_MIN || delta > WEB_BET_MAX) {
    return { ok: false, error: `Use a whole number from ${WEB_BET_MIN} to ${formatCoins(WEB_BET_MAX)} carrots.` };
  }
  const balance = user.gambaCoins ?? 0;
  if (delta > balance) return { ok: false, error: `Not enough carrots. You have ${formatCoins(balance)}.` };

  const payouts = (round.pickemPayouts || []).slice(0, slotCount + 1).map((value) => {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? Math.min(PICKEM_MAX_MULTIPLIER, number) : 0;
  });
  while (payouts.length <= slotCount) payouts.push(0);

  user.gambaCoins = balance - delta;
  const pickem = {
    pickemId: randomUUID(),
    tournamentId: tournament.id,
    tournamentName: tournament.name,
    roundId: round.id,
    roundLabel: round.label,
    stake: delta,
    payouts,
    legs: built,
    placedAt: new Date().toISOString(),
  };
  user.openPickems = [...(user.openPickems || []), pickem];
  return { ok: true, pickem, user };
}

function parlayHistoryRow(parlay, won, pay) {
  const names = parlay.legs.map((leg) => `#${leg.entryNumber} ${leg.entryName}`).join(', ');
  return {
    kind: 'parlay',
    parlayId: parlay.parlayId,
    chainId: parlay.chainId || null,
    chainName: parlay.chainName || null,
    eventId: `parlay:${parlay.parlayId}`,
    eventName: parlay.chainName || `${parlay.legs.length}-pick ticket`,
    entryNumber: null,
    entryName: names,
    legs: parlay.legs,
    amount: parlay.stake,
    oddsAtBet: parlay.combinedOdds,
    result: won ? 'win' : 'loss',
    payout: pay,
    settledAt: new Date().toISOString(),
  };
}

export function settleParlaysForEvent(usersById, event, winningEntryNumber) {
  let settled = 0;
  for (const user of Object.values(usersById || {})) {
    const remaining = [];
    for (const parlay of user.openParlays || []) {
      const leg = (parlay.legs || []).find((item) => item.eventId === event.id && item.status === 'open');
      if (!leg) {
        remaining.push(parlay);
        continue;
      }
      leg.status = leg.entryNumber === winningEntryNumber ? 'won' : 'lost';
      leg.settledAt = new Date().toISOString();
      const lost = parlay.legs.some((item) => item.status === 'lost');
      const allWon = parlay.legs.every((item) => item.status === 'won');
      if (!lost && !allWon) {
        remaining.push(parlay);
        continue;
      }
      for (const other of parlay.legs) {
        if (other.status === 'open') other.status = 'skipped';
      }
      const pay = allWon ? parlayPayout(parlay.stake, parlay.legs) : 0;
      if (allWon) user.gambaCoins = (user.gambaCoins ?? 0) + pay;
      if (allWon) user.gambaWins = (user.gambaWins || 0) + 1;
      else user.gambaLosses = (user.gambaLosses || 0) + 1;
      user.gambaWr = formatGambaWr(user.gambaWins, user.gambaLosses);
      user.betHistory = trimHistory([...(user.betHistory || []), parlayHistoryRow(parlay, allWon, pay)]);
      settled += 1;
    }
    user.openParlays = remaining;
  }
  return { settled };
}

function pickemHistoryRow(card, pay) {
  const names = card.legs.map((leg) => `#${leg.entryNumber} ${leg.entryName}`).join(', ');
  const correct = card.legs.filter((leg) => leg.status === 'won').length;
  return {
    kind: 'pickem',
    pickemId: card.pickemId,
    tournamentId: card.tournamentId || null,
    eventId: `pickem:${card.pickemId}`,
    eventName: `${card.tournamentName || 'Tournament'} · ${card.roundLabel || 'Pick\'em'}`,
    entryNumber: null,
    entryName: names,
    legs: card.legs,
    amount: card.stake,
    oddsAtBet: Number(card.payouts?.[correct]) || 0,
    result: pay > 0 ? 'win' : 'loss',
    payout: pay,
    settledAt: new Date().toISOString(),
  };
}

function payPickem(user, card) {
  const correct = card.legs.filter((item) => item.status === 'won').length;
  const multiplier = Number(card.payouts?.[correct]) || 0;
  const pay = Math.floor(card.stake * multiplier);
  if (pay > 0) user.gambaCoins = (user.gambaCoins ?? 0) + pay;
  if (pay > 0) user.gambaWins = (user.gambaWins || 0) + 1;
  else user.gambaLosses = (user.gambaLosses || 0) + 1;
  user.gambaWr = formatGambaWr(user.gambaWins, user.gambaLosses);
  user.betHistory = trimHistory([...(user.betHistory || []), pickemHistoryRow(card, pay)]);
}

export function settlePickemsForEvent(usersById, event, winningEntryNumber) {
  let settled = 0;
  for (const user of Object.values(usersById || {})) {
    const remaining = [];
    for (const card of user.openPickems || []) {
      const leg = (card.legs || []).find((item) =>
        (item.kind || 'match') === 'match' && item.eventId === event.id && item.status === 'open',
      );
      if (!leg) {
        remaining.push(card);
        continue;
      }
      leg.status = leg.entryNumber === winningEntryNumber ? 'won' : 'lost';
      leg.settledAt = new Date().toISOString();
      if (card.legs.some((item) => item.status === 'open')) {
        remaining.push(card);
        continue;
      }
      payPickem(user, card);
      settled += 1;
    }
    user.openPickems = remaining;
  }
  return { settled };
}

export function settleAdvancePickems(usersById, { tournamentId, roundId, advanceResults }) {
  const results = advanceResults && typeof advanceResults === 'object' ? advanceResults : {};
  let settled = 0;
  for (const user of Object.values(usersById || {})) {
    const remaining = [];
    for (const card of user.openPickems || []) {
      if (card.tournamentId !== tournamentId || card.roundId !== roundId) {
        remaining.push(card);
        continue;
      }
      for (const leg of card.legs || []) {
        if (leg.kind !== 'advance' || leg.status !== 'open') continue;
        const result = results[leg.slotId];
        if (!result) continue;
        const hit = String(result.eventId) === String(leg.eventId) && Number(result.entryNumber) === Number(leg.entryNumber);
        leg.status = hit ? 'won' : 'lost';
        leg.settledAt = new Date().toISOString();
      }
      if (card.legs.some((item) => item.status === 'open')) {
        remaining.push(card);
        continue;
      }
      payPickem(user, card);
      settled += 1;
    }
    user.openPickems = remaining;
  }
  return { settled };
}

export function settleEvent(usersById, event, winningEntryNumber) {
  const winner = getEntry(event, winningEntryNumber);
  if (!winner) return { ok: false, error: 'Invalid winning entry number.' };

  let winnersPaid = 0;
  let ticketsSettled = 0;
  const results = [];

  for (const [discordUserId, user] of Object.entries(usersById)) {
    const eventTickets = getUserEventTickets(user, event.id);
    if (!eventTickets.length) continue;

    const won = eventTickets[0].entryNumber === winningEntryNumber;
    let totalWagered = 0;
    let totalPayout = 0;

    for (const ticket of eventTickets) {
      const ticketWon = ticket.entryNumber === winningEntryNumber;
      const pay = ticketWon ? payout(ticket.amount, ticket.oddsAtBet) : 0;
      totalWagered += ticket.amount;
      totalPayout += pay;
      if (ticketWon) {
        user.gambaCoins = (user.gambaCoins ?? 0) + pay;
        winnersPaid += 1;
      }

      user.betHistory = trimHistory([
        ...(user.betHistory || []),
        {
          eventId: event.id,
          eventName: event.name,
          entryNumber: ticket.entryNumber,
          entryName: ticket.entryName,
          amount: ticket.amount,
          oddsAtBet: ticket.oddsAtBet,
          result: ticketWon ? 'win' : 'loss',
          payout: pay,
          settledAt: new Date().toISOString(),
          winner: winningEntryNumber,
          winnerName: winner.name,
        },
      ]);
      ticketsSettled += 1;
    }

    user.openTickets = (user.openTickets || []).filter((ticket) => ticket.eventId !== event.id);

    if (won) user.gambaWins = (user.gambaWins || 0) + 1;
    else user.gambaLosses = (user.gambaLosses || 0) + 1;
    user.gambaWr = formatGambaWr(user.gambaWins, user.gambaLosses);

    results.push({
      discordUserId,
      displayName: user.trainerName || 'Trainer',
      entryNumber: eventTickets[0].entryNumber,
      entryName: eventTickets[0].entryName,
      totalWagered,
      totalPayout,
      won,
      netGain: totalPayout - totalWagered,
    });
  }

  results.sort((a, b) => {
    if (a.won !== b.won) return a.won ? -1 : 1;
    return b.netGain - a.netGain;
  });

  return {
    ok: true,
    winner,
    winnersPaid,
    ticketsSettled,
    results,
  };
}

export function collectEventSettlementResults(usersById, eventId, storedResults = null) {
  if (Array.isArray(storedResults) && storedResults.length) {
    return storedResults.map((entry) => ({ ...entry }));
  }

  const byUser = new Map();
  for (const [discordUserId, user] of Object.entries(usersById || {})) {
    const entries = (user.betHistory || []).filter((item) => item.eventId === eventId);
    if (!entries.length) continue;

    let totalWagered = 0;
    let totalPayout = 0;
    for (const entry of entries) {
      totalWagered += entry.amount;
      totalPayout += entry.payout || 0;
    }

    const won = entries.some((item) => item.result === 'win');
    byUser.set(discordUserId, {
      discordUserId,
      displayName: user.trainerName || 'Trainer',
      entryNumber: entries[0].entryNumber,
      entryName: entries[0].entryName,
      totalWagered,
      totalPayout,
      won,
      netGain: totalPayout - totalWagered,
    });
  }

  return [...byUser.values()];
}

export function collectAllUsersForBets() {
  const users = {};
  for (const link of listGambaWalletUsers()) {
    users[link.discordUserId] = {
      trainerName: link.trainerName,
      gambaCoins: link.gambaCoins,
      openTickets: link.openTickets || [],
      openParlays: link.openParlays || [],
      betHistory: link.betHistory || [],
    };
  }
  return users;
}

export function getWalletUser(discordUserId) {
  const link = getUserLink(discordUserId);
  if (!link) return null;
  return {
    trainerName: link.trainerName,
    gambaCoins: link.gambaCoins,
    openTickets: link.openTickets || [],
    openParlays: link.openParlays || [],
    betHistory: link.betHistory || [],
  };
}

export function groupTicketsByEvent(tickets) {
  const groups = new Map();
  for (const ticket of tickets || []) {
    const key = ticket.eventId || ticket.eventName;
    if (!groups.has(key)) {
      groups.set(key, {
        eventName: ticket.eventName,
        entryNumber: ticket.entryNumber,
        entryName: ticket.entryName,
        amount: 0,
      });
    }
    groups.get(key).amount += ticket.amount;
  }
  return [...groups.values()];
}

export function groupHistoryByEvent(history) {
  const groups = new Map();
  for (const entry of history || []) {
    if (entry.kind === 'parlay') {
      const key = `parlay:${entry.parlayId || entry.settledAt}`;
      groups.set(key, {
        kind: 'parlay',
        eventName: entry.eventName,
        entryNumber: null,
        entryName: entry.entryName,
        amount: entry.amount || 0,
        payout: entry.payout || 0,
        result: entry.result,
        settledAt: entry.settledAt,
      });
      continue;
    }
    const key = entry.eventId || entry.eventName;
    if (!groups.has(key)) {
      groups.set(key, {
        eventName: entry.eventName,
        entryNumber: entry.entryNumber,
        entryName: entry.entryName,
        amount: 0,
        payout: 0,
        result: entry.result,
        settledAt: entry.settledAt,
      });
    }
    const group = groups.get(key);
    group.amount += entry.amount;
    group.payout += entry.payout || 0;
    if (new Date(entry.settledAt) > new Date(group.settledAt)) {
      group.settledAt = entry.settledAt;
    }
  }
  return [...groups.values()].sort(
    (a, b) => new Date(b.settledAt).getTime() - new Date(a.settledAt).getTime(),
  );
}

export function buildGambleProfileFields({ openTickets = [], betHistory = [], openParlays = [] } = {}) {
  const groupedOpen = groupTicketsByEvent(openTickets);
  const lines = groupedOpen.map(
    (ticket) =>
      `• ${ticket.eventName} — #${ticket.entryNumber} ${ticket.entryName}: ${formatCoins(ticket.amount)}`,
  );
  for (const parlay of openParlays || []) {
    const names = (parlay.legs || []).map((leg) => `#${leg.entryNumber} ${leg.entryName}`).join(', ');
    const title = parlay.chainName || `${(parlay.legs || []).length}-pick ticket`;
    lines.push(`• 🎟️ ${title} — ${names}: ${formatCoins(parlay.stake)} (×${formatOdds(parlay.combinedOdds)})`);
  }
  const openValue = lines.length ? lines.join('\n') : '_None_';

  const history = groupHistoryByEvent(betHistory).slice(0, PROFILE_HISTORY);
  const historyValue = history.length
    ? history
        .map((entry) => {
          const icon = entry.result === 'win' ? '✅' : '❌';
          const pay =
            entry.result === 'win'
              ? `+${formatCoins(entry.payout)}`
              : `-${formatCoins(entry.amount)}`;
          if (entry.kind === 'parlay') {
            return `${icon} ${entry.eventName} — ${entry.entryName} — ${pay}`;
          }
          return `${icon} ${entry.eventName} #${entry.entryNumber} ${entry.entryName} — ${pay}`;
        })
        .join('\n')
    : '_No settled bets yet_';

  return [
    { name: '🎰 Open Tickets', value: openValue.slice(0, 1024), inline: false },
    {
      name: `📜 Last ${PROFILE_HISTORY} Results`,
      value: historyValue.slice(0, 1024),
      inline: false,
    },
  ];
}
