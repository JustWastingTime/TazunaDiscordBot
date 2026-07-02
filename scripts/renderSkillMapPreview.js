import fs from "fs/promises";
import path from "path";
import { getUpcomingChampionsMeet, getCourseMapDataFromCm, resolveSkillActivationOverlay } from "./skillCourseMap.js";
import { renderCourseMapPng } from "./courseMapRenderer.js";

function lower(value) {
  return String(value ?? "").toLowerCase();
}

function findSkill(skills, query) {
  const q = lower(query).trim();
  return skills.find((skill) => {
    if (lower(skill.skill_name) === q) return true;
    return Array.isArray(skill.aliases) && skill.aliases.some((alias) => lower(alias) === q);
  });
}

async function loadJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

async function main() {
  const skillQuery = process.argv[2];
  const cmNumberArg = process.argv[3];
  if (!skillQuery) {
    throw new Error("Usage: node scripts/renderSkillMapPreview.js \"Skill Name\" [cm-number]");
  }

  const skills = await loadJson(path.resolve("assets", "skill.json"));
  const champsmeets = await loadJson(path.resolve("assets", "champsmeet.json"));
  const mapsCatalog = await loadJson(path.resolve("assets", "maps.json")).catch(() => []);

  const skill = findSkill(skills, skillQuery);
  if (!skill) {
    throw new Error(`Skill not found: ${skillQuery}`);
  }

  const cm = cmNumberArg
    ? champsmeets.find((item) => String(item.number) === String(cmNumberArg))
    : getUpcomingChampionsMeet(champsmeets);
  if (!cm) throw new Error("No Champions Meet found.");

  const mapData = getCourseMapDataFromCm(cm, mapsCatalog);
  if (!mapData) {
    throw new Error(`CM ${cm.number} (${cm.name}) has no valid map data.`);
  }

  const overlay = resolveSkillActivationOverlay(skill, cm, mapData);
  if (!overlay.shouldShowChart) {
    console.log(`No chart to render for "${skill.skill_name}" on CM ${cm.number}.`);
    return;
  }

  const safeName = skill.skill_name.replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "").toLowerCase();
  const fileName = `cm${cm.number}-${safeName}-preview.png`;
  const outputPath = path.resolve("assets", "generated", "skill-maps", fileName);

  await renderCourseMapPng(mapData, outputPath, {
    width: 1500,
    height: 360,
    skillMarkers: overlay.markers,
    warningText: overlay.doesNotWork ? "DOES NOT WORK" : undefined,
  });

  console.log(`Rendered: ${outputPath}`);
  if (overlay.doesNotWork) {
    console.log("Status: DOES NOT WORK on this CM (chart shown with no red overlays).");
  } else {
    console.log(`Markers: ${overlay.markers.length}`);
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
