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

export async function buildProfileEmbedForViewerId(viewerId, options = {}) {
  const { circleIdHint = null, festa = null } = options;
  const profile = await fetchUserProfile(viewerId);
  let circle = profile.circle;
  let member = profile.member;
  let members = [];

  const circleId = profile.circleId ?? circleIdHint ?? null;
  if (circleId) {
    try {
      const circleData = await fetchCircleData(circleId);
      circle = circleData.circle ?? circle;
      members = circleData.members || [];
      const fromCircle = members.find((m) => String(m.viewer_id) === String(viewerId));
      if (fromCircle) member = fromCircle;
    } catch (err) {
      console.warn(`Could not refresh circle ${circleId} for profile:`, err.message);
    }
  }

  if (!member) {
    throw new Error('Could not load trainer fan data from uma.moe.');
  }

  const ranks =
    circle && members.length
      ? buildTrainerRanks(circle, members, viewerId)
      : {};

  return buildProfileEmbed({
    member,
    circle: circle ?? (profile.circleName ? { name: profile.circleName, circle_id: circleId } : null),
    ranks,
    festa,
  });
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

export async function fetchCurrentTarget(circleData) {
  const circle = circleData?.circle;
  if (!circle) return null;

  const rank = circle.live_rank ?? circle.monthly_rank;
  const useLivePoints = typeof rank === 'number' ? rank <= 100 : true;
  const page = useLivePoints ? 99 : 499;
  const payload = await fetchUmaJson(`https://uma.moe/api/v4/circles/list?page=${page}&limit=1`);
  const firstCircle = Array.isArray(payload?.circles) ? payload.circles[0] : null;
  if (!firstCircle) return null;

  const totalPoints = useLivePoints ? firstCircle.live_points : firstCircle.monthly_point;
  if (typeof totalPoints !== 'number') return null;

  const daysElapsed = getDaysSinceJstMonthSecondMidnight();
  return totalPoints / 30 / daysElapsed;
}

export function getMemberFanStats(rawFans) {
  const fans = Array.isArray(rawFans) ? rawFans.filter((n) => typeof n === 'number') : [];
  const lastPositiveIdx = fans.reduce((idx, n, i) => (n > 0 ? i : idx), -1);
  if (lastPositiveIdx < 0) return { ...EMPTY_FAN_STATS };

  const trimmed = fans.slice(0, lastPositiveIdx + 1);

  let lastNegativeIdx = -1;
  let negativeCount = 0;
  for (let i = 0; i < trimmed.length; i += 1) {
    if (trimmed[i] < 0) {
      lastNegativeIdx = i;
      negativeCount += 1;
    }
  }

  const isPreviousMonthBaselineOnly = negativeCount === 1 && lastNegativeIdx === 0;

  let dailyFans;

  if (lastNegativeIdx < 0) {
    const firstPositiveIdx = trimmed.findIndex((n) => n > 0);
    const start = firstPositiveIdx > 0 ? firstPositiveIdx : 0;
    let prev = trimmed[start];
    dailyFans = trimmed.slice(start).map((n) => {
      const v = n > 0 ? n : prev;
      prev = v;
      return v;
    });
  } else if (isPreviousMonthBaselineOnly) {
    const baseline = Math.abs(trimmed[0]);
    let prev = baseline;
    const rest = trimmed.slice(1).map((n) => {
      const v = n > 0 ? n : prev;
      prev = v;
      return v;
    });
    dailyFans = [baseline, ...rest];
  } else {
    const baseline = Math.abs(trimmed[lastNegativeIdx]);
    let prev = baseline;
    const postJoin = trimmed.slice(lastNegativeIdx + 1).map((n) => {
      const v = n > 0 ? n : prev;
      prev = v;
      return v;
    });
    dailyFans = [baseline, ...postJoin];
  }

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

export function getActiveCutoffMs(members) {
  const stamps = (members || []).map(getMemberLastUpdatedMs).filter((t) => t != null);
  if (!stamps.length) return null;
  return Math.max(...stamps) - ACTIVE_LAG_TOLERANCE_MS;
}

export function isMemberActive(member, cutoffMs) {
  const ts = getMemberLastUpdatedMs(member);
  if (ts == null) return false;
  if (cutoffMs == null) return true;
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

function normalizeName(raw) {
  let name = raw || 'Unknown';
  name = name.replace(/！/g, '!').replace(/＠/g, '@').replace(/\s+/g, ' ');
  if (name.includes('くま')) name = 'Kuma Kaibutsu';
  if (name.includes('Hai')) name = 'Hai!Aku Aru!';
  return name;
}

function stripDisplaySuffix(name) {
  return String(name || '').replace(/＠/g, '@').trimEnd();
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
  return {
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
    ],
  };
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

export function buildLeaderboardEmbed(data, currentTarget = null) {
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
  lines.push(
    `**Current Target:** ${currentTarget == null ? '—' : formatIntWithCommas(Math.round(currentTarget))}`,
  );

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
  return buildProfileEmbedForViewerId(viewerId, { circleIdHint: circleId || undefined });
}

export function isTop100Circle(circle) {
  const rank = circle?.live_rank;
  return typeof rank === 'number' && rank > 0 && rank <= 100;
}

export async function buildLeaderboardPackage(circleId) {
  const data = await fetchCircleData(circleId);
  const currentTarget = await fetchCurrentTarget(data);
  const embed = buildLeaderboardEmbed(data, currentTarget);
  return {
    data,
    embed,
    isTop100: isTop100Circle(data.circle),
  };
}

export async function resolveLeaderboardFromCircleId(circleId) {
  const pkg = await buildLeaderboardPackage(circleId);
  return pkg.embed;
}
