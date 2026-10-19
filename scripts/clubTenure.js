import { fetchUmaJson, getUserProfileUrl } from './clubService.js';
import { getGuildClubs } from './clubDatabase.js';
import { getEffectiveJstPeriod } from './dashboardPerformance.js';
import { getTenureCache, listMemberDirectory, saveTenureCache } from './dashboardStore.js';

function monthIndex(year, month) {
  return year * 12 + (month - 1);
}

function monthStamp(year, month) {
  return `${year}-${String(month).padStart(2, '0')}`;
}

/**
 * Months the trainer spent in any registered club, from uma.moe monthly history.
 * Moving between registered clubs keeps the total. Months outside those clubs do not count.
 * If the oldest month uma.moe has is already inside a registered club, earlier time is unknown.
 */
export function summarizeNetworkTenure(monthly, registered, options = {}) {
  const clubs = new Map((registered || []).map((club) => [String(club.id), club.name || String(club.id)]));
  const rows = (Array.isArray(monthly) ? monthly : [])
    .map((row) => ({
      year: Number(row?.year),
      month: Number(row?.month),
      circleId: row?.circle_id == null || String(row.circle_id).trim() === '' ? '' : String(row.circle_id),
    }))
    .filter((row) => Number.isInteger(row.year) && row.month >= 1 && row.month <= 12);
  rows.sort((a, b) => monthIndex(a.year, a.month) - monthIndex(b.year, b.month));

  const seen = new Set();
  const unique = [];
  for (const row of rows) {
    const key = monthIndex(row.year, row.month);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(row);
  }

  const now = options.now || new Date();
  const period = getEffectiveJstPeriod(now);
  const currentYear = period.year;
  const currentMonth = period.month + 1;
  const currentCircleId = options.currentCircleId ? String(options.currentCircleId) : '';
  const currentKey = monthIndex(currentYear, currentMonth);
  if (currentCircleId && clubs.has(currentCircleId) && !seen.has(currentKey)) {
    unique.push({ year: currentYear, month: currentMonth, circleId: currentCircleId });
    unique.sort((a, b) => monthIndex(a.year, a.month) - monthIndex(b.year, b.month));
  }

  const inNetwork = unique.filter((row) => clubs.has(row.circleId));
  const stints = [];
  for (const row of inNetwork) {
    const key = monthIndex(row.year, row.month);
    const last = stints[stints.length - 1];
    if (last && last.circleId === row.circleId && key === last.endKey + 1) {
      last.endYear = row.year;
      last.endMonth = row.month;
      last.endKey = key;
      last.monthCount += 1;
    } else if (last && last.circleId === row.circleId && key === last.endKey) {
      continue;
    } else {
      stints.push({
        circleId: row.circleId,
        circleName: clubs.get(row.circleId) || row.circleId,
        startYear: row.year,
        startMonth: row.month,
        endYear: row.year,
        endMonth: row.month,
        endKey: key,
        monthCount: 1,
      });
    }
  }

  const first = inNetwork[0] || null;
  const last = inNetwork[inNetwork.length - 1] || null;
  const oldest = unique[0] || null;
  const historyIncomplete = Boolean(
    first && (!oldest || monthIndex(oldest.year, oldest.month) === monthIndex(first.year, first.month)),
  );
  const firstNetworkMonth = first ? monthStamp(first.year, first.month) : null;
  const historyNote = historyIncomplete && firstNetworkMonth
    ? `At least this long. uma.moe’s oldest month is already in a registered club, so time before ${firstNetworkMonth} is missing.`
    : 'Months spent in any registered club, including moves between them. Months outside those clubs are not counted.';

  return {
    networkMonths: inNetwork.length,
    firstNetworkMonth,
    lastNetworkMonth: last ? monthStamp(last.year, last.month) : null,
    historyIncomplete,
    historyNote,
    stints: stints.map((stint) => ({
      circleId: stint.circleId,
      circleName: stint.circleName,
      startYear: stint.startYear,
      startMonth: stint.startMonth,
      endYear: stint.endYear,
      endMonth: stint.endMonth,
      monthCount: stint.monthCount,
    })),
  };
}

async function tenureForTrainer(umaId, registered) {
  const root = await fetchUmaJson(getUserProfileUrl(umaId));
  const trainer = root?.trainer ?? root?.user ?? root?.profile ?? root;
  const circle = root?.circle ?? trainer?.circle ?? null;
  const currentCircleId = circle?.circle_id ?? circle?.id ?? null;
  const summary = summarizeNetworkTenure(root?.fan_history?.monthly, registered, {
    currentCircleId,
  });
  return {
    ign: trainer?.name ?? trainer?.trainer_name ?? null,
    currentCircleId: currentCircleId == null ? null : String(currentCircleId),
    ...summary,
  };
}

export async function warmNetworkTenure(guildId, umaIds) {
  const registered = getGuildClubs(guildId).map((club) => ({
    id: String(club.circleId),
    name: club.circleName || String(club.circleId),
  }));
  const pending = [...new Set((umaIds || []).map((id) => String(id || '').trim()).filter(Boolean))]
    .filter((umaId) => !getTenureCache(guildId, umaId));
  let cursor = 0;
  const workers = Array.from({ length: Math.min(4, pending.length) }, async () => {
    while (cursor < pending.length) {
      const umaId = pending[cursor];
      cursor += 1;
      try {
        const summary = await tenureForTrainer(umaId, registered);
        await saveTenureCache(guildId, umaId, summary);
      } catch (error) {
        console.warn(`[tenure] ${umaId}: ${error.message}`);
      }
    }
  });
  await Promise.all(workers);
}

export async function buildMemberProfile(guildId, umaId) {
  const id = String(umaId || '').trim();
  const registered = getGuildClubs(guildId).map((club) => ({
    id: String(club.circleId),
    name: club.circleName || String(club.circleId),
  }));
  const summary = await tenureForTrainer(id, registered);
  await saveTenureCache(guildId, id, summary);
  const directory = listMemberDirectory(guildId).find((row) => row.umaId === id);
  const current = registered.find((club) => club.id === summary.currentCircleId) || null;
  const lastStint = summary.stints[summary.stints.length - 1] || null;
  return {
    umaId: id,
    ign: summary.ign || directory?.ign || id,
    discordId: directory?.discordId || null,
    status: current ? 'current' : summary.networkMonths > 0 ? 'former' : 'unknown',
    currentCircleId: current?.id || null,
    currentClubName: current?.name || null,
    lastCircleId: lastStint?.circleId || null,
    lastClubName: lastStint?.circleName || null,
    networkMonths: summary.networkMonths,
    firstNetworkMonth: summary.firstNetworkMonth,
    lastNetworkMonth: summary.lastNetworkMonth,
    historyIncomplete: summary.historyIncomplete,
    historyNote: summary.historyNote,
    stints: summary.stints,
    umaMoeUrl: `https://uma.moe/profile/${id}`,
  };
}
