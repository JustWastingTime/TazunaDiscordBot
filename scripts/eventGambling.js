import { randomUUID } from 'crypto';
import { formatGambaWr, getUserLink, listGambaWalletUsers } from './clubDatabase.js';

export const BET_AMOUNTS = [10, 50, 100, 500];
export const BET_HISTORY_LIMIT = 50;
export const PROFILE_HISTORY = 5;

export function formatCoins(amount) {
  return Math.trunc(amount).toLocaleString('en-US');
}

export function payout(amount, odds) {
  return Math.floor(amount * odds);
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

export function placeBet(user, event, entryNumber, amount) {
  const entry = getEntry(event, entryNumber);
  if (!entry) return { ok: false, error: 'Entry not found.' };

  const delta = Math.trunc(amount);
  if (!BET_AMOUNTS.includes(delta)) {
    return { ok: false, error: 'Invalid bet amount.' };
  }

  const lockedEntry = getUserEventHorse(user, event.id);
  if (lockedEntry != null && lockedEntry !== entryNumber) {
    const locked = getEntry(event, lockedEntry);
    return {
      ok: false,
      error:
        `You already bet on **#${lockedEntry} ${locked?.name || '?'}** for this event. ` +
        'You can only pick **one** horse per event.',
    };
  }

  const balance = user.gambaCoins ?? 0;
  if (delta > balance) {
    return {
      ok: false,
      error: `Not enough GambaCoins. You have **${formatCoins(balance)}** but tried **${formatCoins(delta)}**.`,
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

export function buildGambleProfileFields({ openTickets = [], betHistory = [] } = {}) {
  const groupedOpen = groupTicketsByEvent(openTickets);
  const openValue = groupedOpen.length
    ? groupedOpen
        .map(
          (ticket) =>
            `• ${ticket.eventName} — #${ticket.entryNumber} ${ticket.entryName}: ${formatCoins(ticket.amount)}`,
        )
        .join('\n')
    : '_None_';

  const history = groupHistoryByEvent(betHistory).slice(0, PROFILE_HISTORY);
  const historyValue = history.length
    ? history
        .map((entry) => {
          const icon = entry.result === 'win' ? '✅' : '❌';
          const pay =
            entry.result === 'win'
              ? `+${formatCoins(entry.payout)}`
              : `-${formatCoins(entry.amount)}`;
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
