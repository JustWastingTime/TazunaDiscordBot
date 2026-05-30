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

function collectSkillConditionText(skill) {
  const sources = [];

  if (Array.isArray(skill.preconditions)) sources.push(...skill.preconditions);
  if (Array.isArray(skill.effect)) {
    for (const effect of skill.effect) {
      if (Array.isArray(effect.conditions)) sources.push(...effect.conditions);
      if (effect.description) sources.push(effect.description);
    }
  }
  if (skill.description) sources.push(skill.description);

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

export function inferSkillMarkers(skill, mapData) {
  if (!skill || !mapData) return [];

  const conditions = collectSkillConditionText(skill);
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
