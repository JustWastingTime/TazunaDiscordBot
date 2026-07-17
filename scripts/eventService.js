import { saveAllUsersFromSettlement, loadAllUsersForSettlement } from './clubDatabase.js';
import { buildEventBetsEmbed } from './eventBetsBoard.js';
import { collectAllUsersForBets, settleEvent } from './eventGambling.js';
import {
  deleteChannelMessage,
  editChannelMessage,
  sendChannelMessage,
} from './quizDiscord.js';
import {
  getEventPostTargets,
  getEligibleEventChannels,
  getEvent,
  getEventPost,
  listCatchUpEvents,
  listEvents,
  listSettleableEvents,
  patchEventRuntime,
  reloadEventDefinitions,
  resolveEventPostChannelId,
  upsertEventPost,
} from './eventStorage.js';
import { buildAllEventMessagePayloads, buildEventMessagePayload } from './eventUi.js';

function isChannelUnavailableError(err) {
  const message = String(err?.message || err || '');
  // 50001 Missing Access, 50013 Missing Permissions, 10003 Unknown Channel,
  // 50083 Thread is archived
  return (
    message.includes('50001') ||
    message.includes('50013') ||
    message.includes('10003') ||
    message.includes('50083')
  );
}

function isUnknownMessageError(err) {
  const message = String(err?.message || err || '');
  return message.includes('"code":10008') || message.includes('10008') || /unknown message/i.test(message);
}

async function upsertBetsBoardMessage(event, guildId, channelId, existingPost = null) {
  const betsEmbed = buildEventBetsEmbed(event, collectAllUsersForBets());
  let betsMessageId = existingPost?.betsMessageId || null;

  if (betsMessageId) {
    try {
      await editChannelMessage(channelId, betsMessageId, { embeds: [betsEmbed] });
      return betsMessageId;
    } catch (err) {
      if (!isUnknownMessageError(err)) throw err;
      console.warn(
        `upsertBetsBoardMessage: bets board ${betsMessageId} missing in guild ${guildId}; recreating.`,
      );
      betsMessageId = null;
    }
  }

  const betsMessage = await sendChannelMessage(channelId, { embeds: [betsEmbed] });
  return betsMessage.id;
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

    const betsMessageId = await upsertBetsBoardMessage(event, guildId, channelId, existing);

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

  const targets = getEventPostTargets(event);
  let refreshed = 0;
  let skipped = 0;
  for (const target of targets) {
    const channelId =
      getEventPost(target.guildId, event.id)?.channelId || target.channelId;
    const result = await refreshEventInChannel(event, target.guildId, channelId);
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
  const targets = getEventPostTargets(opened);
  if (!targets.length) {
    return {
      ok: false,
      error: event.threadId
        ? 'No subscribed event channels match this event (needed to resolve guild for the thread).'
        : 'No subscribed event channels match this event.',
    };
  }

  let posted = 0;
  let skipped = 0;
  for (const target of targets) {
    const result = await postEventToChannel(opened, target.guildId, target.channelId);
    if (result.ok) posted += 1;
    else if (result.channelUnavailable) skipped += 1;
  }

  if (!posted && skipped) {
    return {
      ok: false,
      error: event.threadId
        ? 'Could not post to the event thread (missing access, or the thread is archived).'
        : 'Could not post to any event channels (missing channel access).',
    };
  }

  return { ok: true, event: opened, posted, skipped };
}

export async function catchUpGuildEvents(guildId, channelId) {
  const events = listCatchUpEvents().filter((event) =>
    getEligibleEventChannels(event).some((entry) => String(entry.guildId) === String(guildId)),
  );

  let posted = 0;
  for (const event of events) {
    const targetChannelId = resolveEventPostChannelId(event, guildId, channelId);
    const result = await postEventToChannel(event, guildId, targetChannelId);
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
  const targets = getEventPostTargets(event);
  for (const target of targets) {
    const post = getEventPost(target.guildId, event.id);
    const channelId = post?.channelId || target.channelId;
    try {
      const betsMessageId = await upsertBetsBoardMessage(event, target.guildId, channelId, post);
      upsertEventPost({
        guildId: target.guildId,
        eventId: event.id,
        channelId,
        horseMessages: post?.horseMessages || [],
        betsMessageId,
      });
    } catch (err) {
      if (isChannelUnavailableError(err)) {
        console.warn(
          `refreshBetsBoardForEvent: guild ${target.guildId} channel ${channelId} unavailable (${err.message})`,
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
