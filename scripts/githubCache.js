import fetch from 'node-fetch';

// In-memory cache
const cache = {
  supporters: [],
  skills: [],
  events: [],
  characters: [],
  users: [],
  races: [],
  champsmeets: [],
  legendraces: [],
  misc: [],
  resources: []
};

// GitHub raw URLs
const urls = {
  supporters: 'https://raw.githubusercontent.com/JustWastingTime/TazunaDiscordBot/heads/main/assets/supporter.json',
  skills: 'https://raw.githubusercontent.com/JustWastingTime/TazunaDiscordBot/heads/main/assets/skill.json',
  events: 'https://raw.githubusercontent.com/JustWastingTime/TazunaDiscordBot/heads/main/assets/event.json',
  characters: 'https://raw.githubusercontent.com/JustWastingTime/TazunaDiscordBot/heads/main/assets/character.json',
  races: 'https://raw.githubusercontent.com/JustWastingTime/TazunaDiscordBot/heads/main/assets/races.json',
  champsmeets: 'https://raw.githubusercontent.com/JustWastingTime/TazunaDiscordBot/heads/main/assets/champsmeet.json',
  legendraces: 'https://raw.githubusercontent.com/JustWastingTime/TazunaDiscordBot/heads/main/assets/legendrace.json',
  schedule: 'https://raw.githubusercontent.com/JustWastingTime/TazunaDiscordBot/heads/main/assets/schedule.json',
  misc: 'https://raw.githubusercontent.com/JustWastingTime/TazunaDiscordBot/heads/main/assets/misc.json',
  resources: 'https://raw.githubusercontent.com/JustWastingTime/TazunaDiscordBot/heads/main/assets/resources.json',
};

// Function to fetch a JSON file
async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`[CacheUpdater] Failed to fetch ${url}: ${res.status}`);
  return await res.json();
}

// Function to update all cached data
async function updateCache() {
  try {
    console.log('[CacheUpdater] Updating JSON cache from GitHub...');
    for (const key of Object.keys(urls)) {
      cache[key] = await fetchJson(urls[key]);
    }
    console.log('[CacheUpdater] Cache updated successfully.');
  } catch (err) {
    console.error('[CacheUpdater] Error updating cache:', err);
  }
}

// Initial fetch
await updateCache();

// Refresh every day
setInterval(updateCache, 1000 * 60 * 60 * 24); // 1 day

export default cache;