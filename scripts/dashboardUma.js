import { fetchUmaJson, fetchCircleData, resolveClubTargetInfo, getRankThresholds, findRankThreshold, computeMemberDailyTarget } from './clubService.js';
import { getGuildClubs } from './clubDatabase.js';
import {
  applicantCircleCandidates,
  applicantClubName,
  classifyPerformance,
  getActiveCutoffMs,
  getFullPeriodFanStats,
  getMemberFanStats,
  getTodayFanGain,
  isMemberActive,
  pickCurrentMonthRecord,
  withMonthSummary,
} from './dashboardPerformance.js';
import {
  getClubSettingsMap,
  getDashboardMaxClubs,
  recordManagedRoster,
} from './dashboardStore.js';

export function listGuildDashboardClubs(guildId) {
  const registered = getGuildClubs(guildId);
  const extras = getClubSettingsMap(guildId);
  const max = getDashboardMaxClubs();
  return registered.map((club) => {
    const extra = extras[String(club.circleId)] || {};
    const dailyTarget = extra.dailyTarget != null
      ? Number(extra.dailyTarget)
      : (typeof club.manualTarget === 'number' ? club.manualTarget : 0);
    return {
      circleId: String(club.circleId),
      name: String(club.circleName || extra.name || club.circleId),
      dailyTarget: Number.isFinite(dailyTarget) ? dailyTarget : 0,
      promotionRatio: extra.promotionRatio ?? 1.25,
      severeRatio: extra.severeRatio ?? 0.5,
      inactiveDays: extra.inactiveDays ?? 3,
      promotionEnabled: extra.promotionEnabled !== false,
      rankGrade: extra.rankGrade ?? null,
      cardColor: extra.cardColor || null,
      cardColor2: extra.cardColor2 || null,
      dynamicRequirement: extra.dynamicRequirement === true,
      storedDailyTarget: Number.isFinite(dailyTarget) ? dailyTarget : 0,
      showTotal: club.showTotal !== false,
      showAvg: club.showAvg !== false,
      showToday: club.showToday !== false,
      sortOrder: Number.isFinite(Number(extra.sortOrder)) ? Number(extra.sortOrder) : 9999,
    };
  }).sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name)).slice(0, max);
}

const RANK_GRADE_TO_TIER = {
  ss: 'SS',
  splus: 'S+',
  s: 'S',
  aplus: 'A+',
  a: 'A',
  bplus: 'B+',
  b: 'B',
};

export async function applyDynamicDailyTargets(clubs) {
  const next = clubs.map((club) => ({
    ...club,
    dynamicRequirement: club.dynamicRequirement === true,
    storedDailyTarget: Number.isFinite(Number(club.storedDailyTarget))
      ? Number(club.storedDailyTarget)
      : club.dailyTarget,
  }));
  if (!next.some((club) => club.dynamicRequirement)) return next;
  try {
    const tiers = await getRankThresholds();
    return next.map((club) => {
      if (!club.dynamicRequirement) return club;
      const tierName = RANK_GRADE_TO_TIER[String(club.rankGrade || '').toLowerCase()];
      const threshold = tierName ? findRankThreshold(tiers, tierName) : null;
      const live = threshold ? computeMemberDailyTarget(threshold.clubFansPerDay) : null;
      const dailyTarget = live != null && live > 0
        ? Math.max(1, Math.round(live))
        : club.storedDailyTarget;
      return { ...club, dailyTarget };
    });
  } catch (error) {
    console.warn('Rank thresholds unavailable; using stored daily targets.', error.message);
    return next;
  }
}

const RANK_LADDER = ['b', 'bplus', 'a', 'aplus', 's', 'splus', 'ss'];

function nextRankGrade(grade) {
  const index = RANK_LADDER.indexOf(String(grade || '').toLowerCase());
  if (index < 0 || index >= RANK_LADDER.length - 1) return null;
  return RANK_LADDER[index + 1];
}

async function thresholdDailyTarget(grade) {
  const tierName = RANK_GRADE_TO_TIER[grade];
  if (!tierName) return null;
  const tiers = await getRankThresholds();
  const threshold = findRankThreshold(tiers, tierName);
  const live = threshold ? computeMemberDailyTarget(threshold.clubFansPerDay) : null;
  return live != null && live > 0 ? Math.max(1, Math.round(live)) : null;
}

export async function attachPromotionTargets(clubs) {
  const resolved = new Map();
  return Promise.all(clubs.map(async (club) => {
    if (club.promotionEnabled === false) {
      return { ...club, promotionTarget: null, promotionTier: null };
    }
    const next = nextRankGrade(club.rankGrade);
    if (!next) return { ...club, promotionTarget: null, promotionTier: null };
    const peerTargets = clubs
      .filter((other) => String(other.rankGrade || '').toLowerCase() === next && Number(other.dailyTarget) > 0)
      .map((other) => Number(other.dailyTarget));
    let promotionTarget = peerTargets.length ? Math.min(...peerTargets) : null;
    if (promotionTarget == null) {
      if (!resolved.has(next)) {
        try {
          resolved.set(next, await thresholdDailyTarget(next));
        } catch (error) {
          console.warn(`Promotion threshold unavailable for ${next}.`, error.message);
          resolved.set(next, null);
        }
      }
      promotionTarget = resolved.get(next);
    }
    return {
      ...club,
      promotionTarget,
      promotionTier: promotionTarget ? RANK_GRADE_TO_TIER[next] : null,
    };
  }));
}

export function withPlannedMemberCounts(clubs, assignments) {
  const clubIds = new Set(clubs.map((club) => String(club.circleId)));
  const rosters = new Map(clubs.map((club) => [
    String(club.circleId),
    new Set((club.members || []).map((member) => String(member.umaId))),
  ]));
  const home = new Map();
  for (const [circleId, roster] of rosters) {
    for (const umaId of roster) {
      if (!home.has(umaId)) home.set(umaId, circleId);
    }
  }
  for (const item of assignments || []) {
    const id = String(item?.entityId || '').trim();
    if (!id) continue;
    const dest = item.destination === 'unassigned' ? 'applicants' : String(item.destination || '');
    if (item.entityType === 'member') {
      const from = home.get(id);
      if (from && dest !== from) rosters.get(from)?.delete(id);
      if (clubIds.has(dest)) rosters.get(dest)?.add(id);
    } else if (item.entityType === 'applicant' && clubIds.has(dest)) {
      rosters.get(dest)?.add(id);
    }
  }
  return clubs.map((club) => ({
    ...club,
    plannedMembers: Math.min(30, rosters.get(String(club.circleId))?.size || 0),
  }));
}

export async function hydrateClubTargets(guildId, clubs) {
  const next = [];
  for (const club of clubs) {
    if (club.dailyTarget > 0) {
      next.push(club);
      continue;
    }
    try {
      const info = await resolveClubTargetInfo(guildId, club.circleId, null);
      const dailyTarget = info?.dailyTarget != null && Number.isFinite(info.dailyTarget)
        ? Math.round(info.dailyTarget)
        : 0;
      next.push({ ...club, dailyTarget });
    } catch {
      next.push(club);
    }
  }
  return next;
}

export async function resolveUmaProfile(umaId) {
  const root = await fetchUmaJson(`https://uma.moe/api/v4/user/profile/${encodeURIComponent(umaId)}`);
  const trainer = root?.trainer ?? root?.user ?? root?.profile ?? root;
  const month = pickCurrentMonthRecord(root?.fan_history?.monthly);
  const circle = root?.circle ?? trainer?.circle ?? root?.club;
  const ign = trainer?.name ?? trainer?.trainer_name ?? month?.trainer_name;
  if (!ign) throw new Error(`Trainer ${umaId} was not found on uma.moe.`);
  let member = null;
  let loadedClubName = null;
  let currentClubId = null;
  for (const circleId of applicantCircleCandidates(root)) {
    const circleData = await fetchCircleData(circleId);
    const found = (circleData?.members || []).find((item) => String(item.viewer_id) === String(umaId));
    if (found) {
      member = found;
      currentClubId = circleId;
      loadedClubName = circleData?.circle?.name ?? null;
      break;
    }
  }
  const stats = withMonthSummary(getFullPeriodFanStats(member?.daily_fans), month);
  return {
    ign: String(ign),
    currentClubId,
    currentClubName: applicantClubName(month, circle, loadedClubName),
    lastUpdatedAt: member?.last_updated ?? null,
    totalFans: stats.totalFans,
    monthlyGain: stats.monthlyGain,
    dailyAverage: stats.dailyAverage,
    todayGain: getTodayFanGain(member?.daily_fans),
    dailyGains: stats.dailyGains,
  };
}

export async function buildPublicClub(guildId, club) {
  const data = await fetchCircleData(club.circleId);
  const circle = data?.circle || {};
  const roster = data?.members || [];
  const cutoff = getActiveCutoffMs(roster);
  const members = roster
    .filter((member) => isMemberActive(member, cutoff))
    .map((member) => {
      const stats = getMemberFanStats(member.daily_fans);
      const decision = classifyPerformance({
        dailyAverage: stats.dailyAverage,
        dailyTarget: club.dailyTarget,
        lastUpdatedAt: member.last_updated,
        promotionRatio: club.promotionRatio,
        promotionTarget: club.promotionTarget,
        promotionTier: club.promotionTier,
        severeRatio: club.severeRatio,
        inactiveDays: club.inactiveDays,
        promotionEnabled: club.promotionEnabled !== false,
      });
      return {
        umaId: String(member.viewer_id),
        ign: member.trainer_name || 'Unknown',
        lastUpdatedAt: member.last_updated ?? null,
        totalFans: stats.totalFans,
        monthlyGain: stats.monthlyGain,
        dailyAverage: stats.dailyAverage,
        todayGain: getTodayFanGain(member.daily_fans),
        dailyGains: stats.dailyGains,
        band: decision.band,
        reason: decision.reason,
      };
    });

  const liveRank = circle.live_rank ?? circle.monthly_rank ?? null;
  const yesterdayRank = circle.yesterday_rank ?? null;
  const livePoints = typeof circle.live_points === 'number' ? circle.live_points : null;
  const yesterdayPoints = typeof circle.yesterday_points === 'number' ? circle.yesterday_points : null;
  const monthlyFans = livePoints ?? (typeof circle.monthly_point === 'number' ? circle.monthly_point : null);
  const rankDelta = liveRank != null && yesterdayRank != null ? yesterdayRank - liveRank : null;

  await recordManagedRoster(guildId, club.circleId, members.map((member) => ({
    umaId: member.umaId,
    ign: member.ign,
  })));

  return {
    ...club,
    rank: liveRank,
    yesterdayRank,
    rankDelta,
    lastMonthRank: circle.last_month_rank ?? null,
    monthlyFans,
    fansSinceYesterday:
      livePoints != null && yesterdayPoints != null ? livePoints - yesterdayPoints : null,
    rankGrade: club.rankGrade || null,
    sourceUpdatedAt: circle.last_live_update ?? circle.last_updated ?? null,
    members,
  };
}

const CACHE_MS = Math.max(60_000, Number(process.env.DASHBOARD_CACHE_MS || 300_000));

export function cacheTtlMs() {
  return CACHE_MS;
}
