import {
  collectEventSettlementResults,
  formatCoins,
  formatCutoff,
  getEntry,
  getEventPhase,
} from './eventGambling.js';

export const BETTOR_LINES_PER_ENTRY = 8;
export const SETTLEMENT_WINNERS_SHOWN = 20;
export const SETTLEMENT_LOSERS_SHOWN = 15;
const EMBED_DESCRIPTION_LIMIT = 3900;

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

function formatSettlementWinnerLine(entry) {
  return `• **${escapeMarkdown(entry.displayName)}** — +${formatCoins(entry.netGain)} coins`;
}

function formatSettlementLoserLine(entry) {
  const loss = Math.max(0, entry.totalWagered - entry.totalPayout);
  return (
    `• **${escapeMarkdown(entry.displayName)}** — -${formatCoins(loss)} coins ` +
    `(#${entry.entryNumber} ${entry.entryName})`
  );
}

function appendSettlementSection(lines, {
  title,
  entries,
  formatLine,
  maxVisible,
}) {
  if (!entries.length) return maxVisible;

  lines.push(title);
  let visibleCount = Math.min(maxVisible, entries.length);
  while (visibleCount > 0) {
    const sectionLines = entries.slice(0, visibleCount).map(formatLine);
    const hidden = entries.length - visibleCount;
    const candidate = [
      ...lines,
      ...sectionLines,
      ...(hidden > 0 ? [`_…and ${hidden} more._`] : []),
    ];
    if (candidate.join('\n').length <= EMBED_DESCRIPTION_LIMIT || visibleCount === 1) {
      lines.push(...sectionLines);
      if (hidden > 0) {
        lines.push(`_…and ${hidden} more._`);
      }
      return visibleCount;
    }
    visibleCount -= 1;
  }

  return 0;
}

function buildSettledResultsLines(event, usersById) {
  const results = collectEventSettlementResults(
    usersById,
    event.id,
    event.settlementResults,
  );
  if (!results.length) {
    return { lines: ['_No bets were placed for this event._'], bettorCount: 0 };
  }

  const winners = results
    .filter((entry) => entry.won)
    .sort((a, b) => b.netGain - a.netGain || b.totalPayout - a.totalPayout);
  const losers = results
    .filter((entry) => !entry.won)
    .sort(
      (a, b) =>
        a.netGain - b.netGain ||
        b.totalWagered - a.totalWagered,
    );

  const lines = [];
  const winnerEntry = getEntry(event, event.winner);
  const winnersTitle = winnerEntry
    ? `**Winners** (#${event.winner} ${winnerEntry.name})`
    : '**Winners**';

  appendSettlementSection(lines, {
    title: winnersTitle,
    entries: winners,
    formatLine: formatSettlementWinnerLine,
    maxVisible: SETTLEMENT_WINNERS_SHOWN,
  });

  if (winners.length && losers.length) {
    lines.push('');
  }

  appendSettlementSection(lines, {
    title: '**Biggest Losers**',
    entries: losers,
    formatLine: formatSettlementLoserLine,
    maxVisible: SETTLEMENT_LOSERS_SHOWN,
  });

  return { lines, bettorCount: results.length };
}

export function buildEventBetsEmbed(event, usersById) {
  const phase = getEventPhase(event);
  const groups = phase === 'settled' ? [] : collectEventBets(usersById, event.id);
  let totalPool = 0;
  let bettorCount = 0;

  for (const group of groups) {
    for (const bettor of group.bettors.values()) {
      bettorCount += 1;
      totalPool += bettor.parts.reduce((sum, part) => sum + part.amount, 0);
    }
  }

  const lines = [];
  switch (phase) {
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

  if (phase === 'settled') {
    const settled = buildSettledResultsLines(event, usersById);
    lines.push(...settled.lines);
    bettorCount = settled.bettorCount;
  } else if (!groups.length) {
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
  if (description.length > EMBED_DESCRIPTION_LIMIT) {
    description = `${description.slice(0, EMBED_DESCRIPTION_LIMIT - 20).trimEnd()}…`;
  }

  const footerText =
    phase === 'settled'
      ? bettorCount
        ? `${bettorCount} bettor${bettorCount === 1 ? '' : 's'} settled`
        : 'Event settled'
      : groups.length
        ? `${formatCoins(totalPool)} coins across ${bettorCount} pick${bettorCount === 1 ? '' : 's'}`
        : 'Updates when players bet';

  return {
    color: event.status === 'settled' ? 0x57f287 : 0x5865f2,
    title: `📊 ${event.name} — Live Bets`,
    description,
    footer: { text: footerText },
    timestamp: new Date().toISOString(),
  };
}
