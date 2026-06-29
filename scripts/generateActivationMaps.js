import fs from "fs/promises";
import path from "path";

const SKILLS_PATH = path.resolve("assets", "skill.json");
const START_SKILL = "Introduction to Physiology";

function lower(value) {
  return String(value ?? "").toLowerCase();
}

function collectTexts(skill) {
  const texts = [];
  if (Array.isArray(skill.preconditions)) texts.push(...skill.preconditions);
  if (Array.isArray(skill.effect)) {
    for (const effect of skill.effect) {
      if (Array.isArray(effect.conditions)) texts.push(...effect.conditions);
      if (effect.description) texts.push(effect.description);
    }
  }
  if (skill.description) texts.push(skill.description);
  return texts.map((t) => lower(t));
}

function firstNumberFromText(text) {
  const match = text.match(/(\d+)/);
  return match ? Number(match[1]) : null;
}

function extractRemainingDistanceMeters(text) {
  const normalized = lower(text);

  // last 777m of the race / 200m or less remaining / 777m remaining
  const direct = normalized.match(/(?:last\s+)?(\d+)\s*m(?:eters?)?\s*(?:remaining|of the race|or less remaining)?/);
  if (direct) return Number(direct[1]);

  // with 200m or less remaining
  const withRemaining = normalized.match(/with\s+(\d+)\s*m(?:eters?)?\s*or less remaining/);
  if (withRemaining) return Number(withRemaining[1]);

  return null;
}

function buildActivationMapForSkill(skill) {
  const texts = collectTexts(skill);
  const allText = texts.join(" | ");
  const triggers = [];
  const requirements = {};

  if (/\b(sprint|mile|medium|long)\b/.test(allText)) {
    const distanceTypes = new Set();
    for (const t of texts) {
      const m = t.match(/\b(sprint|mile|medium|long)\b/g) ?? [];
      for (const item of m) distanceTypes.add(item);
    }
    if (distanceTypes.size) requirements.distance_types = [...distanceTypes];
  }

  if (allText.includes("turf")) requirements.terrains = ["turf"];
  if (allText.includes("dirt")) requirements.terrains = ["dirt"];
  if (allText.includes("counterclockwise") || allText.includes("left-handed") || allText.includes("left handed")) {
    requirements.directions = ["counterclockwise"];
  }
  if (allText.includes("clockwise") || allText.includes("right-handed") || allText.includes("right handed")) {
    requirements.directions = ["clockwise"];
  }

  // Final corner == last corner in map, regardless of corner number.
  if (allText.includes("final corner")) {
    triggers.push({
      type: "box",
      target: "layout",
      match: "corner",
      select: "last",
    });
  }

  if (allText.includes("any corner") || allText.includes("random point on a random corner") || allText.includes("random point on corner 1/2/3/4")) {
    triggers.push({
      type: "box",
      target: "layout",
      match: "corner",
    });
  }

  if (allText.includes("not a corner")) {
    triggers.push({
      type: "box",
      target: "layout",
      match: "not_a_corner",
    });
  }

  if (allText.includes("random point on a random straight")) {
    triggers.push({
      type: "box",
      target: "layout",
      match: "straight",
    });
  }

  // Final straight == last straight in map.
  if (allText.includes("final straight")) {
    triggers.push({
      type: "box",
      target: "layout",
      match: "straight",
      select: "last",
    });
  }

  // Second half of early/opening leg => local 50%-100% window on opening leg segment.
  if (allText.includes("second half of early race")) {
    triggers.push({
      type: "box",
      target: "zones",
      labels: ["opening leg", "early"],
      clip_within_segment_start_ratio: 0.5,
      clip_within_segment_end_ratio: 1,
    });
  }

  // First half of mid race => local 0%-50% window on middle/mid leg.
  if (allText.includes("first half of mid race")) {
    triggers.push({
      type: "box",
      target: "zones",
      labels: ["middle leg", "mid"],
      clip_within_segment_start_ratio: 0,
      clip_within_segment_end_ratio: 0.5,
    });
  }

  // Remaining-distance threshold -> line at (length - value).
  for (const text of texts) {
    const meters = extractRemainingDistanceMeters(text);
    if (Number.isFinite(meters) && meters > 0) {
      triggers.push({
        type: "line",
        distance_mode: "remaining",
        value: meters,
      });
    }
  }

  if (triggers.length === 0) {
    return null;
  }

  const activationMap = {
    show_chart: true,
    triggers,
  };
  if (Object.keys(requirements).length > 0) {
    activationMap.requirements = requirements;
  }
  return activationMap;
}

async function main() {
  const raw = await fs.readFile(SKILLS_PATH, "utf8");
  const skills = JSON.parse(raw);
  const startIndex = skills.findIndex((s) => s.skill_name === START_SKILL);
  if (startIndex < 0) throw new Error(`Start skill not found: ${START_SKILL}`);

  let changed = 0;
  for (let i = startIndex; i < skills.length; i++) {
    const skill = skills[i];
    const generated = buildActivationMapForSkill(skill);
    if (!generated) continue;

    // Preserve any existing manual map config.
    if (skill.activation_map) continue;
    skill.activation_map = generated;
    changed += 1;
  }

  let formatted = JSON.stringify(skills, null, 4);
  // Keep top-level skill objects compact at the opening line:
  // {   "skill_name": "...",
  // This preserves the user's preferred collapsed visual style.
  formatted = formatted.replace(/\n    \{\n        "skill_name":/g, '\n    {   "skill_name":');

  await fs.writeFile(SKILLS_PATH, formatted + "\n", "utf8");
  console.log(`Generated activation_map for ${changed} skills (starting from "${START_SKILL}").`);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
