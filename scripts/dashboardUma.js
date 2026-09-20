import { fetchUmaJson, fetchCircleData, resolveClubTargetInfo } from './clubService.js';
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
  return registered.slice(0, max).map((club) => {
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
    };
  });
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
