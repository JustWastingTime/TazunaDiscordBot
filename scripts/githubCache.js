import fetch from 'node-fetch';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ASSETS_DIR = path.resolve(__dirname, '..', 'assets');

// In-memory cache
const cache = {
  supporters: [],
  skills: [],
  characters: [],
  schedule: [],
  events: [],
  users: [],
  races: [],
  champsmeets: [],
  maps: [],
  customraces: [],
  legendraces: [],
  misc: [],
  resources: [],
  epithets: []
};

// GitHub raw URLs
const urls = {
  supporters: 'https://raw.githubusercontent.com/JustWastingTime/TazunaDiscordBot/heads/main/assets/supporter.json',
  skills: 'https://raw.githubusercontent.com/JustWastingTime/TazunaDiscordBot/heads/main/assets/skill.json',
  characters: 'https://raw.githubusercontent.com/JustWastingTime/TazunaDiscordBot/heads/main/assets/character.json',
  races: 'https://raw.githubusercontent.com/JustWastingTime/TazunaDiscordBot/heads/main/assets/races.json',
  champsmeets: 'https://raw.githubusercontent.com/JustWastingTime/TazunaDiscordBot/heads/main/assets/champsmeet.json',
  maps: 'https://raw.githubusercontent.com/JustWastingTime/TazunaDiscordBot/heads/main/assets/maps.json',
  customraces: 'https://raw.githubusercontent.com/JustWastingTime/TazunaDiscordBot/heads/main/assets/customraces.json',
  legendraces: 'https://raw.githubusercontent.com/JustWastingTime/TazunaDiscordBot/heads/main/assets/legendrace.json',
  schedule: 'https://raw.githubusercontent.com/JustWastingTime/TazunaDiscordBot/heads/main/assets/schedule.json',
  misc: 'https://raw.githubusercontent.com/JustWastingTime/TazunaDiscordBot/heads/main/assets/misc.json',
  resources: 'https://raw.githubusercontent.com/JustWastingTime/TazunaDiscordBot/heads/main/assets/resources.json',
  epithets: 'https://raw.githubusercontent.com/JustWastingTime/TazunaDiscordBot/heads/main/assets/epithets.json',
};

const localFiles = {
  supporters: 'supporter.json',
  skills: 'skill.json',
  characters: 'character.json',
  races: 'races.json',
  champsmeets: 'champsmeet.json',
  maps: 'maps.json',
  customraces: 'customraces.json',
  legendraces: 'legendrace.json',
  schedule: 'schedule.json',
  misc: 'misc.json',
  resources: 'resources.json',
  epithets: 'epithets.json',
};

// Function to fetch a JSON file
async function readLocalJson(fileName) {
  const filePath = path.join(ASSETS_DIR, fileName);
  const raw = await fs.readFile(filePath, 'utf8');
  return JSON.parse(raw);
}

async function loadCacheEntry(key, useLocalAssets) {
  if (useLocalAssets) {
    try {
      return await readLocalJson(localFiles[key]);
    } catch (err) {
      if (key === 'customraces' && err?.code === 'ENOENT') return [];
      throw err;
    }
  }

  const url = urls[key];
  const res = await fetch(url);
  if (key === 'customraces' && res.status === 404) return [];
  if (!res.ok) throw new Error(`[CacheUpdater] Failed to fetch ${url}: ${res.status}`);
  return await res.json();
}

let updateInFlight = null;

// Function to update all cached data
async function updateCache() {
  if (updateInFlight) return updateInFlight;

  updateInFlight = (async () => {
    const localSetting = String(process.env.USE_LOCAL_ASSETS ?? '').toLowerCase().trim();
    const useLocalAssets = (localSetting === '1' || localSetting === 'true' || localSetting === 'yes');

    console.log(`[CacheUpdater] Updating JSON cache from ${useLocalAssets ? 'local assets' : 'GitHub'}...`);
    const nextData = {};
    for (const key of Object.keys(urls)) {
      nextData[key] = await loadCacheEntry(key, useLocalAssets);
    }

    // Mutate arrays in place so existing references keep seeing fresh data.
    for (const key of Object.keys(nextData)) {
      if (!Array.isArray(cache[key])) cache[key] = [];
      cache[key].length = 0;
      cache[key].push(...nextData[key]);
    }
    console.log('[CacheUpdater] Cache updated successfully.');
  })();

  try {
    await updateInFlight;
  } catch (err) {
    console.error('[CacheUpdater] Error updating cache:', err);
    throw err;
  } finally {
    updateInFlight = null;
  }
}

// Initial fetch
await updateCache();

// Refresh every day
setInterval(updateCache, 1000 * 60 * 60 * 24); // 1 day

export { updateCache };
export default cache;