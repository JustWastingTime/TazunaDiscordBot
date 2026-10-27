import { getEventPhase, isEventBettable } from './eventGambling.js';
import { getEvent, getEventChannels } from './eventStorage.js';
import { getTournament, listTournaments, rememberTournamentPosts } from './gambaTournaments.js';
import { editChannelMessage, sendChannelMessage } from './quizDiscord.js';

function paddockUrl(id) {
  const base = String(process.env.DASHBOARD_PUBLIC_URL || process.env.SITE_URL || '').replace(/\/$/, '');
  const path = `/gamba/tournament/${encodeURIComponent(id)}`;
  return base ? `${base}${path}` : path;
}

function isUnknownMessageError(err) {
  const message = String(err?.message || err || '');
  return message.includes('"code":10008') || message.includes('10008') || /unknown message/i.test(message);
}

export function tournamentStatusLine(tournament) {
  const rounds = tournament?.rounds || [];
  const open = rounds.find((round) => (round.eventIds || []).some((eventId) => isEventBettable(getEvent(eventId))));
  if (open) return `${open.label} is open.`;
  const waiting = rounds.find((round) => (round.eventIds || []).some((eventId) => {
    const phase = getEventPhase(getEvent(eventId));
    return phase === 'scheduled' || phase === 'closed';
  }));
  if (waiting) return `${waiting.label} is next.`;
  return 'Every round is settled.';
}

function cardPayload(tournament) {
  return {
    content: [
      `**${tournament.name}**`,
      tournamentStatusLine(tournament),
      `Bet on the site: ${paddockUrl(tournament.id)}`,
    ].join('\n'),
  };
}

export async function postTournamentCard(tournament) {
  const channels = getEventChannels();
  const posts = [];
  const payload = cardPayload(tournament);
  for (const channel of channels) {
    const channelId = String(channel.channelId || '');
    if (!channelId) continue;
    const prior = (tournament.posts || []).find((post) => String(post.channelId) === channelId);
    let messageId = prior?.messageId || null;
    try {
      if (messageId) {
        try {
          await editChannelMessage(channelId, messageId, payload);
        } catch (err) {
          if (!isUnknownMessageError(err)) throw err;
          messageId = null;
        }
      }
      if (!messageId) {
        const message = await sendChannelMessage(channelId, payload);
        messageId = message.id;
      }
      posts.push({
        guildId: String(channel.guildId),
        channelId,
        messageId: String(messageId),
      });
    } catch (err) {
      console.warn(`postTournamentCard: channel ${channelId} unavailable (${err.message})`);
    }
  }
  return posts;
}

export async function refreshTournamentsForEvent(eventId) {
  const matches = listTournaments().filter((tournament) =>
    (tournament.rounds || []).some((round) => (round.eventIds || []).map(String).includes(String(eventId))),
  );
  for (const tournament of matches) {
    try {
      const posts = await postTournamentCard(tournament);
      rememberTournamentPosts(tournament.id, posts);
    } catch (err) {
      console.warn(`refreshTournamentsForEvent: ${tournament.id} (${err.message})`);
    }
  }
}

export async function refreshTournamentById(id) {
  const tournament = getTournament(id);
  if (!tournament) return null;
  const posts = await postTournamentCard(tournament);
  return rememberTournamentPosts(tournament.id, posts);
}
