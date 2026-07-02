import 'dotenv/config';
import express from 'express';

// Validate required env vars at startup (fail fast with clear message)
const PUBLIC_KEY = process.env.PUBLIC_KEY || process.env.DISCORD_PUBLIC_KEY;
if (!PUBLIC_KEY) {
  console.error("Missing required env var: PUBLIC_KEY (Discord Application Public Key)");
  console.error("Add it in Railway: Project → Service → Variables → PUBLIC_KEY = <your public key>");
  process.exit(1);
}
import fs from 'fs';
import {
  ButtonStyleTypes,
  InteractionResponseFlags,
  InteractionResponseType,
  InteractionType,
  verifyKeyMiddleware,
} from 'discord-interactions';
import { scheduleColors, truncate, buildSupporterEmbed, buildSupporterComponents, buildSupporterEventEmbed, buildSkillEmbed, buildSkillComponents, parseSkillNavCustomId, getColor, getCustomEmoji, parseEmojiForDropdown, buildEventEmbed, buildUmaEmbed, buildUmaComponents, buildRaceEmbed, buildCMEmbed, buildMapEmbed, capitalize, buildResourceEmbed, buildEpithetEmbed, buildEpithetListPayload, EPITHET_PAGINATION_ID_PREFIX, DiscordRequest } from './utils.js';
import cache, { updateCache } from './githubCache.js';
import { renderCourseMapPng } from './courseMapRenderer.js';
import {
  getUpcomingChampionsMeet,
  getSelectableChampionsMeets,
  getCourseMapDataFromCm,
  getCourseMapDataFromMap,
  resolveMapOverride,
  resolveMapSource,
  buildMapOverrideAutocompleteChoices,
  resolveMapCatalogMatches,
  buildMapCatalogAutocompleteChoices,
  resolveSkillActivationOverlay,
  buildSkillMapCacheKey,
  ensureDirectory,
  resolveSkillMapOutputPath,
} from './skillCourseMap.js';
import {
  buildLeaderboardAutocompleteChoices,
  buildRegisteredClubAutocompleteChoices,
  buildTargetTierAutocompleteChoices,
  dispatchClubCommand,
  handleClubComponent,
  isClubCommand,
  resolveAutocompleteFocus,
  runClubComponentAction,
} from './clubHandlers.js';
import { getUmaApiKey } from './clubService.js';
import { startLeaderboardCron } from './clubLeaderboardCron.js';
import {
  dispatchQuizCommand,
  handleQuizAnswer,
  handleQuizAnswerComponent,
  isQuizCommand,
} from './quizHandlers.js';
import {
  dispatchGambacoinCommand,
  handleGambaDonateClick,
  handleGambaDonateComponent,
  isGambacoinCommand,
} from './gambacoinHandlers.js';
import {
  buildEventAutocomplete,
  dispatchEventCommand,
  dispatchGambaCommand,
  handleGambaBetClick,
  handleGambaBetComponent,
  handleGambaWagerClick,
  handleGambaWagerComponent,
  isEventGamblingCommand,
  isGambaCommand,
} from './eventHandlers.js';
import { startEventCron } from './eventCron.js';
import { reloadEventsFromDisk } from './eventService.js';
import { resumeActiveQuizzes } from './quizRunner.js';
import { startQuizRemoteSync } from './quizStorage.js';
import {
  buildScheduleAutocompleteChoices,
  getCurrentMonthEventById,
  getCurrentMonthSchedule,
} from './scheduleService.js';

import path from 'path';
import { fileURLToPath } from "url";

// ESM-friendly __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');
const MAP_RENDERER_CACHE_VERSION = 'v3';

// Champions Meets offered in the skill-map dropdown are limited to this range so
// users can't trigger image generation for an unbounded number of CMs.
// Adjust SKILL_MAP_MAX_CM_NUMBER (or the env var) to decide the highest CM shown.
// The effective lower bound is dynamic: max(configured minimum, current upcoming CM).
const SKILL_MAP_MIN_CM_NUMBER = Number(process.env.SKILL_MAP_MIN_CM_NUMBER ?? 16);
const SKILL_MAP_MAX_CM_NUMBER = Number(process.env.SKILL_MAP_MAX_CM_NUMBER ?? 16);

const characters = cache.characters;
const supporters = cache.supporters;
const events = cache.events;
const skills = cache.skills;
const races = cache.races;
const champsmeets = cache.champsmeets;
const legendraces = cache.legendraces;
const misc = cache.misc;
const resources = cache.resources;
const epithets = cache.epithets;

function getRequestBaseUrl(req) {
  const protocol = req.get('x-forwarded-proto') || req.protocol || 'http';
  const host = req.get('host');
  return host ? `${protocol}://${host}` : null;
}

function getSupporterMatchesForSkill(skillName) {
  const matches = supporters.filter(s => {
    if (s.rarity == "r") return false;
    return (
      s.support_skills?.some(sk => sk.toLowerCase() === skillName.toLowerCase()) ||
      s.event_skills?.some(sk => sk.toLowerCase() === skillName.toLowerCase())
    );
  });

  // Sort supporters by rarity (ssr first)
  matches.sort((a, b) => {
    const order = { ssr: 0, sr: 1 };
    return order[a.rarity.toLowerCase()] - order[b.rarity.toLowerCase()];
  });
  return matches;
}

// Builds the dropdown row that lets the user switch which Champions Meet map is
// shown under a skill. Returns null when there is nothing meaningful to pick.
function buildSkillCmDropdownRow(skill, selectableCms, selectedCmNumber) {
  if (!Array.isArray(selectableCms) || selectableCms.length < 2) return null;

  const identifier = skill.gametora_id ?? skill.skill_name;
  const options = selectableCms.slice(0, 25).map((cm) => {
    const num = Number(cm.number);
    const shortName = String(cm.name ?? '').replace(/\s*\d{4}\s*$/, '').trim() || `CM ${num}`;
    const track = cm.track ?? {};
    const subtitle = [track.racetrack, track.distance_meters, track.distance_type]
      .filter(Boolean)
      .join(' - ');
    return {
      label: `CM${num} - ${shortName}`.slice(0, 100),
      value: `${num}::${identifier}`,
      description: subtitle ? subtitle.slice(0, 100) : undefined,
      default: Number(selectedCmNumber) === num,
    };
  });

  return {
    type: 1,
    components: [
      {
        type: 3,
        custom_id: 'skill_cm_select',
        placeholder: 'Select a Champions Meet map',
        options,
      },
    ],
  };
}

// Inserts map selector rows before the skill button row (upgrade/downgrade/
// visualizer links), while keeping other dropdown rows above them.
function composeSkillComponents(baseComponents, mapComponents) {
  const base = Array.isArray(baseComponents) ? baseComponents : [];
  const mapRows = Array.isArray(mapComponents) ? mapComponents : [];
  if (mapRows.length === 0) return base;

  const firstButtonRowIndex = base.findIndex((row) =>
    Array.isArray(row?.components) && row.components.some((component) => component?.type === 2)
  );

  if (firstButtonRowIndex === -1) {
    return [...base, ...mapRows];
  }

  return [
    ...base.slice(0, firstButtonRowIndex),
    ...mapRows,
    ...base.slice(firstButtonRowIndex),
  ];
}

const SCHEDULE_TYPE_META = {
  character_banner: { label: 'Character Banner', color: scheduleColors.Banner },
  support_card_banner: { label: 'Support Banner', color: scheduleColors.Banner },
  story_event: { label: 'Story Event', color: scheduleColors['Story Event'] },
  champions_meeting: { label: 'Champions Meeting', color: scheduleColors['Champions Meeting'] },
  campaign: { label: 'Campaign', color: scheduleColors.Scenario },
  paid_banner: { label: 'Paid Banner', color: scheduleColors.Banner },
  anniversary: { label: 'Anniversary', color: scheduleColors.Anniversary },
};

function getScheduleTypeMeta(type) {
  return SCHEDULE_TYPE_META[type] || { label: 'Event', color: scheduleColors.Default };
}

function toDiscordTimestamp(isoString) {
  const ms = Date.parse(String(isoString || ''));
  if (!Number.isFinite(ms)) return null;
  return Math.floor(ms / 1000);
}

function formatScheduleDateLine(event) {
  const startTs = toDiscordTimestamp(event.startAt);
  const endTs = toDiscordTimestamp(event.endAt);
  if (!startTs) return 'Date unavailable';
  if (endTs && endTs !== startTs) {
    return `<t:${startTs}:F> - <t:${endTs}:F>`;
  }
  return `<t:${startTs}:F>`;
}

function formatScheduleOptionRange(event) {
  const startMs = Date.parse(String(event.startAt || ''));
  if (!Number.isFinite(startMs)) return 'Date TBD';
  const start = new Date(startMs);
  const startLabel = start.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
  const endMs = Date.parse(String(event.endAt || ''));
  if (!Number.isFinite(endMs) || endMs === startMs) return startLabel;
  const end = new Date(endMs);
  const endLabel = end.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
  return `${startLabel} - ${endLabel}`;
}

function buildScheduleSelectRow(events, selectedId, placeholder) {
  return [
    {
      type: 1,
      components: [
        {
          type: 3,
          custom_id: 'schedule_select',
          placeholder: placeholder || 'Select another event',
          options: events.slice(0, 25).map((event) => ({
            label: event.title.length > 100 ? `${event.title.slice(0, 97)}...` : event.title,
            value: event.id,
            description: `${getScheduleTypeMeta(event.type).label} • ${formatScheduleOptionRange(event)}`.slice(0, 100),
            default: event.id === selectedId,
          })),
        },
      ],
    },
  ];
}

function buildScheduleEmbed(event, monthLabel, generatedAt) {
  const typeMeta = getScheduleTypeMeta(event.type);
  const startRelative = toDiscordTimestamp(event.startAt);
  const footerParts = [`${monthLabel} schedule`, 'Dates are estimated'];
  if (generatedAt) {
    const generatedTs = toDiscordTimestamp(generatedAt);
    if (generatedTs) footerParts.push(`Snapshot <t:${generatedTs}:R>`);
  }

  const embed = {
    title: event.title,
    color: typeMeta.color,
    description: [
      `**Type:** ${typeMeta.label}`,
      `**Window:** ${formatScheduleDateLine(event)}`,
      startRelative ? `**Starts:** <t:${startRelative}:R>` : '',
      `**Status:** ${event.isConfirmed ? 'Confirmed' : 'Estimated'}`,
      '',
      '⚠️ Timeline dates are predictions and can change.',
    ].filter(Boolean).join('\n'),
    footer: { text: footerParts.join(' • ') },
  };

  if (event.imageUrl) {
    embed.image = { url: event.imageUrl };
  }

  return embed;
}

function normalizeSkillMapOptions(options) {
  if (options == null) return {};
  if (typeof options === 'number') return { selectedCmNumber: options };
  return options;
}

function skillMapFilePrefix(mapContextKey) {
  return String(mapContextKey ?? 'map').replace(/[^a-zA-Z0-9._-]+/g, '-');
}

// Returns { embed, mapComponents } where mapComponents holds the optional
// Champions Meet selector row. selectedCmNumber forces a specific CM map.
// mapOverride resolves a catalog/custom-race map instead of the CM default.
async function buildSkillEmbedWithMap(skill, supporterList, req, options = {}) {
  const { selectedCmNumber = null, mapOverride = null } = normalizeSkillMapOptions(options);
  const embed = buildSkillEmbed(skill, supporterList);
  const result = { embed, mapComponents: [], mapOverrideKey: null, mapCid: null };

  const override = mapOverride
    ? resolveMapOverride(mapOverride, cache.maps, cache.customraces)
    : null;
  if (override) result.mapOverrideKey = override.key;
  let mapData = null;
  let overlayCm = null;
  let mapLabel = null;
  let mapContextKey = null;

  if (override) {
    mapData = getCourseMapDataFromMap(override.rawMap, override.context);
    overlayCm = override.context;
    mapLabel = override.label;
    mapContextKey = override.key;
    result.mapCid = override.rawMap?.cid ?? null;
  } else {
    const upcomingCm = getUpcomingChampionsMeet(champsmeets);
    const upcomingCmNumber = Number(upcomingCm?.number);
    const effectiveMinCmNumber = Number.isFinite(upcomingCmNumber)
      ? Math.max(SKILL_MAP_MIN_CM_NUMBER, upcomingCmNumber)
      : SKILL_MAP_MIN_CM_NUMBER;

    const selectableCms = getSelectableChampionsMeets(champsmeets, {
      fromCmNumber: effectiveMinCmNumber,
      maxCmNumber: SKILL_MAP_MAX_CM_NUMBER,
      mapsCatalog: cache.maps,
    });
    if (selectableCms.length === 0) return result;

    let activeCm = null;
    if (selectedCmNumber != null) {
      activeCm = selectableCms.find((cm) => Number(cm.number) === Number(selectedCmNumber)) ?? null;
    }
    if (!activeCm) {
      activeCm =
        (upcomingCm && selectableCms.find((cm) => Number(cm.number) === Number(upcomingCm.number))) ||
        selectableCms[0];
    }

    mapData = getCourseMapDataFromCm(activeCm, cache.maps);
    overlayCm = activeCm;
    mapLabel = activeCm.name;
    mapContextKey = `cm:${activeCm.number}`;
    result._selectableCms = selectableCms;
    result._activeCm = activeCm;
    result.mapCid = resolveMapSource(activeCm, cache.maps)?.cid ?? null;
  }

  if (!mapData) return result;

  const overlay = resolveSkillActivationOverlay(skill, overlayCm, mapData);

  const chartCapable =
    skill.activation_map?.show_chart === true ||
    (Array.isArray(skill.activation_map?.triggers) && skill.activation_map.triggers.length > 0);

  if (!overlay.shouldShowChart) {
    if (!override && chartCapable && result._selectableCms && result._activeCm) {
      const dropdownRow = buildSkillCmDropdownRow(skill, result._selectableCms, result._activeCm.number);
      if (dropdownRow) result.mapComponents.push(dropdownRow);
    }
    return result;
  }

  const cacheKey = buildSkillMapCacheKey({
    cmNumber: overlayCm?.number,
    mapContextKey,
    skillId: skill.gametora_id ?? skill.skill_name,
    mapData,
    markers: overlay.markers,
    doesNotWork: overlay.doesNotWork,
    rendererVersion: MAP_RENDERER_CACHE_VERSION,
  });
  const fileName = `${skillMapFilePrefix(mapContextKey)}-${cacheKey}.png`;
  const outputPath = resolveSkillMapOutputPath(PROJECT_ROOT, fileName);
  if (!fs.existsSync(outputPath)) {
    await ensureDirectory(path.dirname(outputPath));
    await renderCourseMapPng(mapData, outputPath, {
      width: 1500,
      height: 360,
      skillMarkers: overlay.markers,
      warningText: overlay.doesNotWork ? 'DOES NOT WORK' : undefined,
    });
  }

  const baseUrl = getRequestBaseUrl(req);
  if (baseUrl) {
    embed.image = { url: `${baseUrl}/assets/generated/skill-maps/${fileName}` };
  }

  const suffix = `Map overlay: ${mapLabel} • Report any errors using /bugreport`;
  embed.footer = embed.footer?.text
    ? { text: `${embed.footer.text} • ${suffix}` }
    : { text: suffix };

  if (!override && result._selectableCms && result._activeCm) {
    const dropdownRow = buildSkillCmDropdownRow(skill, result._selectableCms, result._activeCm.number);
    if (dropdownRow) result.mapComponents.push(dropdownRow);
  }

  return result;
}

async function resolveCmMapImageUrl(cm, req) {
  const mapData = getCourseMapDataFromCm(cm, cache.maps);
  if (!mapData) return null;

  const cacheKey = buildSkillMapCacheKey({
    cmNumber: cm.number,
    skillId: "cm-map",
    mapData,
    markers: [],
    rendererVersion: MAP_RENDERER_CACHE_VERSION,
  });
  const fileName = `cm${cm.number}-${cacheKey}.png`;
  const outputPath = resolveSkillMapOutputPath(PROJECT_ROOT, fileName);
  if (!fs.existsSync(outputPath)) {
    await ensureDirectory(path.dirname(outputPath));
    await renderCourseMapPng(mapData, outputPath, {
      width: 1500,
      height: 360,
      skillMarkers: [],
    });
  }

  const baseUrl = getRequestBaseUrl(req);
  if (!baseUrl) return null;
  return `${baseUrl}/assets/generated/skill-maps/${fileName}`;
}

async function resolveCatalogMapImageUrl(resolved, req) {
  const mapData = getCourseMapDataFromMap(resolved.rawMap, resolved.context);
  if (!mapData) return null;

  const cacheKey = buildSkillMapCacheKey({
    mapContextKey: resolved.key,
    skillId: "catalog-map",
    mapData,
    markers: [],
    rendererVersion: MAP_RENDERER_CACHE_VERSION,
  });
  const fileName = `${skillMapFilePrefix(resolved.key)}-${cacheKey}.png`;
  const outputPath = resolveSkillMapOutputPath(PROJECT_ROOT, fileName);
  if (!fs.existsSync(outputPath)) {
    await ensureDirectory(path.dirname(outputPath));
    await renderCourseMapPng(mapData, outputPath, {
      width: 1500,
      height: 360,
      skillMarkers: [],
    });
  }

  const baseUrl = getRequestBaseUrl(req);
  if (!baseUrl) return null;
  return `${baseUrl}/assets/generated/skill-maps/${fileName}`;
}

async function buildMapLookupPayload(resolved, req) {
  const imageUrl = await resolveCatalogMapImageUrl(resolved, req);
  return buildMapEmbed(resolved, imageUrl);
}

// Bug report destination (overridable via env)
const BUG_REPORT_GUILD_ID = process.env.BUG_REPORT_GUILD_ID || '1416320822846689333';
const BUG_REPORT_CHANNEL_ID = process.env.BUG_REPORT_CHANNEL_ID || '1495734291253035028';
const SUPPORT_INVITE_URL = process.env.SUPPORT_INVITE_URL || 'https://discord.gg/5BW4gSUVSz';
const KOFI_URL = process.env.KOFI_URL || 'https://ko-fi.com/justwastingtime';
const BOT_OWNER_IDS = new Set(
  String(process.env.BOT_OWNER_IDS || process.env.BOT_OWNER_ID || '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean)
);

function formatErrorForEmbed(errorLike) {
  if (!errorLike) return 'No error payload provided.';
  if (errorLike instanceof Error) {
    return `${errorLike.name}: ${errorLike.message}\n${errorLike.stack || ''}`.trim();
  }
  if (typeof errorLike === 'object') {
    try {
      return JSON.stringify(errorLike, null, 2);
    } catch (_) {
      return String(errorLike);
    }
  }
  return String(errorLike);
}

async function postOpsNotice(title, description, color = 0xE74C3C) {
  const text = String(description || 'No details').slice(0, 3900);
  try {
    await DiscordRequest(`channels/${BUG_REPORT_CHANNEL_ID}/messages`, {
      method: 'POST',
      body: {
        embeds: [{
          title,
          description: `\`\`\`\n${text}\n\`\`\``,
          color,
          fields: [
            { name: 'Host', value: process.env.HOSTNAME || 'unknown', inline: true },
            { name: 'Node', value: process.version, inline: true },
            { name: 'Time', value: new Date().toISOString(), inline: true }
          ]
        }]
      }
    });
  } catch (notifyErr) {
    console.error('Failed to post ops notice:', notifyErr);
  }
}

// Create an express app
const app = express();
// Get port, or default to 3000
const PORT = process.env.PORT || 3000;

// Serve static assets (including guide images)
app.use('/assets', express.static(path.join(__dirname, '../assets')));


/**
 * Interactions endpoint URL where Discord will send HTTP requests
 * Parse request body and verifies incoming requests using discord-interactions package
 */
app.post('/interactions', verifyKeyMiddleware(PUBLIC_KEY), async function (req, res) {
  // Interaction id, type and data
  const { id, type, data, message, token } = req.body;

  /**
   * Handle verification requests
   */
  if (type === InteractionType.PING) {
    return res.send({ type: InteractionResponseType.PONG });
  }

  /**
   * Handle slash command autocomplete requests
   * See https://discord.com/developers/docs/interactions/application-commands#autocomplete
   */
  if (type === InteractionType.APPLICATION_COMMAND_AUTOCOMPLETE) {
    const focus = resolveAutocompleteFocus(data);

    if (data.name === 'club' && focus.optionName === 'clubname') {
      const choices =
        focus.subcommand === 'leaderboard'
          ? buildLeaderboardAutocompleteChoices(req.body.guild_id, focus.value)
          : focus.subcommand === 'setleaderboardchannel' || focus.subcommand === 'settarget'
            ? buildRegisteredClubAutocompleteChoices(req.body.guild_id, focus.value)
            : [];

      return res.send({
        type: InteractionResponseType.APPLICATION_COMMAND_AUTOCOMPLETE_RESULT,
        data: { choices },
      });
    }

    if (data.name === 'club' && focus.optionName === 'target' && focus.subcommand === 'settarget') {
      const choices = await buildTargetTierAutocompleteChoices(focus.value);
      return res.send({
        type: InteractionResponseType.APPLICATION_COMMAND_AUTOCOMPLETE_RESULT,
        data: { choices },
      });
    }

    if (data.name === 'gamba' && focus.optionName === 'name') {
      const choices = buildEventAutocomplete(focus.value);
      return res.send({
        type: InteractionResponseType.APPLICATION_COMMAND_AUTOCOMPLETE_RESULT,
        data: { choices },
      });
    }

    if (data.name === 'map' && focus.optionName === 'name') {
      const choices = buildMapCatalogAutocompleteChoices(focus.value, cache.maps, cache.customraces);
      return res.send({
        type: InteractionResponseType.APPLICATION_COMMAND_AUTOCOMPLETE_RESULT,
        data: { choices },
      });
    }

    if (data.name === 'skill' && focus.optionName === 'map_override') {
      const choices = buildMapOverrideAutocompleteChoices(focus.value, cache.maps, cache.customraces);
      return res.send({
        type: InteractionResponseType.APPLICATION_COMMAND_AUTOCOMPLETE_RESULT,
        data: { choices },
      });
    }

    if (data.name === 'skill' && focus.optionName === 'name') {
      const query = focus.value.trim().toLowerCase();

      // Only start suggesting once the user has typed at least 3 characters.
      if (query.length < 3) {
        return res.send({
          type: InteractionResponseType.APPLICATION_COMMAND_AUTOCOMPLETE_RESULT,
          data: { choices: [] },
        });
      }

      const terms = query.split(/\s+/);
      const matches = skills.filter(s => {
        return terms.every(q =>
          s.skill_name.toLowerCase().includes(q) ||
          s.aliases?.some(a => a.toLowerCase().includes(q))
        );
      });

      // Surface skills whose name starts with the query first, then alphabetical.
      matches.sort((a, b) => {
        const aStarts = a.skill_name.toLowerCase().startsWith(query) ? 0 : 1;
        const bStarts = b.skill_name.toLowerCase().startsWith(query) ? 0 : 1;
        if (aStarts !== bStarts) return aStarts - bStarts;
        return a.skill_name.localeCompare(b.skill_name);
      });

      const choices = matches.slice(0, 25).map(s => ({
        name: s.skill_name.length > 100 ? s.skill_name.slice(0, 100) : s.skill_name,
        value: s.skill_name.length > 100 ? s.skill_name.slice(0, 100) : s.skill_name,
      }));

      return res.send({
        type: InteractionResponseType.APPLICATION_COMMAND_AUTOCOMPLETE_RESULT,
        data: { choices },
      });
    }

    if (data.name === 'schedule' && focus.optionName === 'name') {
      try {
        const choices = await buildScheduleAutocompleteChoices(focus.value);
        return res.send({
          type: InteractionResponseType.APPLICATION_COMMAND_AUTOCOMPLETE_RESULT,
          data: { choices },
        });
      } catch (err) {
        console.error('Schedule autocomplete failed:', err.message);
        return res.send({
          type: InteractionResponseType.APPLICATION_COMMAND_AUTOCOMPLETE_RESULT,
          data: { choices: [] },
        });
      }
    }

    return res.send({
      type: InteractionResponseType.APPLICATION_COMMAND_AUTOCOMPLETE_RESULT,
      data: { choices: [] },
    });
  }

  /**
   * Handle slash command requests
   * See https://discord.com/developers/docs/interactions/application-commands#slash-commands
   */
  if (type === InteractionType.APPLICATION_COMMAND) {
    const { name, options } = data;
    const invokingUserId = req.body.member?.user?.id || req.body.user?.id;

    if (name === 'refreshcache') {
      if (!invokingUserId || !BOT_OWNER_IDS.has(invokingUserId)) {
        return res.send({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: {
            flags: InteractionResponseFlags.EPHEMERAL,
            content: '❌ You are not allowed to use this command.'
          }
        });
      }

      res.send({
        type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
        data: { flags: InteractionResponseFlags.EPHEMERAL }
      });

      (async () => {
        try {
          await updateCache();
          reloadEventsFromDisk();
          await sendFollowup(token, {
            flags: InteractionResponseFlags.EPHEMERAL,
            content: '✅ Cache refreshed. Event JSON definitions reloaded — use `/gamba event refresh` to push odds changes.',
          });
        } catch (err) {
          console.error('Manual cache refresh failed:', err);
          await sendFollowup(token, {
            flags: InteractionResponseFlags.EPHEMERAL,
            content: '❌ Cache refresh failed.'
          });
        }
      })();

      return;
    }

    // "supporter" command
    if (name === 'supporter') {
      const supporterQuery = data.options?.find(opt => opt.name === 'name')?.value?.toLowerCase();
      const levelOpt = data.options?.find(opt => opt.name === 'limitbreak')?.value; // may be undefined
      const query = supporterQuery.toLowerCase().split(/\s+/); 

      const level = levelOpt !== undefined ? Number(levelOpt) : undefined;
      const matches = supporters.filter(s => {
        return query.every(q =>
          s.card_name.toLowerCase().includes(q) ||
          s.character_name.toLowerCase().includes(q) ||
          s.rarity.toLowerCase().includes(q) ||
          s.category.toLowerCase().includes(q) ||
          s.aliases?.some(a => a.toLowerCase().includes(q))
        );
      });

      if (matches.length === 0) {
        return res.send({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: { content: `❌ Supporter: ${supporterQuery} not found` }
        });
      }
      // If only 1 result
      else if (matches.length === 1)
      {
        return res.send({
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: { 
          embeds: [buildSupporterEmbed(matches[0], skills, level)],
          components: buildSupporterComponents(matches[0], level)
          }
        });
      }

      // If multiple matches → return a dropdown menu
      return res.send({
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: {
          content: `🔎 Found ${matches.length} matches. Pick one:`,
          components: [
            {
              type: 1, // Action row
              components: [
                {
                  type: 3, // String Select
                  custom_id: "supporter_select",
                  placeholder: "Choose a supporter",
                  options: matches.slice(0, 25).map(s => ({
                    label:  s.card_name + ' (' + s.rarity.toUpperCase() +')' , // must be <=100 chars
                    value: `${s.id}|${level ?? ""}`, // send supporter id and LB on select
                    description: s.character_name,
                    emoji: getCustomEmoji(s.category)
                  }))
                }
              ]
            }
          ]
        }
      });
    }

    // "skill" command
    if (name === 'skill') {
      const skillQuery = data.options?.find(opt => opt.name === 'name')?.value?.toLowerCase();
      const mapOverride = data.options?.find(opt => opt.name === 'map_override')?.value ?? null;
      const query = skillQuery.toLowerCase().split(/\s+/); 

      // Find the skills that match
      const matches = skills.filter(s => {
        return query.every(q =>
          s.skill_name.toLowerCase().includes(q) ||
          s.aliases?.some(a => a.toLowerCase().includes(q))
        );
      });

      if (matches.length === 0) {
        return res.send({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: { content: `❌ Skill ${skillQuery} not found` }
        });
      }

      // If only 1 result
      if (matches.length === 1)
      {

        // Lookup supporters with this skill, hide r cards
        const supporterMatches = getSupporterMatchesForSkill(matches[0].skill_name);

        // Format supporter names into a list
        let supporterList = supporterMatches.length
          ? supporterMatches.map(s => `• ${s.character_name} - ${s.card_name} (${s.rarity.toUpperCase()})`).join('\n')
          : 'None';

        // Creating components if the skill has cards or upgraded version
        let components = [];

        const { embed: skillEmbed, mapComponents, mapOverrideKey, mapCid } = await buildSkillEmbedWithMap(
          matches[0],
          supporterList,
          req,
          { mapOverride }
        );

        return res.send({
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: { 
          embeds: [skillEmbed],
          components: composeSkillComponents(
            buildSkillComponents(matches[0], supporterMatches.length, supporterMatches, mapOverrideKey, mapCid),
            mapComponents
          )
        }
        });
      }
      

      // If multiple matches → return a dropdown menu
      return res.send({
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: {
          content: `🔎 Found ${matches.length} matches. Pick one:`,
          components: [
            {
              type: 1, // Action row
              components: [
                {
                  type: 3, // String Select
                  custom_id: "skill_select",
                  placeholder: "Choose a Skill",
                  options: matches.slice(0, 25).map(s => ({
                    label:  s.skill_name , // must be <=100 chars
                    value: mapOverride ? `${s.skill_name}::${mapOverride}` : s.skill_name,
                    description: s.description.length > 80 
                      ? s.description.slice(0, 77) + "..." 
                      : s.description,
                  }))
                }
              ]
            }
          ]
        }
      });
    }

    if (name === 'uma') {
      const umaQuery = data.options?.find(opt => opt.name === 'name')?.value?.toLowerCase();
      const query = umaQuery.toLowerCase().split(/\s+/); 

      // Find matches
      const matches = characters.filter(c => {
        return query.every(q =>
          c.character_name.toLowerCase().includes(q) ||
          c.aliases?.some(a => a.toLowerCase().includes(q))
        );
      });

      // No matches
      if (matches.length === 0) {
        return res.send({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: { content: `❌ Uma "${umaQuery}" not found.` }
        });
      }

      // One match → embed
      if (matches.length === 1) {
        return res.send({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: { 
            embeds: [buildUmaEmbed(matches[0], skills)],
            components: buildUmaComponents(matches[0], true, characters)
          }
        });
      }

      // Multiple matches → dropdown
      return res.send({
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: {
          content: `🔎 Found ${matches.length} matches. Pick one:`,
          components: [
            {
              type: 1, // Action row
              components: [
                {
                  type: 3, // String Select
                  custom_id: "uma_select",
                  placeholder: "Choose a Character",
                  options: matches.slice(0, 25).map(c => ({
                    label: c.character_name.length > 100 
                      ? c.character_name.slice(0, 97) + "..." 
                      : c.character_name,
                    value: c.id,
                    description: c.type + " " + c.rarity
                  }))
                }
              ]
            }
          ]
        }
      });
    }

    if (name === "race") {
    const raceQuery = data.options?.find(opt => opt.name === "name")?.value?.toLowerCase();
    const gradeFilter = data.options?.find(opt => opt.name === "grade")?.value;
    const yearFilter = data.options?.find(opt => opt.name === "year")?.value;
    const query = raceQuery ? raceQuery.split(/\s+/) : [];

    // Find matches
    const matches = races.filter(r => {
      let ok = true;

      // Text query
      if (query.length > 0) {
        ok = ok && query.every(q =>
          r.race_name.toLowerCase().includes(q) ||
          r.aliases?.some(a => a.toLowerCase().includes(q))
        );
      }

      // Grade filter
      if (gradeFilter) {
        ok = ok && r.grade === gradeFilter;
      }

      // Year filter
      if (yearFilter) {
        ok = ok && r.date?.toLowerCase().includes(yearFilter.toLowerCase());
      }

      return ok;
    });

    // No matches
    if (matches.length === 0) {
      return res.send({
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: { content: `❌ Race not found.` }
      });
    }

    // One match → embed
    if (matches.length === 1) {
      return res.send({
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: { embeds: [buildRaceEmbed(matches[0], characters)] }
      });
    }

      // Multiple matches → dropdown
      return res.send({
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: {
          content: `🔎 Found ${matches.length} matches. Pick one:`,
          components: [
            {
              type: 1, // Action row
              components: [
                {
                  type: 3, // String Select
                  custom_id: "race_select",
                  placeholder: "Choose a Race",
                  options: matches.slice(0, 25).map(r => ({
                    label: r.race_name.length > 100
                      ? r.race_name.slice(0, 97) + "..."
                      : r.race_name,
                    value: r.id,
                    description: `${r.grade} • ${r.distance_meters} • ${r.racetrack} • ${r.date}`
                  }))
                }
              ]
            }
          ]
        }
      });
    }

    // "map" command
    if (name === 'map') {
      const mapQuery = data.options?.find((opt) => opt.name === 'name')?.value ?? '';
      const matches = resolveMapCatalogMatches(mapQuery, cache.maps, cache.customraces);

      if (matches.length === 0) {
        return res.send({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: { content: `❌ Course map "${mapQuery}" not found.` },
        });
      }

      if (matches.length === 1) {
        const mapPayload = await buildMapLookupPayload(matches[0], req);
        return res.send({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: mapPayload,
        });
      }

      return res.send({
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: {
          content: `🔎 Found ${matches.length} matches. Pick one:`,
          components: [
            {
              type: 1,
              components: [
                {
                  type: 3,
                  custom_id: 'map_select',
                  placeholder: 'Choose a course map',
                  options: matches.slice(0, 25).map((entry) => ({
                    label: entry.label.length > 100 ? `${entry.label.slice(0, 97)}...` : entry.label,
                    value: entry.key,
                  })),
                },
              ],
            },
          ],
        },
      });
    }

    // "cm" command
    if (name === 'cm') {
      const cupQuery = data.options?.find(opt => opt.name === "name")?.value?.toLowerCase();

      // Find matches
      const matches = champsmeets.filter(c => {
        if (!cupQuery) return true;

        return (
          c.name.toLowerCase().includes(cupQuery) ||
          c.number.toLowerCase().includes(cupQuery)
        );
      });


      // No matches
      if (matches.length === 0) {
        return res.send({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: { content: `❌ Champion's Meeting "${cupQuery}" not found.` }
        });
      }

      // One match → embed
      if (matches.length === 1) {
        const cm = matches[0];
        const mapImageUrl = await resolveCmMapImageUrl(cm, req);
        const cmWithPreferredImage = mapImageUrl ? { ...cm, image: mapImageUrl } : cm;
        return res.send({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: buildCMEmbed(cmWithPreferredImage)
          
        });
      }

      // Multiple matches → dropdown
      return res.send({
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: {
          content: `🔎 Found ${matches.length} matches. Pick one:`,
          components: [
            {
              type: 1, // Action row
              components: [
                {
                  type: 3, // String Select
                  custom_id: "cm_select",
                  placeholder: "Choose a CM",
                  options: matches.slice(0, 25).map(c => ({
                    label: c.name.length > 100 
                      ? c.name.slice(0, 97) + "..." 
                      : c.name,
                    value: c.name
                  }))
                }
              ]
            }
          ]
        }
      });
    }

    // "parse" command
    if (name === "parse") {
      const attachmentId = data.options?.find(opt => opt.name === "image")?.value;
      const attachment = data.resolved?.attachments?.[attachmentId];

      if (!attachment) {
        return res.send({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: { content: "❌ Please upload an image to scan." }
        });
      }

      // Step 1: Defer right away
      res.send({
        type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
        data: { content: "Tazuna is scrutinizing your uma." }
      });

      (async () => {
        try {
          // Step 2: Run OCR
          const ocrResult = await parseWithOcrSpace(attachment.url);

          const requiredWords = ["Turf", "Dirt", "Sprint", "Mile", "Medium", "Long", "Front", "Pace", "Late", "End"];
          const missingWords = requiredWords.filter(word => !ocrResult.text.includes(word));
          if (missingWords.length > 0) {
            return await sendFollowup(token, {
              content: `❌ OCR failed: the image is missing these required fields: ${missingWords.join(', ')}`
            });
          }

          // Step 3: Parse Uma profile
          const parsed = await parseUmaProfile(
            ocrResult.text, 
            ocrResult.overlayLines, 
            attachment.url,
            ocrResult.rawData,
            ocrResult.info
          );

          // Step 4: Generate Umalator link
          let umalatorUrl = null;
          try {
            umalatorUrl = await generateUmaLatorLink(parsed);

            // Shorten the URL for Discord button
            //if (umalatorUrl) {
              //umalatorUrl = await shortenUrl(umalatorUrl);
            //}
          } catch (umalatorError) {
            console.warn("Failed to generate or shorten UmaLator URL:", umalatorError.message);
          }

          // Step 5: Build embed with Umalator link
          const embed = buildUmaParsedEmbed(parsed, false);

          // Step 6: Add Umalator link button
          let components = [];
          if (umalatorUrl) {
            components = [
              {
                type: 1, // Action row
                components: [
                  {
                    type: 2,      // Button
                    style: 5,     // Link button
                    label: "Open in Umalator",
                    url: umalatorUrl
                  }
                ]
              }
            ];
          }
          
          await sendFollowup(token, {
            content: `✅ Parsed Uma data for **${parsed.name || "Unknown"}**`,
            embeds: [embed], components
          });

        } catch (err) {
          console.error("OCR Error:", err);
          await sendFollowup(token, { 
            content: "❌ Error processing image with OCR.space. " + err.message 
          });
        }
      })();

      return; // <- important to prevent falling through to unknown command handler
    }

    if (name === "schedule") {
      res.send({
        type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE
      });

      try {
        const nameQuery = String(data.options?.find((opt) => opt.name === 'name')?.value || '').trim();
        const view = await getCurrentMonthSchedule(nameQuery);

        if (!view.selected || view.monthEvents.length === 0) {
          await sendFollowup(token, {
            content: '❌ No schedule events found for this month.',
          });
          return;
        }

        const selected = view.selected;
        const hasQuery = nameQuery.length > 0;
        const hasMatches = view.matches.length > 0;
        const header = hasQuery
          ? hasMatches
            ? view.matches.length > 1
              ? `🔎 Found ${view.matches.length} matches for **${nameQuery}**. Pick one from the dropdown.`
              : `✅ Matched **${nameQuery}**.`
            : `❌ No matches for **${nameQuery}**. Showing the full ${view.monthLabel} schedule instead.`
          : `📅 ${view.monthLabel} schedule`;

        const dropdownSource = view.monthEvents;

        await sendFollowup(token, {
          content: header,
          embeds: [buildScheduleEmbed(selected, view.monthLabel, view.generatedAt)],
          components: buildScheduleSelectRow(
            dropdownSource,
            selected.id,
            hasQuery && view.matches.length > 1
              ? `Multiple matches for "${nameQuery}" — pick one`
              : `Select another ${view.monthLabel} event`,
          ),
        });
      } catch (err) {
        console.error("Schedule command error:", err);
        await sendFollowup(token, { content: "❌ Failed to load schedule." });
      }

      return;
    }

    // "resource" command
    if (name === 'resource') {
      const query = data.options?.find(opt => opt.name === "mode")?.value?.toLowerCase();

      // Find matches
      const matches = resources.filter(c => {
        if (!query) return true;

        return (
          c.name.toLowerCase().includes(query)
        );
      });


      // No matches
      if (matches.length === 0) {
        return res.send({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: { content: `❌ Resource "${query}" not found.` }
        });
      }

      // One match → embed
      if (matches.length === 1) {
        return res.send({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: buildResourceEmbed(matches[0])
          
        });
      }
    }

    // "qp" command
    if (name === 'qp') {
      const guideKey = data.options?.find(opt => opt.name === "guide")?.value;

      const qpGuides = {
        sample_schedule: {
          title: "Sample Race Schedule",
          filename: "sample_schedule.png",
        },
        race_bonus_and_hammers: {
          title: "Race Bonus and Hammers",
          filename: "race_bonus_and_hammers.png",
        },
        consecutive_race_penalty: {
          title: "Consecutive Race Penalty",
          filename: "consecutive_race_penalty.png",
        },
        mood_energy_mant: {
          title: "Trackblazer Mood & Energy Events",
          filename: "mood_energy_mant.png",
        },
        unique_levels: {
          title: "Unique Levels",
          filename: "unique_levels.png",
        },
      };

      const guide = qpGuides[guideKey];

      if (!guide) {
        return res.send({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: { content: "❌ Unknown guide selected." }
        });
      }

      const protocol = req.get('x-forwarded-proto') || req.protocol || 'http';
      const host = req.get('host');
      const baseUrl = host ? `${protocol}://${host}` : '';
      const imageUrl = `${baseUrl}/assets/guides/${guide.filename}`;

      return res.send({
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: {
          embeds: [
            {
              title: guide.title,
              image: { url: imageUrl }
            }
          ]
        }
      });
    }

    // "epithet" command
    if (name === 'epithet') {
      const nameOpt = data.options?.find(opt => opt.name === 'name')?.value?.trim?.() || '';
      const queryTerms = nameOpt ? nameOpt.toLowerCase().split(/\s+/) : [];

      const matches = epithets.filter(e => {
        if (queryTerms.length === 0) return true;
        const id = (e.id || '').toLowerCase();
        const conditions = (e.conditions || '').toLowerCase();
        const reward = (e.reward || '').toLowerCase();
        const aliases = (e.aliases || []).map(a => String(a).toLowerCase());
        return queryTerms.every(q =>
          id.includes(q) ||
          conditions.includes(q) ||
          reward.includes(q) ||
          aliases.some(a => a.includes(q))
        );
      });

      if (matches.length === 0) {
        return res.send({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: { content: `❌ No epithet found${nameOpt ? ` for "${nameOpt}"` : ''}.` }
        });
      }

      // Single match → detail view (including when search is exact/specific)
      if (matches.length === 1) {
        return res.send({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: buildEpithetEmbed(matches[0])
        });
      }

      // Multiple matches → list with pagination
      const listPayload = buildEpithetListPayload(matches, 0, nameOpt || null);
      return res.send({
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: listPayload
      });
    }

    // "donate" command
    if (name === 'donate') {
      return res.send({
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: {
          embeds: [
            {
              title: '☕ Support Tazuna',
              description:
                "Tazuna runs on a paid server, and every month it costs real money to keep the bot online, fast, and updated.\n\n" +
                "If the bot has been useful to you and you'd like to help cover hosting costs, any contribution is hugely appreciated — no pressure, the bot will always be free to use!\n\n" +
                "Thank you for your support! 💚",
              color: 0x13A10E,
              footer: { text: 'Donations are entirely voluntary and never unlock paid features.' }
            }
          ],
          components: [
            {
              type: 1, // Action row
              components: [
                {
                  type: 2,     // Button
                  style: 5,    // Link
                  label: 'Support on Ko-fi',
                  url: KOFI_URL,
                  emoji: { name: '☕' }
                }
              ]
            }
          ]
        }
      });
    }

    // "bugreport" command
    if (name === 'bugreport') {
      const descriptionText = data.options?.find(opt => opt.name === 'description')?.value;
      const imageAttachmentId = data.options?.find(opt => opt.name === 'image')?.value;
      const imageAttachment = imageAttachmentId
        ? data.resolved?.attachments?.[imageAttachmentId]
        : null;

      if (!descriptionText || !descriptionText.trim()) {
        return res.send({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: {
            flags: InteractionResponseFlags.EPHEMERAL,
            content: '❌ Please provide a description of the bug.'
          }
        });
      }

      // Acknowledge immediately so we have time to post to the report channel
      res.send({
        type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
        data: { flags: InteractionResponseFlags.EPHEMERAL }
      });

      (async () => {
        try {
          const user = req.body.member?.user || req.body.user;
          const userTag = user?.username
            ? (user.discriminator && user.discriminator !== '0'
                ? `${user.username}#${user.discriminator}`
                : user.username)
            : 'Unknown user';
          const userId = user?.id || 'unknown';
          const guildId = req.body.guild_id || null;
          const channelId = req.body.channel_id || req.body.channel?.id || null;

          const reportEmbed = {
            title: '🐞 New Bug Report',
            description: descriptionText.length > 4000
              ? descriptionText.slice(0, 3997) + '...'
              : descriptionText,
            color: 0xE74C3C,
            fields: [
              { name: 'Reporter', value: `${userTag} (<@${userId}>)`, inline: false },
              { name: 'User ID', value: userId, inline: true },
              ...(guildId
                ? [{ name: 'Origin Guild', value: guildId, inline: true }]
                : [{ name: 'Origin', value: 'DM / User-install', inline: true }]),
              ...(channelId
                ? [{ name: 'Origin Channel', value: channelId, inline: true }]
                : [])
            ],
            timestamp: new Date().toISOString()
          };

          if (imageAttachment?.url) {
            reportEmbed.image = { url: imageAttachment.url };
            reportEmbed.fields.push({
              name: 'Attachment',
              value: `[${imageAttachment.filename || 'image'}](${imageAttachment.url})`,
              inline: false
            });
          }

          try {
            await DiscordRequest(`channels/${BUG_REPORT_CHANNEL_ID}/messages`, {
              method: 'POST',
              body: { embeds: [reportEmbed] }
            });
          } catch (postErr) {
            console.error('Failed to post bug report to channel:', postErr);
            await sendFollowup(token, {
              flags: InteractionResponseFlags.EPHEMERAL,
              content: '⚠️ Your report was received but I could not forward it to the developer. Please join the support server and report it directly: ' + SUPPORT_INVITE_URL
            });
            return;
          }

          await sendFollowup(token, {
            flags: InteractionResponseFlags.EPHEMERAL,
            content: `✅ Your bug report has been received. If you have any questions, feel free to join the discord server ${SUPPORT_INVITE_URL}`
          });
        } catch (err) {
          console.error('Bug report handler error:', err);
          await sendFollowup(token, {
            flags: InteractionResponseFlags.EPHEMERAL,
            content: '❌ Something went wrong submitting your bug report. Please try again later.'
          });
        }
      })();

      return;
    }

    if (isQuizCommand(name)) {
      const quizResult = await dispatchQuizCommand(req);
      if (quizResult?.deferred) {
        res.send({
          type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
          data: quizResult.ephemeral ? { flags: InteractionResponseFlags.EPHEMERAL } : undefined,
        });
        (async () => {
          try {
            await quizResult.run((payload) => sendFollowup(token, payload));
          } catch (err) {
            console.error('quiz deferred handler failed:', err);
            try {
              await sendFollowup(token, {
                flags: InteractionResponseFlags.EPHEMERAL,
                content: '❌ Something went wrong. Please try again later.',
              });
            } catch (followupErr) {
              console.error('quiz follow-up failed:', followupErr);
            }
          }
        })();
        return;
      }
      if (quizResult) {
        return res.send(quizResult);
      }
    }

    if (isGambacoinCommand(name)) {
      const gambacoinResult = await dispatchGambacoinCommand(req);
      if (gambacoinResult) {
        return res.send(gambacoinResult);
      }
    }

    if (isGambaCommand(name)) {
      const gambaResult = await dispatchGambaCommand(req);
      if (gambaResult) {
        return res.send(gambaResult);
      }
    }

    if (isEventGamblingCommand(name)) {
      const eventResult = await dispatchEventCommand(req);
      if (eventResult) {
        return res.send(eventResult);
      }
    }

    if (isClubCommand(name)) {
      const clubResult = await dispatchClubCommand(name, req);
      if (clubResult?.deferred) {
        res.send({
          type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
          data: clubResult.ephemeral ? { flags: InteractionResponseFlags.EPHEMERAL } : undefined,
        });
        (async () => {
          try {
            await clubResult.run((payload) => sendFollowup(token, payload));
          } catch (err) {
            console.error(`${name} deferred handler failed:`, err);
            try {
              await sendFollowup(token, {
                flags: InteractionResponseFlags.EPHEMERAL,
                content: '❌ Something went wrong. Please try again later.',
              });
            } catch (followupErr) {
              console.error(`${name} follow-up failed:`, followupErr);
            }
          }
        })();
        return;
      }
      if (clubResult) {
        return res.send(clubResult);
      }
    }

    console.error(`unknown command: ${name}`);
    return res.status(400).json({ error: 'unknown command' });
  }

  if (type === InteractionType.MESSAGE_COMPONENT) {
    const { custom_id, values } = data;

    const quizAnswer = handleQuizAnswerComponent(custom_id);
    if (quizAnswer) {
      try {
        const response = await handleQuizAnswer(req, quizAnswer);
        return res.send(response);
      } catch (err) {
        console.error('Quiz answer handler failed:', err);
        return res.send({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: {
            flags: InteractionResponseFlags.EPHEMERAL,
            content: '❌ Something went wrong processing your answer.',
          },
        });
      }
    }

    const gambaWager = handleGambaWagerComponent(custom_id);
    if (gambaWager) {
      try {
        const response = await handleGambaWagerClick(
          req,
          gambaWager.eventId,
          gambaWager.entryNumber,
          gambaWager.amount,
        );
        return res.send(response);
      } catch (err) {
        console.error('Gamba wager handler failed:', err.message);
        return res.send({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: {
            flags: InteractionResponseFlags.EPHEMERAL,
            content: '❌ Something went wrong placing your bet.',
          },
        });
      }
    }

    const gambaBet = handleGambaBetComponent(custom_id);
    if (gambaBet) {
      try {
        const response = await handleGambaBetClick(req, gambaBet.eventId, gambaBet.entryNumber);
        return res.send(response);
      } catch (err) {
        console.error('Gamba bet handler failed:', err.message);
        return res.send({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: {
            flags: InteractionResponseFlags.EPHEMERAL,
            content: '❌ Something went wrong opening the wager menu.',
          },
        });
      }
    }

    const gambaDonate = handleGambaDonateComponent(custom_id);
    if (gambaDonate) {
      try {
        const response = await handleGambaDonateClick(req, gambaDonate.beggarId, gambaDonate.amount);
        return res.send(response);
      } catch (err) {
        console.error('Gamba donate handler failed:', err);
        return res.send({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: {
            flags: InteractionResponseFlags.EPHEMERAL,
            content: '❌ Something went wrong processing your donation.',
          },
        });
      }
    }

    const clubAction = handleClubComponent(custom_id, values);
    if (clubAction) {
      const componentUserId = req.body.member?.user?.id || req.body.user?.id;
      if (clubAction.ownerUserId && clubAction.ownerUserId !== componentUserId) {
        return res.send({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: {
            flags: InteractionResponseFlags.EPHEMERAL,
            content: '❌ That menu belongs to someone else.',
          },
        });
      }

      try {
        const componentData = await runClubComponentAction(clubAction, {
          guildId: req.body.guild_id ?? null,
        });
        return res.send({
          type: InteractionResponseType.UPDATE_MESSAGE,
          data: componentData,
        });
      } catch (err) {
        console.error('Club component handler failed:', err);
        return res.send({
          type: InteractionResponseType.UPDATE_MESSAGE,
          data: {
            content: `❌ ${err.message}`,
            components: [],
            embeds: [],
          },
        });
      }
    }

    if (custom_id === "supporter_select") {
      const [selectedId, levelStr] = values[0].split("|");
      const supporter = supporters.find(s => s.id === selectedId);
      const level = levelStr !== "" ? Number(levelStr) : undefined;

      return res.send({
        type: InteractionResponseType.UPDATE_MESSAGE,
        data: {
          content: `✅ You selected **${supporter.card_name}**`,
          embeds: [buildSupporterEmbed(supporter, skills, level)],
          components: buildSupporterComponents(supporter, level)
        }
      });
    }

    // Handling selecting a skill from support card skill dropdown
    if (custom_id === "supporter_skill_select") {
      const [meta, selectedTitle] = values[0].split("::");
      const [supporterId, levelStr] = meta.split("|");
      const supporter = supporters.find(s => s.id === supporterId);
      const level = levelStr !== "" ? Number(levelStr) : undefined;

      const skill = skills.find(s =>
        s.skill_name.toLowerCase() === selectedTitle.toLowerCase()
      );

      if (!supporter || !skill) {
        return res.send({
          type: InteractionResponseType.UPDATE_MESSAGE,
          data: {
            content: "❌ Could not find the selected supporter skill.",
            components: supporter ? buildSupporterComponents(supporter, level) : []
          }
        });
      }

      // Lookup supporters with this skill, hide r cards
      const supporterMatches = getSupporterMatchesForSkill(skill.skill_name);

      // Format supporter names into a list
      const supporterList = supporterMatches.length
        ? supporterMatches.map(s => `• ${s.character_name} - ${s.card_name} (${s.rarity.toUpperCase()})`).join('\n')
        : 'None';

      const { embed: skillEmbed, mapCid } = await buildSkillEmbedWithMap(skill, supporterList, req);
      return res.send({
        type: InteractionResponseType.UPDATE_MESSAGE,
        data: {
          content: `✅ You selected **${skill.skill_name}**`,
          embeds: [buildSupporterEmbed(supporter, skills, level), skillEmbed],
          components: [
            ...buildSupporterComponents(supporter, level),
            ...buildSkillComponents(skill, false, supporterMatches, null, mapCid)
          ]
        }
      });
    }

    // Handling selecting an event from supporter's event dropdown
    if (custom_id === "supporter_event_select") {
      const [meta, selectedEventIndexRaw] = values[0].split("::");
      const [supporterId, levelStr] = meta.split("|");
      const supporter = supporters.find(s => s.id === supporterId);
      const level = levelStr !== "" ? Number(levelStr) : undefined;
      const selectedEventIndex = Number(selectedEventIndexRaw);
      const event = supporter?.events?.[selectedEventIndex];

      if (!supporter || !event) {
        return res.send({
          type: InteractionResponseType.UPDATE_MESSAGE,
          data: {
            content: "❌ Could not find the selected supporter event.",
            components: supporter ? buildSupporterComponents(supporter, level) : []
          }
        });
      }

      return res.send({
        type: InteractionResponseType.UPDATE_MESSAGE,
        data: {
          content: `✅ You selected **${event.name || `Event ${selectedEventIndex + 1}`}**`,
          embeds: [buildSupporterEmbed(supporter, skills, level), buildSupporterEventEmbed(supporter, event, selectedEventIndex)],
          components: buildSupporterComponents(supporter, level)
        }
      });
    }

    // Handling selecting a skill from a dropdown
    if (custom_id === "skill_select") {
      const [selectedTitle, selectedMapOverride] = String(values[0] ?? "").split("::");
      const skill = skills.find(s =>
        s.skill_name.toLowerCase() === selectedTitle.toLowerCase()
      );
      if (!skill) {
        return res.send({
          type: InteractionResponseType.UPDATE_MESSAGE,
          data: { content: "❌ Could not find the selected skill." }
        });
      }

      // Lookup supporters with this skill
      const supporterMatches = getSupporterMatchesForSkill(skill.skill_name);

      // Format supporter names into a list
      let supporterList = supporterMatches.length
        ? supporterMatches.map(s => `• ${s.character_name} - ${s.card_name} (${s.rarity.toUpperCase()})`).join('\n')
        : 'None';

        
      const { embed: skillEmbed, mapComponents, mapOverrideKey, mapCid } = await buildSkillEmbedWithMap(
        skill,
        supporterList,
        req,
        { mapOverride: selectedMapOverride || null }
      );

      return res.send({
        type: InteractionResponseType.UPDATE_MESSAGE,
        data: {
          content: `✅ You selected **${skill.skill_name}**`,
          embeds: [skillEmbed],
          components: composeSkillComponents(
            buildSkillComponents(skill, supporterMatches.length, supporterMatches, mapOverrideKey, mapCid),
            mapComponents
          )
        }
      });
    }

    // Handling switching the Champions Meet map shown under a skill
    if (custom_id === "skill_cm_select") {
      const [cmNumberRaw, identifier] = String(values[0] ?? "").split("::");
      const selectedCmNumber = Number(cmNumberRaw);
      const skill = skills.find(s =>
        String(s.gametora_id ?? "") === identifier ||
        s.skill_name.toLowerCase() === String(identifier ?? "").toLowerCase()
      );

      if (!skill) {
        return res.send({
          type: InteractionResponseType.UPDATE_MESSAGE,
          data: { content: "❌ Could not find the selected skill." }
        });
      }

      const supporterMatches = getSupporterMatchesForSkill(skill.skill_name);
      const supporterList = supporterMatches.length
        ? supporterMatches.map(s => `• ${s.character_name} - ${s.card_name} (${s.rarity.toUpperCase()})`).join('\n')
        : 'None';

      const { embed: skillEmbed, mapComponents, mapCid } = await buildSkillEmbedWithMap(skill, supporterList, req, selectedCmNumber);

      return res.send({
        type: InteractionResponseType.UPDATE_MESSAGE,
        data: {
          content: `✅ You selected **${skill.skill_name}**`,
          embeds: [skillEmbed],
          components: composeSkillComponents(
            buildSkillComponents(skill, supporterMatches.length, supporterMatches, null, mapCid),
            mapComponents
          )
        }
      });
    }

    // Handling selecting a supporter card from skills
    if (custom_id === "supporter_lookup_select") {
      const cardID = values[0];
      const supporter = supporters.find(s => s.id === cardID);
      
      return res.send({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: { 
            embeds: [buildSupporterEmbed(supporter, skills)]
            }
          });
    }

    // Handling looking up the upgraded/downgraded skill
    if (custom_id.startsWith("upgrade_") || custom_id.startsWith("downgrade_")) {
      const parsed = parseSkillNavCustomId(custom_id);
      if (!parsed) {
        return res.send({
          type: InteractionResponseType.UPDATE_MESSAGE,
          data: { content: "⚠️ Could not parse skill navigation button." }
        });
      }

      const targetSkill = skills.find(s =>
        s.skill_name.toLowerCase() === parsed.targetName.toLowerCase()
      );

      if (!targetSkill) {
        return res.send({
          type: InteractionResponseType.UPDATE_MESSAGE,
          data: { content: `⚠️ ${parsed.kind === "upgrade" ? "Upgraded" : "Downgraded"} skill not found!` }
        });
      }

      const supporterMatches = getSupporterMatchesForSkill(targetSkill.skill_name);
      const supporterList = supporterMatches.length
        ? supporterMatches.map(s => `• ${s.character_name} - ${s.card_name} (${s.rarity.toUpperCase()})`).join('\n')
        : 'None';

      const { embed: skillEmbed, mapComponents, mapOverrideKey, mapCid } = await buildSkillEmbedWithMap(
        targetSkill,
        supporterList,
        req,
        { mapOverride: parsed.mapOverrideKey }
      );
      return res.send({
        type: InteractionResponseType.UPDATE_MESSAGE,
        data: {
          embeds: [skillEmbed],
          components: composeSkillComponents(
            buildSkillComponents(targetSkill, supporterMatches.length, supporterMatches, mapOverrideKey, mapCid),
            mapComponents
          )
        }
      });
    }

    if (custom_id === "uma_select") {
      const selectedTitle = values[0];
      const uma = characters.find(c =>
        c.id === selectedTitle
      );

      return res.send({
        type: InteractionResponseType.UPDATE_MESSAGE,
        data: {
          content: `✅ You selected **${uma.character_name} (${uma.type})**`,
          embeds: [buildUmaEmbed(uma, skills)],
          components: buildUmaComponents(uma, true, characters)
        }
      });
    }

    if (custom_id === "uma_variant_select") {
      const selectedVariantId = values[0];
      const variant = characters.find(c => c.id === selectedVariantId);

      if (!variant) {
        return res.send({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: { content: `❌ Variant not found.` }
        });
      }

      return res.send({
        type: InteractionResponseType.UPDATE_MESSAGE, // update the same message
        data: {
          embeds: [buildUmaEmbed(variant, skills)],
          components: buildUmaComponents(variant, true, characters)
        }
      });
    }

    // Handling selecting a skill from Uma's skill dropdown
    if (custom_id === "uma_skill_select") {
      const [umaId, selectedTitle] = values[0].split("::");

      const uma = characters.find(c => c.id === umaId);

      const skill = skills.find(s =>
        s.skill_name.toLowerCase() === selectedTitle.toLowerCase()
      );

      if (!skill) {
        return res.send({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: { content: `❌ Skill "${values[0]}" not found.` }
        });
      }

      // Lookup supporters with this skill
      const supporterMatches = getSupporterMatchesForSkill(skill.skill_name);

      let supporterList = supporterMatches.length
        ? supporterMatches.map(s =>
            `• ${s.character_name} - ${s.card_name} (${s.rarity.toUpperCase()})`
          ).join('\n')
        : 'None';

      const { embed: skillEmbed, mapCid } = await buildSkillEmbedWithMap(skill, supporterList, req);
      return res.send({
        type: InteractionResponseType.UPDATE_MESSAGE,
        data: {
          content: `✅ You selected **${skill.skill_name}**`,
          embeds: [buildUmaEmbed(uma, skills), skillEmbed],
          components: [
            ...buildUmaComponents(uma, true, characters),
            ...buildSkillComponents(skill, supporterMatches.length, supporterMatches, null, mapCid)
          ]
        }
      });
    }

    if (custom_id === "event_select") {
      const selectedId = values[0]; // exact match
      const event = events.find(s => s.id === selectedId);

      return res.send({
        type: InteractionResponseType.UPDATE_MESSAGE,
        data: {
          content: `✅ You selected **${event.event_name}**`,
          embeds: [buildEventEmbed(event, events)] // remove the dropdown after selection
        }
      });
    }

    if (custom_id === 'schedule_select') {
      try {
        const selectedId = String(values?.[0] || '');
        const view = await getCurrentMonthEventById(selectedId);
        if (!view.selected || view.monthEvents.length === 0) {
          return res.send({
            type: InteractionResponseType.UPDATE_MESSAGE,
            data: {
              content: '❌ This schedule entry is no longer available for the current month.',
              embeds: [],
              components: [],
            },
          });
        }

        return res.send({
          type: InteractionResponseType.UPDATE_MESSAGE,
          data: {
            content: `📅 ${view.monthLabel} schedule`,
            embeds: [buildScheduleEmbed(view.selected, view.monthLabel, view.generatedAt)],
            components: buildScheduleSelectRow(
              view.monthEvents,
              view.selected.id,
              `Select another ${view.monthLabel} event`,
            ),
          },
        });
      } catch (err) {
        console.error('Schedule select handler failed:', err);
        return res.send({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: {
            flags: InteractionResponseFlags.EPHEMERAL,
            content: '❌ Could not update the schedule card.',
          },
        });
      }
    }

    if (custom_id === "race_select") {
      const selectedId = values[0];
      const race = races.find(r => r.id === selectedId);

      if (!race) {
        return res.send({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: { content: `❌ Race not found.` }
        });
      }

      return res.send({
        type: InteractionResponseType.UPDATE_MESSAGE,
        data: {
          content: `✅ You selected **${race.race_name}**`,
          embeds: [buildRaceEmbed(race, characters)],
          components: [] // remove the dropdown after selection
        }
      });
    }

    if (custom_id === "map_select") {
      const selectedKey = values[0];
      const resolved = resolveMapOverride(selectedKey, cache.maps, cache.customraces);

      if (!resolved) {
        return res.send({
          type: InteractionResponseType.UPDATE_MESSAGE,
          data: { content: "❌ Course map not found." },
        });
      }

      const mapPayload = await buildMapLookupPayload(resolved, req);
      return res.send({
        type: InteractionResponseType.UPDATE_MESSAGE,
        data: {
          content: `✅ You selected **${resolved.label}**`,
          ...mapPayload,
          components: [],
        },
      });
    }

    if (custom_id === "cm_select") {
      const selectedId = values[0];
      const cm = champsmeets.find(c => c.name === selectedId);

      if (!cm) {
        return res.send({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: { content: `❌ Champion's Meet not found.` }
        });
      }

      const mapImageUrl = await resolveCmMapImageUrl(cm, req);
      const cmPayload = buildCMEmbed(mapImageUrl ? { ...cm, image: mapImageUrl } : cm);

      return res.send({
        type: InteractionResponseType.UPDATE_MESSAGE,
        data: {
          content: `✅ You selected **${cm.name}**`,
          ...cmPayload
        }
      });
    }

    // Epithet list pagination
    if (custom_id.startsWith(EPITHET_PAGINATION_ID_PREFIX)) {
      const after = custom_id.slice(EPITHET_PAGINATION_ID_PREFIX.length);
      const sep = after.indexOf('_');
      const page = Math.max(0, parseInt(sep >= 0 ? after.slice(0, sep) : after, 10) || 0);
      const queryEnc = sep >= 0 ? after.slice(sep + 1) : '';
      const queryTerms = queryEnc ? queryEnc.toLowerCase().split(/\s+/) : [];

      const matches = epithets.filter(e => {
        if (queryTerms.length === 0) return true;
        const id = (e.id || '').toLowerCase();
        const conditions = (e.conditions || '').toLowerCase();
        const reward = (e.reward || '').toLowerCase();
        const aliases = (e.aliases || []).map(a => String(a).toLowerCase());
        return queryTerms.every(q =>
          id.includes(q) ||
          conditions.includes(q) ||
          reward.includes(q) ||
          aliases.some(a => a.includes(q))
        );
      });

      const listPayload = buildEpithetListPayload(matches, page, queryEnc || null);
      return res.send({
        type: InteractionResponseType.UPDATE_MESSAGE,
        data: listPayload
      });
    }
  }

console.error('unknown interaction type', type);
return res.status(400).json({ error: 'unknown interaction type' });
});

async function sendFollowup(token, payload) {
  const file = payload.files?.[0];
  const jsonPayload = { ...payload };
  delete jsonPayload.files;

  let response;
  if (file?.buffer) {
    const form = new FormData();
    form.append('payload_json', JSON.stringify(jsonPayload));
    form.append('files[0]', new Blob([file.buffer], { type: file.mime || 'application/octet-stream' }), file.filename);
    response = await fetch(`https://discord.com/api/v10/webhooks/${process.env.APP_ID}/${token}`, {
      method: 'POST',
      body: form,
    });
  } else {
    response = await fetch(`https://discord.com/api/v10/webhooks/${process.env.APP_ID}/${token}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(jsonPayload),
    });
  }

  if (!response.ok) {
    const errText = await response.text();
    console.error('Follow-up failed:', response.status, errText);
  }

  return response;
}

// --- Terms of Service & Privacy Policy (for Discord verification / discovery) ---
const termsHtml = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Terms of Service – Tazuna Bot</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 720px; margin: 2rem auto; padding: 0 1rem; line-height: 1.6; color: #333; }
    h1 { font-size: 1.5rem; margin-bottom: 0.5rem; }
    .updated { color: #666; font-size: 0.9rem; margin-bottom: 1.5rem; }
  </style>
</head>
<body>
  <h1>Terms of Service</h1>
  <p class="updated">Last updated: March 2025</p>
  <p>By inviting and using <strong>Tazuna</strong> (“the Bot”) in your Discord server, you agree to these terms.</p>
  <ul>
    <li>You must comply with <a href="https://discord.com/terms">Discord’s Terms of Service</a> and <a href="https://discord.com/guidelines">Community Guidelines</a>.</li>
    <li>You may not use the Bot for spam, abuse, or to violate any applicable laws.</li>
    <li>The Bot is provided “as is.” We do not guarantee uptime or specific features.</li>
    <li>We may update or discontinue the Bot with reasonable notice where possible.</li>
  </ul>
  <p>If you do not agree, please remove the Bot from your server.</p>
</body>
</html>
`;

const privacyHtml = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Privacy Policy – Tazuna Bot</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 720px; margin: 2rem auto; padding: 0 1rem; line-height: 1.6; color: #333; }
    h1 { font-size: 1.5rem; margin-bottom: 0.5rem; }
    .updated { color: #666; font-size: 0.9rem; margin-bottom: 1.5rem; }
    h2 { font-size: 1.1rem; margin-top: 1.25rem; }
  </style>
</head>
<body>
  <h1>Privacy Policy</h1>
  <p class="updated">Last updated: March 2025</p>
  <p>This policy describes what data <strong>Tazuna</strong> (“the Bot”) collects and how it is used.</p>
  <h2>Data we collect</h2>
  <ul>
    <li><strong>Discord data:</strong> User IDs, usernames, server (guild) IDs, and channel IDs when you use commands or when your server uses leaderboard/sheets features.</li>
    <li><strong>Saved data:</strong> If you use the save command, we store the labels and URLs (e.g. Umalator links) you provide, associated with your Discord user ID.</li>
    <li><strong>Server data:</strong> For servers that use leaderboards or Google Sheets sync, we store server configuration (e.g. sheet IDs, channel IDs) and fan/rank data synced from your sheet.</li>
    <li><strong>Images:</strong> Images you upload for profile parsing are sent to a third-party OCR service for text extraction; we do not store the image content long-term.</li>
  </ul>
  <h2>How we use it</h2>
  <p>Data is used to provide Bot features (leaderboards, trainer lookups, saved links, sheet sync, image parsing) and to operate the service.</p>
  <h2>Storage & sharing</h2>
  <p>Data is stored on the Bot’s hosting infrastructure and, where configured, in Google Sheets. We do not sell your data. We may share data only as required by law or to protect the service.</p>
  <h2>Your rights</h2>
  <p>You can stop using the Bot and remove it from your server at any time. Data tied to your user or server may remain in our storage until we purge it; you can request deletion by contacting the Bot developer.</p>
  <h2>Changes</h2>
  <p>We may update this policy; the “Last updated” date will be revised. Continued use of the Bot after changes constitutes acceptance.</p>
</body>
</html>
`;

app.get('/terms', (req, res) => {
  res.type('html').send(termsHtml);
});

app.get('/privacy', (req, res) => {
  res.type('html').send(privacyHtml);
});

let shuttingDownFromFatal = false;

process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
  if (shuttingDownFromFatal) return;
  shuttingDownFromFatal = true;
  postOpsNotice('🚨 Tazuna fatal crash (uncaughtException)', formatErrorForEmbed(err))
    .finally(() => process.exit(1));
});

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection:', reason);
  if (shuttingDownFromFatal) return;
  shuttingDownFromFatal = true;
  postOpsNotice('🚨 Tazuna fatal crash (unhandledRejection)', formatErrorForEmbed(reason))
    .finally(() => process.exit(1));
});

app.listen(PORT, () => {
  console.log('Listening on port', PORT);
  if (getUmaApiKey()) {
    console.log('UMA_API_KEY is configured.');
    startLeaderboardCron();
  } else {
    console.warn('UMA_API_KEY is missing — /register, /profile, and club leaderboards will fail until it is set.');
  }
  startQuizRemoteSync();
  resumeActiveQuizzes().catch((err) => {
    console.error('Failed to resume active quizzes:', err.message);
  });
  startEventCron();
  postOpsNotice('✅ Tazuna bot started', `Listening on port ${PORT}`, 0x2ECC71);
});
