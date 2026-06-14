import {
  formatCutoff,
  getEventPhase,
  isEventBettable,
} from './eventGambling.js';

export const EVENT_V2_FLAG = 1 << 15;
export const HORSES_PER_MESSAGE = 10;

function eventTitleEmoji(event) {
  return event.type === 'misc' ? '🎲' : '🏇';
}

function eventStatusLine(event) {
  switch (getEventPhase(event)) {
    case 'settled':
      return `🏁 **Settled** — Winner: #${event.winner}`;
    case 'open':
      return '🟢 **Bets open**';
    case 'scheduled':
      return '⏳ **Scheduled** — Waiting to open';
    default:
      return '🔴 **Bets closed**';
  }
}

function eventAccentColor(event) {
  switch (getEventPhase(event)) {
    case 'settled':
      return 0x57f287;
    case 'open':
      return 0xfee75c;
    case 'scheduled':
      return 0x5865f2;
    default:
      return 0xed4245;
  }
}

export function getEventChunkCount(event) {
  const count = event?.entries?.length || 0;
  return Math.max(1, Math.ceil(count / HORSES_PER_MESSAGE));
}

function getEventChunkEntries(event, chunk) {
  const entries = event.entries || [];
  const chunkCount = getEventChunkCount(event);
  const safeChunk = Math.min(Math.max(0, chunk), chunkCount - 1);
  const start = safeChunk * HORSES_PER_MESSAGE;
  return entries.slice(start, start + HORSES_PER_MESSAGE);
}

function formatEntryDisplay(entry) {
  const main = `**#${entry.number} ${entry.name}**  ·  Odds **${entry.odds}**`;
  const sub = [entry.ageSex, entry.jockey].filter(Boolean).join(' · ');
  return sub ? `${main}\n-# ${sub}` : main;
}

function buildChunkHeader(event, chunk) {
  if (chunk !== 0) return null;
  return [
    `# ${eventTitleEmoji(event)} ${event.name}`,
    eventStatusLine(event),
    `**Cutoff:** ${formatCutoff(event.endsAt)}`,
    '_You can only bet on **one** horse per event._',
  ].join('\n');
}

function buildEntrySection(event, entry, bettable) {
  return {
    type: 9,
    components: [{ type: 10, content: formatEntryDisplay(entry) }],
    accessory: {
      type: 2,
      style: 1,
      custom_id: `gamba-bet:${event.id}:${entry.number}`,
      label: 'BET',
      disabled: !bettable,
    },
  };
}

export function buildEventMessagePayload(event, chunk = 0) {
  const chunkCount = getEventChunkCount(event);
  const safeChunk = Math.min(Math.max(0, chunk), chunkCount - 1);
  const chunkEntries = getEventChunkEntries(event, safeChunk);
  const bettable = isEventBettable(event);
  const header = buildChunkHeader(event, safeChunk);
  const inner = [];

  if (header) {
    inner.push({ type: 10, content: header });
    inner.push({ type: 14, divider: true, spacing: 1 });
  }

  for (const entry of chunkEntries) {
    inner.push(buildEntrySection(event, entry, bettable));
  }

  return {
    flags: EVENT_V2_FLAG,
    components: [
      {
        type: 17,
        accent_color: eventAccentColor(event),
        components: inner,
      },
    ],
  };
}

export function buildAllEventMessagePayloads(event) {
  const payloads = [];
  for (let chunk = 0; chunk < getEventChunkCount(event); chunk += 1) {
    payloads.push({ chunk, payload: buildEventMessagePayload(event, chunk) });
  }
  return payloads;
}

export function buildWagerEmbed(event, entry, user) {
  const tickets = (user?.openTickets || []).filter((ticket) => ticket.eventId === event.id);
  const onHorse = tickets.filter((ticket) => ticket.entryNumber === entry.number);
  const totalOnHorse = onHorse.reduce((sum, ticket) => sum + ticket.amount, 0);
  const myBetLines = tickets.length
    ? tickets.map(
        (ticket) =>
          `• **#${ticket.entryNumber} ${ticket.entryName}** — ${ticket.amount} @ ${ticket.oddsAtBet}`,
      )
    : ['_No bets on this event yet._'];

  return {
    color: 0xeb459e,
    title: `Bet on #${entry.number} ${entry.name}`,
    description: [
      `**Odds:** ${entry.odds}`,
      `**Wallet:** ${user.gambaCoins ?? 0} GambaCoins`,
      `**Your total on this horse:** ${totalOnHorse} coins`,
      '',
      '**Your bets on this event**',
      ...myBetLines,
      '',
      '_You can only bet on **one** horse per event._',
    ].join('\n'),
    footer: { text: event.name },
  };
}

export function buildWagerButtons(eventId, entryNumber) {
  return [
    {
      type: 1,
      components: [10, 50, 100, 500].map((amount) => ({
        type: 2,
        style: 3,
        custom_id: `gamba-wager:${eventId}:${entryNumber}:${amount}`,
        label: String(amount),
      })),
    },
  ];
}

export function buildSettleSummaryEmbed(event, result) {
  const lines = [
    `🏁 **Winner:** #${result.winner.number} ${result.winner.name}`,
    `**Tickets settled:** ${result.ticketsSettled}`,
    '',
  ];

  const winners = result.results
    .filter((entry) => entry.won)
    .sort((a, b) => b.netGain - a.netGain || b.totalPayout - a.totalPayout);
  const losers = result.results
    .filter((entry) => !entry.won)
    .sort((a, b) => a.netGain - b.netGain || b.totalWagered - a.totalWagered);

  if (winners.length) {
    lines.push('**Winners**');
    for (const entry of winners.slice(0, 15)) {
      lines.push(
        `✅ **${entry.displayName}** — +${entry.netGain.toLocaleString('en-US')} coins`,
        `   #${entry.entryNumber} ${entry.entryName} · wagered ${entry.totalWagered.toLocaleString('en-US')} → won ${entry.totalPayout.toLocaleString('en-US')}`,
      );
    }
    if (winners.length > 15) lines.push(`_…and ${winners.length - 15} more winners._`);
    lines.push('');
  }

  if (losers.length) {
    lines.push('**Losers**');
    for (const entry of losers.slice(0, 10)) {
      const loss = Math.max(0, entry.totalWagered - entry.totalPayout);
      lines.push(
        `❌ **${entry.displayName}** — -${loss.toLocaleString('en-US')} coins`,
        `   #${entry.entryNumber} ${entry.entryName}`,
      );
    }
    if (losers.length > 10) lines.push(`_…and ${losers.length - 10} more losers._`);
  }

  if (!winners.length && !losers.length) {
    lines.push('_No bets were placed for this event._');
  }

  return {
    color: 0x57f287,
    title: `${event.name} — Settled`,
    description: lines.join('\n').trim(),
    timestamp: new Date().toISOString(),
  };
}
