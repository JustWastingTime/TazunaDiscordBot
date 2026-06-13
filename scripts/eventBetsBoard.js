import {
  formatCoins,
  formatCutoff,
  getEntry,
  getEventPhase,
} from './eventGambling.js';

export const BETTOR_LINES_PER_ENTRY = 8;

function escapeMarkdown(value) {
  return String(value).replace(/([*_`~|\\])/g, '\\$1');
}

export function collectEventBets(usersById, eventId) {
  const byEntry = new Map();

  for (const [discordUserId, user] of Object.entries(usersById || {})) {
    const tickets = (user.openTickets || []).filter((ticket) => ticket.eventId === eventId);
    for (const ticket of tickets) {
      if (!byEntry.has(ticket.entryNumber)) {
        byEntry.set(ticket.entryNumber, {
          entryNumber: ticket.entryNumber,
          entryName: ticket.entryName,
          bettors: new Map(),
        });
      }
      const group = byEntry.get(ticket.entryNumber);
      if (!group.bettors.has(discordUserId)) {
        group.bettors.set(discordUserId, {
          displayName: user.trainerName || 'Trainer',
          parts: [],
        });
      }
      group.bettors.get(discordUserId).parts.push({
        amount: ticket.amount,
        oddsAtBet: ticket.oddsAtBet,
      });
    }
  }

  return [...byEntry.values()].sort((a, b) => a.entryNumber - b.entryNumber);
}

function formatBettorLine(bettor) {
  const total = bettor.parts.reduce((sum, part) => sum + part.amount, 0);
  const oddsGroups = new Map();
  for (const part of bettor.parts) {
    oddsGroups.set(part.oddsAtBet, (oddsGroups.get(part.oddsAtBet) || 0) + part.amount);
  }
  const oddsParts = [...oddsGroups.entries()].map(
    ([odds, amount]) => `${formatCoins(amount)} @ ${odds}`,
  );
  const detail = oddsParts.length === 1 ? oddsParts[0] : oddsParts.join(' + ');
  return `• **${escapeMarkdown(bettor.displayName)}** — ${detail} (${formatCoins(total)} total)`;
}

export function buildEventBetsEmbed(event, usersById) {
  const groups = collectEventBets(usersById, event.id);
  let totalPool = 0;
  let bettorCount = 0;

  for (const group of groups) {
    for (const bettor of group.bettors.values()) {
      bettorCount += 1;
      totalPool += bettor.parts.reduce((sum, part) => sum + part.amount, 0);
    }
  }

  const lines = [];
  switch (getEventPhase(event)) {
    case 'settled': {
      const winner = getEntry(event, event.winner);
      lines.push(`🏁 **Settled** — Winner: **#${event.winner} ${winner?.name || '?'}**`, '');
      break;
    }
    case 'open':
      lines.push(`🟢 **Bets open** · Cutoff ${formatCutoff(event.endsAt)}`, '');
      break;
    case 'scheduled':
      lines.push('⏳ **Scheduled** — Bets not open yet', '');
      break;
    default:
      lines.push('🔴 **Bets closed**', '');
  }

  lines.push('_One horse per bettor per event._', '');

  if (!groups.length) {
    lines.push('_No bets placed yet._');
  } else {
    for (const group of groups) {
      const horsePool = [...group.bettors.values()].reduce(
        (sum, bettor) => sum + bettor.parts.reduce((inner, part) => inner + part.amount, 0),
        0,
      );
      lines.push(
        `**#${group.entryNumber} ${group.entryName}** — ${formatCoins(horsePool)} coins`,
      );
      const bettors = [...group.bettors.values()];
      const visible = bettors.slice(0, BETTOR_LINES_PER_ENTRY);
      for (const bettor of visible) {
        lines.push(formatBettorLine(bettor));
      }
      const hidden = bettors.length - visible.length;
      if (hidden > 0) {
        lines.push(`_…and ${hidden} more._`);
      }
      lines.push('');
    }
  }

  let description = lines.join('\n').trim();
  if (description.length > 3900) {
    description = `${description.slice(0, 3880).trimEnd()}…`;
  }

  return {
    color: event.status === 'settled' ? 0x57f287 : 0x5865f2,
    title: `📊 ${event.name} — Live Bets`,
    description,
    footer: {
      text: groups.length
        ? `${formatCoins(totalPool)} coins across ${bettorCount} pick${bettorCount === 1 ? '' : 's'}`
        : 'Updates when players bet',
    },
    timestamp: new Date().toISOString(),
  };
}
