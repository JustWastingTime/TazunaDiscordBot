import fetch from 'node-fetch';

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
  legendraces: 'https://raw.githubusercontent.com/JustWastingTime/TazunaDiscordBot/heads/main/assets/legendrace.json',
  schedule: 'https://raw.githubusercontent.com/JustWastingTime/TazunaDiscordBot/heads/main/assets/schedule.json',
  misc: 'https://raw.githubusercontent.com/JustWastingTime/TazunaDiscordBot/heads/main/assets/misc.json',
  resources: 'https://raw.githubusercontent.com/JustWastingTime/TazunaDiscordBot/heads/main/assets/resources.json',
  epithets: 'https://raw.githubusercontent.com/JustWastingTime/TazunaDiscordBot/heads/main/assets/epithets.json',
};

// Function to fetch a JSON file
async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`[CacheUpdater] Failed to fetch ${url}: ${res.status}`);
  return await res.json();
}

let updateInFlight = null;

// Function to update all cached data
async function updateCache() {
  if (updateInFlight) return updateInFlight;

  updateInFlight = (async () => {
    console.log('[CacheUpdater] Updating JSON cache from GitHub...');
    const nextData = {};
    for (const key of Object.keys(urls)) {
      nextData[key] = await fetchJson(urls[key]);
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