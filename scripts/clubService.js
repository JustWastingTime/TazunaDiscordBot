import { buildGambleProfileFields } from './eventGambling.js';
import { buildFestProfileData, getGuildClubTarget, getUserLinkByViewerId, setUmaTrainerName } from './clubDatabase.js';

const EMPTY_FAN_STATS = {
  dailyFans: [],
  monthlyGain: 0,
  contributionFans: 0,
  firstFans: 0,
  latestFans: 0,
  averageDays: 1,
  activeDays: 0,
};

const ACTIVE_LAG_TOLERANCE_MS = 2 * 60 * 60 * 1000;
const MIN_ACTIVE_RATIO_FOR_FILTER = 0.75;

export function getUmaApiKey() {
  return String(process.env.UMA_API_KEY || process.env.UMA_MOE_API_KEY || '').trim();
}

function getUmaHeaders() {
  const apiKey = getUmaApiKey();
  if (!apiKey) return {};
  return {
    'X-API-Key': apiKey,
    Authorization: `Bearer ${apiKey}`,
  };
}

export async function fetchUmaJson(url) {
  const apiKey = getUmaApiKey();
  if (!apiKey) {
    throw new Error(
      'UMA_API_KEY is not set on the bot server. Create an API key at uma.moe, add it to your environment, and restart the bot.',
    );
  }

  const res = await fetch(url, { headers: getUmaHeaders() });
  if (!res.ok) {
    if (res.status === 404) throw new Error('Not found on uma.moe.');
    if (res.status === 401) {
      throw new Error(
        'uma.moe rejected the API key (401). Check that UMA_API_KEY on the server is correct and starts with uma_k_.',
      );
    }
    if (res.status === 403) {
      throw new Error('uma.moe API access denied (403). Your API key may lack permission for this endpoint.');
    }
    throw new Error(`uma.moe API returned ${res.status}`);
  }
  return res.json();
}

export function getCircleApiUrl(circleId) {
  return `https://uma.moe/api/v4/circles?circle_id=${encodeURIComponent(circleId)}`;
}

export function getUserProfileUrl(accountId) {
  return `https://uma.moe/api/v4/user/profile/${encodeURIComponent(accountId)}`;
}

export async function fetchCircleData(circleId) {
  return fetchUmaJson(getCircleApiUrl(circleId));
}

function pickObject(...candidates) {
  for (const candidate of candidates) {
    if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) return candidate;
  }
  return null;
}

export function normalizeUserProfile(data, accountId) {
  const root = data && typeof data === 'object' ? data : {};

  // uma.moe v4: GET /api/v4/user/profile/{account_id}
  if (root.trainer && typeof root.trainer === 'object') {
    const trainer = root.trainer;
    const circle = root.circle ?? null;
    const currentMonth = Array.isArray(root.fan_history?.monthly)
      ? root.fan_history.monthly[0]
      : null;

    const viewerId = String(trainer.account_id ?? accountId);
    const trainerName = trainer.name ?? currentMonth?.trainer_name ?? null;
    if (!trainerName) {
      throw new Error(`Trainer account \`${accountId}\` was not found on uma.moe.`);
    }

    const circleIdRaw =
      circle?.circle_id ?? currentMonth?.circle_id ?? null;
    const circleId = circleIdRaw != null ? String(circleIdRaw) : null;
    const circleName = circle?.name ?? currentMonth?.circle_name ?? null;

    return {
      viewerId,
      trainerName,
      circleId,
      circleName,
      member: {
        trainer_name: trainerName,
        viewer_id: viewerId,
        daily_fans: [],
        last_updated: null,
      },
      circle: circle ?? (circleName ? { name: circleName, circle_id: circleId } : null),
    };
  }

  const user = pickObject(root.user, root.profile, root.member, root);
  const circle = pickObject(root.circle, user?.circle, root.club);

  const viewerId = String(
    user?.account_id ??
      user?.viewer_id ??
      user?.id ??
      root.account_id ??
      root.viewer_id ??
      accountId,
  );

  const trainerName =
    user?.trainer_name ?? user?.name ?? root.trainer_name ?? root.name ?? null;

  if (!trainerName) {
    throw new Error(`Trainer account \`${accountId}\` was not found on uma.moe.`);
  }

  const circleIdRaw =
    circle?.circle_id ?? circle?.id ?? user?.circle_id ?? root.circle_id ?? null;
  const circleId = circleIdRaw != null ? String(circleIdRaw) : null;
  const circleName = circle?.name ?? user?.circle_name ?? root.circle_name ?? null;

  const dailyFans = user?.daily_fans ?? root.daily_fans;
  const lastUpdated = user?.last_updated ?? root.last_updated;

  return {
    viewerId,
    trainerName,
    circleId,
    circleName,
    member: {
      trainer_name: trainerName,
      viewer_id: viewerId,
      daily_fans: Array.isArray(dailyFans) ? dailyFans : [],
      last_updated: lastUpdated ?? null,
    },
    circle: circle ?? (circleName ? { name: circleName, circle_id: circleId } : null),
  };
}

export async function fetchUserProfile(accountId) {
  const id = String(accountId ?? '').trim();
  if (!id) throw new Error('Trainer account ID is required.');
  const data = await fetchUmaJson(getUserProfileUrl(id));
  return normalizeUserProfile(data, id);
}

function scoreProfileMemberMatch({ circleId, member }) {
  let score = 0;
  if (String(member?.circle_id ?? '') === String(circleId)) score += 1e15;

  const updatedMs = getMemberLastUpdatedMs(member);
  if (updatedMs != null) score += updatedMs;

  const fanStats = getMemberFanStats(member?.daily_fans ?? []);
  if (fanStats.activeDays > 0) score += 1e10;

  return score;
}

export function pickBestProfileMatch(matches) {
  if (!matches?.length) return null;
  if (matches.length === 1) return matches[0];
  return [...matches].sort(
    (a, b) => scoreProfileMemberMatch(b) - scoreProfileMemberMatch(a),
  )[0];
}

export async function resolveProfileCircleMember(viewerId, candidateCircleIds) {
  const target = String(viewerId);
  const uniqueIds = [...new Set(candidateCircleIds.map(String).filter(Boolean))];
  const matches = [];

  await Promise.all(
    uniqueIds.map(async (circleId) => {
      try {
        const circleData = await fetchCircleData(circleId);
        const member = (circleData.members || []).find(
          (m) => String(m.viewer_id) === target,
        );
        if (!member) return;
        matches.push({
          circleId,
          circle: circleData.circle,
          members: circleData.members || [],
          member,
        });
      } catch (err) {
        console.warn(`Could not load circle ${circleId} for profile:`, err.message);
      }
    }),
  );

  return pickBestProfileMatch(matches);
}

export async function buildProfileEmbedForViewerId(viewerId, options = {}) {
  const { circleIdHint = null, festa = null, searchCircleIds = [] } = options;
  const festaData = festa ?? buildFestProfileData(getUserLinkByViewerId(viewerId));
  const profile = await fetchUserProfile(viewerId);

  const candidateCircleIds = [
    profile.circleId,
    circleIdHint,
    ...searchCircleIds,
  ];

  const resolved = await resolveProfileCircleMember(viewerId, candidateCircleIds);

  let circle = profile.circle;
  let member = profile.member;
  let members = [];
  let resolvedCircleId = profile.circleId ?? circleIdHint ?? null;

  if (resolved) {
    circle = resolved.circle ?? circle;
    members = resolved.members;
    member = resolved.member;
    resolvedCircleId = resolved.circleId;
  } else if (resolvedCircleId) {
    try {
      const circleData = await fetchCircleData(resolvedCircleId);
      circle = circleData.circle ?? circle;
      members = circleData.members || [];
      const fromCircle = members.find((m) => String(m.viewer_id) === String(viewerId));
      if (fromCircle) member = fromCircle;
    } catch (err) {
      console.warn(`Could not refresh circle ${resolvedCircleId} for profile:`, err.message);
    }
  }

  if (!member) {
    throw new Error('Could not load trainer fan data from uma.moe.');
  }

  const ranks =
    circle && members.length
      ? buildTrainerRanks(circle, members, viewerId)
      : {};

  const embed = buildProfileEmbed({
    member,
    circle:
      circle ??
      (profile.circleName
        ? { name: profile.circleName, circle_id: resolvedCircleId }
        : null),
    ranks,
    festa: festaData,
  });

  return {
    embed,
    resolvedCircle: circle
      ? {
          circleId: String(circle.circle_id ?? circle.id ?? resolvedCircleId ?? ''),
          circleName: circle.name ?? profile.circleName ?? null,
        }
      : null,
  };
}

// Monthly tracking period boundary is day 2 at 00:00 JST.
export function getEffectiveJstPeriod(now = new Date()) {
  const jstNow = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Tokyo' }));
  let year = jstNow.getFullYear();
  let month = jstNow.getMonth();
  if (jstNow.getDate() < 2) {
    month -= 1;
    if (month < 0) {
      month = 11;
      year -= 1;
    }
  }
  return { year, month, jstNow };
}

export function getDaysSinceJstMonthSecondMidnight(now = new Date()) {
  const { year, month, jstNow } = getEffectiveJstPeriod(now);
  const jstSecondMidnight = new Date(year, month, 2, 0, 0, 0, 0);
  const elapsedMs = Math.max(0, jstNow.getTime() - jstSecondMidnight.getTime());
  const elapsedHours = elapsedMs / (1000 * 60 * 60);
  return Math.max(elapsedHours / 24, 1 / 24);
}

const RANK_THRESHOLDS_URL = 'https://uma.moe/api/v4/circles/rank-thresholds';
const RANK_THRESHOLDS_TTL_MS = 60 * 60 * 1000;
const TARGET_TIER_ORDER = ['SS', 'S+', 'S', 'A+', 'A', 'B+', 'B', 'C+', 'C', 'D+', 'D'];
const CLUB_MEMBER_COUNT = 30;
let rankThresholdsCache = { fetchedAt: 0, tiers: [] };

function normalizeRankThresholdEntry(item) {
  if (!item || typeof item !== 'object') return null;

  const tier = item.name ?? item.tier;
  if (tier == null || tier === '') return null;

  const rankingFrom =
    item.ranking_from != null && Number.isFinite(Number(item.ranking_from))
      ? Number(item.ranking_from)
      : null;
  const rankingTo =
    item.ranking_to != null && Number.isFinite(Number(item.ranking_to))
      ? Number(item.ranking_to)
      : null;
  const minFans =
    item.current_min_fans != null && Number.isFinite(Number(item.current_min_fans))
      ? Number(item.current_min_fans)
      : null;
  const clubFansPerDay =
    item.current_fans_per_day != null && Number.isFinite(Number(item.current_fans_per_day))
      ? Number(item.current_fans_per_day)
      : null;

  return {
    tier: String(tier).trim(),
    rankIndex: Number(item.rank_index) || 0,
    rankingFrom,
    rankingTo,
    minFans,
    clubFansPerDay,
  };
}

export function normalizeRankThresholds(payload) {
  const items = Array.isArray(payload)
    ? payload
    : payload?.thresholds ?? payload?.tiers ?? payload?.ranks ?? [];

  const byTier = new Map();
  for (const item of items) {
    const normalized = normalizeRankThresholdEntry(item);
    if (!normalized) continue;
    if (!TARGET_TIER_ORDER.includes(normalized.tier)) continue;
    byTier.set(normalized.tier.toLowerCase(), normalized);
  }

  return TARGET_TIER_ORDER.map((name) => byTier.get(name.toLowerCase())).filter(Boolean);
}

export function formatTierRankRange(threshold) {
  if (!threshold) return '';
  const { rankingFrom, rankingTo, tier } = threshold;
  if (rankingFrom != null && rankingTo != null) {
    return `${tier} (#${rankingFrom}–#${rankingTo})`;
  }
  if (rankingFrom != null) return `${tier} (#${rankingFrom}+)`;
  if (rankingTo != null) return `${tier} (≤ #${rankingTo})`;
  return tier;
}

export async function getRankThresholds() {
  const now = Date.now();
  if (rankThresholdsCache.tiers.length && now - rankThresholdsCache.fetchedAt < RANK_THRESHOLDS_TTL_MS) {
    return rankThresholdsCache.tiers;
  }

  const payload = await fetchUmaJson(RANK_THRESHOLDS_URL);
  const tiers = normalizeRankThresholds(payload);
  rankThresholdsCache = { fetchedAt: now, tiers };
  return tiers;
}

export function findRankThreshold(tiers, tierQuery) {
  const query = String(tierQuery ?? '').trim().toLowerCase();
  if (!query) return null;
  return tiers.find((tier) => tier.tier.toLowerCase() === query) ?? null;
}

export function computeMemberDailyTarget(clubFansPerDay) {
  if (clubFansPerDay == null || !Number.isFinite(clubFansPerDay)) return null;
  return clubFansPerDay / CLUB_MEMBER_COUNT;
}

export async function resolveClubTargetInfo(guildId, circleId, circleData) {
  const targetTier = getGuildClubTarget(guildId, circleId);
  if (!targetTier) return null;

  const tiers = await getRankThresholds();
  const threshold = findRankThreshold(tiers, targetTier);
  if (!threshold) return null;

  return {
    tierLabel: threshold.tier,
    tierRangeLabel: formatTierRankRange(threshold),
    rankBoundary: threshold.rankingTo,
    dailyTarget: computeMemberDailyTarget(threshold.clubFansPerDay),
  };
}

function buildDailyFansFromTrimmed(trimmed) {
  let lastNegativeIdx = -1;
  for (let i = 0; i < trimmed.length; i += 1) {
    if (trimmed[i] < 0) lastNegativeIdx = i;
  }

  if (lastNegativeIdx < 0) {
    const firstPositiveIdx = trimmed.findIndex((n) => n > 0);
    if (firstPositiveIdx < 0) return [];
    let prev = trimmed[firstPositiveIdx];
    return trimmed.slice(firstPositiveIdx).map((n) => {
      const v = n > 0 ? n : prev;
      prev = v;
      return v;
    });
  }

  const baseline = Math.abs(trimmed[lastNegativeIdx]);
  let startIdx = lastNegativeIdx + 1;
  // Zeros after the last baseline are untracked days (between clubs) — skip until first real reading.
  while (startIdx < trimmed.length && trimmed[startIdx] <= 0) startIdx += 1;

  if (startIdx >= trimmed.length) return [baseline];

  const dailyFans = [baseline];
  let prev = baseline;
  for (let i = startIdx; i < trimmed.length; i += 1) {
    const n = trimmed[i];
    if (n > 0) prev = n;
    dailyFans.push(prev);
  }
  return dailyFans;
}

export function getMemberFanStats(rawFans) {
  const fans = Array.isArray(rawFans) ? rawFans.filter((n) => typeof n === 'number') : [];
  const lastPositiveIdx = fans.reduce((idx, n, i) => (n > 0 ? i : idx), -1);
  if (lastPositiveIdx < 0) return { ...EMPTY_FAN_STATS };

  const trimmed = fans.slice(0, lastPositiveIdx + 1);
  const dailyFans = buildDailyFansFromTrimmed(trimmed);

  if (!dailyFans.length) return { ...EMPTY_FAN_STATS };

  const firstFans = dailyFans[0] ?? 0;
  const latestFans = dailyFans[dailyFans.length - 1] ?? firstFans;
  const monthlyGain = latestFans - firstFans;
  const averageDays = Math.max(1, dailyFans.length - 1);

  return {
    dailyFans,
    monthlyGain,
    contributionFans: monthlyGain,
    firstFans,
    latestFans,
    averageDays,
    activeDays: dailyFans.length,
  };
}

function getMemberLastUpdatedMs(member) {
  if (!member?.last_updated) return null;
  const t = new Date(member.last_updated).getTime();
  return Number.isFinite(t) ? t : null;
}

function getCurrentJstDayIndex(now = new Date()) {
  const jstNow = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Tokyo' }));
  const day = jstNow.getDate();
  return Number.isFinite(day) ? Math.max(0, day - 1) : null;
}

function hasTodayAndYesterdayZeroDailyFans(member, now = new Date()) {
  const fans = Array.isArray(member?.daily_fans) ? member.daily_fans : [];
  if (!fans.length) return false;
  const dayIdx = getCurrentJstDayIndex(now);
  if (dayIdx == null || dayIdx <= 0 || dayIdx >= fans.length) return false;
  return fans[dayIdx] === 0 && fans[dayIdx - 1] === 0;
}

export function getActiveCutoffMs(members) {
  const list = members || [];
  const stamps = list.map(getMemberLastUpdatedMs).filter((t) => t != null);
  if (!stamps.length) return null;

  const freshest = Math.max(...stamps);
  const cutoff = freshest - ACTIVE_LAG_TOLERANCE_MS;
  const activeCount = stamps.filter((t) => t >= cutoff).length;
  const activeRatio = activeCount / Math.max(1, list.length);

  // If this filter would hide too many members, treat scrape timestamps as stale and disable it.
  if (activeRatio < MIN_ACTIVE_RATIO_FOR_FILTER) return null;

  return cutoff;
}

export function isMemberActive(member, cutoffMs) {
  // If both today's and yesterday's slots are 0, treat this trainer as no longer in the current club.
  if (hasTodayAndYesterdayZeroDailyFans(member)) return false;
  if (cutoffMs == null) return true;
  const ts = getMemberLastUpdatedMs(member);
  if (ts == null) return false;
  return ts >= cutoffMs;
}

export function formatNumber(n) {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(n);
}

export function formatIntWithCommas(n) {
  return Math.trunc(n).toLocaleString('en-US');
}

function formatCompactInt(n) {
  return formatNumber(Math.trunc(n));
}

function toHalfwidthAscii(input) {
  return String(input || '')
    // Fullwidth space
    .replace(/\u3000/g, ' ')
    // Fullwidth ASCII variants (！-～) -> (!-~)
    .replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0));
}

function normalizeName(raw) {
  let name = toHalfwidthAscii(raw || 'Unknown');
  name = name.replace(/\s+/g, ' ');
  return name;
}

function stripDisplaySuffix(name) {
  return toHalfwidthAscii(name || '').trimEnd();
}

function truncateAndPadName(rawName, width) {
  let name = normalizeName(rawName || 'Unknown');
  name = stripDisplaySuffix(name);
  if (name.length > width) name = name.slice(0, width);
  return name.padEnd(width, ' ');
}

export function buildTrainerRanks(circle, members, targetViewerId) {
  const cutoff = getActiveCutoffMs(members);
  const enriched = (members || [])
    .filter((m) => isMemberActive(m, cutoff))
    .map((m) => {
      const fanStats = getMemberFanStats(m.daily_fans);
      return {
        ...m,
        totalFans: fanStats.latestFans,
        monthlyGain: fanStats.monthlyGain,
        dailyAvg: Math.round(fanStats.monthlyGain / fanStats.averageDays),
      };
    });

  const byTotalFans = [...enriched].sort((a, b) => b.totalFans - a.totalFans);
  const byMonthly = [...enriched].sort((a, b) => b.monthlyGain - a.monthlyGain);
  const byDailyAvg = [...enriched].sort((a, b) => b.dailyAvg - a.dailyAvg);

  const idx = (arr) => {
    const i = arr.findIndex((m) => String(m.viewer_id) === String(targetViewerId));
    return i >= 0 ? i + 1 : null;
  };

  return { totalFans: idx(byTotalFans), monthly: idx(byMonthly), dailyAvg: idx(byDailyAvg) };
}

function getCircleDisplayRank(circle) {
  if (!circle) return null;
  const live = circle.live_rank;
  if (live != null && live !== 0) return live;
  const monthly = circle.monthly_rank;
  if (monthly != null && monthly !== 0) return monthly;
  return null;
}

function buildClubDescription(circle) {
  if (!circle?.name) return null;
  const rank = getCircleDisplayRank(circle);
  return rank != null
    ? `**🏇 Club:** ${circle.name} (#${rank})`
    : `**🏇 Club:** ${circle.name}`;
}

function formatRankSuffix(rank) {
  return rank != null ? ` (#${rank})` : '';
}

function formatFestField(value) {
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Number.isInteger(value) ? formatIntWithCommas(value) : `${value}`;
  }
  return String(value);
}

export function buildUnlinkedProfileEmbed(link) {
  const name = link?.trainerName || 'Trainer';
  const embed = {
    color: 0xF1C40F,
    title: `${name} — Trainer Profile`,
    description:
      '**🏇 Club:** Unlinked\n**Fan stats:** Unlinked — use `/register` with your uma.moe account ID.',
    fields: [
      {
        name: '🎰 GambaCoins',
        value: formatFestField(link?.gambaCoins),
        inline: true,
      },
      {
        name: '🎲 Gamba WR',
        value: formatFestField(link?.gambaWr),
        inline: true,
      },
      {
        name: '🧠 Quiz Accuracy',
        value: formatFestField(link?.quizAccuracy),
        inline: true,
      },
      ...buildGambleProfileFields({
        openTickets: link?.openTickets,
        betHistory: link?.betHistory,
      }),
    ],
  };
  return embed;
}

export function buildProfileEmbed({ member, circle, ranks = {}, festa = null }) {
  const fanStats = getMemberFanStats(member.daily_fans);
  const dailyAvg = Math.round(fanStats.monthlyGain / fanStats.averageDays);
  const viewerId = String(member.viewer_id ?? '');
  const clubLine = buildClubDescription(circle);

  const chartData = fanStats.dailyFans
    .slice(1)
    .map((v, i) => Math.max(0, v - fanStats.dailyFans[i]));
  const labels = chartData.map((_, idx) => `Day ${idx + 1}`);

  const embed = {
    color: 0xF1C40F,
    title: `${member.trainer_name} — Trainer Profile`,
    url: viewerId ? `https://uma.moe/profile/${viewerId}` : undefined,
    description: clubLine ? `${clubLine}\n\u200b` : undefined,
    fields: [
      {
        name: '🔶 Total Fans',
        value: `${formatIntWithCommas(fanStats.latestFans)}${formatRankSuffix(ranks?.totalFans)}`,
        inline: true,
      },
      {
        name: '📆 Monthly Fans',
        value: `${formatIntWithCommas(fanStats.monthlyGain)}${formatRankSuffix(ranks?.monthly)}`,
        inline: true,
      },
      {
        name: '📊 Daily Average',
        value: `${formatIntWithCommas(dailyAvg)}${formatRankSuffix(ranks?.dailyAvg)}`,
        inline: true,
      },
      {
        name: '🎰 GambaCoins',
        value: formatFestField(festa?.gambaCoins),
        inline: true,
      },
      {
        name: '🎲 Gamba WR',
        value: formatFestField(festa?.gambaWr),
        inline: true,
      },
      {
        name: '🧠 Quiz Accuracy',
        value: formatFestField(festa?.quizAccuracy),
        inline: true,
      },
      ...(festa
        ? buildGambleProfileFields({
            openTickets: festa.openTickets,
            betHistory: festa.betHistory,
          })
        : []),
    ],
  };

  if (chartData.length > 0) {
    const qcConfig = {
      type: 'line',
      data: {
        labels,
        datasets: [
          {
            label: 'Fans gained',
            data: chartData,
            borderColor: 'rgb(75, 192, 192)',
            backgroundColor: 'rgba(75, 192, 192, 0.2)',
            fill: true,
            tension: 0.2,
          },
        ],
      },
      options: {
        legend: { display: false },
        plugins: {
          datalabels: { display: true, align: 'top', anchor: 'end' },
          tickFormat: { useGrouping: true, locale: 'en-US', applyToDataLabels: true },
        },
        scales: {
          xAxes: [{ display: true, gridLines: { display: false } }],
          yAxes: [{
            display: true,
            gridLines: { display: false },
            scaleLabel: { display: true, labelString: 'Fans' },
          }],
        },
      },
    };

    embed.image = {
      url: `https://quickchart.io/chart?w=600&h=300&c=${encodeURIComponent(JSON.stringify(qcConfig))}`,
    };
  }

  return embed;
}

export function buildLeaderboardEmbed(data, targetInfo = null) {
  const circle = data.circle;
  const members = data.members || [];
  const cutoff = getActiveCutoffMs(members);

  const activeMembers = members
    .filter((m) => isMemberActive(m, cutoff))
    .map((m) => {
      const fanStats = getMemberFanStats(m.daily_fans);
      return {
        ...m,
        monthlyGain: fanStats.monthlyGain,
        contributionFans: fanStats.contributionFans,
        averageDays: fanStats.averageDays,
      };
    })
    .sort((a, b) => b.contributionFans - a.contributionFans);

  const nameW = 13;
  const rankW = 4;
  const totalW = 6;
  const dailyW = 6;
  const header =
    'Rank Name           Total  Daily  \n' +
    '----------------------------------  ';

  const rows = activeMembers.map((m, idx) => {
    const rank = `#${idx + 1}`.padEnd(rankW, ' ');
    const name = truncateAndPadName(m.trainer_name, nameW);
    const totalFans = formatCompactInt(m.contributionFans).padStart(totalW, ' ');
    const dailyAvg = formatCompactInt(Math.round(m.monthlyGain / m.averageDays)).padStart(dailyW, ' ');
    return `${rank} ${name} ${totalFans} ${dailyAvg}  `;
  });

  const lines = [];
  const currentRank = circle.live_rank ?? circle.monthly_rank ?? '—';
  lines.push(`**Current Rank:** # ${currentRank}`);
  lines.push(`**Last Month's Rank:** # ${circle.last_month_rank ?? '—'}`);

  if (targetInfo) {
    lines.push(`**Target Tier:** ${targetInfo.tierRangeLabel ?? targetInfo.tierLabel}`);
    lines.push(
      `**Daily Target (per member):** ${
        targetInfo.dailyTarget == null ? '—' : formatIntWithCommas(Math.round(targetInfo.dailyTarget))
      }`,
    );
  } else {
    lines.push('**Target Tier:** — *(set with `/club settarget`)*');
    lines.push('**Daily Target (per member):** —');
  }

  if (!activeMembers.length) {
    lines.push('');
    lines.push('*No active members yet*');
  } else {
    lines.push('');
    lines.push(['```', header, ...rows, '```'].join('\n'));
  }

  const circleId = circle?.circle_id ?? circle?.id;
  return {
    color: 0xF1C40F,
    title: `🏆 ${circle.name} — Monthly Fans`,
    url: circleId ? `https://uma.moe/circles/${circleId}` : undefined,
    description: lines.join('\n'),
    footer: {
      text: `Last updated • ${circle.last_updated ? new Date(circle.last_updated).toLocaleString() : '—'}`,
    },
    timestamp: new Date().toISOString(),
  };
}

const ALL_CLUBS_LEADERBOARD_VALUE = 'all';
const ALL_LEADERBOARD_PAGE_SIZE = 30;

function abbreviateClubLabel(name, width = 4) {
  const text = String(name || '—').trim() || '—';
  return (text.length > width ? text.slice(0, width) : text).padEnd(width, ' ');
}

function getActiveMembersWithClubLabel(data, clubLabel) {
  const members = data?.members || [];
  const cutoff = getActiveCutoffMs(members);

  return members
    .filter((m) => isMemberActive(m, cutoff))
    .map((m) => {
      const fanStats = getMemberFanStats(m.daily_fans);
      return {
        ...m,
        clubLabel,
        monthlyGain: fanStats.monthlyGain,
        contributionFans: fanStats.contributionFans,
        averageDays: fanStats.averageDays,
      };
    });
}

export function isAllClubsLeaderboardQuery(query) {
  const normalized = String(query || '').trim().toLowerCase();
  return normalized === ALL_CLUBS_LEADERBOARD_VALUE || normalized === 'all clubs';
}

export function buildAllLeaderboardEmbeds(guildClubs, datasets) {
  const dataByCircleId = new Map(datasets.map((d) => [String(d.circleId), d]));
  const combined = [];

  for (const club of guildClubs) {
    const dataset = dataByCircleId.get(String(club.circleId));
    if (!dataset?.members?.length) continue;
    const label = abbreviateClubLabel(club.circleName || dataset.clubName, 4);
    combined.push(...getActiveMembersWithClubLabel(dataset, label));
  }

  combined.sort((a, b) => b.contributionFans - a.contributionFans);

  const clubNames = guildClubs
    .map((club) => club.circleName || club.circleId)
    .filter(Boolean);
  const totalPages = Math.max(1, Math.ceil(combined.length / ALL_LEADERBOARD_PAGE_SIZE));
  const embeds = [];

  for (let pageIdx = 0; pageIdx < totalPages; pageIdx += 1) {
    const start = pageIdx * ALL_LEADERBOARD_PAGE_SIZE;
    const pageMembers = combined.slice(start, start + ALL_LEADERBOARD_PAGE_SIZE);

    const nameW = 10;
    const rankW = 4;
    const clubW = 4;
    const monthlyW = 7;
    const dailyW = 6;
    const header =
      'Rank Name        Club Monthly  Daily  \n' +
      '--------------------------------------  ';
    const rows = pageMembers.map((m, idx) => {
      const rank = `#${start + idx + 1}`.padEnd(rankW, ' ');
      const name = truncateAndPadName(m.trainer_name, nameW);
      const club = m.clubLabel || abbreviateClubLabel('—', clubW);
      const monthlyFans = formatCompactInt(m.contributionFans).padStart(monthlyW, ' ');
      const dailyAvg = formatCompactInt(Math.round(m.monthlyGain / m.averageDays)).padStart(dailyW, ' ');
      return `${rank} ${name} ${club} ${monthlyFans} ${dailyAvg}  `;
    });

    const lines = [];
    lines.push(`**Combined Clubs:** ${clubNames.join(' + ') || '—'}`);
    lines.push(`**Total Active Members:** ${combined.length}`);
    lines.push(`**Page:** ${pageIdx + 1}/${totalPages}`);

    if (!pageMembers.length) {
      lines.push('');
      lines.push('*No active members yet*');
    } else {
      lines.push('');
      lines.push(['```', header, ...rows, '```'].join('\n'));
    }

    embeds.push({
      color: 0xF1C40F,
      title: '🏆 All Clubs — Monthly Fans',
      description: lines.join('\n'),
      timestamp: new Date().toISOString(),
    });
  }

  return embeds;
}

export function buildAllLeaderboardPageButtons(pageIdx, totalPages, ownerUserId, guildId) {
  return {
    type: 1,
    components: [
      {
        type: 2,
        style: 2,
        custom_id: `lb_all_prev:${ownerUserId}:${guildId}:${pageIdx}`,
        label: 'Previous',
        disabled: pageIdx <= 0,
      },
      {
        type: 2,
        style: 2,
        custom_id: `lb_all_next:${ownerUserId}:${guildId}:${pageIdx}`,
        label: 'Next',
        disabled: pageIdx >= totalPages - 1,
      },
    ],
  };
}

export async function buildAllLeaderboardPackage(guildClubs) {
  const datasets = await buildClubDatasets(guildClubs.map((club) => club.circleId));
  return {
    embeds: buildAllLeaderboardEmbeds(guildClubs, datasets),
  };
}

export async function buildAllLeaderboardPageResponse(guildClubs, pageIdx, ownerUserId, guildId) {
  const { embeds } = await buildAllLeaderboardPackage(guildClubs);
  const totalPages = Math.max(1, embeds.length);
  const safePage = Math.max(0, Math.min(pageIdx, totalPages - 1));

  return {
    embeds: [embeds[safePage]],
    components:
      totalPages > 1
        ? [buildAllLeaderboardPageButtons(safePage, totalPages, ownerUserId, guildId)]
        : [],
  };
}

export function findTrainerCandidates(targetName, datasets) {
  const lowerTarget = targetName.toLowerCase();
  const exact = [];
  const partial = [];

  for (const dataset of datasets) {
    for (const member of dataset.members) {
      const lowerName = (member.trainer_name || '').toLowerCase();
      if (lowerName === lowerTarget) {
        exact.push({ ...dataset, member });
      } else if (lowerName.includes(lowerTarget)) {
        partial.push({ ...dataset, member });
      }
    }
  }

  return exact.length ? exact : partial;
}

export async function buildClubDatasets(circleIds) {
  const uniqueIds = [...new Set(circleIds.map(String))];
  const results = await Promise.all(
    uniqueIds.map(async (circleId) => {
      const data = await fetchCircleData(circleId);
      return {
        circleId,
        clubName: data?.circle?.name ?? circleId,
        circle: data?.circle,
        members: data?.members || [],
      };
    }),
  );
  return results;
}

export function findMemberByViewerId(datasets, viewerId) {
  const target = String(viewerId);
  for (const dataset of datasets) {
    const member = dataset.members.find((m) => String(m.viewer_id) === target);
    if (member) return { ...dataset, member };
  }
  return null;
}

export function findClubsByName(registeredClubs, clubNameQuery) {
  const query = clubNameQuery.trim().toLowerCase();
  if (!query) return [];

  return registeredClubs.filter((club) => {
    const name = (club.circleName || '').toLowerCase();
    return name === query || name.includes(query);
  });
}

export function buildProfileSelectRow(candidates, ownerUserId) {
  const customId = `profile_pick:${ownerUserId}`;
  const limited = candidates.slice(0, 25);
  return {
    type: 1,
    components: [
      {
        type: 3,
        custom_id: customId,
        placeholder: 'Multiple trainers found — choose one',
        options: limited.map((c) => ({
          label: (c.member.trainer_name || 'Unknown').slice(0, 100),
          value: `${c.circleId}::${c.member.viewer_id}`.slice(0, 100),
          description: (c.clubName || 'Club').slice(0, 100),
        })),
      },
    ],
  };
}

export function buildLeaderboardSelectRow(clubs, circleDataById, ownerUserId) {
  const customId = `leaderboard_pick:${ownerUserId}`;
  const limited = clubs.slice(0, 25);
  return {
    type: 1,
    components: [
      {
        type: 3,
        custom_id: customId,
        placeholder: 'Multiple clubs found — choose one',
        options: limited.map((club) => {
          const circle = circleDataById.get(String(club.circleId))?.circle;
          const rank = circle?.live_rank ?? circle?.monthly_rank;
          const rankLabel = rank != null ? `Rank #${rank}` : 'Rank unknown';
          return {
            label: (club.circleName || circle?.name || club.circleId).slice(0, 100),
            value: String(club.circleId).slice(0, 100),
            description: rankLabel.slice(0, 100),
          };
        }),
      },
    ],
  };
}

export async function resolveProfileFromPick(value) {
  const [circleId, viewerId] = String(value).split('::');
  if (!viewerId) throw new Error('Invalid selection.');
  const { embed } = await buildProfileEmbedForViewerId(viewerId, {
    circleIdHint: circleId || undefined,
  });
  return embed;
}

export function isTop100Circle(circle) {
  const rank = circle?.live_rank;
  return typeof rank === 'number' && rank > 0 && rank <= 100;
}

export async function buildLeaderboardPackage(circleId, options = {}) {
  const { guildId = null } = options;
  const data = await fetchCircleData(circleId);
  const targetInfo = guildId ? await resolveClubTargetInfo(guildId, circleId, data) : null;
  const embed = buildLeaderboardEmbed(data, targetInfo);
  return {
    data,
    embed,
    isTop100: isTop100Circle(data.circle),
  };
}

export async function resolveLeaderboardFromCircleId(circleId, options = {}) {
  const pkg = await buildLeaderboardPackage(circleId, options);
  return pkg.embed;
}

export async function enrichGambaLeaderboardEntries(entries) {
  const enriched = await Promise.all(
    entries.map(async (entry) => {
      if (entry.umaTrainerName) {
        return { ...entry, displayName: entry.umaTrainerName };
      }
      if (!entry.viewerId) {
        return { ...entry, displayName: entry.trainerName || 'Trainer' };
      }

      try {
        const profile = await fetchUserProfile(entry.viewerId);
        setUmaTrainerName(entry.discordUserId, profile.trainerName);
        return {
          ...entry,
          umaTrainerName: profile.trainerName,
          trainerName: profile.trainerName,
          displayName: profile.trainerName,
        };
      } catch (err) {
        console.warn(`Could not resolve trainer name for ${entry.viewerId}:`, err.message);
        return { ...entry, displayName: entry.trainerName || 'Trainer' };
      }
    }),
  );
  return enriched;
}
