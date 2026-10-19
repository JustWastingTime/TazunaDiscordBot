import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import express from 'express';
import { isBotOwner } from './adminRole.js';
import { httpError, requireOwner } from './adminAuth.js';
import {
  deleteEntry,
  getCachedEntry,
  listAudit,
  listCachedEntries,
  listDatasets,
  publicDataset,
  readDatasetHead,
  readEntryFromGitHub,
  readRawFromGitHub,
  saveEntry,
  saveRawFile,
} from './assetStore.js';
import { convertConditions, parseEvents, suggestActivationMap } from './adminTools.js';
import { jsonError, readSession } from './dashboardAuth.js';
import { listPublicTenants } from './dashboardStore.js';
import {
  isPremiumGuild,
  listAllGuildClubs,
  premiumGuildStatus,
  setGuildPremium,
} from './clubDatabase.js';
import cache, { updateCache } from './githubCache.js';
import { reloadEventsFromDisk } from './eventService.js';
import { deleteGambaEvent, listGambaEvents, readGambaEvent, saveGambaEvent } from './gambaEventAdmin.js';
import { renderCourseMapPng } from './courseMapRenderer.js';
import {
  getCourseMapDataFromCm,
  getCourseMapDataFromMap,
  getUpcomingChampionsMeet,
  resolveSkillActivationOverlay,
} from './skillCourseMap.js';

const previewHits = new Map();

function previewAllowed(ip) {
  const now = Date.now();
  const recent = (previewHits.get(ip) || []).filter((ts) => now - ts < 60_000);
  if (recent.length >= 20) return false;
  recent.push(now);
  previewHits.set(ip, recent);
  return true;
}

function entryKey(req) {
  const fromQuery = req.query.key != null ? String(req.query.key) : '';
  const fromParam = req.params.key != null ? String(req.params.key) : '';
  return (fromQuery || fromParam || '').trim();
}

function findCm(cmNumber) {
  if (cmNumber == null || cmNumber === '') return getUpcomingChampionsMeet(cache.champsmeets);
  return (cache.champsmeets || []).find((cm) => String(cm.number) === String(cmNumber)) || null;
}

function findMap(query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return null;
  return (cache.maps || []).find((map) => {
    const name = String(map.name || '').toLowerCase();
    return name === q || name.includes(q) || String(map.cid || '') === q;
  }) || null;
}

async function renderPreview(skill, { cmNumber, mapQuery }) {
  let mapData = null;
  let label = '';
  let cm = null;
  if (mapQuery) {
    const raw = findMap(mapQuery);
    if (!raw) throw httpError(404, `No map matching "${mapQuery}".`);
    mapData = getCourseMapDataFromMap(raw, null);
    label = raw.name || mapQuery;
  } else {
    cm = findCm(cmNumber);
    if (!cm) throw httpError(404, 'No Champions Meet found.');
    mapData = getCourseMapDataFromCm(cm, cache.maps);
    label = cm.name ? `${cm.name} (${cm.number})` : `CM ${cm.number}`;
  }
  if (!mapData) throw httpError(404, 'That course has no map data.');
  const overlay = resolveSkillActivationOverlay(skill, cm, mapData);
  if (!overlay.shouldShowChart) {
    return { label, shouldShowChart: false, doesNotWork: overlay.doesNotWork, reasons: overlay.reasons || [], pngBase64: null };
  }
  const tmp = path.join(os.tmpdir(), `tazuna-map-${Date.now()}-${Math.random().toString(16).slice(2)}.png`);
  try {
    await renderCourseMapPng(mapData, tmp, {
      width: 1500,
      height: 360,
      skillMarkers: overlay.markers,
      warningText: overlay.doesNotWork ? 'DOES NOT WORK' : undefined,
    });
    const png = await fs.readFile(tmp);
    return {
      label,
      shouldShowChart: true,
      doesNotWork: Boolean(overlay.doesNotWork),
      reasons: overlay.reasons || [],
      pngBase64: png.toString('base64'),
    };
  } finally {
    await fs.unlink(tmp).catch(() => {});
  }
}

export function mountAdmin(app) {
  const router = express.Router();
  router.use(express.json({ limit: '2mb' }));

  router.get('/me', (req, res) => {
    const session = readSession(req);
    if (!session?.discordId) return res.json({ authenticated: false, isOwner: false });
    res.json({
      authenticated: true,
      isOwner: isBotOwner(session.discordId),
      user: {
        discordId: session.discordId,
        username: session.username,
        globalName: session.globalName ?? null,
        avatar: session.avatar ?? null,
      },
    });
  });

  router.get('/public/datasets', (_req, res) => {
    res.json({
      datasets: listDatasets().filter((item) => item.public),
    });
  });

  router.get('/public/:dataset', (req, res) => {
    try {
      const spec = publicDataset(req.params.dataset);
      if (!spec) return res.status(404).json({ error: 'Unknown dataset.' });
      const entries = listCachedEntries(req.params.dataset, req.query.q);
      const limit = Math.max(1, Math.min(5000, Number(req.query.limit) || 80));
      const offset = Math.max(0, Number(req.query.offset) || 0);
      res.json({ total: entries.length, entries: entries.slice(offset, offset + limit) });
    } catch (error) {
      jsonError(res, error);
    }
  });

  router.get('/public/:dataset/entry', (req, res) => {
    try {
      const spec = publicDataset(req.params.dataset);
      if (!spec) return res.status(404).json({ error: 'Unknown dataset.' });
      const key = entryKey(req);
      if (!key) return res.status(400).json({ error: 'Missing key.' });
      res.json({ entry: getCachedEntry(req.params.dataset, key) });
    } catch (error) {
      jsonError(res, error);
    }
  });

  router.get('/public/catalog/maps', (_req, res) => {
    const maps = (cache.maps || []).map((map) => ({
      name: map.name,
      cid: map.cid || null,
      racetrack: map.racetrack || '',
      distance_meters: map.distance_meters || '',
    }));
    const meets = (cache.champsmeets || []).map((cm) => ({
      number: cm.number,
      name: cm.name,
      map_id: cm.map_id || null,
    }));
    res.json({ maps, meets });
  });

  router.get('/public/catalog/races', (_req, res) => {
    const races = (cache.races || []).map((race) => ({
      id: race.id,
      name: race.race_name || race.id,
      grade: race.grade || '',
      date: race.date || '',
    }));
    res.json({ races });
  });

  router.post('/public/skill-preview', async (req, res) => {
    try {
      const ip = String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'local').split(',')[0].trim();
      if (!previewAllowed(ip)) return res.status(429).json({ error: 'Too many previews. Wait a minute.' });
      const body = req.body || {};
      let skill = body.skill;
      if (!skill && body.skillName) skill = getCachedEntry('skills', body.skillName);
      if (!skill || typeof skill !== 'object') return res.status(400).json({ error: 'Missing skill.' });
      res.json(await renderPreview(skill, { cmNumber: body.cmNumber, mapQuery: body.mapQuery }));
    } catch (error) {
      jsonError(res, error);
    }
  });

  router.post('/tools/conditions', (req, res) => {
    res.json(convertConditions(req.body?.input || ''));
  });
  router.post('/tools/events', (req, res) => {
    res.json({ events: parseEvents(req.body?.input || '') });
  });
  router.post('/tools/activation-map', (req, res) => {
    res.json({ activation_map: suggestActivationMap(req.body?.input || '') });
  });

  router.use(requireOwner);

  router.get('/datasets', (_req, res) => {
    res.json({ datasets: listDatasets() });
  });

  router.get('/data/:dataset/meta', async (req, res) => {
    try {
      res.json(await readDatasetHead(req.params.dataset));
    } catch (error) {
      jsonError(res, error);
    }
  });

  router.get('/data/:dataset/entry', async (req, res) => {
    try {
      const key = entryKey(req);
      if (!key) return res.status(400).json({ error: 'Missing key.' });
      if (publicDataset(req.params.dataset) || ['skills', 'supporters', 'characters'].includes(req.params.dataset)) {
        return res.json(await readEntryFromGitHub(req.params.dataset, key));
      }
      return res.status(404).json({ error: 'Unknown dataset.' });
    } catch (error) {
      jsonError(res, error);
    }
  });

  router.post('/data/:dataset/entry', async (req, res) => {
    try {
      const saved = await saveEntry(req.params.dataset, {
        creating: true,
        entry: req.body?.entry,
        afterKey: req.body?.afterKey || null,
        message: req.body?.message,
        baseBlobSha: req.body?.baseBlobSha,
        actor: req.adminUser,
      });
      res.status(201).json(saved);
    } catch (error) {
      jsonError(res, error);
    }
  });

  router.put('/data/:dataset/entry', async (req, res) => {
    try {
      const key = entryKey(req) || req.body?.key;
      if (!key) return res.status(400).json({ error: 'Missing key.' });
      const saved = await saveEntry(req.params.dataset, {
        creating: false,
        key,
        entry: req.body?.entry,
        message: req.body?.message,
        baseBlobSha: req.body?.baseBlobSha,
        actor: req.adminUser,
      });
      res.json(saved);
    } catch (error) {
      jsonError(res, error);
    }
  });

  router.delete('/data/:dataset/entry', async (req, res) => {
    try {
      const key = entryKey(req);
      const saved = await deleteEntry(req.params.dataset, {
        key,
        message: req.body?.message || req.query.message,
        baseBlobSha: req.body?.baseBlobSha || req.query.baseBlobSha,
        actor: req.adminUser,
      });
      res.json(saved);
    } catch (error) {
      jsonError(res, error);
    }
  });

  router.get('/data/:dataset/raw', async (req, res) => {
    try {
      res.json(await readRawFromGitHub(req.params.dataset));
    } catch (error) {
      jsonError(res, error);
    }
  });

  router.put('/data/:dataset/raw', async (req, res) => {
    try {
      const saved = await saveRawFile(req.params.dataset, {
        text: req.body?.text,
        message: req.body?.message,
        baseBlobSha: req.body?.baseBlobSha,
        actor: req.adminUser,
      });
      res.json(saved);
    } catch (error) {
      jsonError(res, error);
    }
  });

  router.get('/premium', (_req, res) => {
    const status = premiumGuildStatus();
    const ids = [...new Set([...status.envIds, ...status.storedIds])].sort();
    res.json({
      ...status,
      guilds: ids.map((guildId) => ({
        guildId,
        premium: isPremiumGuild(guildId),
        fromEnv: status.envIds.includes(guildId),
        stored: status.storedIds.includes(guildId),
      })),
    });
  });

  router.put('/premium/:guildId', (req, res) => {
    try {
      const guildId = String(req.params.guildId || '').trim();
      if (!/^\d+$/.test(guildId)) return res.status(400).json({ error: 'Guild ID must be digits.' });
      const enabled = req.body?.enabled === true;
      const status = premiumGuildStatus();
      if (!enabled && status.envIds.includes(guildId)) {
        return res.status(400).json({ error: 'This guild is pinned by PREMIUM_GUILD_IDS. Remove it from the environment to turn premium off.' });
      }
      setGuildPremium(guildId, enabled);
      res.json({ guildId, premium: isPremiumGuild(guildId), stored: enabled });
    } catch (error) {
      jsonError(res, error);
    }
  });

  router.get('/clubs', (_req, res) => {
    const tenants = new Map(listPublicTenants().map((row) => [String(row.guildId), row]));
    const premium = premiumGuildStatus();
    const guilds = listAllGuildClubs().map((row) => {
      const site = tenants.get(row.guildId);
      return {
        guildId: row.guildId,
        slug: site?.slug || null,
        siteName: site?.siteName || null,
        premium: isPremiumGuild(row.guildId),
        fromEnv: premium.envIds.includes(row.guildId),
        clubs: row.clubs,
      };
    });
    res.json({ guilds });
  });

  router.get('/gamba-events', (_req, res) => {
    res.json({ events: listGambaEvents() });
  });

  router.get('/gamba-events/entry', async (req, res) => {
    try {
      const key = entryKey(req);
      if (!key) return res.status(400).json({ error: 'Missing key.' });
      res.json(await readGambaEvent(key));
    } catch (error) {
      jsonError(res, error);
    }
  });

  router.put('/gamba-events/entry', async (req, res) => {
    try {
      res.json(await saveGambaEvent({
        event: req.body?.event,
        file: req.body?.file,
        creating: req.body?.creating === true,
        message: req.body?.message,
        baseBlobSha: req.body?.baseBlobSha,
        actor: req.adminUser,
      }));
    } catch (error) {
      jsonError(res, error);
    }
  });

  router.delete('/gamba-events/entry', async (req, res) => {
    try {
      res.json(await deleteGambaEvent({
        key: entryKey(req),
        message: req.body?.message || req.query.message,
        baseBlobSha: req.body?.baseBlobSha || req.query.baseBlobSha,
        actor: req.adminUser,
      }));
    } catch (error) {
      jsonError(res, error);
    }
  });

  router.post('/cache/refresh', async (_req, res) => {
    try {
      const events = reloadEventsFromDisk();
      await updateCache();
      res.json({ ok: true, events: events.length });
    } catch (error) {
      jsonError(res, error);
    }
  });

  router.get('/audit', async (req, res) => {
    try {
      res.json({ entries: await listAudit(req.query.limit) });
    } catch (error) {
      jsonError(res, error);
    }
  });

  router.use((error, _req, res, _next) => {
    jsonError(res, error);
  });

  app.use('/api/admin', router);
}
