import path from "path";
import crypto from "crypto";
import fs from "fs/promises";

function toMeters(distanceValue) {
  if (typeof distanceValue === "number") return distanceValue;
  const parsed = parseInt(String(distanceValue ?? "").replace(/[^\d]/g, ""), 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function extractUnixTimestamp(value) {
  const match = String(value ?? "").match(/<t:(\d+):/);
  if (!match) return null;
  return Number(match[1]);
}

function normalizeDirection(value) {
  const v = String(value ?? "").toLowerCase();
  if (v.includes("left") || v.includes("counterclockwise")) return "counterclockwise";
  if (v.includes("right") || v.includes("clockwise")) return "clockwise";
  return value ?? "";
}

export function getUpcomingChampionsMeet(champsmeets, nowSec = Math.floor(Date.now() / 1000)) {
  if (!Array.isArray(champsmeets) || champsmeets.length === 0) return null;

  const withTs = champsmeets
    .map((cm) => ({ cm, ts: extractUnixTimestamp(cm.date) }))
    .filter((item) => Number.isFinite(item.ts))
    .sort((a, b) => a.ts - b.ts);

  if (withTs.length > 0) {
    const upcoming = withTs.find((item) => item.ts >= nowSec);
    if (upcoming) return upcoming.cm;
  }

  return champsmeets[champsmeets.length - 1] ?? null;
}

function resolveMapName(cm, length) {
  if (cm?.map?.name) return cm.map.name;
  const racetrack = cm?.track?.racetrack ?? "Course";
  const terrain = cm?.track?.terrain ?? "";
  const direction = normalizeDirection(cm?.track?.direction);
  return `${racetrack} ${terrain} ${length}m (${direction})`.trim();
}

function normalizeSegments(segments) {
  return Array.isArray(segments)
    ? segments
        .map((segment) => ({
          ...segment,
          start: Number(segment.start),
          end: Number(segment.end),
        }))
        .filter((segment) => Number.isFinite(segment.start) && Number.isFinite(segment.end) && segment.end > segment.start)
    : [];
}

export function getCourseMapDataFromCm(cm) {
  if (!cm?.map) return null;
  const length = toMeters(cm.track?.distance_meters);
  if (!length || length <= 0) return null;

  const elevation = normalizeSegments(cm.map.elevation);
  const layout = normalizeSegments(cm.map.layout);
  const zones = normalizeSegments(cm.map.zones);
  if (!elevation.length || !layout.length || !zones.length) return null;

  return {
    name: resolveMapName(cm, length),
    length,
    elevation,
    layout,
    zones,
  };
}

function lower(value) {
  return String(value ?? "").toLowerCase();
}

function collectSkillConditionText(skill, includeDescriptions = false) {
  const sources = [];

  if (Array.isArray(skill.preconditions)) sources.push(...skill.preconditions);
  if (Array.isArray(skill.effect)) {
    for (const effect of skill.effect) {
      if (Array.isArray(effect.conditions)) sources.push(...effect.conditions);
      if (includeDescriptions && effect.description) sources.push(effect.description);
    }
  }
  if (includeDescriptions && skill.description) sources.push(skill.description);

  return sources.map((v) => lower(v)).filter(Boolean);
}

function pushUniqueBox(markers, start, end, color = "#d11f2a") {
  const exists = markers.some((m) => m.type === "box" && m.start === start && m.end === end);
  if (!exists) markers.push({ type: "box", start, end, color, fillOpacity: 0.16 });
}

function pushUniqueLine(markers, distance, color = "#d11f2a") {
  const normalized = Math.max(0, Math.round(distance));
  const exists = markers.some((m) => m.type === "line" && m.distance === normalized);
  if (!exists) markers.push({ type: "line", distance: normalized, color });
}

function inferTextTrackRequirements(skill) {
  const texts = collectSkillConditionText(skill, false);
  const requirements = {
    distanceTypes: new Set(),
    terrains: new Set(),
    directions: new Set(),
  };

  for (const text of texts) {
    const distanceTypeMatches = text.match(/\b(sprint|mile|medium|long)\b/g) ?? [];
    for (const match of distanceTypeMatches) requirements.distanceTypes.add(match);

    const terrainMatches = text.match(/\b(turf|dirt)\b/g) ?? [];
    for (const match of terrainMatches) requirements.terrains.add(match);

    if (text.includes("counterclockwise") || text.includes("left-handed") || text.includes("left handed")) {
      requirements.directions.add("counterclockwise");
    }
    if (text.includes("clockwise") || text.includes("right-handed") || text.includes("right handed")) {
      requirements.directions.add("clockwise");
    }
  }

  return requirements;
}

function findZoneByLabel(mapData, candidates) {
  if (!mapData?.zones) return null;
  return mapData.zones.find((segment) => {
    const label = lower(segment.label);
    return candidates.some((candidate) => label.includes(candidate));
  }) ?? null;
}

function inferAutoPhaseWindow(skill, mapData) {
  const texts = collectSkillConditionText(skill, false);
  if (!texts.length) return null;

  const earlyZone = findZoneByLabel(mapData, ["opening", "early"]);
  const midZone = findZoneByLabel(mapData, ["middle", "mid"]);
  const lateZone = findZoneByLabel(mapData, ["late", "final"]);
  const spurtZone = findZoneByLabel(mapData, ["spurt"]);

  // "Late race and beyond" means from late-race start to race end.
  if (texts.some((t) => t.includes("late race and beyond"))) {
    const start = lateZone?.start ?? spurtZone?.start ?? mapData.length * 0.75;
    return { start, end: mapData.length };
  }

  if (texts.some((t) => t.includes("second half of the race"))) {
    return { start: mapData.length * 0.5, end: mapData.length };
  }

  if (texts.some((t) => t.includes("late race"))) {
    if (lateZone) return { start: lateZone.start, end: lateZone.end };
  }

  if (texts.some((t) => t.includes("mid race"))) {
    if (midZone) return { start: midZone.start, end: midZone.end };
  }

  if (texts.some((t) => t.includes("early race"))) {
    if (earlyZone) return { start: earlyZone.start, end: earlyZone.end };
  }

  return null;
}

function requirementsFromActivationMap(activationMap) {
  const req = activationMap?.requirements;
  if (!req) return null;
  return {
    distanceTypes: new Set((req.distance_types ?? req.distanceTypes ?? []).map((v) => lower(v))),
    terrains: new Set((req.terrains ?? req.terrain ?? []).map((v) => lower(v))),
    directions: new Set((req.directions ?? req.direction ?? []).map((v) => lower(v))),
    racetracks: new Set((req.racetracks ?? req.racetrack ?? []).map((v) => lower(v))),
    grounds: new Set((req.grounds ?? req.ground ?? []).map((v) => lower(v))),
    seasons: new Set((req.seasons ?? req.season ?? []).map((v) => lower(v))),
    weathers: new Set((req.weathers ?? req.weather ?? []).map((v) => lower(v))),
  };
}

function evaluateTrackCompatibility(cmTrack, requirements) {
  if (!requirements) return { doesNotWork: false, reasons: [] };

  const track = {
    distanceType: lower(cmTrack?.distance_type),
    terrain: lower(cmTrack?.terrain),
    direction: normalizeDirection(cmTrack?.direction),
    racetrack: lower(cmTrack?.racetrack),
    ground: lower(cmTrack?.ground),
    season: lower(cmTrack?.season),
    weather: lower(cmTrack?.weather),
  };

  const reasons = [];
  if (requirements.distanceTypes?.size && !requirements.distanceTypes.has(track.distanceType)) {
    reasons.push("distance type mismatch");
  }
  if (requirements.terrains?.size && !requirements.terrains.has(track.terrain)) {
    reasons.push("terrain mismatch");
  }
  if (requirements.directions?.size && !requirements.directions.has(track.direction)) {
    reasons.push("direction mismatch");
  }
  if (requirements.racetracks?.size && !requirements.racetracks.has(track.racetrack)) {
    reasons.push("racetrack mismatch");
  }
  if (requirements.grounds?.size && !requirements.grounds.has(track.ground)) {
    reasons.push("ground mismatch");
  }
  if (requirements.seasons?.size && !requirements.seasons.has(track.season)) {
    reasons.push("season mismatch");
  }
  if (requirements.weathers?.size && !requirements.weathers.has(track.weather)) {
    reasons.push("weather mismatch");
  }

  return { doesNotWork: reasons.length > 0, reasons };
}

function markersFromActivationMap(skill, mapData) {
  const activationMap = skill?.activation_map;
  if (!activationMap || !Array.isArray(activationMap.triggers)) return [];

  const markers = [];
  const autoPhaseWindow = inferAutoPhaseWindow(skill, mapData);
  for (const trigger of activationMap.triggers) {
    const color = trigger.color ?? "#d11f2a";
    if (trigger.type === "line") {
      if (Number.isFinite(Number(trigger.distance))) {
        pushUniqueLine(markers, Number(trigger.distance), color);
        continue;
      }
      const mode = lower(trigger.distance_mode ?? trigger.distanceMode ?? "absolute");
      const value = Number(trigger.value);
      if (!Number.isFinite(value)) continue;
      if (mode === "remaining") {
        pushUniqueLine(markers, mapData.length - value, color);
      } else {
        pushUniqueLine(markers, value, color);
      }
      continue;
    }

    if (trigger.type === "box") {
      const ratioStart = Number(trigger.clip_start_ratio ?? trigger.start_ratio);
      const ratioEnd = Number(trigger.clip_end_ratio ?? trigger.end_ratio);
      const absoluteStart = Number(trigger.clip_start ?? trigger.start_m ?? trigger.range_start);
      const absoluteEnd = Number(trigger.clip_end ?? trigger.end_m ?? trigger.range_end);

      let clipStart = 0;
      let clipEnd = mapData.length;
      if (Number.isFinite(ratioStart)) clipStart = Math.max(0, ratioStart) * mapData.length;
      if (Number.isFinite(ratioEnd)) clipEnd = Math.min(1, ratioEnd) * mapData.length;
      if (Number.isFinite(absoluteStart)) clipStart = absoluteStart;
      if (Number.isFinite(absoluteEnd)) clipEnd = absoluteEnd;
      if (autoPhaseWindow && trigger.disable_auto_phase_clip !== true) {
        clipStart = Math.max(clipStart, autoPhaseWindow.start);
        clipEnd = Math.min(clipEnd, autoPhaseWindow.end);
      }

      const pushClippedBox = (start, end) => {
        const clippedStart = Math.max(start, clipStart);
        const clippedEnd = Math.min(end, clipEnd);
        if (clippedEnd > clippedStart) {
          pushUniqueBox(markers, clippedStart, clippedEnd, color);
        }
      };

      if (Number.isFinite(Number(trigger.start)) && Number.isFinite(Number(trigger.end))) {
        pushClippedBox(Number(trigger.start), Number(trigger.end));
        continue;
      }

      const target = lower(trigger.target ?? "layout");
      const source = target === "elevation" ? mapData.elevation : target === "zones" ? mapData.zones : mapData.layout;
      const match = lower(trigger.match ?? "");
      const labels = Array.isArray(trigger.labels) ? trigger.labels.map((v) => lower(v)) : [];
      const cornerNumbers = Array.isArray(trigger.corner_numbers) ? trigger.corner_numbers.map((v) => Number(v)) : [];
      const selectMode = lower(trigger.select ?? "");
      const localStartRatio = Number(trigger.clip_within_segment_start_ratio ?? trigger.local_start_ratio);
      const localEndRatio = Number(trigger.clip_within_segment_end_ratio ?? trigger.local_end_ratio);
      const applyLocalClip = Number.isFinite(localStartRatio) || Number.isFinite(localEndRatio);

      const matchingSegments = [];
      for (const segment of source) {
        const label = lower(segment.label);
        let ok = false;

        if (match && label.includes(match)) ok = true;
        if (!ok && labels.length && labels.some((v) => label.includes(v))) ok = true;
        if (!ok && cornerNumbers.length && cornerNumbers.some((n) => label.includes(`corner ${n}`))) ok = true;
        if (!ok && !match && !labels.length && !cornerNumbers.length) ok = true;

        if (ok) matchingSegments.push(segment);
      }

      const selectedSegments =
        selectMode === "last"
          ? (matchingSegments.length ? [matchingSegments[matchingSegments.length - 1]] : [])
          : selectMode === "first"
            ? (matchingSegments.length ? [matchingSegments[0]] : [])
            : matchingSegments;

      for (const segment of selectedSegments) {
        if (!applyLocalClip) {
          pushClippedBox(segment.start, segment.end);
          continue;
        }
        const segmentLength = segment.end - segment.start;
        const localStart = Number.isFinite(localStartRatio) ? segment.start + Math.max(0, localStartRatio) * segmentLength : segment.start;
        const localEnd = Number.isFinite(localEndRatio) ? segment.start + Math.min(1, localEndRatio) * segmentLength : segment.end;
        pushClippedBox(localStart, localEnd);
      }
    }
  }

  return markers;
}

export function inferSkillMarkers(skill, mapData) {
  if (!skill || !mapData) return [];

  const conditions = collectSkillConditionText(skill, true);
  const markers = [];

  for (const condition of conditions) {
    // Direction-only / course-only checks should not create activation overlays.
    if (
      condition.includes("counterclockwise") ||
      condition.includes("clockwise") ||
      condition.includes("left-handed") ||
      condition.includes("right-handed")
    ) {
      continue;
    }

    if (condition.includes("corner")) {
      const cornerNumberMatch = condition.match(/corner\s*([1-4])/);
      if (cornerNumberMatch) {
        const cornerLabel = `corner ${cornerNumberMatch[1]}`;
        for (const segment of mapData.layout) {
          if (lower(segment.label).includes(cornerLabel)) {
            pushUniqueBox(markers, segment.start, segment.end);
          }
        }
      } else {
        for (const segment of mapData.layout) {
          if (lower(segment.label).includes("corner")) {
            pushUniqueBox(markers, segment.start, segment.end);
          }
        }
      }
    }

    if (condition.includes("straight")) {
      for (const segment of mapData.layout) {
        if (lower(segment.label).includes("straight")) {
          pushUniqueBox(markers, segment.start, segment.end);
        }
      }
    }

    if (condition.includes("opening leg") || condition.includes("early leg")) {
      for (const segment of mapData.zones) {
        if (lower(segment.label).includes("opening") || lower(segment.label).includes("early")) {
          pushUniqueBox(markers, segment.start, segment.end);
        }
      }
    }

    if (condition.includes("middle leg") || condition.includes("mid leg")) {
      for (const segment of mapData.zones) {
        if (lower(segment.label).includes("middle") || lower(segment.label).includes("mid")) {
          pushUniqueBox(markers, segment.start, segment.end);
        }
      }
    }

    if (condition.includes("final leg") || condition.includes("late leg")) {
      for (const segment of mapData.zones) {
        if (lower(segment.label).includes("final") || lower(segment.label).includes("late")) {
          pushUniqueBox(markers, segment.start, segment.end);
        }
      }
    }

    if (condition.includes("last spurt")) {
      for (const segment of mapData.zones) {
        if (lower(segment.label).includes("spurt")) {
          pushUniqueBox(markers, segment.start, segment.end);
        }
      }
    }

    if (condition.includes("uphill")) {
      for (const segment of mapData.elevation) {
        if (segment.type === "uphill" || lower(segment.label).includes("uphill")) {
          pushUniqueBox(markers, segment.start, segment.end);
        }
      }
    }

    if (condition.includes("downhill")) {
      for (const segment of mapData.elevation) {
        if (segment.type === "downhill" || lower(segment.label).includes("downhill")) {
          pushUniqueBox(markers, segment.start, segment.end);
        }
      }
    }

    const remainingMatch = condition.match(/(\d+)\s*m(?:eters?)?\s*remaining/);
    if (remainingMatch) {
      const remaining = Number(remainingMatch[1]);
      if (Number.isFinite(remaining)) {
        pushUniqueLine(markers, mapData.length - remaining);
      }
    }

    const afterMatch = condition.match(/after\s*(\d+)\s*m(?:eters?)?/);
    if (afterMatch) {
      const afterMeters = Number(afterMatch[1]);
      if (Number.isFinite(afterMeters)) {
        pushUniqueLine(markers, afterMeters);
      }
    }
  }

  return markers;
}

export function resolveSkillActivationOverlay(skill, cm, mapData) {
  if (!skill || !mapData) {
    return { shouldShowChart: false, markers: [], doesNotWork: false, reasons: [] };
  }

  const activationMap = skill.activation_map;
  const explicitRequirements = requirementsFromActivationMap(activationMap);
  const fallbackRequirements = inferTextTrackRequirements(skill);
  const requirements = explicitRequirements ?? fallbackRequirements;
  const compatibility = evaluateTrackCompatibility(cm?.track, requirements);

  const explicitMarkers = markersFromActivationMap(skill, mapData);
  const markers = explicitMarkers.length > 0 ? explicitMarkers : inferSkillMarkers(skill, mapData);
  const hasActivationWindow = markers.length > 0;

  const explicitShow = activationMap?.show_chart;
  if (compatibility.doesNotWork) {
    if (!hasActivationWindow) {
      // Passive/always-on or non-spatial skills should not show map warnings.
      return {
        shouldShowChart: false,
        markers: [],
        doesNotWork: false,
        reasons: [],
        usedActivationMap: Boolean(activationMap),
      };
    }
    return {
      shouldShowChart: true,
      markers: [],
      doesNotWork: true,
      reasons: compatibility.reasons,
      usedActivationMap: Boolean(activationMap),
    };
  }

  const shouldShowChart = explicitShow === false ? false : explicitShow === true ? true : hasActivationWindow;
  return {
    shouldShowChart,
    markers,
    doesNotWork: false,
    reasons: [],
    usedActivationMap: Boolean(activationMap),
  };
}

export function buildSkillMapCacheKey({ cmNumber, skillId, mapData, markers }) {
  const payload = {
    cm: String(cmNumber ?? ""),
    skill: String(skillId ?? ""),
    map: mapData,
    markers,
  };
  return crypto.createHash("sha1").update(JSON.stringify(payload)).digest("hex").slice(0, 16);
}

export async function ensureDirectory(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}

export function resolveSkillMapOutputPath(projectRoot, fileName) {
  return path.join(projectRoot, "assets", "generated", "skill-maps", fileName);
}
