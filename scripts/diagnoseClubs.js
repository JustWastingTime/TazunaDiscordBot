// Read-only check of what uma.moe returns for every registered club, and how the
// dashboard's member filter treats it. Usage: node scripts/diagnoseClubs.js
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { fetchCircleData } from './clubService.js';
import { DATA_DIR } from './dataDir.js';
import { getActiveCutoffMs, getCurrentJstDayIndex, isMemberActive } from './dashboardPerformance.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const clubsPath = path.join(DATA_DIR, 'guild-clubs.json');
const store = JSON.parse(fs.readFileSync(clubsPath, 'utf8'));
const circles = new Map();
for (const clubs of Object.values(store)) {
  for (const club of Array.isArray(clubs) ? clubs : []) circles.set(String(club.circleId), club.circleName || '');
}

const now = new Date();
console.log(`now ${now.toISOString()} | JST day index ${getCurrentJstDayIndex(now)} | ${circles.size} circle(s)\n`);

for (const [circleId, savedName] of circles) {
  try {
    const data = await fetchCircleData(circleId);
    const roster = Array.isArray(data?.members) ? data.members : [];
    const cutoff = getActiveCutoffMs(roster);
    const active = roster.filter((member) => isMemberActive(member, cutoff));
    const sample = roster[0] || {};
    const fans = Array.isArray(sample.daily_fans) ? sample.daily_fans : null;
    console.log(`${circleId} "${savedName}" -> uma.moe name "${data?.circle?.name ?? '?'}"`);
    console.log(`  top-level keys: ${Object.keys(data || {}).join(', ')}`);
    console.log(`  roster ${roster.length}, active ${active.length}, cutoff ${cutoff ? new Date(cutoff).toISOString() : 'off'}`);
    if (roster.length) {
      console.log(`  member keys: ${Object.keys(sample).join(', ')}`);
      console.log(`  sample last_updated ${sample.last_updated ?? '-'} | daily_fans length ${fans ? fans.length : 'missing'}`);
      if (fans) console.log(`  sample daily_fans tail: ${JSON.stringify(fans.slice(-6))}`);
    }
  } catch (error) {
    console.log(`${circleId} "${savedName}" -> FAILED: ${error.message}`);
    if (error.rateLimited) {
      console.log('\nStopping: uma.moe is rate-limiting this API key. Try again later.');
      break;
    }
  }
  console.log('');
  // Space requests out: this shares the API key's rate limit with the running bot.
  await new Promise((resolve) => setTimeout(resolve, 2000));
}
process.exit(0);
