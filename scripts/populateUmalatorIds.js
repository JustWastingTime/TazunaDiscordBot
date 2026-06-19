/**
 * Maintenance script: add `cid` to maps.json for Umalator skill-visualizer deep links.
 *
 * Usage: node scripts/populateUmalatorIds.js
 */
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const TRACK_NAMES_URL =
  "https://raw.githubusercontent.com/alpha123/uma-tools/master/umalator-global/tracknames.json";
const COURSE_DATA_URL =
  "https://raw.githubusercontent.com/alpha123/uma-tools/master/umalator-global/course_data.json";

function normDir(value) {
  const v = String(value ?? "").toLowerCase();
  if (v.includes("counter")) return 2;
  if (v.includes("clock")) return 1;
  return null;
}

function normSurface(value) {
  const v = String(value ?? "").toLowerCase();
  if (v.includes("dirt")) return 2;
  return 1;
}

function parseDist(value) {
  return Number(String(value ?? "").replace(/[^\d]/g, ""));
}

function parseInout(name) {
  const n = String(name ?? "").toLowerCase();
  if (n.includes("outer to inner")) return "oti";
  if (n.includes("(outer)")) return "outer";
  if (n.includes("(inner)")) return "inner";
  return "default";
}

function buildTrackIdByName(tracknames) {
  const out = {};
  for (const [id, names] of Object.entries(tracknames)) {
    for (const name of names) {
      if (name) out[name.toLowerCase()] = Number(id);
    }
  }
  return out;
}

function buildRaceCidHints(races) {
  const hints = new Map();
  for (const race of races ?? []) {
    const match = String(race.image ?? "").match(/\/(\d{5})\/(\d{5})\.png/);
    if (!match) continue;
    const key = [
      String(race.racetrack ?? "").toLowerCase(),
      parseDist(race.distance_meters),
      normSurface(race.terrain),
      normDir(race.direction),
    ].join("|");
    hints.set(key, match[2]);
  }
  return hints;
}

const COURSE_FIELD_BY_INOUT = { default: 1, inner: 2, outer: 3, oti: 4 };

function resolveCid(map, { entries, trackIdByName, raceCidHints }) {
  const track = String(map.racetrack ?? "").toLowerCase();
  const trackId = trackIdByName[track];
  const dist = parseDist(map.distance_meters);
  const surface = normSurface(map.terrain);
  const turn = normDir(map.direction);
  const raceKey = [track, dist, surface, turn].join("|");
  if (raceCidHints.has(raceKey)) return raceCidHints.get(raceKey);
  if (!trackId) return null;

  const candidates = entries.filter(
    (c) =>
      c.raceTrackId === trackId &&
      c.distance === dist &&
      c.surface === surface &&
      c.turn === turn
  );
  if (candidates.length === 1) return candidates[0].cid;

  const wantCourse = COURSE_FIELD_BY_INOUT[parseInout(map.name)];
  const byCourse = candidates.filter((c) => c.course === wantCourse);
  if (byCourse.length === 1) return byCourse[0].cid;

  if (parseInout(map.name) === "default") {
    const def = candidates.find((c) => c.course === 1);
    if (def) return def.cid;
  }

  return candidates.length === 1 ? candidates[0].cid : null;
}

async function buildCidByMapName() {
  const racesPath = path.join(ROOT, "assets", "races.json");
  const mapsPath = path.join(ROOT, "assets", "maps.json");
  const [maps, races, tracknames, courseData] = await Promise.all([
    fs.readFile(mapsPath, "utf8").then(JSON.parse),
    fs.readFile(racesPath, "utf8").then(JSON.parse),
    fetch(TRACK_NAMES_URL).then((r) => r.json()),
    fetch(COURSE_DATA_URL).then((r) => r.json()),
  ]);

  const trackIdByName = buildTrackIdByName(tracknames);
  const raceCidHints = buildRaceCidHints(races);
  const entries = Object.entries(courseData).map(([cid, course]) => ({ cid, ...course }));
  const ctx = { entries, trackIdByName, raceCidHints };

  const byName = new Map();
  for (const map of maps) {
    const cid = resolveCid(map, ctx);
    if (cid) byName.set(map.name, cid);
  }
  return byName;
}

async function patchMapsJson(cidByName) {
  const mapsPath = path.join(ROOT, "assets", "maps.json");
  let text = await fs.readFile(mapsPath, "utf8");
  let updated = 0;

  for (const [name, cid] of cidByName) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const namePattern = new RegExp(
      `(\\{\\s*"name": "${escaped}",\\s*\\n)(\\s*"cid": "[^"]*",\\s*\\n)?`,
      "g"
    );
    const replacement = `$1        "cid": "${cid}",\n`;
    const next = text.replace(namePattern, replacement);
    if (next !== text) {
      text = next;
      updated++;
    }
  }

  // Remove stale cid lines for maps that no longer resolve.
  const allNames = [...cidByName.keys()];
  const stalePattern = /(\{\s*"name": "([^"]+)",\s*\n)\s*"cid": "[^"]*",\s*\n/g;
  text = text.replace(stalePattern, (full, prefix, name) => {
    if (cidByName.has(name)) return full;
    return prefix;
  });

  await fs.writeFile(mapsPath, text);
  console.log(`maps.json: set cid on ${updated} entries (${cidByName.size} resolvable)`);
}

const cidByName = await buildCidByMapName();
await patchMapsJson(cidByName);
