import crypto from 'crypto';
import { DiscordRequest } from './utils.js';
import {
  getAllLeaderboardChannels,
  isPremiumGuild,
  updateLeaderboardChannelState,
  removeLeaderboardChannel,
} from './clubDatabase.js';
import { buildLeaderboardPackage, getUmaApiKey } from './clubService.js';

const PREMIUM_TOP100_INTERVAL_MS = 5 * 60 * 1000;
const STANDARD_TOP100_INTERVAL_MS = 15 * 60 * 1000;
const NON_TOP100_POLL_MS = 60 * 60 * 1000;
const HOURLY_RANK_MIN = 101;
const HOURLY_RANK_MAX = 10000;
const HOURLY_UPDATE_MINUTE_UTC = 15;
const TICK_MS = 60 * 1000;
const EDIT_STAGGER_MS = 2500;
const CIRCLE_CACHE_TTL_MS = 3 * 60 * 1000;

const circleCache = new Map();
let tickInFlight = false;

export function hashLeaderboardContent(embed) {
  const stable = {
    color: embed?.color,
    title: embed?.title,
    url: embed?.url,
    description: embed?.description,
    footer: embed?.footer,
  };
  return crypto.createHash('sha256').update(JSON.stringify(stable)).digest('hex');
}

function getCircleUpdatedMs(circle) {
  if (!circle?.last_updated) return null;
  const t = new Date(circle.last_updated).getTime();
  return Number.isFinite(t) ? t : null;
}

function getSyncedCircleUpdatedMs(entry) {
  if (!entry?.lastCircleUpdatedAt) return 0;
  const t = new Date(entry.lastCircleUpdatedAt).getTime();
  return Number.isFinite(t) ? t : 0;
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

function leaderboardCacheKey(guildId, circleId) {
  return guildId ? `${guildId}:${circleId}` : String(circleId);
}

async function getCachedLeaderboardPackage(circleId, guildId = null) {
  const key = leaderboardCacheKey(guildId, circleId);
  const cached = circleCache.get(key);
  const now = Date.now();
  if (cached && now - cached.fetchedAt < CIRCLE_CACHE_TTL_MS) {
    return cached;
  }

  const pkg = await buildLeaderboardPackage(circleId, { guildId });
  const cachedPkg = {
    ...pkg,
    contentHash: hashLeaderboardContent(pkg.embed),
    fetchedAt: now,
  };
  circleCache.set(key, cachedPkg);
  return cachedPkg;
}

function isDueForTop100(entry, now, intervalMs) {
  if (!entry.lastUpdatedAt) return true;
  return now - entry.lastUpdatedAt >= intervalMs;
}

function getCircleRank(circle) {
  const rank = circle?.live_rank ?? circle?.monthly_rank;
  return typeof rank === 'number' ? rank : null;
}

function isHourlyRankBandCircle(circle) {
  const rank = getCircleRank(circle);
  return rank != null && rank >= HOURLY_RANK_MIN && rank <= HOURLY_RANK_MAX;
}

function getUtcHourKey(tsMs) {
  const d = new Date(tsMs);
  return `${d.getUTCFullYear()}-${d.getUTCMonth() + 1}-${d.getUTCDate()}-${d.getUTCHours()}`;
}

function isDueForHourlyRankBand(entry, now) {
  const minute = new Date(now).getUTCMinutes();
  if (minute !== HOURLY_UPDATE_MINUTE_UTC) return false;
  if (!entry.lastUpdatedAt) return true;
  return getUtcHourKey(entry.lastUpdatedAt) !== getUtcHourKey(now);
}

function isDueForNonTop100(entry, now, pkg) {
  if (!entry.lastUpdatedAt) return true;
  if (now - entry.lastUpdatedAt < NON_TOP100_POLL_MS) return false;

  const circleUpdatedMs = getCircleUpdatedMs(pkg?.data?.circle);
  if (circleUpdatedMs != null && circleUpdatedMs > getSyncedCircleUpdatedMs(entry)) {
    return true;
  }

  return entry.lastEmbedHash !== pkg.contentHash;
}

function shouldWarnNeverSynced(entry, now) {
  if (entry.lastUpdatedAt != null) return false;
  const createdMs = entry.createdAt ? new Date(entry.createdAt).getTime() : 0;
  return createdMs > 0 && now - createdMs > 2 * 60 * 60 * 1000;
}

function collectDueChannels(channels, now, packagesByCircle) {
  const due = [];

  for (const entry of channels) {
    const cacheKey = leaderboardCacheKey(entry.guildId, entry.circleId);
    const pkg = packagesByCircle.get(cacheKey);
    if (!pkg) {
      if (shouldWarnNeverSynced(entry, now)) {
        console.warn(
          `Leaderboard channel guild ${entry.guildId} circle ${entry.circleId} has no uma.moe data — fetch may be failing.`,
        );
      }
      continue;
    }

    if (pkg.isTop100) {
      const intervalMs = getTop100IntervalMs(entry.guildId);
      if (isDueForTop100(entry, now, intervalMs)) due.push(entry);
    } else if (isHourlyRankBandCircle(pkg?.data?.circle)) {
      if (isDueForHourlyRankBand(entry, now)) due.push(entry);
    } else if (isDueForNonTop100(entry, now, pkg)) {
      due.push(entry);
    } else if (shouldWarnNeverSynced(entry, now)) {
      console.warn(
        `Leaderboard channel guild ${entry.guildId} circle ${entry.circleId} has never synced — still waiting for uma.moe data changes.`,
      );
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
  const circleLastUpdated = pkg.data?.circle?.last_updated ?? null;
  const unchanged =
    entry.lastEmbedHash === pkg.contentHash &&
    getSyncedCircleUpdatedMs(entry) >= (getCircleUpdatedMs(pkg.data?.circle) ?? 0);

  if (unchanged) {
    updateLeaderboardChannelState(entry.guildId, entry.circleId, { lastUpdatedAt: now });
    return;
  }

  try {
    await editLeaderboardMessage(entry, pkg.embed);
    updateLeaderboardChannelState(entry.guildId, entry.circleId, {
      lastUpdatedAt: now,
      lastEmbedHash: pkg.contentHash,
      lastCircleUpdatedAt: circleLastUpdated,
    });
  } catch (err) {
    const message = String(err?.message || err);
    if (message.includes('10008') || message.includes('Unknown Message')) {
      console.warn(`Leaderboard message missing for guild ${entry.guildId} club ${entry.circleId}, removing channel.`);
      removeLeaderboardChannel(entry.guildId, entry.circleId);
      return;
    }
    console.error(
      `Failed to update leaderboard guild ${entry.guildId} circle ${entry.circleId} message ${entry.messageId}:`,
      message,
    );
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
    const channelPairs = channels.map((entry) => ({
      guildId: String(entry.guildId),
      circleId: String(entry.circleId),
      cacheKey: leaderboardCacheKey(entry.guildId, entry.circleId),
    }));
    const uniquePairs = [...new Map(channelPairs.map((pair) => [pair.cacheKey, pair])).values()];
    const packagesByCircle = new Map();

    await Promise.all(
      uniquePairs.map(async ({ guildId, circleId, cacheKey }) => {
        try {
          const pkg = await getCachedLeaderboardPackage(circleId, guildId);
          packagesByCircle.set(cacheKey, pkg);
        } catch (err) {
          console.error(`Leaderboard fetch failed for circle ${circleId}:`, err.message);
        }
      }),
    );

    const due = collectDueChannels(channels, now, packagesByCircle);
    for (let i = 0; i < due.length; i += 1) {
      const entry = due[i];
      const pkg = packagesByCircle.get(leaderboardCacheKey(entry.guildId, entry.circleId));
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

  console.log(
    'Leaderboard cron started (tick every 60s, premium top-100: 5m, standard top-100: 15m, ranks 101-10000: hourly at :15 UTC, others: hourly when uma.moe data changes).',
  );
  setInterval(() => {
    runLeaderboardTick().catch((err) => console.error('Leaderboard cron tick failed:', err));
  }, TICK_MS);

  setTimeout(() => {
    runLeaderboardTick().catch((err) => console.error('Leaderboard cron initial tick failed:', err));
  }, 15_000);
}
