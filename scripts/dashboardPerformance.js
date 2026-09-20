export function getEffectiveJstPeriod(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const value = (type) => Number(parts.find((part) => part.type === type)?.value);
  let year = value('year');
  let month = value('month') - 1;
  if (value('day') < 2) {
    month -= 1;
    if (month < 0) {
      month = 11;
      year -= 1;
    }
  }
  return { year, month };
}

export function pickCurrentMonthRecord(monthly, now = new Date()) {
  if (!Array.isArray(monthly) || monthly.length === 0) return null;
  const { year, month } = getEffectiveJstPeriod(now);
  const jstMonth = month + 1;
  const match = monthly.find((row) => (
    row && typeof row === 'object'
    && Number(row.year) === year
    && Number(row.month) === jstMonth
  ));
  const row = match || monthly[0];
  return row && typeof row === 'object' ? row : null;
}

export function applicantCircleCandidates(root, now = new Date()) {
  const month = pickCurrentMonthRecord(root?.fan_history?.monthly, now);
  const circle = root?.circle ?? root?.trainer?.circle ?? root?.club;
  const ids = [month?.circle_id, circle?.circle_id, circle?.id]
    .map((id) => (id == null || String(id).trim() === '' ? '' : String(id)))
    .filter(Boolean);
  return [...new Set(ids)];
}

export function applicantClubName(month, circle, loadedName) {
  return loadedName || month?.circle_name || circle?.name || null;
}

export function withMonthSummary(stats, month) {
  if (!month) return stats;
  return {
    ...stats,
    monthlyGain: typeof month.monthly_gain === 'number' ? Math.max(0, Math.round(month.monthly_gain)) : stats.monthlyGain,
    dailyAverage: typeof month.avg_daily === 'number' ? Math.round(month.avg_daily) : stats.dailyAverage,
    totalFans: typeof month.total_fans === 'number' ? month.total_fans : stats.totalFans,
  };
}

export function getMemberFanStats(rawFans) {
  const fans = Array.isArray(rawFans) ? rawFans.filter((value) => typeof value === 'number') : [];
  const lastPositive = fans.reduce((found, value, index) => (value > 0 ? index : found), -1);
  if (lastPositive < 0) {
    return { dailyFans: [], dailyGains: [], monthlyGain: 0, totalFans: 0, averageDays: 1, dailyAverage: 0 };
  }
  const trimmed = fans.slice(0, lastPositive + 1);
  const lastNegative = trimmed.reduce((found, value, index) => (value < 0 ? index : found), -1);
  let dailyFans = [];
  if (lastNegative < 0) {
    const firstPositive = trimmed.findIndex((value) => value > 0);
    if (firstPositive >= 0) {
      let previous = trimmed[firstPositive];
      dailyFans = trimmed.slice(firstPositive).map((value) => {
        if (value > 0) previous = value;
        return previous;
      });
    }
  } else {
    const baseline = Math.abs(trimmed[lastNegative]);
    let start = lastNegative + 1;
    while (start < trimmed.length && trimmed[start] <= 0) start += 1;
    dailyFans = [baseline];
    let previous = baseline;
    for (const value of trimmed.slice(start)) {
      if (value > 0) previous = value;
      dailyFans.push(previous);
    }
  }
  const first = dailyFans[0] ?? 0;
  const totalFans = dailyFans.length ? dailyFans[dailyFans.length - 1] : first;
  const monthlyGain = Math.max(0, totalFans - first);
  const averageDays = Math.max(1, dailyFans.length - 1);
  return {
    dailyFans,
    dailyGains: dailyFans.slice(1).map((value, index) => Math.max(0, value - dailyFans[index])),
    monthlyGain,
    totalFans,
    averageDays,
    dailyAverage: Math.round(monthlyGain / averageDays),
  };
}

export function getFullPeriodFanStats(rawFans) {
  const fans = Array.isArray(rawFans) ? rawFans.filter((value) => typeof value === 'number') : [];
  return getMemberFanStats(fans.map((value) => (value < 0 ? Math.abs(value) : value)));
}

function getCurrentJstDayIndex(now = new Date()) {
  const day = Number(new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Tokyo', day: 'numeric' }).format(now));
  return Number.isFinite(day) ? Math.max(0, day - 1) : null;
}

function resolveDailyFansValueAt(rawFans, dayIdx) {
  if (!Array.isArray(rawFans) || dayIdx < 0) return null;
  for (let i = Math.min(dayIdx, rawFans.length - 1); i >= 0; i -= 1) {
    const value = rawFans[i];
    if (typeof value !== 'number') continue;
    if (value > 0) return value;
    if (value < 0) return Math.abs(value);
  }
  return null;
}

export function getTodayFanGain(rawFans, now = new Date()) {
  const dayIdx = getCurrentJstDayIndex(now);
  if (dayIdx == null || dayIdx <= 0) return 0;
  const today = resolveDailyFansValueAt(rawFans, dayIdx);
  const yesterday = resolveDailyFansValueAt(rawFans, dayIdx - 1);
  if (today == null || yesterday == null) return 0;
  return Math.max(0, today - yesterday);
}

function hasTodayAndYesterdayZeroDailyFans(member, now = new Date()) {
  const fans = Array.isArray(member.daily_fans) ? member.daily_fans : [];
  if (!fans.length) return false;
  const dayIdx = getCurrentJstDayIndex(now);
  if (dayIdx == null || dayIdx <= 0 || dayIdx >= fans.length) return false;
  return fans[dayIdx] === 0 && fans[dayIdx - 1] === 0;
}

export function isMemberActive(member, cutoffMs, now = new Date()) {
  if (hasTodayAndYesterdayZeroDailyFans(member, now)) return false;
  if (cutoffMs == null) return true;
  const ts = member.last_updated ? new Date(member.last_updated).getTime() : Number.NaN;
  if (!Number.isFinite(ts)) return false;
  return ts >= cutoffMs;
}

export function classifyPerformance(input) {
  const {
    dailyAverage,
    dailyTarget,
    lastUpdatedAt,
    promotionRatio = 1.25,
    meetingRatio = 0.9,
    severeRatio = 0.5,
    inactiveDays = 3,
    promotionEnabled = true,
    now = new Date(),
  } = input;
  const updatedMs = lastUpdatedAt ? new Date(lastUpdatedAt).getTime() : Number.NaN;
  const staleDays = Number.isFinite(updatedMs) ? Math.max(0, (now.getTime() - updatedMs) / 86_400_000) : Number.POSITIVE_INFINITY;
  if (staleDays >= inactiveDays) {
    return { band: 'inactive', reason: `No update for ${Math.floor(staleDays)} days`, ratio: null };
  }
  const ratio = dailyTarget > 0 ? dailyAverage / dailyTarget : 1;
  const reason = `${Math.round(ratio * 100)}% of daily requirement`;
  if (promotionEnabled && ratio >= promotionRatio) return { band: 'promotion', reason, ratio };
  if (ratio >= meetingRatio) return { band: 'meeting', reason, ratio };
  if (ratio < severeRatio) return { band: 'severe', reason, ratio };
  return { band: 'under', reason, ratio };
}

export function getActiveCutoffMs(members) {
  const times = members
    .map((member) => (member.last_updated ? new Date(member.last_updated).getTime() : Number.NaN))
    .filter(Number.isFinite);
  if (!times.length) return null;
  const freshest = Math.max(...times);
  const cutoff = freshest - 2 * 60 * 60 * 1000;
  return times.filter((time) => time >= cutoff).length / Math.max(1, members.length) >= 0.75 ? cutoff : null;
}
