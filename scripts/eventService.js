import { saveAllUsersFromSettlement, loadAllUsersForSettlement } from './clubDatabase.js';
import { buildEventBetsEmbed } from './eventBetsBoard.js';
import { collectAllUsersForBets, settleEvent } from './eventGambling.js';
import {
  deleteChannelMessage,
  editChannelMessage,
  sendChannelMessage,
} from './quizDiscord.js';
import {
  getEligibleEventChannels,
  getEvent,
  getEventPost,
  listCatchUpEvents,
  listEvents,
  listSettleableEvents,
  patchEventRuntime,
  reloadEventDefinitions,
  upsertEventPost,
} from './eventStorage.js';
import { buildAllEventMessagePayloads, buildEventMessagePayload } from './eventUi.js';

function isChannelUnavailableError(err) {
  const message = String(err?.message || err || '');
  return message.includes('50001') || message.includes('50013') || message.includes('10003');
}

export function reloadEventsFromDisk() {
  return reloadEventDefinitions();
}

export async function postEventToChannel(event, guildId, channelId) {
  try {
    const payloads = buildAllEventMessagePayloads(event);
    const existing = getEventPost(guildId, event.id);
    const horseMessages = [];

    for (const { chunk, payload } of payloads) {
      const prior = existing?.horseMessages?.find((item) => item.chunk === chunk);
      if (prior?.messageId) {
        await editChannelMessage(channelId, prior.messageId, payload);
        horseMessages.push({ messageId: prior.messageId, chunk });
      } else {
        const message = await sendChannelMessage(channelId, payload);
        horseMessages.push({ messageId: message.id, chunk });
      }
    }

    if (existing?.horseMessages?.length) {
      for (const prior of existing.horseMessages) {
        if (!horseMessages.some((item) => item.chunk === prior.chunk)) {
          await deleteChannelMessage(channelId, prior.messageId);
        }
      }
    }

    const betsEmbed = buildEventBetsEmbed(event, collectAllUsersForBets());
    let betsMessageId = existing?.betsMessageId || null;
    if (betsMessageId) {
      await editChannelMessage(channelId, betsMessageId, { embeds: [betsEmbed] });
    } else {
      const betsMessage = await sendChannelMessage(channelId, { embeds: [betsEmbed] });
      betsMessageId = betsMessage.id;
    }

    upsertEventPost({
      guildId,
      eventId: event.id,
      channelId,
      horseMessages,
      betsMessageId,
    });
    return { ok: true };
  } catch (err) {
    if (isChannelUnavailableError(err)) {
      console.warn(
        `postEventToChannel: guild ${guildId} channel ${channelId} unavailable (${err.message})`,
      );
      return { ok: false, channelUnavailable: true };
    }
    throw err;
  }
}

export async function refreshEventInChannel(event, guildId, channelId) {
  return postEventToChannel(event, guildId, channelId);
}

export async function refreshEventEverywhere(eventId) {
  const event = getEvent(eventId);
  if (!event) return { ok: false, error: 'Event not found.' };

  const channels = getEligibleEventChannels(event);
  let refreshed = 0;
  let skipped = 0;
  for (const channel of channels) {
    const post = getEventPost(channel.guildId, event.id);
    if (!post) continue;
    const result = await refreshEventInChannel(event, channel.guildId, post.channelId);
    if (result.ok) refreshed += 1;
    else if (result.channelUnavailable) skipped += 1;
  }

  return { ok: true, event, refreshed, skipped };
}

export async function postEventEverywhere(eventId) {
  reloadEventsFromDisk();
  const event = getEvent(eventId);
  if (!event) return { ok: false, error: 'Event not found.' };

  const opened = patchEventRuntime(event.id, {
    status: 'open',
    postedAt: new Date().toISOString(),
  });
  const channels = getEligibleEventChannels(opened);
  if (!channels.length) {
    return { ok: false, error: 'No subscribed event channels match this event.' };
  }

  let posted = 0;
  let skipped = 0;
  for (const channel of channels) {
    const result = await postEventToChannel(opened, channel.guildId, channel.channelId);
    if (result.ok) posted += 1;
    else if (result.channelUnavailable) skipped += 1;
  }

  if (!posted && skipped) {
    return { ok: false, error: 'Could not post to any event channels (missing channel access).' };
  }

  return { ok: true, event: opened, posted, skipped };
}

export async function catchUpGuildEvents(guildId, channelId) {
  const events = listCatchUpEvents().filter((event) =>
    getEligibleEventChannels(event).some((entry) => String(entry.guildId) === String(guildId)),
  );

  let posted = 0;
  for (const event of events) {
    const result = await postEventToChannel(event, guildId, channelId);
    if (!result.ok) {
      return { posted, channelUnavailable: Boolean(result.channelUnavailable) };
    }
    posted += 1;
  }

  return { posted, channelUnavailable: false };
}

export async function refreshBetsBoardForEvent(eventId) {
  const event = getEvent(eventId);
  if (!event) return;
  const users = collectAllUsersForBets();
  const channels = getEligibleEventChannels(event);
  for (const channel of channels) {
    const post = getEventPost(channel.guildId, event.id);
    if (!post?.betsMessageId) continue;
    try {
      await editChannelMessage(channel.channelId, post.betsMessageId, {
        embeds: [buildEventBetsEmbed(event, users)],
      });
    } catch (err) {
      if (isChannelUnavailableError(err)) {
        console.warn(
          `refreshBetsBoardForEvent: guild ${channel.guildId} channel ${channel.channelId} unavailable (${err.message})`,
        );
        continue;
      }
      throw err;
    }
  }
}

export async function closeDueEvents() {
  reloadEventsFromDisk();
  const now = Date.now();
  const closed = [];

  for (const event of listEvents()) {
    if (event.status !== 'open') continue;
    const endsAt = new Date(event.endsAt).getTime();
    if (!Number.isFinite(endsAt) || now < endsAt) continue;

    const updated = patchEventRuntime(event.id, {
      status: 'closed',
      closedAt: new Date().toISOString(),
    });
    await refreshEventEverywhere(event.id);
    closed.push(updated);
  }

  return closed;
}

export async function settleEventEverywhere(eventId, winningEntryNumber) {
  const event = getEvent(eventId);
  if (!event) return { ok: false, error: 'Event not found.' };
  if (event.status === 'settled') return { ok: false, error: 'Event already settled.' };

  const users = loadAllUsersForSettlement();
  const result = settleEvent(users, event, winningEntryNumber);
  if (!result.ok) return result;

  saveAllUsersFromSettlement(users);
  const settled = patchEventRuntime(event.id, {
    status: 'settled',
    winner: winningEntryNumber,
    settledAt: new Date().toISOString(),
    settlementResults: result.results,
  });
  await refreshEventEverywhere(event.id);

  return { ok: true, event: settled, result };
}

export function buildEventAutocompleteChoices(query) {
  const q = String(query || '').trim().toLowerCase();
  const events = listSettleableEvents();
  const matches = q
    ? events.filter(
        (event) =>
          event.id.toLowerCase().includes(q) || event.name.toLowerCase().includes(q),
      )
    : events;
  return matches.slice(0, 25).map((event) => ({
    name: `${event.id} — ${event.name}`.slice(0, 100),
    value: event.id,
  }));
}
