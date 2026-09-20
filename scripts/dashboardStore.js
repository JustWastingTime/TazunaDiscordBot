import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.resolve(__dirname, '..', 'data');
const STORE_PATH = path.join(DATA_DIR, 'dashboard.json');

export const DEFAULT_FEATURES = {
  overview: true,
  planner: false,
  applicants: false,
  apply: false,
  tournaments: false,
};

const FEATURE_KEYS = Object.keys(DEFAULT_FEATURES);

const DEFAULT_SITE = {
  slug: null,
  siteName: 'Tazuna Clubs',
  networkName: 'Club network',
  description: 'Club performance overview and applications.',
  theme: 'slate',
  applyTitle: 'Apply to a club',
  applyBlocked: 'This trainer cannot apply to this club network.',
  publicEyebrow: 'Club dashboard',
  tenureNote: 'Time in any club in this network counts as one stay.',
  premium: false,
  // Empty means "no overrides": resolveFeatures() decides from the premium entitlement.
  // Baked-in false values here would be indistinguishable from a deliberate opt-out.
  features: {},
  managers: [],
};

let writeQueue = Promise.resolve();

function withLock(fn) {
  const run = () => fn();
  writeQueue = writeQueue.then(run, run);
  return writeQueue;
}

function emptyStore() {
  return {
    sites: {},
    clubSettings: {},
    planning: {},
    blacklist: {},
    memberLinks: {},
    directory: {},
    sightings: {},
    staffExtra: {},
    tournaments: {},
    membersCache: {},
  };
}

function ensureDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function loadStore() {
  ensureDataDir();
  try {
    const parsed = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
    return { ...emptyStore(), ...parsed };
  } catch (err) {
    if (err.code === 'ENOENT') return emptyStore();
    throw err;
  }
}

function saveStore(store) {
  ensureDataDir();
  fs.writeFileSync(STORE_PATH, `${JSON.stringify(store, null, 2)}\n`, 'utf8');
}

export function getDashboardMaxClubs() {
  const n = Number(process.env.DASHBOARD_MAX_CLUBS || 8);
  return Number.isFinite(n) && n > 0 ? Math.min(20, Math.trunc(n)) : 8;
}

export function getSite(guildId) {
  const store = loadStore();
  const row = store.sites[String(guildId)] || {};
  return {
    ...DEFAULT_SITE,
    ...row,
    guildId: String(guildId),
    // Nested merge: a stored partial `features` must not drop the defaults.
    features: { ...DEFAULT_FEATURES, ...(row.features || {}) },
    managers: Array.isArray(row.managers) ? row.managers : [],
  };
}

/** Raw per-network feature overrides, without the defaults merged in. */
export function getStoredFeatureOverrides(guildId) {
  const store = loadStore();
  const row = store.sites[String(guildId)] || {};
  return row.features && typeof row.features === 'object' ? row.features : {};
}

/**
 * Manager entry for one Discord user, with the clubs they may see.
 * `clubIds: null` means every club in the network (owners).
 */
export function getManagerEntry(guildId, discordId) {
  const id = String(discordId);
  const site = getSite(guildId);
  return site.managers.find((row) => String(row.discordId) === id) || null;
}

export function setSiteManagers(guildId, managers) {
  return withLock(() => {
    const store = loadStore();
    const g = String(guildId);
    const current = { ...DEFAULT_SITE, ...(store.sites[g] || {}) };
    const rows = (Array.isArray(managers) ? managers : [])
      .map((row) => {
        const discordId = String(row?.discordId || '').trim();
        if (!/^\d{5,32}$/.test(discordId)) return null;
        const clubIds = Array.isArray(row?.clubIds) && row.clubIds.length
          ? row.clubIds.map((id) => String(id))
          : null;
        return {
          discordId,
          label: String(row?.label || 'Manager'),
          role: row?.role === 'owner' ? 'owner' : 'manager',
          clubIds,
        };
      })
      .filter(Boolean);
    store.sites[g] = { ...current, managers: rows };
    saveStore(store);
    return rows;
  });
}

export function resolveGuildRef(ref) {
  const raw = String(ref || '').trim();
  if (!raw) return null;
  const store = loadStore();
  if (store.sites[raw]) return raw;
  for (const [guildId, site] of Object.entries(store.sites)) {
    if (site?.slug && String(site.slug).toLowerCase() === raw.toLowerCase()) return guildId;
  }
  return raw;
}

export function listPublicTenants() {
  const store = loadStore();
  return Object.entries(store.sites).map(([guildId, site]) => ({
    guildId,
    slug: site.slug || guildId,
    siteName: site.siteName || DEFAULT_SITE.siteName,
  }));
}

export function saveSite(guildId, patch) {
  return withLock(() => {
    const store = loadStore();
    const key = String(guildId);
    const current = { ...DEFAULT_SITE, ...(store.sites[key] || {}) };
    const next = { ...current, ...patch };
    if (next.slug) {
      const slug = String(next.slug).trim().toLowerCase().replace(/[^a-z0-9-]/g, '');
      next.slug = slug || null;
      for (const [otherId, site] of Object.entries(store.sites)) {
        if (otherId !== key && site?.slug && site.slug === next.slug) {
          throw new Error('That dashboard slug is already in use.');
        }
      }
    }
    store.sites[key] = next;
    saveStore(store);
    return getSite(key);
  });
}

export function getClubSettingsMap(guildId) {
  const store = loadStore();
  return store.clubSettings[String(guildId)] || {};
}

export function upsertClubSettings(guildId, circleId, patch) {
  return withLock(() => {
    const store = loadStore();
    const g = String(guildId);
    const c = String(circleId);
    if (!store.clubSettings[g]) store.clubSettings[g] = {};
    store.clubSettings[g][c] = { ...(store.clubSettings[g][c] || {}), ...patch };
    saveStore(store);
    return store.clubSettings[g][c];
  });
}

export function getPlanning(guildId) {
  const store = loadStore();
  const row = store.planning[String(guildId)];
  return {
    board: row?.board || { status: 'draft', updatedAt: null, confirmedAt: null },
    assignments: Array.isArray(row?.assignments) ? row.assignments : [],
  };
}

export function savePlanning(guildId, assignments) {
  return withLock(() => {
    const store = loadStore();
    const g = String(guildId);
    const unique = new Map();
    for (const item of assignments) unique.set(`${item.entityType}:${item.entityId}`, item);
    store.planning[g] = {
      board: { status: 'draft', updatedAt: new Date().toISOString(), confirmedAt: null },
      assignments: [...unique.values()],
    };
    saveStore(store);
    return getPlanning(g);
  });
}

export function confirmPlanning(guildId) {
  return withLock(() => {
    const store = loadStore();
    const g = String(guildId);
    const current = store.planning[g] || { board: {}, assignments: [] };
    const now = new Date().toISOString();
    store.planning[g] = {
      assignments: current.assignments || [],
      board: { status: 'confirmed', updatedAt: now, confirmedAt: now },
    };
    saveStore(store);
    return getPlanning(g);
  });
}

export function listBlacklist(guildId) {
  const store = loadStore();
  return Array.isArray(store.blacklist[String(guildId)]) ? store.blacklist[String(guildId)] : [];
}

export function findBlacklistMatch(guildId, umaId, discordUsername) {
  const entries = listBlacklist(guildId);
  const uma = String(umaId || '').trim();
  const name = String(discordUsername || '').trim().toLowerCase();
  return entries.find((entry) => (
    (uma && String(entry.umaId) === uma)
    || (name && String(entry.discordUsernameNormalized || entry.discordUsername || '').toLowerCase() === name)
  )) || null;
}

export function addBlacklist(guildId, { umaId, discordUsername, reason, createdBy }) {
  return withLock(() => {
    const store = loadStore();
    const g = String(guildId);
    const entries = Array.isArray(store.blacklist[g]) ? store.blacklist[g] : [];
    const nextId = entries.reduce((max, entry) => Math.max(max, Number(entry.id) || 0), 0) + 1;
    const entry = {
      id: nextId,
      umaId: String(umaId || '').trim(),
      discordUsername: String(discordUsername || '').trim(),
      discordUsernameNormalized: String(discordUsername || '').trim().toLowerCase(),
      reason: String(reason || ''),
      createdBy: String(createdBy || ''),
      createdAt: new Date().toISOString(),
    };
    entries.push(entry);
    store.blacklist[g] = entries;
    saveStore(store);
    return entry;
  });
}

export function deleteBlacklist(guildId, id) {
  return withLock(() => {
    const store = loadStore();
    const g = String(guildId);
    const entries = Array.isArray(store.blacklist[g]) ? store.blacklist[g] : [];
    const next = entries.filter((entry) => Number(entry.id) !== Number(id));
    const changed = next.length !== entries.length;
    store.blacklist[g] = next;
    if (changed) saveStore(store);
    return changed;
  });
}

export function listMemberLinks(guildId) {
  const store = loadStore();
  const map = store.memberLinks[String(guildId)] || {};
  return Object.entries(map).map(([umaId, discordId]) => ({ umaId, discordId: String(discordId) }));
}

export function upsertMemberLink(guildId, umaId, discordId) {
  return withLock(() => {
    const store = loadStore();
    const g = String(guildId);
    const id = String(umaId || '').trim();
    if (!store.memberLinks[g]) store.memberLinks[g] = {};
    const discord = String(discordId || '').trim();
    if (!id) throw new Error('Uma ID is required.');
    if (!discord) {
      delete store.memberLinks[g][id];
      saveStore(store);
      return null;
    }
    if (!/^\d{5,32}$/.test(discord)) throw new Error('Discord ID must be a numeric snowflake.');
    for (const [otherUma, otherDiscord] of Object.entries(store.memberLinks[g])) {
      if (String(otherDiscord) === discord && otherUma !== id) delete store.memberLinks[g][otherUma];
    }
    store.memberLinks[g][id] = discord;
    saveStore(store);
    return { umaId: id, discordId: discord };
  });
}

export function listStaffExtra(guildId) {
  const store = loadStore();
  return Array.isArray(store.staffExtra[String(guildId)]) ? store.staffExtra[String(guildId)] : [];
}

/**
 * Clubs a Discord user is currently in, derived from managed rosters:
 * memberLinks maps umaId -> discordId, directory maps umaId -> currentCircleId.
 * Used to scope what a non-manager sees on the dashboard.
 */
export function listClubsForDiscordUser(guildId, discordId) {
  const store = loadStore();
  const g = String(guildId);
  const id = String(discordId);
  const links = store.memberLinks[g] || {};
  const directory = store.directory[g] || {};
  const out = new Set();
  for (const [umaId, discord] of Object.entries(links)) {
    if (String(discord) !== id) continue;
    const circleId = directory[umaId]?.currentCircleId;
    if (circleId) out.add(String(circleId));
  }
  return [...out];
}

export function addStaffExtra(guildId, { discordId, label }) {
  return withLock(() => {
    const store = loadStore();
    const g = String(guildId);
    const id = String(discordId || '').trim();
    if (!/^\d{5,32}$/.test(id)) throw new Error('Discord ID must be a numeric snowflake.');
    const rows = Array.isArray(store.staffExtra[g]) ? store.staffExtra[g] : [];
    if (rows.some((row) => String(row.discordId) === id)) {
      return rows.find((row) => String(row.discordId) === id);
    }
    const row = { discordId: id, label: String(label || 'Staff'), clubIds: [] };
    rows.push(row);
    store.staffExtra[g] = rows;
    saveStore(store);
    return row;
  });
}

export function removeStaffExtra(guildId, discordId) {
  return withLock(() => {
    const store = loadStore();
    const g = String(guildId);
    const rows = Array.isArray(store.staffExtra[g]) ? store.staffExtra[g] : [];
    const next = rows.filter((row) => String(row.discordId) !== String(discordId));
    store.staffExtra[g] = next;
    saveStore(store);
    return next.length !== rows.length;
  });
}

function jstDate(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tokyo' }).format(now);
}

export function recordManagedRoster(guildId, circleId, members) {
  return withLock(() => {
    const store = loadStore();
    const g = String(guildId);
    const club = String(circleId);
    const today = jstDate();
    if (!store.directory[g]) store.directory[g] = {};
    if (!store.sightings[g]) store.sightings[g] = {};
    const present = (members || [])
      .map((member) => ({
        umaId: String(member.umaId || '').trim(),
        ign: String(member.ign || '').trim() || 'Unknown',
      }))
      .filter((member) => member.umaId);
    const presentIds = new Set(present.map((member) => member.umaId));
    for (const member of present) {
      store.sightings[g][`${member.umaId}:${club}:${today}`] = true;
      const existing = store.directory[g][member.umaId] || {};
      store.directory[g][member.umaId] = {
        umaId: member.umaId,
        ign: member.ign,
        currentCircleId: club,
        lastCircleId: club,
        firstSeenOn: existing.firstSeenOn || today,
        lastSeenOn: today,
      };
    }
    for (const [umaId, row] of Object.entries(store.directory[g])) {
      if (row.currentCircleId === club && !presentIds.has(umaId)) {
        store.directory[g][umaId] = { ...row, currentCircleId: null };
      }
    }
    saveStore(store);
  });
}

export function listMemberDirectory(guildId) {
  const store = loadStore();
  const g = String(guildId);
  const links = store.memberLinks[g] || {};
  const sightings = store.sightings[g] || {};
  return Object.values(store.directory[g] || {}).map((row) => {
    const observedDays = Object.keys(sightings).filter((key) => key.startsWith(`${row.umaId}:`)).length;
    return {
      ...row,
      observedDays,
      status: row.currentCircleId ? 'current' : 'former',
      discordId: links[row.umaId] || null,
    };
  });
}

export function getMembersCache(guildId) {
  const store = loadStore();
  return store.membersCache[String(guildId)] || null;
}

export function setMembersCache(guildId, payload) {
  return withLock(() => {
    const store = loadStore();
    store.membersCache[String(guildId)] = {
      savedAt: Date.now(),
      payload,
    };
    saveStore(store);
    return payload;
  });
}

function guildTournaments(store, guildId) {
  const g = String(guildId);
  if (!store.tournaments[g]) {
    store.tournaments[g] = { nextId: 1, nextPlayerId: 1, items: [] };
  }
  return store.tournaments[g];
}

export function listTournaments(guildId) {
  const store = loadStore();
  const pack = guildTournaments(store, guildId);
  return pack.items.map((item) => ({
    ...item.tournament,
    playerCount: (item.players || []).length,
  }));
}

export function listTournamentsForUser(guildId, discordId, isManager) {
  const store = loadStore();
  const pack = guildTournaments(store, guildId);
  return pack.items
    .filter((item) => isManager || (item.players || []).some((player) => String(player.discordId) === String(discordId)))
    .map((item) => ({ ...item.tournament, playerCount: (item.players || []).length }));
}

export function getTournamentBoard(guildId, id) {
  const store = loadStore();
  const pack = guildTournaments(store, guildId);
  const item = pack.items.find((row) => Number(row.tournament.id) === Number(id));
  if (!item) return null;
  return {
    tournament: item.tournament,
    players: item.players || [],
    picks: item.picks || [],
  };
}

export function createTournament(guildId, input) {
  return withLock(() => {
    const store = loadStore();
    const pack = guildTournaments(store, guildId);
    const id = pack.nextId++;
    const now = new Date().toISOString();
    const tournament = {
      id,
      name: input.name,
      rounds: input.rounds,
      eventDate: input.eventDate,
      createdAt: now,
      updatedAt: now,
      locked: false,
    };
    pack.items.push({ tournament, players: [], picks: [] });
    saveStore(store);
    return tournament;
  });
}

export function updateTournament(guildId, id, input) {
  return withLock(() => {
    const store = loadStore();
    const pack = guildTournaments(store, guildId);
    const item = pack.items.find((row) => Number(row.tournament.id) === Number(id));
    if (!item) return null;
    item.tournament = {
      ...item.tournament,
      ...input,
      id: item.tournament.id,
      updatedAt: new Date().toISOString(),
    };
    saveStore(store);
    return item.tournament;
  });
}

export function deleteTournament(guildId, id) {
  return withLock(() => {
    const store = loadStore();
    const pack = guildTournaments(store, guildId);
    const before = pack.items.length;
    pack.items = pack.items.filter((row) => Number(row.tournament.id) !== Number(id));
    if (pack.items.length === before) return false;
    saveStore(store);
    return true;
  });
}

export function replaceTournamentRoster(guildId, id, players) {
  return withLock(() => {
    const store = loadStore();
    const pack = guildTournaments(store, guildId);
    const item = pack.items.find((row) => Number(row.tournament.id) === Number(id));
    if (!item) throw new Error('Tournament not found.');
    item.players = players.map((player, index) => ({
      id: pack.nextPlayerId++,
      tournamentId: Number(id),
      discordId: String(player.discordId),
      displayName: String(player.displayName),
      team: Number(player.team || 1),
      distance: player.distance || 'mile',
      sortOrder: player.sortOrder ?? index,
      umaId: player.umaId ?? null,
    }));
    item.picks = (item.picks || []).filter((pick) => item.players.some((player) => player.id === pick.playerId));
    item.tournament.updatedAt = new Date().toISOString();
    saveStore(store);
    return item.players;
  });
}

export function saveTournamentPick(guildId, input) {
  return withLock(() => {
    const store = loadStore();
    const pack = guildTournaments(store, guildId);
    const item = pack.items.find((row) => Number(row.tournament.id) === Number(input.tournamentId));
    if (!item) throw new Error('Tournament not found.');
    if (item.tournament.locked && !input.isManager) throw new Error('Picks are locked.');
    const player = (item.players || []).find((row) => Number(row.id) === Number(input.playerId));
    if (!player) throw new Error('Player not found.');
    if (!input.isManager && String(player.discordId) !== String(input.actorDiscordId)) {
      throw new Error('You can only edit your own picks.');
    }
    item.picks = (item.picks || []).filter((pick) => !(
      Number(pick.playerId) === Number(input.playerId) && Number(pick.round) === Number(input.round)
    ));
    const pick = {
      playerId: Number(input.playerId),
      round: Number(input.round),
      team: player.team,
      characterId: input.characterId,
      characterName: input.characterName,
      updatedAt: new Date().toISOString(),
      updatedBy: input.updatedBy || '',
    };
    item.picks.push(pick);
    saveStore(store);
    return pick;
  });
}

export function clearTournamentPick(guildId, input) {
  return withLock(() => {
    const store = loadStore();
    const pack = guildTournaments(store, guildId);
    const item = pack.items.find((row) => Number(row.tournament.id) === Number(input.tournamentId));
    if (!item) throw new Error('Tournament not found.');
    if (item.tournament.locked && !input.isManager) throw new Error('Picks are locked.');
    const player = (item.players || []).find((row) => Number(row.id) === Number(input.playerId));
    if (!player) throw new Error('Player not found.');
    if (!input.isManager && String(player.discordId) !== String(input.actorDiscordId)) {
      throw new Error('You can only edit your own picks.');
    }
    item.picks = (item.picks || []).filter((pick) => !(
      Number(pick.playerId) === Number(input.playerId) && Number(pick.round) === Number(input.round)
    ));
    saveStore(store);
    return true;
  });
}

/**
 * Seed a network's club settings (and, on first run, its site record).
 * Branding is supplied by the caller — nothing here is specific to one community,
 * so the same command works for any club network.
 *
 * options: { branding?: { slug, siteName, networkName, theme, publicEyebrow, description },
 *            premium?: boolean, features?: object, managers?: [] }
 */
export function seedClubSettings(guildId, clubs, options = {}) {
  return withLock(() => {
    const store = loadStore();
    const g = String(guildId);
    if (!store.clubSettings[g]) store.clubSettings[g] = {};
    for (const club of clubs) {
      const id = String(club.circleId);
      if (store.clubSettings[g][id]) continue;
      store.clubSettings[g][id] = {
        dailyTarget: club.dailyTarget,
        promotionRatio: club.promotionRatio ?? 1.25,
        severeRatio: club.severeRatio ?? 0.5,
        inactiveDays: club.inactiveDays ?? 3,
        promotionEnabled: club.promotionEnabled !== false,
        rankGrade: club.rankGrade ?? null,
      };
    }
    // Branding is applied only on first seed; management fields are refreshed on
    // every run so an admin can add managers or flip premium without editing JSON.
    const branding = options.branding || {};
    const current = store.sites[g] || { ...DEFAULT_SITE };
    const next = { ...current };
    if (!store.sites[g]) {
      next.slug = branding.slug
        ? String(branding.slug).trim().toLowerCase().replace(/[^a-z0-9-]/g, '') || null
        : null;
      next.siteName = branding.siteName || DEFAULT_SITE.siteName;
      next.networkName = branding.networkName || DEFAULT_SITE.networkName;
      next.description = branding.description || DEFAULT_SITE.description;
      next.theme = branding.theme || DEFAULT_SITE.theme;
      next.publicEyebrow = branding.publicEyebrow || DEFAULT_SITE.publicEyebrow;
    }
    if (options.premium !== undefined) next.premium = options.premium === true;
    if (options.features) {
      next.features = { ...DEFAULT_FEATURES, ...(current.features || {}), ...options.features };
    }
    if (Array.isArray(options.managers)) {
      next.managers = options.managers
        .map((row) => {
          const discordId = String(row?.discordId || '').trim();
          if (!/^\d{5,32}$/.test(discordId)) return null;
          const clubIds = Array.isArray(row?.clubIds) && row.clubIds.length
            ? row.clubIds.map((id) => String(id))
            : null;
          return {
            discordId,
            label: String(row?.label || 'Manager'),
            role: row?.role === 'owner' ? 'owner' : 'manager',
            clubIds,
          };
        })
        .filter(Boolean);
    }
    store.sites[g] = next;
    saveStore(store);
  });
}
