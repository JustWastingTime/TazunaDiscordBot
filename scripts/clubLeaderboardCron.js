import crypto from 'crypto';
import { DiscordRequest } from './utils.js';
import {
  getAllLeaderboardChannels,
  isGuildClubRegistered,
  isPremiumGuild,
  updateLeaderboardChannelState,
  removeLeaderboardChannel,
} from './clubDatabase.js';
import { buildLeaderboardPackage, getUmaApiKey } from './clubService.js';

const PREMIUM_TOP100_INTERVAL_MS = 5 * 60 * 1000;
const STANDARD_TOP100_INTERVAL_MS = 15 * 60 * 1000;
const TICK_MS = 60 * 1000;
const EDIT_STAGGER_MS = 2500;
const CIRCLE_CACHE_TTL_MS = 3 * 60 * 1000;

const circleCache = new Map();
let tickInFlight = false;

function hashEmbed(embed) {
  return crypto.createHash('sha256').update(JSON.stringify(embed)).digest('hex');
}

function getJstParts(now = new Date()) {
  const jst = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Tokyo' }));
  return {
    year: jst.getFullYear(),
    month: jst.getMonth() + 1,
    day: jst.getDate(),
    hour: jst.getHours(),
    minute: jst.getMinutes(),
  };
}

function getJstDateKey(now = new Date()) {
  const { year, month, day } = getJstParts(now);
  return `${year}-${month}-${day}`;
}

function isPastDailyJstCutoff(now = new Date()) {
  const { hour, minute } = getJstParts(now);
  return hour > 0 || (hour === 0 && minute >= 10);
}

function getTop100IntervalMs(guildId) {
  return isPremiumGuild(guildId) ? PREMIUM_TOP100_INTERVAL_MS : STANDARD_TOP100_INTERVAL_MS;
}

function staggerDelayMs(entry, index) {
  const hash = crypto
    .createHash('sha256')
    .update(`${entry.guildId}:${entry.circleId}`)
    .digest();
  const bucket = hash.readUInt32BE(0) % 20;
  return index * EDIT_STAGGER_MS + bucket * 150;
}

async function getCachedLeaderboardPackage(circleId) {
  const key = String(circleId);
  const cached = circleCache.get(key);
  const now = Date.now();
  if (cached && now - cached.fetchedAt < CIRCLE_CACHE_TTL_MS) {
    return cached;
  }

  const pkg = await buildLeaderboardPackage(key);
  const cachedPkg = {
    ...pkg,
    embedHash: hashEmbed(pkg.embed),
    fetchedAt: now,
  };
  circleCache.set(key, cachedPkg);
  return cachedPkg;
}

function isDueForTop100(entry, now, intervalMs) {
  if (!entry.lastUpdatedAt) return true;
  return now - entry.lastUpdatedAt >= intervalMs;
}

function isDueForDaily(entry, now) {
  const todayKey = getJstDateKey(now);
  if (entry.lastDailyKey === todayKey) return false;
  return isPastDailyJstCutoff(now);
}

function collectDueChannels(channels, now, packagesByCircle) {
  const due = [];

  for (const entry of channels) {
    if (!isGuildClubRegistered(entry.guildId, entry.circleId)) continue;

    const pkg = packagesByCircle.get(String(entry.circleId));
    if (!pkg) continue;

    if (pkg.isTop100) {
      const intervalMs = getTop100IntervalMs(entry.guildId);
      if (isDueForTop100(entry, now, intervalMs)) due.push(entry);
    } else if (isDueForDaily(entry, now)) {
      due.push(entry);
    }
  }

  due.sort((a, b) => {
    const ha = crypto.createHash('sha256').update(`${a.guildId}:${a.circleId}`).digest('hex');
    const hb = crypto.createHash('sha256').update(`${b.guildId}:${b.circleId}`).digest('hex');
    return ha.localeCompare(hb);
  });

  return due;
}

async function editLeaderboardMessage(entry, embed) {
  await DiscordRequest(`channels/${entry.channelId}/messages/${entry.messageId}`, {
    method: 'PATCH',
    body: { embeds: [embed] },
  });
}

async function processDueChannel(entry, pkg, now) {
  if (entry.lastEmbedHash === pkg.embedHash) {
    const patch = { lastUpdatedAt: now };
    if (!pkg.isTop100) patch.lastDailyKey = getJstDateKey(now);
    updateLeaderboardChannelState(entry.guildId, entry.circleId, patch);
    return;
  }

  try {
    await editLeaderboardMessage(entry, pkg.embed);
    const patch = {
      lastUpdatedAt: now,
      lastEmbedHash: pkg.embedHash,
    };
    if (!pkg.isTop100) patch.lastDailyKey = getJstDateKey(now);
    updateLeaderboardChannelState(entry.guildId, entry.circleId, patch);
  } catch (err) {
    const message = String(err?.message || err);
    if (message.includes('10008') || message.includes('Unknown Message')) {
      console.warn(`Leaderboard message missing for guild ${entry.guildId} club ${entry.circleId}, removing channel.`);
      removeLeaderboardChannel(entry.guildId, entry.circleId);
      return;
    }
    console.error(`Failed to update leaderboard ${entry.guildId}/${entry.circleId}:`, message);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function runLeaderboardTick() {
  if (tickInFlight) return;
  tickInFlight = true;

  try {
    const channels = getAllLeaderboardChannels();
    if (!channels.length) return;

    const now = Date.now();
    const uniqueCircleIds = [...new Set(channels.map((c) => String(c.circleId)))];
    const packagesByCircle = new Map();

    await Promise.all(
      uniqueCircleIds.map(async (circleId) => {
        try {
          const pkg = await getCachedLeaderboardPackage(circleId);
          packagesByCircle.set(circleId, pkg);
        } catch (err) {
          console.error(`Leaderboard fetch failed for circle ${circleId}:`, err.message);
        }
      }),
    );

    const due = collectDueChannels(channels, now, packagesByCircle);
    for (let i = 0; i < due.length; i += 1) {
      const entry = due[i];
      const pkg = packagesByCircle.get(String(entry.circleId));
      if (!pkg) continue;

      if (i > 0) {
        await sleep(staggerDelayMs(entry, i));
      }
      await processDueChannel(entry, pkg, Date.now());
    }
  } finally {
    tickInFlight = false;
  }
}

export function startLeaderboardCron() {
  if (!getUmaApiKey()) {
    console.warn('Leaderboard auto-update disabled: UMA_API_KEY is not set.');
    return;
  }

  console.log('Leaderboard cron started (tick every 60s, premium top-100: 5m, standard top-100: 15m, else daily 00:10 JST).');
  setInterval(() => {
    runLeaderboardTick().catch((err) => console.error('Leaderboard cron tick failed:', err));
  }, TICK_MS);

  setTimeout(() => {
    runLeaderboardTick().catch((err) => console.error('Leaderboard cron initial tick failed:', err));
  }, 15_000);
}
