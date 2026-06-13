import { randomUUID } from 'crypto';
import { getUserLink, listGambaWalletUsers } from './clubDatabase.js';

export const BET_AMOUNTS = [10, 50, 100, 500];
export const BET_HISTORY_LIMIT = 50;

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
