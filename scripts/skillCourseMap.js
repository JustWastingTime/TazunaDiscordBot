import path from "path";
import crypto from "crypto";
import fs from "fs/promises";
import { MAP_COLORS } from "./courseMapRenderer.js";

function toMeters(distanceValue) {
  if (typeof distanceValue === "number") return distanceValue;
  const parsed = parseInt(String(distanceValue ?? "").replace(/[^\d]/g, ""), 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function inferDistanceTypeFromMeters(distanceValue) {
  const meters = toMeters(distanceValue);
  if (!meters || meters <= 0) return null;
  if (meters <= 1400) return "Sprint";
  if (meters <= 1800) return "Mile";
  if (meters <= 2400) return "Medium";
  return "Long";
}

function extractUnixTimestamp(value) {
  const match = String(value ?? "").match(/<t:(\d+):/);
  if (!match) return null;
  return Number(match[1]);
}

function extractUnixTimestamps(value) {
  const matches = String(value ?? "").matchAll(/<t:(\d+):/g);
  const list = [];
  for (const m of matches) {
    const n = Number(m[1]);
    if (Number.isFinite(n)) list.push(n);
  }
  return list;
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
    .map((cm) => {
      const stamps = extractUnixTimestamps(cm.date);
      if (stamps.length === 0) return null;
      const start = Math.min(...stamps);
      const end = Math.max(...stamps);
      return { cm, start, end };
    })
    .filter(Boolean)
    .sort((a, b) => a.start - b.start);

  if (withTs.length > 0) {
    // 1) A CM whose date range currently contains "now" is the active one.
    const running = withTs.find((item) => item.start <= nowSec && nowSec <= item.end);
    if (running) return running.cm;

    // 2) Otherwise the next CM that hasn't started yet.
    const upcoming = withTs.find((item) => item.start >= nowSec);
    if (upcoming) return upcoming.cm;

    // 3) Otherwise the most recently started CM (latest in the past).
    return withTs[withTs.length - 1].cm;
  }

  return champsmeets[champsmeets.length - 1] ?? null;
}

function resolveMapName(cm, rawMap, length) {
  if (rawMap?.name) return rawMap.name;
  const racetrack = cm?.track?.racetrack ?? rawMap?.racetrack ?? "Course";
  const terrain = cm?.track?.terrain ?? rawMap?.terrain ?? "";
  const direction = normalizeDirection(cm?.track?.direction ?? rawMap?.direction);
  return `${racetrack} ${terrain} ${length}m (${direction})`.trim();
}

function withDefaultSegmentColor(segment, rowKey) {
  const label = lower(segment?.label);
  if (rowKey === "layout") {
    if (!label) return { ...segment, color: MAP_COLORS.layoutBlank };
    if (label.includes("corner")) return { ...segment, color: MAP_COLORS.layoutCorner };
    return { ...segment, color: MAP_COLORS.layoutStraight };
  }
  if (segment?.color) return segment;
  if (rowKey === "elevation") {
    const type = lower(segment?.type);
    if (type.includes("uphill") || label.includes("uphill")) return { ...segment, color: MAP_COLORS.elevationUphill };
    if (type.includes("downhill") || label.includes("downhill")) return { ...segment, color: MAP_COLORS.elevationDownhill };
    return { ...segment, color: MAP_COLORS.elevationFlat };
  }
  if (rowKey === "zones") {
    if (label.includes("spurt")) return { ...segment, color: MAP_COLORS.zoneSpurt };
    if (label.includes("early")) return { ...segment, color: MAP_COLORS.zoneEarly };
    if (label.includes("mid")) return { ...segment, color: MAP_COLORS.zoneMid };
    if (label.includes("late")) return { ...segment, color: MAP_COLORS.zoneLate };
    return { ...segment, color: MAP_COLORS.zoneFallback };
  }
  return segment;
}

function normalizeSegments(segments, rowKey) {
  return Array.isArray(segments)
    ? segments
        .map((segment) => withDefaultSegmentColor({
          ...segment,
          start: Number(segment.start),
          end: Number(segment.end),
        }, rowKey))
        .filter((segment) => Number.isFinite(segment.start) && Number.isFinite(segment.end) && segment.end > segment.start)
    : [];
}

function normalizeStatThresholds(rawMap) {
  const source =
    rawMap?.stat_thresholds ??
    rawMap?.statThresholds ??
    rawMap?.stat_tresholds ??
    rawMap?.stat_treshold ??
    rawMap?.stat_threshold ??
    "";

  if (Array.isArray(source)) {
    return source.map((v) => String(v).trim()).filter(Boolean);
  }

  const text = String(source ?? "").trim();
  if (!text) return [];
  return text
    .split(/(?:\s*&\s*|\s*,\s*|\s*\/\s*|\s+\+\s+)/g)
    .map((v) => v.trim())
    .filter(Boolean);
}

export function resolveMapSource(cm, mapsCatalog) {
  const mapRef = cm?.map_id ?? cm?.mapId ?? cm?.map_ref ?? cm?.mapRef
    ?? (typeof cm?.map === "string" ? cm.map : null);
  if (mapRef) {
    const ref = lower(mapRef);
    if (Array.isArray(mapsCatalog)) {
      const found = mapsCatalog.find((map) => {
        if (!map || typeof map !== "object") return false;
        return (
          lower(map.id) === ref ||
          lower(map.map_id) === ref ||
          lower(map.slug) === ref ||
          lower(map.name) === ref
        );
      });
      if (found) return found;
    }
  }
  if (cm?.map && typeof cm.map === "object") return cm.map;
  return null;
}

function normalizeDistancePoints(points, length) {
  const values = Array.isArray(points) ? points : [points];
  return [...new Set(
    values
      .map((value) => Number(value))
      .filter((value) => Number.isFinite(value) && value >= 0 && value <= length)
  )].sort((a, b) => a - b);
}

export function getCourseMapDataFromMap(rawMap, contextCm = null) {
  if (!rawMap || typeof rawMap !== "object") return null;
  const length = toMeters(contextCm?.track?.distance_meters ?? rawMap.distance_meters);
  if (!length || length <= 0) return null;

  const elevation = normalizeSegments(rawMap.elevation, "elevation");
  const layout = normalizeSegments(rawMap.layout, "layout");
  const zones = normalizeSegments(rawMap.zones, "zones");
  const positionKeepEnds = normalizeDistancePoints(
    rawMap.position_keep_ends ?? rawMap.positionKeepEnds ?? rawMap.position_keep_end,
    length
  );
  const statThresholds = normalizeStatThresholds(rawMap);
  const elevationScale = Number(
    rawMap?.elevation_scale ??
    rawMap?.elevationScale ??
    rawMap?.elevation_range ??
    rawMap?.elevationRange
  );
  if (!elevation.length || !layout.length || !zones.length) return null;

  return {
    name: resolveMapName(contextCm, rawMap, length),
    length,
    elevation,
    layout,
    zones,
    positionKeepEnds,
    statThresholds,
    elevationScale: Number.isFinite(elevationScale) && elevationScale > 0 ? elevationScale : null,
  };
}

export function getCourseMapDataFromCm(cm, mapsCatalog = []) {
  const rawMap = resolveMapSource(cm, mapsCatalog);
  if (!rawMap) return null;
  return getCourseMapDataFromMap(rawMap, cm);
}

function slugifyMapKey(value) {
  return lower(value).replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function mapChoiceKey(map) {
  return map?.id ?? map?.slug ?? map?.map_id ?? slugifyMapKey(map?.name);
}

function mapSearchHaystack(map) {
  return [
    map?.name,
    map?.racetrack,
    map?.direction,
    map?.terrain,
    map?.distance_meters,
    mapChoiceKey(map),
  ].filter(Boolean).join(" ").toLowerCase();
}

function findMapInCatalog(key, mapsCatalog = []) {
  if (!Array.isArray(mapsCatalog) || !key) return null;
  const ref = lower(String(key).trim());
  const exact = mapsCatalog.find((map) => {
    if (!map || typeof map !== "object") return false;
    return [map.id, map.slug, map.map_id, map.name, mapChoiceKey(map)]
      .filter(Boolean)
      .some((candidate) => lower(candidate) === ref);
  });
  if (exact) return exact;

  const terms = ref.split(/\s+/).filter(Boolean);
  if (!terms.length) return null;
  const matches = mapsCatalog.filter((map) => {
    if (!map) return false;
    const hay = mapSearchHaystack(map);
    return terms.every((term) => hay.includes(term));
  });
  if (matches.length === 1) return matches[0];
  return matches.find((map) => lower(map.name) === ref) ?? null;
}

function resolveCustomRaceMapSource(race, mapsCatalog = []) {
  if (!race || typeof race !== "object") return null;
  if (race.map && typeof race.map === "object") return race.map;
  const mapRef = race.map_id ?? race.mapId ?? race.map_ref ?? race.mapRef;
  if (mapRef) return findMapInCatalog(mapRef, mapsCatalog);
  if (Array.isArray(race.elevation) && Array.isArray(race.layout) && Array.isArray(race.zones)) {
    return race;
  }
  return null;
}

function buildMapContextFromRawMap(rawMap, label = null, trackOverlay = null) {
  return {
    name: label ?? rawMap?.name ?? "Course",
    track: {
      racetrack: rawMap?.racetrack,
      direction: rawMap?.direction,
      terrain: rawMap?.terrain,
      distance_meters: rawMap?.distance_meters,
      distance_type: rawMap?.distance_type ?? inferDistanceTypeFromMeters(rawMap?.distance_meters),
      ground: rawMap?.ground,
      season: rawMap?.season,
      weather: rawMap?.weather,
      ...(trackOverlay ?? {}),
    },
  };
}

function resolveMapOverrideExact(rawValue, mapsCatalog = [], customRacesCatalog = []) {
  const value = String(rawValue ?? "").trim();
  if (!value) return null;

  if (value.toLowerCase().startsWith("custom:")) {
    const customId = value.slice(7).trim().toLowerCase();
    const race = (customRacesCatalog ?? []).find((entry) => {
      if (!entry) return false;
      return [entry.id, entry.slug, slugifyMapKey(entry.name)]
        .filter(Boolean)
        .some((candidate) => lower(candidate) === customId);
    });
    if (!race) return null;
    return toCatalogEntryFromCustomRace(race, mapsCatalog);
  }

  const mapKey = value.toLowerCase().startsWith("map:") ? value.slice(4).trim() : value;
  const map = findMapInCatalog(mapKey, mapsCatalog);
  if (!map) return null;
  return toCatalogEntryFromMap(map);
}

function searchMapCatalogByTerms(terms, mapsCatalog = [], customRacesCatalog = []) {
  const matches = [];
  const seen = new Set();

  for (const map of mapsCatalog ?? []) {
    if (!map?.name || !getCourseMapDataFromMap(map)) continue;
    const hay = mapSearchHaystack(map);
    if (!terms.every((term) => hay.includes(term))) continue;
    const entry = toCatalogEntryFromMap(map);
    if (seen.has(entry.key)) continue;
    seen.add(entry.key);
    matches.push(entry);
  }

  for (const race of customRacesCatalog ?? []) {
    const entry = toCatalogEntryFromCustomRace(race, mapsCatalog);
    if (!entry) continue;
    const searchText = [
      entry.label,
      race.host,
      race.description,
      mapSearchHaystack(entry.rawMap),
    ].filter(Boolean).join(" ").toLowerCase();
    if (!terms.every((term) => searchText.includes(term))) continue;
    if (seen.has(entry.key)) continue;
    seen.add(entry.key);
    matches.push(entry);
  }

  matches.sort((a, b) => a.label.localeCompare(b.label));
  return matches;
}

export function resolveMapOverride(rawValue, mapsCatalog = [], customRacesCatalog = []) {
  const exact = resolveMapOverrideExact(rawValue, mapsCatalog, customRacesCatalog);
  if (exact) return exact;

  const value = String(rawValue ?? "").trim();
  if (!value || value.toLowerCase().startsWith("custom:")) return null;

  const mapKey = value.toLowerCase().startsWith("map:") ? value.slice(4).trim() : value;
  const terms = mapKey.toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return null;

  const matches = searchMapCatalogByTerms(terms, mapsCatalog, customRacesCatalog);
  return matches.length === 1 ? matches[0] : null;
}

export function resolveMapOverrideSelection(rawValue, mapsCatalog = [], customRacesCatalog = []) {
  const value = String(rawValue ?? "").trim();
  if (!value) return { entry: null, candidates: [], query: null };

  const lowered = value.toLowerCase();
  if (lowered.startsWith("custom:") || lowered.startsWith("map:")) {
    const entry = resolveMapOverrideExact(value, mapsCatalog, customRacesCatalog);
    return { entry, candidates: [], query: null };
  }

  const exact = resolveMapOverrideExact(value, mapsCatalog, customRacesCatalog);
  if (exact) return { entry: exact, candidates: [], query: null };

  const terms = value.toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return { entry: null, candidates: [], query: value };

  const candidates = searchMapCatalogByTerms(terms, mapsCatalog, customRacesCatalog);
  if (candidates.length === 0) return { entry: null, candidates: [], query: value };
  if (candidates.length === 1) return { entry: candidates[0], candidates: [], query: null };
  return { entry: candidates[0], candidates, query: value };
}

export function buildMapOverrideAutocompleteChoices(query, mapsCatalog = [], customRacesCatalog = []) {
  const terms = String(query ?? "").trim().toLowerCase().split(/\s+/).filter(Boolean);
  const entries = [];

  for (const map of mapsCatalog ?? []) {
    if (!map?.name || !getCourseMapDataFromMap(map)) continue;
    const searchText = mapSearchHaystack(map);
    if (terms.length && !terms.every((term) => searchText.includes(term))) continue;
    entries.push({
      name: map.name,
      value: `map:${mapChoiceKey(map)}`,
      sortKey: `0:${map.name}`,
    });
  }

  for (const race of customRacesCatalog ?? []) {
    const rawMap = resolveCustomRaceMapSource(race, mapsCatalog);
    if (!rawMap || !getCourseMapDataFromMap(rawMap)) continue;
    const label = race.name ?? rawMap.name ?? "Custom Race";
    const searchText = [
      label,
      race.host,
      race.description,
      rawMap.name,
      rawMap.racetrack,
    ].filter(Boolean).join(" ").toLowerCase();
    if (terms.length && !terms.every((term) => searchText.includes(term))) continue;
    entries.push({
      name: `[Custom] ${label}`,
      value: `custom:${race.id ?? slugifyMapKey(label)}`,
      sortKey: `1:${label}`,
    });
  }

  entries.sort((a, b) => a.sortKey.localeCompare(b.sortKey));
  return entries.slice(0, 25).map(({ name, value }) => ({
    name: name.length > 100 ? `${name.slice(0, 97)}...` : name,
    value: value.length > 100 ? value.slice(0, 100) : value,
  }));
}

function toCatalogEntryFromMap(map) {
  return {
    source: "map",
    key: `map:${mapChoiceKey(map)}`,
    label: map.name ?? "Course Map",
    rawMap: map,
    context: buildMapContextFromRawMap(map),
    customRace: null,
  };
}

function toCatalogEntryFromCustomRace(race, mapsCatalog = []) {
  const rawMap = resolveCustomRaceMapSource(race, mapsCatalog);
  if (!rawMap) return null;
  return {
    source: "custom",
    key: `custom:${race.id ?? slugifyMapKey(race.name)}`,
    label: race.name ?? rawMap.name ?? "Custom Race",
    rawMap,
    context: buildMapContextFromRawMap(rawMap, race.name, race.track),
    customRace: race,
  };
}

export function resolveMapCatalogMatches(rawValue, mapsCatalog = [], customRacesCatalog = []) {
  const value = String(rawValue ?? "").trim();
  if (!value) return [];

  const exact = resolveMapOverrideExact(value, mapsCatalog, customRacesCatalog);
  if (exact) return [exact];

  const mapKey = value.toLowerCase().startsWith("map:") ? value.slice(4).trim() : value;
  const terms = mapKey.toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return [];

  return searchMapCatalogByTerms(terms, mapsCatalog, customRacesCatalog);
}

export const buildMapCatalogAutocompleteChoices = buildMapOverrideAutocompleteChoices;

// Returns the Champions Meets that can be offered in the skill map dropdown:
// those that have renderable map data and whose number falls within the
// [fromCmNumber, maxCmNumber] window. Sorted ascending by CM number.
export function getSelectableChampionsMeets(champsmeets, { fromCmNumber = 0, maxCmNumber = Infinity, mapsCatalog = [] } = {}) {
  if (!Array.isArray(champsmeets)) return [];
  return champsmeets
    .filter((cm) => {
      const num = Number(cm?.number);
      if (!Number.isFinite(num)) return false;
      if (num < fromCmNumber || num > maxCmNumber) return false;
      return !!getCourseMapDataFromCm(cm, mapsCatalog);
    })
    .sort((a, b) => Number(a.number) - Number(b.number));
}

function lower(value) {
  return String(value ?? "").toLowerCase();
}

function isLayoutCornerSegment(segment) {
  return lower(segment?.label).includes("corner");
}

function isUphillSegment(segment) {
  const label = lower(segment?.label);
  const type = lower(segment?.type);
  return type === "uphill" || label.includes("uphill");
}

function layoutSegmentMatches(segment, match) {
  const normalizedMatch = lower(match);
  if (!normalizedMatch) return true;
  if (normalizedMatch === "not_a_corner" || normalizedMatch === "not_corner" || normalizedMatch === "not corner") {
    return !isLayoutCornerSegment(segment);
  }
  if (normalizedMatch === "not_uphill" || normalizedMatch === "not uphill" || normalizedMatch === "not_an_uphill" || normalizedMatch === "not an uphill") {
    return !isUphillSegment(segment);
  }
  if (normalizedMatch === "uphill") return isUphillSegment(segment);
  return lower(segment?.label).includes(normalizedMatch);
}

function flattenConditionSources(values, out = []) {
  for (const value of values ?? []) {
    if (Array.isArray(value)) flattenConditionSources(value, out);
    else if (value != null && value !== "") out.push(value);
  }
  return out;
}

function collectSkillConditionText(skill, includeDescriptions = false) {
  const sources = [];

  if (Array.isArray(skill.preconditions)) sources.push(...flattenConditionSources(skill.preconditions));
  if (Array.isArray(skill.effect)) {
    for (const effect of skill.effect) {
      if (Array.isArray(effect.preconditions)) sources.push(...flattenConditionSources(effect.preconditions));
      if (Array.isArray(effect.conditions)) sources.push(...effect.conditions);
      if (includeDescriptions && effect.description) sources.push(effect.description);
    }
  }
  if (includeDescriptions && skill.description) sources.push(skill.description);

  return sources.map((v) => lower(v)).filter(Boolean);
}

function unionNumbers(left, right) {
  return [...new Set([...(left ?? []), ...(right ?? [])])].filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
}

function pushUniqueBox(markers, start, end, color = "#d11f2a", triggerBehavior, meta = {}) {
  const exists = markers.find(
    (m) =>
      m.type === "box" &&
      m.start === start &&
      m.end === end &&
      (m.color ?? "#d11f2a") === (color ?? "#d11f2a") &&
      (m.trigger_behavior ?? "") === (triggerBehavior ?? "")
  );
  if (exists) {
    exists.effects = unionNumbers(exists.effects, meta.effects);
    exists.requires = unionNumbers(exists.requires, meta.requires);
    if (meta.preconditionForAll) exists.preconditionForAll = true;
    if (meta.requireActivation) exists.requireActivation = true;
    return;
  }
  const marker = { type: "box", start, end, color, fillOpacity: 0.16 };
  if (triggerBehavior) marker.trigger_behavior = triggerBehavior;
  if (meta.effects?.length) marker.effects = [...meta.effects];
  if (meta.requires?.length) marker.requires = [...meta.requires];
  if (meta.preconditionForAll) marker.preconditionForAll = true;
  if (meta.requireActivation) marker.requireActivation = true;
  markers.push(marker);
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
  return inferPhaseWindowFromTexts(texts, mapData);
}

function inferPhaseWindowFromTexts(texts, mapData) {
  if (!texts.length) return null;

  const earlyZone = findZoneByLabel(mapData, ["opening", "early"]);
  const midZone = findZoneByLabel(mapData, ["middle", "mid"]);
  const lateZone = findZoneByLabel(mapData, ["late", "final"]);
  const spurtZone = findZoneByLabel(mapData, ["spurt"]);
  const cornerSegments = (mapData.layout ?? []).filter((segment) => lower(segment.label).includes("corner"));
  const finalCorner = cornerSegments.length ? cornerSegments[cornerSegments.length - 1] : null;

  // "Final corner and beyond" + "Late race and beyond" => intersection of both windows.
  const hasFinalCornerBeyond = texts.some((t) => t.includes("final corner and beyond"));
  const hasLateAndBeyond = texts.some((t) => t.includes("late race and beyond"));
  if (hasFinalCornerBeyond && hasLateAndBeyond) {
    return resolvePhaseClipFromSpec(mapData, ["final_corner_and_beyond", "late_and_beyond"]);
  }

  // "Final corner and beyond" means from start of last corner to race end.
  if (hasFinalCornerBeyond) {
    const start = finalCorner?.start ?? (lateZone?.start ?? mapData.length * 0.75);
    return { start, end: mapData.length, forceFullRange: true };
  }

  // "Late race and beyond" means from late-race start to race end.
  if (hasLateAndBeyond) {
    const start = lateZone?.start ?? spurtZone?.start ?? mapData.length * 0.75;
    return { start, end: mapData.length };
  }

  // "Mid race and beyond" means from mid-race start to race end.
  if (texts.some((t) => t.includes("mid race and beyond"))) {
    const start = midZone?.start ?? mapData.length * 0.5;
    return { start, end: mapData.length };
  }

  if (texts.some((t) => t.includes("last spurt")) || texts.some((t) => t.includes("spurt mode"))) {
    const start = lateZone?.start ?? (spurtZone?.start ?? mapData.length * 0.75);
    return { start, end: mapData.length };
  }

  if (texts.some((t) => t.includes("second half of the race"))) {
    return { start: mapData.length * 0.5, end: mapData.length };
  }

  if (texts.some((t) => t.includes("early race or mid race"))) {
    if (earlyZone && midZone) return { start: earlyZone.start, end: midZone.end };
    if (earlyZone) return { start: earlyZone.start, end: earlyZone.end };
    if (midZone) return { start: midZone.start, end: midZone.end };
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

function inferMarkersFromConditionSet(conditionTexts, mapData) {
  const texts = (conditionTexts ?? []).map((t) => lower(t)).filter(Boolean);
  if (!texts.length) return [];

  const markers = [];
  const phaseWindow = inferPhaseWindowFromTexts(texts, mapData);
  const clipStart = phaseWindow?.start ?? 0;
  const clipEnd = phaseWindow?.end ?? mapData.length;
  const triggerBehavior = texts.some((t) => t.includes("random point")) ? "random" : "asap";

  const addClippedBox = (start, end) => {
    const clippedStart = Math.max(start, clipStart);
    const clippedEnd = Math.min(end, clipEnd);
    if (clippedEnd > clippedStart) {
      pushUniqueBox(markers, clippedStart, clippedEnd, "#d11f2a", triggerBehavior);
    }
  };

  const cornerSegments = (mapData.layout ?? []).filter((s) => lower(s.label).includes("corner"));
  const straightSegments = (mapData.layout ?? []).filter((s) => lower(s.label).includes("straight"));
  const finalCorner = cornerSegments.length ? cornerSegments[cornerSegments.length - 1] : null;
  const finalStraight = straightSegments.length ? straightSegments[straightSegments.length - 1] : null;

  const mentionsCorner = texts.some((t) => t.includes("corner"));
  const mentionsFinalCorner = texts.some((t) => t.includes("final corner"));
  const mentionsNotFinalCorner = texts.some((t) => t.includes("not final corner"));
  const mentionsNotACorner = texts.some((t) => t.includes("not a corner"));
  const mentionsStraight = texts.some((t) => t.includes("straight"));
  const mentionsFinalStraight = texts.some((t) => t.includes("final straight"));

  if (phaseWindow?.forceFullRange && (mentionsCorner || mentionsStraight || mentionsNotACorner)) {
    addClippedBox(clipStart, clipEnd);
  } else {
    if (mentionsCorner) {
      let selected = cornerSegments;
      if (mentionsFinalCorner && !mentionsNotFinalCorner) {
        selected = finalCorner ? [finalCorner] : [];
      }
      if (mentionsNotFinalCorner && selected.length > 0) {
        selected = selected.slice(0, Math.max(0, selected.length - 1));
      }
      for (const segment of selected) addClippedBox(segment.start, segment.end);
    }

    if (mentionsNotACorner) {
      const notCornerSegments = (mapData.layout ?? []).filter((s) => !isLayoutCornerSegment(s));
      for (const segment of notCornerSegments) addClippedBox(segment.start, segment.end);
    } else if (mentionsStraight) {
      const selected = mentionsFinalStraight ? (finalStraight ? [finalStraight] : []) : straightSegments;
      for (const segment of selected) addClippedBox(segment.start, segment.end);
    }
  }

  for (const text of texts) {
    if (text.includes("opening leg") || text.includes("early leg")) {
      for (const segment of mapData.zones) {
        if (lower(segment.label).includes("opening") || lower(segment.label).includes("early")) {
          addClippedBox(segment.start, segment.end);
        }
      }
    }
    if (text.includes("middle leg") || text.includes("mid leg")) {
      for (const segment of mapData.zones) {
        if (lower(segment.label).includes("middle") || lower(segment.label).includes("mid")) {
          addClippedBox(segment.start, segment.end);
        }
      }
    }
    if (text.includes("final leg") || text.includes("late leg") || text.includes("late race")) {
      for (const segment of mapData.zones) {
        if (lower(segment.label).includes("final") || lower(segment.label).includes("late")) {
          addClippedBox(segment.start, segment.end);
        }
      }
    }
    if (text.includes("last spurt")) {
      for (const segment of mapData.zones) {
        if (lower(segment.label).includes("spurt")) {
          addClippedBox(segment.start, segment.end);
        }
      }
    }
    if (text.includes("uphill")) {
      for (const segment of mapData.elevation) {
        if (segment.type === "uphill" || lower(segment.label).includes("uphill")) {
          addClippedBox(segment.start, segment.end);
        }
      }
    }
    if (text.includes("downhill")) {
      for (const segment of mapData.elevation) {
        if (segment.type === "downhill" || lower(segment.label).includes("downhill")) {
          addClippedBox(segment.start, segment.end);
        }
      }
    }

    const remainingMatch = text.match(/(\d+)\s*m(?:eters?)?\s*remaining/);
    if (remainingMatch) {
      const remaining = Number(remainingMatch[1]);
      if (Number.isFinite(remaining)) pushUniqueLine(markers, mapData.length - remaining);
    }

    const afterMatch = text.match(/after\s*(\d+)\s*m(?:eters?)?/);
    if (afterMatch) {
      const afterMeters = Number(afterMatch[1]);
      if (Number.isFinite(afterMeters)) pushUniqueLine(markers, afterMeters);
    }
  }

  return markers;
}

function canonicalPhaseName(phaseName) {
  return lower(phaseName).replace(/[\s-]+/g, "_").replace(/_race(?=_|$)/g, "");
}

function phaseWindowFromName(mapData, phaseName) {
  const phase = canonicalPhaseName(phaseName);
  const earlyZone = findZoneByLabel(mapData, ["opening", "early"]);
  const midZone = findZoneByLabel(mapData, ["middle", "mid"]);
  const lateZone = findZoneByLabel(mapData, ["late", "final"]);
  const spurtZone = findZoneByLabel(mapData, ["spurt"]);
  const cornerSegments = (mapData.layout ?? []).filter((segment) => lower(segment.label).includes("corner"));
  const finalCorner = cornerSegments.length ? cornerSegments[cornerSegments.length - 1] : null;

  if (phase === "early") return earlyZone ? { start: earlyZone.start, end: earlyZone.end } : null;
  if (phase === "mid" || phase === "middle") return midZone ? { start: midZone.start, end: midZone.end } : null;
  if (phase === "late") return lateZone ? { start: lateZone.start, end: lateZone.end } : null;
  if (phase === "spurt") return spurtZone ? { start: spurtZone.start, end: spurtZone.end } : null;
  if (phase === "first_half") return { start: 0, end: mapData.length * 0.5 };
  if (phase === "late_and_beyond") {
    const start = lateZone?.start ?? spurtZone?.start ?? mapData.length * 0.75;
    return { start, end: mapData.length };
  }
  if (phase === "mid_and_beyond") {
    const start = midZone?.start ?? mapData.length * 0.5;
    return { start, end: mapData.length };
  }
  if (phase === "final_corner_and_beyond") {
    const start = finalCorner?.start ?? (lateZone?.start ?? mapData.length * 0.75);
    return { start, end: mapData.length };
  }
  if (phase === "second_half") return { start: mapData.length * 0.5, end: mapData.length };
  return null;
}

// Intersects one or more named phase windows (AND). Accepts a string or array of phase keys.
function resolvePhaseClipFromSpec(mapData, phaseSpec) {
  const names = Array.isArray(phaseSpec)
    ? phaseSpec
    : phaseSpec
      ? [phaseSpec]
      : [];
  if (!names.length) return null;

  let start = 0;
  let end = mapData.length;
  let matched = false;
  for (const name of names) {
    const window = phaseWindowFromName(mapData, name);
    if (!window) continue;
    matched = true;
    start = Math.max(start, window.start);
    end = Math.min(end, window.end);
  }
  if (!matched || end <= start) return null;
  return { start, end };
}

const TRIGGER_COURSE_GATES = [
  { keys: ["distance_types", "distanceTypes"], courseKey: "distanceType", reason: "distance type mismatch" },
  { keys: ["terrains", "terrain"], courseKey: "terrain", reason: "terrain mismatch" },
  { keys: ["directions", "direction"], courseKey: "direction", reason: "direction mismatch", normalize: normalizeDirection },
  { keys: ["racetracks", "racetrack"], courseKey: "racetrack", reason: "racetrack mismatch" },
  { keys: ["grounds", "ground"], courseKey: "ground", reason: "ground mismatch" },
  { keys: ["seasons", "season"], courseKey: "season", reason: "season mismatch" },
  { keys: ["weathers", "weather"], courseKey: "weather", reason: "weather mismatch" },
];

const TRIGGER_COURSE_EXCLUSIONS = [
  { keys: ["exclude_racetracks", "exclude_racetrack"], courseKey: "racetrack", reason: "racetrack mismatch" },
];

function triggerAllowList(trigger, gate) {
  for (const key of gate.keys) {
    const raw = trigger?.[key];
    const values = Array.isArray(raw) ? raw : typeof raw === "string" && raw.trim() ? [raw] : null;
    if (!values || values.length === 0) continue;
    return new Set(values.map((value) => {
      const normalized = gate.normalize ? gate.normalize(value) : value;
      return lower(normalized);
    }));
  }
  return null;
}

function triggerHasCourseGate(trigger) {
  return TRIGGER_COURSE_GATES.some((gate) => triggerAllowList(trigger, gate))
    || TRIGGER_COURSE_EXCLUSIONS.some((gate) => triggerAllowList(trigger, gate));
}

function triggerCourseMismatches(trigger, course) {
  const reasons = [];
  for (const gate of TRIGGER_COURSE_GATES) {
    const allowed = triggerAllowList(trigger, gate);
    if (!allowed) continue;
    const raw = course?.[gate.courseKey];
    const value = lower(gate.normalize ? gate.normalize(raw) : raw);
    if (!value || !allowed.has(value)) reasons.push(gate.reason);
  }
  for (const gate of TRIGGER_COURSE_EXCLUSIONS) {
    const blocked = triggerAllowList(trigger, gate);
    if (!blocked) continue;
    const raw = course?.[gate.courseKey];
    const value = lower(gate.normalize ? gate.normalize(raw) : raw);
    if (value && blocked.has(value)) reasons.push(gate.reason);
  }
  return reasons;
}

function triggerMatchesCourse(trigger, course) {
  return triggerCourseMismatches(trigger, course).length === 0;
}

function courseContextFromCm(cm) {
  return {
    distanceType: lower(cm?.track?.distance_type ?? inferDistanceTypeFromMeters(cm?.track?.distance_meters)),
    terrain: lower(cm?.track?.terrain),
    direction: lower(normalizeDirection(cm?.track?.direction)),
    racetrack: lower(cm?.track?.racetrack),
    ground: lower(cm?.track?.ground),
    season: lower(cm?.track?.season),
    weather: lower(cm?.track?.weather),
  };
}

function evaluateTrackCompatibility(cmTrack, requirements) {
  if (!requirements) return { doesNotWork: false, reasons: [] };

  const track = {
    terrain: lower(cmTrack?.terrain),
    direction: normalizeDirection(cmTrack?.direction),
    racetrack: lower(cmTrack?.racetrack),
    ground: lower(cmTrack?.ground),
    season: lower(cmTrack?.season),
    weather: lower(cmTrack?.weather),
  };

  const reasons = [];
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

function triggerBehaviorName(trigger) {
  return lower(trigger?.trigger_behavior ?? trigger?.behavior);
}

function isPreconditionTrigger(trigger) {
  return triggerBehaviorName(trigger) === "precondition";
}

function effectNumbersFrom(value) {
  const raw = Array.isArray(value) ? value : value == null || value === "" ? [] : [value];
  const numbers = raw.map((item) => Number(item)).filter((item) => Number.isFinite(item) && item > 0);
  return numbers.length ? numbers : null;
}

function activationEffectNumbers(trigger) {
  return effectNumbersFrom(trigger?.effect ?? trigger?.effects) ?? [];
}

function preconditionEffectNumbers(trigger) {
  const explicit = trigger?.effects ?? trigger?.for_effects ?? trigger?.for;
  if (explicit == null) return null;
  return effectNumbersFrom(explicit) ?? [];
}

function requiresEffectNumbers(trigger) {
  return effectNumbersFrom(trigger?.requires ?? trigger?.requires_effects) ?? [];
}

function prepareActivationTriggers(triggers, course) {
  const copies = triggers.map((trigger) => ({ ...trigger }));
  const explicitTaken = new Set();
  for (const trigger of copies) {
    if (isPreconditionTrigger(trigger)) continue;
    for (const number of activationEffectNumbers(trigger)) explicitTaken.add(number);
  }

  let auto = 1;
  const seen = new Set();
  const activationEffects = [];
  for (const trigger of copies) {
    if (isPreconditionTrigger(trigger)) continue;
    const explicit = activationEffectNumbers(trigger);
    if (explicit.length) {
      trigger._effects = explicit;
    } else {
      while (explicitTaken.has(auto)) auto += 1;
      trigger._effects = [auto];
      explicitTaken.add(auto);
      auto += 1;
    }
    trigger._requires = requiresEffectNumbers(trigger);
    for (const number of trigger._effects) {
      if (seen.has(number)) continue;
      seen.add(number);
      activationEffects.push(number);
    }
  }
  activationEffects.sort((a, b) => a - b);

  const hasActivation = copies.some((trigger) => !isPreconditionTrigger(trigger));
  for (const trigger of copies) {
    trigger._courseOk = !course || triggerMatchesCourse(trigger, course);
    if (!isPreconditionTrigger(trigger)) continue;
    const explicit = preconditionEffectNumbers(trigger);
    trigger._preconditionForAll = explicit == null;
    trigger._effects = explicit ?? [...activationEffects];
  }

  const activeEffects = new Set();
  for (const trigger of copies) {
    if (isPreconditionTrigger(trigger) || !trigger._courseOk) continue;
    for (const number of trigger._effects) activeEffects.add(number);
  }
  for (const trigger of copies) {
    if (!isPreconditionTrigger(trigger)) {
      trigger._active = trigger._courseOk;
      continue;
    }
    if (!hasActivation) {
      trigger._active = trigger._courseOk;
      continue;
    }
    const linkedActive = (trigger._effects ?? []).filter((number) => activeEffects.has(number));
    trigger._active = trigger._courseOk && linkedActive.length > 0;
    if (!trigger._preconditionForAll) trigger._effects = linkedActive;
  }

  const numberLabels = activationEffects.length > 1 || copies.some((trigger) => trigger._requires?.length);
  return { triggers: copies, activationEffects, numberLabels };
}

function addMissingPreconditionBoxes(markers, skill, mapData, prepared) {
  const covered = new Set();
  for (const trigger of prepared.triggers) {
    if (!isPreconditionTrigger(trigger)) continue;
    const numbers = trigger._preconditionForAll
      ? prepared.activationEffects
      : (preconditionEffectNumbers(trigger) ?? trigger._effects ?? []);
    for (const number of numbers) covered.add(number);
  }
  for (const number of prepared.activationEffects) {
    if (covered.has(number)) continue;
    const window = inferPhaseWindowFromTexts(effectPreconditionTexts(skill, number - 1), mapData);
    if (!window) continue;
    pushUniqueBox(markers, window.start, window.end, "#d9b84a", "precondition", { effects: [number] });
  }
}

function behaviorWord(behavior) {
  const name = lower(behavior);
  if (name === "asap") return "ASAP";
  if (name === "precondition") return "PRECONDITION";
  return "RANDOM";
}

function annotateActivationLabels(markers, { numberLabels, activationEffects }) {
  const all = new Set(activationEffects ?? []);
  for (const marker of markers) {
    if (marker.type !== "box") continue;
    const word = behaviorWord(marker.trigger_behavior);
    const effects = unionNumbers(marker.effects, []);
    const isPrecondition = lower(marker.trigger_behavior) === "precondition";
    const coversAll = isPrecondition && (
      marker.preconditionForAll
      || (all.size > 0 && effects.length === all.size && effects.every((number) => all.has(number)))
    );
    let label = word;
    if (numberLabels && effects.length && !coversAll) {
      label = `${word} ${effects.join(", ")}`;
    }
    if (marker.requires?.length) {
      label += ` (after ${marker.requires.join(", ")})`;
    }
    marker.label = label;
  }
}

function preconditionLines(value) {
  if (!Array.isArray(value) || !value.length) return [];
  const rows = value.every((entry) => Array.isArray(entry)) ? value.flat() : value;
  return rows.map((item) => lower(item)).filter(Boolean);
}

function effectPreconditionTexts(skill, effectIndex) {
  const effects = Array.isArray(skill?.effect) ? skill.effect : [];
  const effect = effects[effectIndex];
  if (Array.isArray(effect?.preconditions)) return preconditionLines(effect.preconditions);
  const shared = skill?.preconditions;
  if (!Array.isArray(shared) || !shared.length) return [];
  if (shared.length > 1 && shared.every((entry) => Array.isArray(entry))) {
    return preconditionLines(shared[effectIndex] ?? []);
  }
  return preconditionLines(shared);
}

function markersFromActivationMap(skill, mapData, options = {}) {
  const activationMap = skill?.activation_map;
  if (!activationMap || !Array.isArray(activationMap.triggers)) return [];

  const markers = [];
  const allowAutoPhaseInference = options.allowAutoPhaseInference !== false;
  const autoPhaseWindow = allowAutoPhaseInference ? inferAutoPhaseWindow(skill, mapData) : null;
  const prepared = prepareActivationTriggers(activationMap.triggers, options.course);
  const orderedTriggers = [...prepared.triggers].sort((a, b) => {
    const aPre = isPreconditionTrigger(a) ? 0 : 1;
    const bPre = isPreconditionTrigger(b) ? 0 : 1;
    if (aPre !== bPre) return aPre - bPre;
    const aEffect = Math.min(...(a._effects?.length ? a._effects : [Number.MAX_SAFE_INTEGER]));
    const bEffect = Math.min(...(b._effects?.length ? b._effects : [Number.MAX_SAFE_INTEGER]));
    return aEffect - bEffect;
  });
  addMissingPreconditionBoxes(markers, skill, mapData, prepared);
  for (const trigger of orderedTriggers) {
    if (!trigger._active) continue;
    if (trigger.requires_precondition === true) {
      const wanted = new Set(trigger._effects ?? []);
      const ready = markers.some((marker) =>
        marker.type === "box"
        && lower(marker.trigger_behavior) === "precondition"
        && (marker.effects ?? []).some((number) => wanted.has(number))
      );
      if (!ready) continue;
    }
    const unlessEffects = effectNumbersFrom(trigger.unless_effect ?? trigger.unless_effects) ?? [];
    if (unlessEffects.some((number) => markers.some((marker) =>
      marker.type === "box"
      && lower(marker.trigger_behavior) !== "precondition"
      && (marker.effects ?? []).includes(number)
    ))) {
      continue;
    }
    const color = trigger.color ?? "#d11f2a";
    if (trigger.type === "line") {
      if (Number.isFinite(Number(trigger.distance))) {
        pushUniqueLine(markers, Number(trigger.distance), color);
        continue;
      }

      const target = lower(trigger.target ?? "");
      const match = lower(trigger.match ?? "");
      const selectMode = lower(trigger.select ?? "");
      const linePosition = lower(trigger.line_position ?? trigger.position ?? "start");
      if (target === "layout" || target === "elevation" || target === "zones") {
        const source = target === "elevation" ? mapData.elevation : target === "zones" ? mapData.zones : mapData.layout;
        const matching = source.filter((segment) => layoutSegmentMatches(segment, match));
        const selected =
          selectMode === "last"
            ? (matching.length ? [matching[matching.length - 1]] : [])
            : selectMode === "first"
              ? (matching.length ? [matching[0]] : [])
              : matching;
        if (selected.length > 0) {
          const segment = selected[0];
          const distance = linePosition === "end" ? segment.end : segment.start;
          pushUniqueLine(markers, distance, color);
          continue;
        }
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
      const triggerBehavior = trigger.trigger_behavior ?? trigger.behavior;
      const boxMeta = {
        effects: trigger._effects,
        requires: trigger._requires,
        preconditionForAll: trigger._preconditionForAll,
        requireActivation: trigger.require_activation === true,
      };
      const ratioStart = Number(trigger.clip_start_ratio ?? trigger.start_ratio);
      const ratioEnd = Number(trigger.clip_end_ratio ?? trigger.end_ratio);
      const absoluteStart = Number(trigger.clip_start ?? trigger.start_m ?? trigger.range_start);
      const absoluteEnd = Number(trigger.clip_end ?? trigger.end_m ?? trigger.range_end);
      const remainingGte = Number(trigger.remaining_gte ?? trigger.min_remaining ?? trigger.remaining_min);
      const remainingLte = Number(trigger.remaining_lte ?? trigger.max_remaining ?? trigger.remaining_max);

      let clipStart = 0;
      let clipEnd = mapData.length;
      if (Number.isFinite(ratioStart)) clipStart = Math.max(0, ratioStart) * mapData.length;
      if (Number.isFinite(ratioEnd)) clipEnd = Math.min(1, ratioEnd) * mapData.length;
      if (Number.isFinite(absoluteStart)) clipStart = absoluteStart;
      if (Number.isFinite(absoluteEnd)) clipEnd = absoluteEnd;
      // Remaining-distance constraints are converted to absolute distance windows:
      // remaining >= X  => distance <= length - X
      // remaining <= Y  => distance >= length - Y
      if (Number.isFinite(remainingGte)) {
        clipEnd = Math.min(clipEnd, mapData.length - remainingGte);
      }
      if (Number.isFinite(remainingLte)) {
        clipStart = Math.max(clipStart, mapData.length - remainingLte);
      }
      const explicitPhaseWindow = resolvePhaseClipFromSpec(mapData, trigger.phases ?? trigger.phase);
      if (explicitPhaseWindow) {
        clipStart = Math.max(clipStart, explicitPhaseWindow.start);
        clipEnd = Math.min(clipEnd, explicitPhaseWindow.end);
      }
      const hasExplicitPhase = Boolean(trigger.phases ?? trigger.phase);
      const useAutoPhaseClip = !hasExplicitPhase && trigger.disable_auto_phase_clip !== true && trigger.apply_auto_phase_clip !== false;
      if (autoPhaseWindow && useAutoPhaseClip) {
        clipStart = Math.max(clipStart, autoPhaseWindow.start);
        clipEnd = Math.min(clipEnd, autoPhaseWindow.end);
      }
      // The effect can overlap its precondition, but it cannot start before that box.
      if (!isPreconditionTrigger(trigger) && trigger.after_precondition_start !== false) {
        const wanted = new Set(trigger._effects ?? []);
        const preconditionStarts = markers
          .filter((marker) => marker.type === "box" && lower(marker.trigger_behavior) === "precondition")
          .filter((marker) => (marker.effects ?? []).some((number) => wanted.has(number)))
          .map((marker) => marker.start);
        if (preconditionStarts.length) {
          clipStart = Math.max(clipStart, Math.min(...preconditionStarts));
        } else if (trigger.after_precondition_start === true) {
          continue;
        }
      }

      const pushClippedBox = (start, end) => {
        const clippedStart = Math.max(start, clipStart);
        const clippedEnd = Math.min(end, clipEnd);
        if (clippedEnd > clippedStart) {
          pushUniqueBox(markers, clippedStart, clippedEnd, color, triggerBehavior, boxMeta);
        }
      };

      const directRangeMode = lower(trigger.distance_mode ?? trigger.distanceMode ?? "absolute");
      const rawStart = Number(
        trigger.start ??
        trigger.start_m ??
        trigger.range_start ??
        trigger.value_start ??
        trigger.value_from ??
        trigger.remaining_start
      );
      const rawEnd = Number(
        trigger.end ??
        trigger.end_m ??
        trigger.range_end ??
        trigger.value_end ??
        trigger.value_to ??
        trigger.remaining_end ??
        trigger.value
      );
      const selectsSegments = Boolean(
        trigger.target || trigger.match || (Array.isArray(trigger.labels) && trigger.labels.length)
      );
      if (Number.isFinite(rawStart) && Number.isFinite(rawEnd)) {
        const startDistance = directRangeMode === "remaining" ? mapData.length - rawStart : rawStart;
        const endDistance = directRangeMode === "remaining" ? mapData.length - rawEnd : rawEnd;
        const normalizedStart = Math.min(startDistance, endDistance);
        const normalizedEnd = Math.max(startDistance, endDistance);
        if (!selectsSegments) {
          pushClippedBox(normalizedStart, normalizedEnd);
          continue;
        }
        clipStart = Math.max(clipStart, normalizedStart);
        clipEnd = Math.min(clipEnd, normalizedEnd);
        if (clipEnd <= clipStart) continue;
      }

      const target = lower(trigger.target ?? "layout");
      const source = target === "elevation" ? mapData.elevation : target === "zones" ? mapData.zones : mapData.layout;
      const match = lower(trigger.match ?? "");
      const labels = Array.isArray(trigger.labels) ? trigger.labels.map((v) => lower(v)) : [];
      const cornerNumbers = Array.isArray(trigger.corner_numbers) ? trigger.corner_numbers.map((v) => Number(v)) : [];
      const selectMode = lower(trigger.select ?? "");
      const excludeSelectMode = lower(trigger.exclude_select ?? "");
      const requireTags = Array.isArray(trigger.require_tags)
        ? trigger.require_tags.map((v) => lower(v))
        : (trigger.require_tag ? [lower(trigger.require_tag)] : []);
      const localStartRatio = Number(trigger.clip_within_segment_start_ratio ?? trigger.local_start_ratio);
      const localEndRatio = Number(trigger.clip_within_segment_end_ratio ?? trigger.local_end_ratio);
      const applyLocalClip = Number.isFinite(localStartRatio) || Number.isFinite(localEndRatio);

      const matchingSegments = [];
      for (const segment of source) {
        const label = lower(segment.label);
        let ok = false;

        if (match) ok = layoutSegmentMatches(segment, match);
        if (!ok && labels.length && labels.some((v) => label.includes(v))) ok = true;
        if (!ok && cornerNumbers.length && cornerNumbers.some((n) => label.includes(`corner ${n}`))) ok = true;
        if (!ok && !match && !labels.length && !cornerNumbers.length) ok = true;

        // Tag gate: segment must carry every required tag (e.g. "backstretch").
        if (ok && requireTags.length) {
          const segTags = Array.isArray(segment.tags) ? segment.tags.map((v) => lower(v)) : [];
          if (!requireTags.every((t) => segTags.includes(t))) ok = false;
        }

        if (ok) matchingSegments.push(segment);
      }

      const selectedSegments =
        selectMode === "last"
          ? (matchingSegments.length ? [matchingSegments[matchingSegments.length - 1]] : [])
          : selectMode === "first"
            ? (matchingSegments.length ? [matchingSegments[0]] : [])
            : matchingSegments;
      const filteredSegments =
        excludeSelectMode === "last"
          ? selectedSegments.slice(0, Math.max(0, selectedSegments.length - 1))
          : excludeSelectMode === "first"
            ? selectedSegments.slice(1)
            : selectedSegments;

      // When the trigger explicitly selects segments (match/labels/corner_numbers/
      // select), honor that selection precisely. The forceFullRange shortcut is
      // only for vague triggers that should fill the inferred phase window.
      const hasExplicitSelection = Boolean(
        match || labels.length || cornerNumbers.length || selectMode || excludeSelectMode || requireTags.length
      );

      // Phase-only triggers paint one continuous window instead of splitting per segment.
      // Local clip ratios apply within that phase window, not each layout segment.
      if (
        hasExplicitPhase &&
        !hasExplicitSelection &&
        !Number.isFinite(ratioStart) &&
        !Number.isFinite(ratioEnd) &&
        trigger.target == null
      ) {
        if (applyLocalClip) {
          const phaseLength = clipEnd - clipStart;
          const localStart = Number.isFinite(localStartRatio)
            ? clipStart + Math.max(0, localStartRatio) * phaseLength
            : clipStart;
          const localEnd = Number.isFinite(localEndRatio)
            ? clipStart + Math.min(1, localEndRatio) * phaseLength
            : clipEnd;
          pushClippedBox(localStart, localEnd);
        } else {
          pushClippedBox(clipStart, clipEnd);
        }
        continue;
      }

      if (autoPhaseWindow?.forceFullRange && filteredSegments.length > 0 && useAutoPhaseClip && !hasExplicitSelection) {
        pushUniqueBox(markers, clipStart, clipEnd, color, triggerBehavior, boxMeta);
        continue;
      }

      for (const segment of filteredSegments) {
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

  const activatedEffects = new Set();
  for (const marker of markers) {
    if (marker.type !== "box" || lower(marker.trigger_behavior) === "precondition") continue;
    for (const effect of marker.effects ?? []) activatedEffects.add(effect);
  }
  for (let index = markers.length - 1; index >= 0; index--) {
    const marker = markers[index];
    if (!marker.requireActivation) continue;
    const effects = marker.effects ?? [];
    if (!effects.some((effect) => activatedEffects.has(effect))) markers.splice(index, 1);
  }

  annotateActivationLabels(markers, prepared);
  return markers;
}

export function inferSkillMarkers(skill, mapData) {
  if (!skill || !mapData) return [];
  const markers = [];
  if (Array.isArray(skill.effect) && skill.effect.length > 0) {
    for (const effect of skill.effect) {
      const branchTexts = Array.isArray(effect?.conditions) ? effect.conditions : [];
      const branchMarkers = inferMarkersFromConditionSet(branchTexts, mapData);
      for (const marker of branchMarkers) {
        if (marker.type === "box") pushUniqueBox(markers, marker.start, marker.end, marker.color, marker.trigger_behavior);
        if (marker.type === "line") pushUniqueLine(markers, marker.distance, marker.color);
      }
    }
  } else {
    const fallbackTexts = collectSkillConditionText(skill, true);
    const fallbackMarkers = inferMarkersFromConditionSet(fallbackTexts, mapData);
    for (const marker of fallbackMarkers) {
      if (marker.type === "box") pushUniqueBox(markers, marker.start, marker.end, marker.color, marker.trigger_behavior);
      if (marker.type === "line") pushUniqueLine(markers, marker.distance, marker.color);
    }
  }

  return markers;
}

export function resolveSkillActivationOverlay(skill, cm, mapData) {
  if (!skill || !mapData) {
    return { shouldShowChart: false, markers: [], doesNotWork: false, reasons: [] };
  }

  const activationMap = skill.activation_map;
  const hasActivationMapConfig = Boolean(activationMap && typeof activationMap === "object");
  const fallbackRequirements = hasActivationMapConfig ? null : inferTextTrackRequirements(skill);
  const compatibility = evaluateTrackCompatibility(cm?.track, fallbackRequirements);

  const hasExplicitActivationMap = Boolean(activationMap && Array.isArray(activationMap.triggers));
  const course = courseContextFromCm(cm);
  const markerOptions = { allowAutoPhaseInference: false, course };
  const explicitMarkers = hasExplicitActivationMap
    ? markersFromActivationMap(skill, mapData, markerOptions)
    : [];
  const unfilteredMarkers = hasExplicitActivationMap
    ? markersFromActivationMap(skill, mapData, { allowAutoPhaseInference: false })
    : [];
  const triggers = hasExplicitActivationMap ? activationMap.triggers : [];
  const courseMismatches = [...new Set(triggers.flatMap((trigger) => triggerCourseMismatches(trigger, course)))];
  const hasCourseGate = triggers.some((trigger) => triggerHasCourseGate(trigger));
  const anyCourseMatch = triggers.some((trigger) => triggerMatchesCourse(trigger, course));
  const courseBlocked = hasCourseGate && !anyCourseMatch && unfilteredMarkers.length > 0;
  const markers = hasExplicitActivationMap
    ? explicitMarkers
    : hasActivationMapConfig
      ? []
      : inferSkillMarkers(skill, mapData);
  const rawConditionTexts = collectSkillConditionText(skill, false);
  const isRandomPointSkill = rawConditionTexts.some((text) => text.includes("random point"));
  const defaultBehavior = isRandomPointSkill ? "random" : "asap";
  const normalizedMarkers = markers.map((marker) => (
    marker.type === "box" && !marker.trigger_behavior
      ? { ...marker, trigger_behavior: defaultBehavior }
      : marker
  ));
  const hasActivationWindow = (hasExplicitActivationMap ? unfilteredMarkers : markers).length > 0;

  const explicitShow = activationMap?.show_chart;
  if (compatibility.doesNotWork || courseBlocked) {
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
      reasons: courseBlocked ? courseMismatches : compatibility.reasons,
      usedActivationMap: Boolean(activationMap),
    };
  }

  const shouldShowChart = explicitShow === false ? false : explicitShow === true ? true : hasActivationWindow;
  return {
    shouldShowChart,
    markers: normalizedMarkers,
    doesNotWork: false,
    reasons: [],
    usedActivationMap: Boolean(activationMap),
  };
}

export function buildSkillMapCacheKey({ cmNumber, mapContextKey, skillId, mapData, markers, rendererVersion, doesNotWork }) {
  const payload = {
    cm: String(cmNumber ?? ""),
    mapContext: String(mapContextKey ?? ""),
    skill: String(skillId ?? ""),
    rendererVersion: String(rendererVersion ?? ""),
    doesNotWork: Boolean(doesNotWork),
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
