import {
  InteractionResponseFlags,
  InteractionResponseType,
} from 'discord-interactions';
import { isGuildAdmin } from './clubHandlers.js';
import {
  getUserLink,
  updateUserBettingState,
} from './clubDatabase.js';
import {
  BET_AMOUNTS,
  formatCoins,
  getEntry,
  getWalletUser,
  isEventBettable,
  placeBet,
} from './eventGambling.js';
import {
  buildEventAutocompleteChoices,
  catchUpGuildEvents,
  postEventEverywhere,
  refreshBetsBoardForEvent,
  refreshEventEverywhere,
  reloadEventsFromDisk,
  settleEventEverywhere,
} from './eventService.js';
import { getEvent, resolveEventId, setEventChannel } from './eventStorage.js';
import {
  buildSettleSummaryEmbed,
  buildWagerButtons,
  buildWagerEmbed,
} from './eventUi.js';

const BOT_OWNER_IDS = new Set(
  String(process.env.BOT_OWNER_IDS || process.env.BOT_OWNER_ID || '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean),
);

function ephemeral(content) {
  return {
    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
    data: { flags: InteractionResponseFlags.EPHEMERAL, content },
  };
}

function guildRequired() {
  return ephemeral('❌ This command can only be used in a server.');
}

function ownerGuildRequired() {
  return ephemeral('❌ This command is only available on the owner server.');
}

function ownerRequired() {
  return ephemeral('❌ Only the bot owner can use this command.');
}

function isOwnerGuild(guildId) {
  const ownerGuildId = String(process.env.BOT_OWNER_GUILD_ID || '').trim();
  return Boolean(guildId && ownerGuildId && String(guildId) === ownerGuildId);
}

function resolveSubcommand(req) {
  return req.body.data.options?.find((opt) => opt.type === 1)?.name ?? null;
}

function getSubcommandOptions(req) {
  const subcommand = req.body.data.options?.find((opt) => opt.type === 1);
  return subcommand?.options ?? [];
}

function getGambaEventOptions(req) {
  const group = req.body.data.options?.find((opt) => opt.type === 2 && opt.name === 'event');
  const subcommand = group?.options?.find((opt) => opt.type === 1);
  return subcommand?.options ?? [];
}

function getGambaEventSubcommand(req) {
  const group = req.body.data.options?.find((opt) => opt.type === 2 && opt.name === 'event');
  return group?.options?.find((opt) => opt.type === 1)?.name ?? null;
}

function getOptionValue(req, name) {
  const value = getSubcommandOptions(req).find((opt) => opt.name === name)?.value;
  if (value === undefined || value === null) return undefined;
  return value;
}

function getGambaEventOptionValue(req, name) {
  const value = getGambaEventOptions(req).find((opt) => opt.name === name)?.value;
  if (value === undefined || value === null) return undefined;
  return value;
}

function requireOwnerOnOwnerGuild(req) {
  const guildId = req.body.guild_id;
  const userId = req.body.member?.user?.id || req.body.user?.id;
  if (!isOwnerGuild(guildId)) return ownerGuildRequired();
  if (!userId || !BOT_OWNER_IDS.has(userId)) return ownerRequired();
  return null;
}

export function buildEventAutocomplete(query) {
  reloadEventsFromDisk();
  return buildEventAutocompleteChoices(query);
}

export async function handleGambacoinSetEventChannel(req) {
  const guildId = req.body.guild_id;
  const channelId = req.body.channel_id;
  if (!guildId || !channelId) return guildRequired();
  if (!isGuildAdmin(req.body.member)) {
    return ephemeral('❌ Only server administrators can use `/gambacoin seteventchannel`.');
  }

  setEventChannel(guildId, channelId);
  const catchUp = await catchUpGuildEvents(guildId, channelId);
  if (catchUp.channelUnavailable) {
    const partialLine = catchUp.posted
      ? `\nPosted **${catchUp.posted}** ongoing event${catchUp.posted === 1 ? '' : 's'} before access failed.`
      : '';
    return ephemeral(
      `⚠️ Event channel set to <#${channelId}>, but I couldn't post there. Give me **View Channel**, **Send Messages**, and **Embed Links** in that channel, then run the command again.${partialLine}`,
    );
  }
  const catchUpLine = catchUp.posted
    ? `\nPosted **${catchUp.posted}** ongoing event${catchUp.posted === 1 ? '' : 's'} to this channel.`
    : '';
  return ephemeral(`✅ Event channel set to <#${channelId}>.${catchUpLine}`);
}

export async function handleEventPost(req) {
  const denied = requireOwnerOnOwnerGuild(req);
  if (denied) return denied;

  const eventId = resolveEventId(getGambaEventOptionValue(req, 'name'));
  if (!eventId) {
    return ephemeral('❌ Event not found. Pick from autocomplete or use the event id (e.g. `001`).');
  }

  reloadEventsFromDisk();
  const result = await postEventEverywhere(eventId);
  if (!result.ok) return ephemeral(`❌ ${result.error}`);
  return ephemeral(
    `✅ Posted **${result.event.name}** (\`${result.event.id}\`) to **${result.posted}** channel${result.posted === 1 ? '' : 's'}.`,
  );
}

export async function handleEventRefresh(req) {
  const denied = requireOwnerOnOwnerGuild(req);
  if (denied) return denied;

  const eventId = resolveEventId(getGambaEventOptionValue(req, 'name'));
  if (!eventId) {
    return ephemeral('❌ Event not found. Pick from autocomplete or use the event id (e.g. `001`).');
  }

  reloadEventsFromDisk();
  const result = await refreshEventEverywhere(eventId);
  if (!result.ok) return ephemeral(`❌ ${result.error}`);
  return ephemeral(
    `✅ Refreshed **${result.event.name}** in **${result.refreshed}** channel${result.refreshed === 1 ? '' : 's'}.\n\n` +
      '_Bettors can only pick **one** horse per event — odds and cutoff are now live everywhere._',
  );
}

export async function handleEventSettle(req) {
  const denied = requireOwnerOnOwnerGuild(req);
  if (denied) return denied;

  const eventId = resolveEventId(getGambaEventOptionValue(req, 'name'));
  const winner = Number(getGambaEventOptionValue(req, 'winner'));
  if (!eventId) {
    return ephemeral('❌ Event not found. Pick from autocomplete or use the event id (e.g. `001`).');
  }
  if (!Number.isFinite(winner) || winner < 1) return ephemeral('❌ Enter a valid winning number.');

  const result = await settleEventEverywhere(eventId, winner);
  if (!result.ok) return ephemeral(`❌ ${result.error}`);

  return {
    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
    data: {
      flags: InteractionResponseFlags.EPHEMERAL,
      content: `✅ Settled **${result.event.name}**.`,
      embeds: [buildSettleSummaryEmbed(result.event, result.result)],
    },
  };
}

function requireWallet(userId, displayName, guildId) {
  const link = getUserLink(userId);
  if (link) return { ok: true, link };
  return {
    ok: false,
    error:
      '❌ You need a GambaCoin wallet first. Use `/register` or join a quiz to get one.',
  };
}

export async function handleGambaBetClick(req, eventId, entryNumber) {
  const guildId = req.body.guild_id;
  if (!guildId) return ephemeral('❌ Betting is only available in servers.');

  const userId = req.body.member?.user?.id || req.body.user?.id;
  const displayName = req.body.member?.display_name || req.body.member?.user?.username || 'Trainer';
  const wallet = requireWallet(userId, displayName, guildId);
  if (!wallet.ok) return ephemeral(wallet.error);

  const event = getEvent(eventId);
  if (!event) return ephemeral('❌ This event is outdated. Wait for a refreshed event post.');
  if (!isEventBettable(event)) return ephemeral('❌ Betting is closed for this event.');

  const entry = getEntry(event, entryNumber);
  if (!entry) return ephemeral('❌ Entry not found.');

  const user = getWalletUser(userId);
  return {
    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
    data: {
      flags: InteractionResponseFlags.EPHEMERAL,
      embeds: [buildWagerEmbed(event, entry, user)],
      components: buildWagerButtons(event.id, entry.number),
    },
  };
}

export async function handleGambaWagerClick(req, eventId, entryNumber, amount) {
  const guildId = req.body.guild_id;
  if (!guildId) return ephemeral('❌ Betting is only available in servers.');

  const userId = req.body.member?.user?.id || req.body.user?.id;
  const displayName = req.body.member?.display_name || req.body.member?.user?.username || 'Trainer';
  const wallet = requireWallet(userId, displayName, guildId);
  if (!wallet.ok) return ephemeral(wallet.error);

  const event = getEvent(eventId);
  const entry = getEntry(event, entryNumber);

  const user = {
    trainerName: wallet.link.trainerName || displayName,
    gambaCoins: wallet.link.gambaCoins ?? 0,
    openTickets: [...(wallet.link.openTickets || [])],
    betHistory: [...(wallet.link.betHistory || [])],
  };

  function wagerUpdate(content) {
    return {
      type: InteractionResponseType.UPDATE_MESSAGE,
      data: {
        content,
        embeds: event && entry ? [buildWagerEmbed(event, entry, user)] : [],
        components: event && entry ? buildWagerButtons(event.id, entry.number) : [],
      },
    };
  }

  if (!event) return wagerUpdate('❌ This event is outdated.');
  if (!isEventBettable(event)) return wagerUpdate('❌ Betting is closed for this event.');
  if (!BET_AMOUNTS.includes(amount)) return wagerUpdate('❌ Invalid bet amount.');
  if (!entry) return wagerUpdate('❌ Entry not found.');

  const result = placeBet(user, event, entryNumber, amount);
  if (!result.ok) return wagerUpdate(`❌ ${result.error}`);

  updateUserBettingState(userId, {
    trainerName: user.trainerName,
    gambaCoins: user.gambaCoins,
    openTickets: user.openTickets,
    betHistory: user.betHistory,
  });

  refreshBetsBoardForEvent(event.id).catch((err) => {
    console.error('Failed to refresh bets board:', err.message);
  });

  return {
    type: InteractionResponseType.UPDATE_MESSAGE,
    data: {
      content: `✅ Placed **${formatCoins(amount)}** GambaCoins on **#${entryNumber} ${result.entry.name}** @ ${result.entry.odds}.`,
      embeds: [buildWagerEmbed(event, result.entry, result.user)],
      components: buildWagerButtons(event.id, entry.number),
    },
  };
}

export function handleGambaBetComponent(customId) {
  if (!customId?.startsWith('gamba-bet:')) return null;
  const [, eventId, entryNumberStr] = customId.split(':');
  const entryNumber = Number.parseInt(entryNumberStr, 10);
  if (!eventId || !Number.isFinite(entryNumber)) return null;
  return { eventId, entryNumber };
}

export function handleGambaWagerComponent(customId) {
  if (!customId?.startsWith('gamba-wager:')) return null;
  const [, eventId, entryNumberStr, amountStr] = customId.split(':');
  const entryNumber = Number.parseInt(entryNumberStr, 10);
  const amount = Number.parseInt(amountStr, 10);
  if (!eventId || !Number.isFinite(entryNumber) || !Number.isFinite(amount)) return null;
  return { eventId, entryNumber, amount };
}

export async function handleEventLookup(req) {
  return ephemeral(
    '❌ Training event lookup is not wired to cached data yet. Use `/uma` for character training events.',
  );
}

export function dispatchEventCommand(req) {
  const subcommand = resolveSubcommand(req);
  switch (subcommand) {
    case 'lookup':
      return handleEventLookup(req);
    default:
      return null;
  }
}

export function dispatchGambaCommand(req) {
  const subcommand = getGambaEventSubcommand(req);
  switch (subcommand) {
    case 'post':
      return handleEventPost(req);
    case 'refresh':
      return handleEventRefresh(req);
    case 'settle':
      return handleEventSettle(req);
    default:
      return null;
  }
}

export function isEventGamblingCommand(name) {
  return name === 'event';
}

export function isGambaCommand(name) {
  return name === 'gamba';
}
