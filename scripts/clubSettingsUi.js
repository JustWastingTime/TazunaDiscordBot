import {
  InteractionResponseFlags,
  InteractionResponseType,
} from 'discord-interactions';
import {
  getAllLeaderboardChannels,
  getGuildClubSettings,
  getGuildClubs,
  setGuildClubManualTarget,
  setGuildClubTarget,
  updateGuildClubSettings,
  updateLeaderboardChannelState,
} from './clubDatabase.js';
import {
  buildLeaderboardPackage,
  computeMemberDailyTarget,
  fetchCircleData,
  findRankThreshold,
  formatIntWithCommas,
  formatTierRankRange,
  getRankThresholds,
} from './clubService.js';
import { hashLeaderboardContent } from './clubLeaderboardCron.js';
import { DiscordRequest } from './utils.js';

const ADMINISTRATOR = 0x8n;

const BOT_OWNER_IDS = new Set(
  String(process.env.BOT_OWNER_IDS || process.env.BOT_OWNER_ID || '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean),
);

function isGuildAdmin(member) {
  if (!member?.permissions) return false;
  try {
    return (BigInt(member.permissions) & ADMINISTRATOR) === ADMINISTRATOR;
  } catch {
    return false;
  }
}

function isBotOwner(userId) {
  return Boolean(userId && BOT_OWNER_IDS.has(String(userId)));
}

function canManageClubSettings(member, userId) {
  return isGuildAdmin(member) || isBotOwner(userId);
}

const CS_PICK = 'cs_pick';
const CS_BTN_RANK = 'cs_btn_rank';
const CS_BTN_MANUAL = 'cs_btn_manual';
const CS_BTN_TOTAL = 'cs_btn_total';
const CS_BTN_AVG = 'cs_btn_avg';
const CS_BTN_TODAY = 'cs_btn_today';
const CS_TIER = 'cs_tier';
const CS_MODAL_MANUAL = 'cs_modal_manual';

function parseIdParts(customId) {
  const parts = String(customId).split(':');
  return {
    kind: parts[0],
    ownerUserId: parts[1] ?? null,
    guildId: parts[2] ?? null,
    circleId: parts[3] ?? null,
  };
}

function buildClubSelectRow(guildId, ownerUserId, selectedCircleId = null) {
  const clubs = getGuildClubs(guildId).slice(0, 25);
  return {
    type: 1,
    components: [
      {
        type: 3,
        custom_id: `${CS_PICK}:${ownerUserId}:${guildId}`.slice(0, 100),
        placeholder: 'Select a registered club',
        options: clubs.map((club) => ({
          label: (club.circleName || club.circleId).slice(0, 100),
          value: String(club.circleId).slice(0, 100),
          description: `ID ${club.circleId}`.slice(0, 100),
          default: selectedCircleId != null && String(club.circleId) === String(selectedCircleId),
        })),
      },
    ],
  };
}

function toggleLabel(name, enabled) {
  return `${enabled ? 'Hide' : 'Show'} ${name}`;
}

function toggleStyle(enabled) {
  return enabled ? 3 : 2; // success / secondary
}

function buildSettingsButtons(ownerUserId, guildId, circleId, settings) {
  const base = `${ownerUserId}:${guildId}:${circleId}`;
  return {
    type: 1,
    components: [
      {
        type: 2,
        style: 1,
        custom_id: `${CS_BTN_RANK}:${base}`.slice(0, 100),
        label: 'Set Rank Target',
      },
      {
        type: 2,
        style: 1,
        custom_id: `${CS_BTN_MANUAL}:${base}`.slice(0, 100),
        label: 'Set Manual Target',
      },
      {
        type: 2,
        style: toggleStyle(settings.showTotal),
        custom_id: `${CS_BTN_TOTAL}:${base}`.slice(0, 100),
        label: toggleLabel('Total', settings.showTotal).slice(0, 80),
      },
      {
        type: 2,
        style: toggleStyle(settings.showAvg),
        custom_id: `${CS_BTN_AVG}:${base}`.slice(0, 100),
        label: toggleLabel('Avg', settings.showAvg).slice(0, 80),
      },
      {
        type: 2,
        style: toggleStyle(settings.showToday),
        custom_id: `${CS_BTN_TODAY}:${base}`.slice(0, 100),
        label: toggleLabel('Today', settings.showToday).slice(0, 80),
      },
    ],
  };
}

async function buildTierSelectRow(ownerUserId, guildId, circleId) {
  const tiers = await getRankThresholds();
  return {
    type: 1,
    components: [
      {
        type: 3,
        custom_id: `${CS_TIER}:${ownerUserId}:${guildId}:${circleId}`.slice(0, 100),
        placeholder: 'Choose a rank tier target',
        options: tiers.slice(0, 25).map((tier) => ({
          label: formatTierRankRange(tier).slice(0, 100),
          value: tier.tier.slice(0, 100),
        })),
      },
    ],
  };
}

function buildManualTargetModal(ownerUserId, guildId, circleId, currentValue = null) {
  return {
    custom_id: `${CS_MODAL_MANUAL}:${ownerUserId}:${guildId}:${circleId}`.slice(0, 100),
    title: 'Set Manual Daily Target',
    components: [
      {
        type: 1,
        components: [
          {
            type: 4,
            custom_id: 'manual_target',
            label: 'Fans per member per day',
            style: 1,
            min_length: 1,
            max_length: 12,
            required: true,
            placeholder: 'e.g. 2284079',
            value: currentValue != null ? String(currentValue) : undefined,
          },
        ],
      },
    ],
  };
}

function formatTargetSummary(settings, targetInfo) {
  if (settings.manualTarget != null) {
    return `Manual — ${formatIntWithCommas(settings.manualTarget)} fans/member/day`;
  }
  if (targetInfo?.tierRangeLabel) {
    const daily =
      targetInfo.dailyTarget == null
        ? '—'
        : formatIntWithCommas(Math.round(targetInfo.dailyTarget));
    return `${targetInfo.tierRangeLabel} (${daily}/member/day)`;
  }
  if (settings.targetTier) return settings.targetTier;
  return 'Not set';
}

export async function buildClubSettingsPanel(guildId, ownerUserId, circleId) {
  const clubs = getGuildClubs(guildId);
  const club = clubs.find((c) => String(c.circleId) === String(circleId));
  if (!club) {
    throw new Error('That club is not registered on this server.');
  }

  const settings = getGuildClubSettings(guildId, circleId);
  const data = await fetchCircleData(circleId);
  const circle = data?.circle;
  const rank = circle?.live_rank ?? circle?.monthly_rank ?? '—';
  const name = circle?.name || club.circleName || circleId;
  const url = `https://uma.moe/circles/${circleId}`;

  let targetInfo = null;
  if (settings.manualTarget == null && settings.targetTier) {
    const tiers = await getRankThresholds();
    const threshold = findRankThreshold(tiers, settings.targetTier);
    if (threshold) {
      targetInfo = {
        tierRangeLabel: formatTierRankRange(threshold),
        dailyTarget: computeMemberDailyTarget(threshold.clubFansPerDay),
      };
    }
  }

  const embed = {
    color: 0xF1C40F,
    title: `⚙️ Club Settings — ${name}`,
    url,
    fields: [
      {
        name: 'Current Rank',
        value: `#${rank}`,
        inline: true,
      },
      {
        name: 'Target',
        value: formatTargetSummary(settings, targetInfo),
        inline: true,
      },
      {
        name: 'uma.moe',
        value: `[Open club page](${url})`,
        inline: true,
      },
      {
        name: 'Leaderboard Columns',
        value: [
          `Total: **${settings.showTotal ? 'Shown' : 'Hidden'}**`,
          `Avg: **${settings.showAvg ? 'Shown' : 'Hidden'}**`,
          `Today: **${settings.showToday ? 'Shown' : 'Hidden'}**`,
        ].join('\n'),
        inline: false,
      },
    ],
    footer: {
      text: 'Column toggles apply to this club’s auto-updating leaderboard.',
    },
  };

  return {
    embeds: [embed],
    components: [
      buildClubSelectRow(guildId, ownerUserId, circleId),
      buildSettingsButtons(ownerUserId, guildId, circleId, settings),
    ],
  };
}

export function buildClubSettingsIntro(guildId, ownerUserId) {
  const clubs = getGuildClubs(guildId);
  return {
    embeds: [
      {
        color: 0xF1C40F,
        title: '⚙️ Club Settings',
        description:
          clubs.length === 1
            ? 'Select your club below to view and edit settings.'
            : 'Select a registered club below to view and edit its settings.',
      },
    ],
    components: [buildClubSelectRow(guildId, ownerUserId)],
  };
}

async function refreshAutoLeaderboard(guildId, circleId) {
  const entry = getAllLeaderboardChannels().find(
    (item) => String(item.guildId) === String(guildId) && String(item.circleId) === String(circleId),
  );
  if (!entry) return;

  try {
    const pkg = await buildLeaderboardPackage(circleId, { guildId });
    await DiscordRequest(`channels/${entry.channelId}/messages/${entry.messageId}`, {
      method: 'PATCH',
      body: { embeds: [pkg.embed] },
    });
    updateLeaderboardChannelState(guildId, circleId, {
      lastUpdatedAt: Date.now(),
      lastEmbedHash: hashLeaderboardContent(pkg.embed),
      lastCircleUpdatedAt: pkg.data?.circle?.last_updated ?? null,
    });
  } catch (err) {
    console.warn(
      `Could not refresh leaderboard after settings change for ${guildId}/${circleId}:`,
      err.message,
    );
  }
}

export function isClubSettingsCustomId(customId) {
  const kind = String(customId || '').split(':')[0];
  return [
    CS_PICK,
    CS_BTN_RANK,
    CS_BTN_MANUAL,
    CS_BTN_TOTAL,
    CS_BTN_AVG,
    CS_BTN_TODAY,
    CS_TIER,
    CS_MODAL_MANUAL,
  ].includes(kind);
}

export function parseClubSettingsComponent(customId, values) {
  if (!isClubSettingsCustomId(customId)) return null;
  const parsed = parseIdParts(customId);
  return {
    ...parsed,
    value: values?.[0] ?? null,
  };
}

export function parseClubSettingsModal(customId, components) {
  if (!String(customId || '').startsWith(`${CS_MODAL_MANUAL}:`)) return null;
  const parsed = parseIdParts(customId);
  const rows = components || [];
  let manualTarget = null;
  for (const row of rows) {
    for (const field of row.components || []) {
      if (field.custom_id === 'manual_target') {
        manualTarget = field.value;
      }
    }
  }
  return { ...parsed, manualTarget };
}

export async function handleClubSettingsCommand(req) {
  const guildId = req.body.guild_id;
  const userId = req.body.member?.user?.id || req.body.user?.id;
  if (!guildId) {
    return {
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: {
        flags: InteractionResponseFlags.EPHEMERAL,
        content: '❌ This command can only be used in a server.',
      },
    };
  }

  if (!canManageClubSettings(req.body.member, userId)) {
    return {
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: {
        flags: InteractionResponseFlags.EPHEMERAL,
        content: '❌ Only server administrators or the bot owner can use `/club settings`.',
      },
    };
  }

  const clubs = getGuildClubs(guildId);
  if (!clubs.length) {
    return {
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: {
        flags: InteractionResponseFlags.EPHEMERAL,
        content: '❌ No clubs are registered on this server. Run `/club registerclub` first.',
      },
    };
  }

  if (clubs.length === 1) {
    return {
      deferred: true,
      ephemeral: true,
      run: async (sendFollowup) => {
        try {
          const panel = await buildClubSettingsPanel(guildId, userId, clubs[0].circleId);
          await sendFollowup({
            flags: InteractionResponseFlags.EPHEMERAL,
            ...panel,
          });
        } catch (err) {
          console.error('club settings failed:', err);
          await sendFollowup({
            flags: InteractionResponseFlags.EPHEMERAL,
            content: `❌ Failed to load settings: ${err.message}`,
          });
        }
      },
    };
  }

  const intro = buildClubSettingsIntro(guildId, userId);
  return {
    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
    data: {
      flags: InteractionResponseFlags.EPHEMERAL,
      ...intro,
    },
  };
}

export async function runClubSettingsComponentAction(action, { member, userId } = {}) {
  if (!canManageClubSettings(member, userId ?? action.ownerUserId)) {
    throw new Error('Only server administrators or the bot owner can change club settings.');
  }

  const { kind, ownerUserId, guildId, circleId, value } = action;

  if (kind === CS_PICK) {
    const selectedId = value;
    if (!selectedId) throw new Error('No club selected.');
    return buildClubSettingsPanel(guildId, ownerUserId, selectedId);
  }

  if (kind === CS_BTN_RANK) {
    const panel = await buildClubSettingsPanel(guildId, ownerUserId, circleId);
    const tierRow = await buildTierSelectRow(ownerUserId, guildId, circleId);
    return {
      embeds: panel.embeds,
      components: [panel.components[0], tierRow, panel.components[1]],
    };
  }

  if (kind === CS_BTN_MANUAL) {
    const settings = getGuildClubSettings(guildId, circleId);
    return {
      type: 'modal',
      modal: buildManualTargetModal(ownerUserId, guildId, circleId, settings.manualTarget),
    };
  }

  if (kind === CS_BTN_TOTAL || kind === CS_BTN_AVG || kind === CS_BTN_TODAY) {
    const settings = getGuildClubSettings(guildId, circleId);
    const patch =
      kind === CS_BTN_TOTAL
        ? { showTotal: !settings.showTotal }
        : kind === CS_BTN_AVG
          ? { showAvg: !settings.showAvg }
          : { showToday: !settings.showToday };
    updateGuildClubSettings(guildId, circleId, patch);
    await refreshAutoLeaderboard(guildId, circleId);
    return buildClubSettingsPanel(guildId, ownerUserId, circleId);
  }

  if (kind === CS_TIER) {
    const tier = value;
    if (!tier) throw new Error('No tier selected.');
    const tiers = await getRankThresholds();
    const threshold = findRankThreshold(tiers, tier);
    if (!threshold) throw new Error(`Unknown tier \`${tier}\`.`);
    setGuildClubTarget(guildId, circleId, threshold.tier);
    await refreshAutoLeaderboard(guildId, circleId);
    return buildClubSettingsPanel(guildId, ownerUserId, circleId);
  }

  throw new Error('Unknown club settings action.');
}

export async function runClubSettingsModalSubmit(action, { member, userId } = {}) {
  if (!canManageClubSettings(member, userId ?? action.ownerUserId)) {
    throw new Error('Only server administrators or the bot owner can change club settings.');
  }

  const { ownerUserId, guildId, circleId, manualTarget } = action;
  const raw = String(manualTarget ?? '').replace(/,/g, '').trim();
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) {
    throw new Error('Manual target must be a whole number of fans (e.g. 2284079).');
  }
  setGuildClubManualTarget(guildId, circleId, n);
  await refreshAutoLeaderboard(guildId, circleId);
  return buildClubSettingsPanel(guildId, ownerUserId, circleId);
}
