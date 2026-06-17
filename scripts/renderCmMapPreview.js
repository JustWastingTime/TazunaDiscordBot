import path from "path";
import fs from "fs/promises";
import { getCourseMapDataFromCm } from "./skillCourseMap.js";
import { renderCourseMapPng } from "./courseMapRenderer.js";

async function main() {
  const cmNumbers = process.argv.slice(2);
  if (cmNumbers.length === 0) {
    throw new Error("Usage: node scripts/renderCmMapPreview.js <cm-number> [cm-number...]");
  }

  const champsmeetPath = path.resolve("assets", "champsmeet.json");
  const champsmeets = JSON.parse(await fs.readFile(champsmeetPath, "utf8"));
  const mapsPath = path.resolve("assets", "maps.json");
  let mapsCatalog = [];
  try {
    mapsCatalog = JSON.parse(await fs.readFile(mapsPath, "utf8"));
  } catch {
    mapsCatalog = [];
  }
  const targets = champsmeets.filter((cm) => cmNumbers.includes(String(cm.number)));
  if (targets.length === 0) {
    throw new Error(`No CM entries matched: ${cmNumbers.join(", ")}`);
  }

  for (const cm of targets) {
    const mapData = getCourseMapDataFromCm(cm, mapsCatalog);
    if (!mapData) {
      console.log(`Skipped CM ${cm.number} (${cm.name}): map data missing or invalid.`);
      continue;
    }

    const outputPath = path.resolve("assets", "generated", "skill-maps", `cm${cm.number}-preview.png`);
    await renderCourseMapPng(mapData, outputPath, {
      width: 1500,
      height: 360,
      skillMarkers: [],
    });
    console.log(`Rendered CM ${cm.number}: ${outputPath}`);
  }
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
