// Server names for the admin dashboard. Discord is the source of truth, but
// we cache it so opening an admin page doesn't call Discord for every row.
import { getApplicationChannel } from './applicationStorage.js';
import { listGuildLabels } from './gambaGuilds.js';
import { DiscordRequest } from './utils.js';

const HIT_TTL_MS = 6 * 60 * 60 * 1000;
const MISS_TTL_MS = 10 * 60 * 1000;
const CONCURRENCY = 4;
const cache = new Map();

function knownName(guildId) {
  const stored = getApplicationChannel(guildId)?.guildName;
  if (stored && stored !== 'this server') return stored;
  const label = listGuildLabels().find((guild) => guild.id === guildId)?.label;
  return label || null;
}

async function fetchName(guildId) {
  const hit = cache.get(guildId);
  if (hit && Date.now() - hit.at < (hit.name ? HIT_TTL_MS : MISS_TTL_MS)) return hit.name;
  let name = null;
  try {
    const res = await DiscordRequest(`guilds/${guildId}`, { method: 'GET' });
    const guild = await res.json();
    name = typeof guild?.name === 'string' && guild.name.trim() ? guild.name.trim() : null;
  } catch {
    name = null;
  }
  cache.set(guildId, { name, at: Date.now() });
  return name;
}

/** Map of guild id -> display name (or null when nothing knows it). */
export async function guildNames(ids) {
  const unique = [...new Set(ids.map(String))];
  const names = new Map();
  let next = 0;
  async function worker() {
    while (next < unique.length) {
      const id = unique[next];
      next += 1;
      names.set(id, (await fetchName(id)) || knownName(id));
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, unique.length) }, worker));
  return names;
}
