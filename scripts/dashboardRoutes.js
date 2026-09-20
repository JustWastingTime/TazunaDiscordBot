import fs from 'fs';
import path from 'path';
import express from 'express';
import { fileURLToPath } from 'url';
import {
  applicationToDashboard,
  createApplication,
  deleteApplication,
  findGuildApplicationByUmaId,
  listGuildApplications,
  newApplicationId,
  patchApplication,
} from './applicationStorage.js';
import { isPremiumGuild } from './clubDatabase.js';
import {
  addBlacklist,
  addStaffExtra,
  clearTournamentPick,
  confirmPlanning,
  createTournament,
  deleteBlacklist,
  deleteTournament,
  findBlacklistMatch,
  getMembersCache,
  getPlanning,
  getSite,
  getTournamentBoard,
  listBlacklist,
  listMemberDirectory,
  listMemberLinks,
  listPublicTenants,
  listStaffExtra,
  listTournaments,
  listTournamentsForUser,
  removeStaffExtra,
  replaceTournamentRoster,
  resolveGuildRef,
  savePlanning,
  saveSite,
  saveTournamentPick,
  seedClubSettings,
  setMembersCache,
  updateTournament,
  upsertClubSettings,
  upsertMemberLink,
} from './dashboardStore.js';
import {
  cacheTtlMs,
  buildPublicClub,
  hydrateClubTargets,
  listGuildDashboardClubs,
  resolveUmaProfile,
} from './dashboardUma.js';
import {
  clearSessionCookie,
  jsonError,
  readSession,
  requirePremiumGuild,
  resolveDashboardAccess,
  safeReturnTo,
  setSessionCookie,
  signSession,
  siteUrl,
} from './dashboardAuth.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function tenantFromReq(req) {
  return resolveGuildRef(req.query.guild || req.headers['x-tazuna-guild'] || req.body?.guild);
}

function tenantPath(guildId) {
  const site = getSite(guildId);
  return `/g/${site.slug || guildId}`;
}

async function requirePremiumTenant(req) {
  const guildId = tenantFromReq(req);
  if (!guildId) {
    const err = new Error('Missing guild.');
    err.statusCode = 400;
    throw err;
  }
  requirePremiumGuild(guildId);
  return guildId;
}

async function buildSessionUser(guildId, base) {
  const access = await resolveDashboardAccess(guildId, base.discordId);
  const clubs = listGuildDashboardClubs(guildId);
  return {
    discordId: base.discordId,
    username: base.username,
    globalName: base.globalName ?? null,
    avatar: base.avatar ?? null,
    clubIds: clubs.map((club) => club.circleId),
    label: access.label || base.username,
    isManager: access.isManager,
    isOwner: access.isOwner,
  };
}

async function requireUser(req, res) {
  const guildId = await requirePremiumTenant(req);
  const session = readSession(req);
  if (!session?.discordId) {
    res.status(401).json({ error: 'Discord login required.' });
    return null;
  }
  const user = await buildSessionUser(guildId, session);
  return { guildId, user };
}

async function requireManager(req, res) {
  const ctx = await requireUser(req, res);
  if (!ctx) return null;
  if (!ctx.user.isManager) {
    res.status(401).json({ error: 'Discord manager login required.' });
    return null;
  }
  return ctx;
}

async function publicDashboardPayload(guildId) {
  requirePremiumGuild(guildId);
  const cached = getMembersCache(guildId);
  if (cached?.payload && Date.now() - Number(cached.savedAt || 0) < cacheTtlMs()) {
    return cached.payload;
  }
  const clubs = await hydrateClubTargets(guildId, listGuildDashboardClubs(guildId));
  const built = [];
  for (const club of clubs) {
    try {
      built.push(await buildPublicClub(guildId, club));
    } catch (error) {
      console.error(`Failed to load club ${club.circleId}`, error);
      built.push({
        ...club,
        members: [],
        rank: null,
        yesterdayRank: null,
        rankDelta: null,
        lastMonthRank: null,
        monthlyFans: null,
        fansSinceYesterday: null,
        rankGrade: club.rankGrade || null,
        sourceUpdatedAt: null,
      });
    }
  }
  const applicants = listGuildApplications(guildId)
    .filter((app) => app.publishPublicly !== false && ['pending', 'approved', 'waitlisted'].includes(app.status))
    .map(applicationToDashboard);
  const site = getSite(guildId);
  const payload = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    source: 'uma.moe',
    guildId,
    slug: site.slug,
    site,
    theme: site.theme || 'slate',
    clubs: built,
    applicants,
  };
  await setMembersCache(guildId, payload);
  return payload;
}

function findCharacter(characterId) {
  const id = String(characterId || '').trim();
  if (!id) return null;
  return { id, characterName: id.split(' - ').slice(1).join(' - ') || id };
}

export function mountDashboard(app) {
  const seedGuild = String(process.env.DASHBOARD_SEED_GUILD_ID || '').trim();
  if (seedGuild) {
    try {
      const clubsPath = path.resolve(__dirname, '../../UmaClubDashboard/config/clubs.json');
      const payload = JSON.parse(fs.readFileSync(clubsPath, 'utf8'));
      seedClubSettings(seedGuild, payload.clubs || []);
      console.log(`Dashboard seeded club settings for guild ${seedGuild}`);
    } catch (err) {
      console.warn('Dashboard seed skipped:', err.message);
    }
  }

  const api = express.Router();
  api.use(express.json({ limit: '256kb' }));

  api.get('/health', (_req, res) => res.json({ ok: true, dashboard: true }));

  api.get('/public/tenants', (_req, res) => {
    const tenants = listPublicTenants().filter((row) => isPremiumGuild(row.guildId));
    res.json({ tenants });
  });

  api.get('/public/dashboard', async (req, res) => {
    try {
      const guildId = await requirePremiumTenant(req);
      res.json(await publicDashboardPayload(guildId));
    } catch (error) {
      jsonError(res, error);
    }
  });

  api.get('/apply', async (req, res) => {
    try {
      const guildId = await requirePremiumTenant(req);
      const clubs = listGuildDashboardClubs(guildId);
      res.json({ clubs: clubs.map((club) => ({ circleId: club.circleId, name: club.name })) });
    } catch (error) {
      jsonError(res, error);
    }
  });

  api.post('/apply', async (req, res) => {
    try {
      const guildId = await requirePremiumTenant(req);
      const umaId = String(req.body?.umaId || '').trim();
      const discordUsername = String(req.body?.discordUsername || '').trim();
      const targetClubId = String(req.body?.targetClubId || '').trim();
      const notes = String(req.body?.notes || '').trim();
      if (!/^\d+$/.test(umaId)) return res.status(400).json({ error: 'Uma ID must contain only digits.' });
      if (discordUsername.length < 2) return res.status(400).json({ error: 'Discord username is required.' });
      const clubs = listGuildDashboardClubs(guildId);
      const club = clubs.find((item) => item.circleId === targetClubId);
      if (!club) return res.status(400).json({ error: 'Selected club is not accepting applications.' });
      if (findBlacklistMatch(guildId, umaId, discordUsername)) {
        return res.status(403).json({ error: getSite(guildId).applyBlocked });
      }
      const profile = await resolveUmaProfile(umaId);
      const existing = findGuildApplicationByUmaId(guildId, umaId);
      const id = existing?.id || newApplicationId();
      const record = existing
        ? patchApplication(id, {
          ign: profile.ign,
          club: club.name,
          targetClubId: club.circleId,
          discordUsername,
          privateNotes: notes,
          reason: notes || existing.reason,
          status: 'pending',
          publishPublicly: true,
          ...profile,
          performanceSyncedAt: new Date().toISOString(),
        })
        : createApplication({
          id,
          guildId,
          channelId: null,
          messageId: null,
          applicantId: null,
          ign: profile.ign,
          gameId: umaId,
          club: club.name,
          reason: notes || null,
          discordUsername,
          privateNotes: notes,
          targetClubId: club.circleId,
          ...profile,
          performanceSyncedAt: new Date().toISOString(),
        });
      res.status(201).json({
        ok: true,
        applicant: {
          umaId: record.gameId,
          ign: record.ign,
          targetClubId: record.targetClubId,
          status: record.status,
        },
      });
    } catch (error) {
      jsonError(res, error);
    }
  });

  api.get('/auth/login', (req, res) => {
    try {
      const clientId = String(process.env.DISCORD_CLIENT_ID || process.env.APP_ID || '').trim();
      if (!clientId) throw new Error('DISCORD_CLIENT_ID is not configured.');
      const returnTo = safeReturnTo(req.query.returnTo, '/');
      const redirectUri = `${siteUrl(req)}/api/auth/callback`;
      const params = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: 'identify',
        state: returnTo,
      });
      if (req.query.force === '1') params.set('prompt', 'consent');
      res.redirect(`https://discord.com/api/oauth2/authorize?${params}`);
    } catch (error) {
      jsonError(res, error);
    }
  });

  api.get('/auth/callback', async (req, res) => {
    const returnTo = safeReturnTo(req.query.state, '/');
    const failStaff = returnTo.includes('/staff') ? `${returnTo.split('?')[0]}?error=login_failed` : `${returnTo}?error=login_failed`;
    try {
      const code = String(req.query.code || '');
      if (!code) throw new Error('Missing Discord OAuth code.');
      const clientId = String(process.env.DISCORD_CLIENT_ID || process.env.APP_ID || '').trim();
      const clientSecret = String(process.env.DISCORD_CLIENT_SECRET || '').trim();
      if (!clientId || !clientSecret) throw new Error('Discord OAuth is not configured.');
      const redirectUri = `${siteUrl(req)}/api/auth/callback`;
      const tokenResponse = await fetch('https://discord.com/api/oauth2/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: clientId,
          client_secret: clientSecret,
          grant_type: 'authorization_code',
          code,
          redirect_uri: redirectUri,
        }),
      });
      if (!tokenResponse.ok) throw new Error('Discord token exchange failed.');
      const token = await tokenResponse.json();
      const meResponse = await fetch('https://discord.com/api/users/@me', {
        headers: { Authorization: `Bearer ${token.access_token}` },
      });
      if (!meResponse.ok) throw new Error('Could not load Discord profile.');
      const me = await meResponse.json();
      const guildMatch = String(returnTo).match(/^\/g\/([^/]+)/);
      const guildId = guildMatch ? resolveGuildRef(guildMatch[1]) : tenantFromReq(req);
      const user = {
        discordId: me.id,
        username: me.username,
        globalName: me.global_name ?? null,
        avatar: me.avatar ?? null,
        exp: Date.now() + 14 * 24 * 60 * 60 * 1000,
      };
      if (returnTo.includes('/staff') && guildId) {
        requirePremiumGuild(guildId);
        const access = await resolveDashboardAccess(guildId, me.id);
        if (!access.isManager) {
          res.redirect(`${tenantPath(guildId)}/staff?error=unauthorized`);
          return;
        }
      }
      setSessionCookie(res, signSession(user));
      res.redirect(returnTo);
    } catch (error) {
      console.error(error);
      res.redirect(failStaff);
    }
  });

  api.get('/auth/me', async (req, res) => {
    try {
      const session = readSession(req);
      if (!session) return res.json({ authenticated: false });
      let guildId = null;
      try {
        guildId = tenantFromReq(req);
      } catch {
        guildId = null;
      }
      if (!guildId) {
        return res.json({ authenticated: true, user: session });
      }
      requirePremiumGuild(guildId);
      const user = await buildSessionUser(guildId, session);
      res.json({ authenticated: true, user, theme: getSite(guildId).theme });
    } catch (error) {
      jsonError(res, error);
    }
  });

  api.post('/auth/me', (_req, res) => {
    clearSessionCookie(res);
    res.json({ ok: true });
  });

  api.get('/applicants', async (req, res) => {
    try {
      const ctx = await requireManager(req, res);
      if (!ctx) return;
      const clubs = listGuildDashboardClubs(ctx.guildId);
      const byName = new Map(clubs.map((club) => [club.name.toLowerCase(), club.circleId]));
      const applicants = listGuildApplications(ctx.guildId).map((app) => {
        const row = applicationToDashboard(app);
        if (!row.targetClubId || !clubs.some((club) => club.circleId === row.targetClubId)) {
          row.targetClubId = byName.get(String(app.club || '').toLowerCase()) || row.targetClubId;
        }
        return row;
      });
      res.json({ applicants, user: ctx.user });
    } catch (error) {
      jsonError(res, error);
    }
  });

  api.post('/applicants', async (req, res) => {
    try {
      const ctx = await requireManager(req, res);
      if (!ctx) return;
      const umaId = String(req.body?.umaId || '').trim();
      const targetClubId = String(req.body?.targetClubId || '').trim();
      const clubs = listGuildDashboardClubs(ctx.guildId);
      const club = clubs.find((item) => item.circleId === targetClubId);
      if (!club) return res.status(400).json({ error: 'Target club does not exist.' });
      const profile = await resolveUmaProfile(umaId);
      const existing = findGuildApplicationByUmaId(ctx.guildId, umaId);
      const id = existing?.id || newApplicationId();
      const record = existing
        ? patchApplication(id, {
          ign: req.body.ign || profile.ign,
          club: club.name,
          targetClubId,
          status: req.body.status || existing.status,
          privateNotes: req.body.privateNotes ?? existing.privateNotes,
          publishPublicly: req.body.publishPublicly !== false,
          discordUsername: req.body.discordUsername ?? existing.discordUsername,
          ...profile,
          performanceSyncedAt: new Date().toISOString(),
        })
        : createApplication({
          id,
          guildId: ctx.guildId,
          ign: req.body.ign || profile.ign,
          gameId: umaId,
          club: club.name,
          targetClubId,
          privateNotes: req.body.privateNotes || '',
          discordUsername: req.body.discordUsername || '',
          publishPublicly: req.body.publishPublicly !== false,
          ...profile,
          performanceSyncedAt: new Date().toISOString(),
        });
      res.status(201).json(applicationToDashboard(record));
    } catch (error) {
      jsonError(res, error);
    }
  });

  api.patch('/applicants', async (req, res) => {
    try {
      const ctx = await requireManager(req, res);
      if (!ctx) return;
      const umaId = String(req.query.umaId || '').trim();
      const existing = findGuildApplicationByUmaId(ctx.guildId, umaId);
      if (!existing) return res.status(404).json({ error: 'Applicant not found.' });
      const patched = patchApplication(existing.id, {
        status: req.body.status ?? existing.status,
        privateNotes: req.body.privateNotes ?? existing.privateNotes,
        publishPublicly: req.body.publishPublicly ?? existing.publishPublicly,
        targetClubId: req.body.targetClubId ?? existing.targetClubId,
        ign: req.body.ign ?? existing.ign,
        discordUsername: req.body.discordUsername ?? existing.discordUsername,
      });
      res.json(applicationToDashboard(patched));
    } catch (error) {
      jsonError(res, error);
    }
  });

  api.delete('/applicants', async (req, res) => {
    try {
      const ctx = await requireManager(req, res);
      if (!ctx) return;
      const existing = findGuildApplicationByUmaId(ctx.guildId, req.query.umaId);
      if (!existing) return res.status(404).end();
      deleteApplication(existing.id);
      res.status(204).end();
    } catch (error) {
      jsonError(res, error);
    }
  });

  api.get('/clubs', async (req, res) => {
    try {
      const ctx = await requireManager(req, res);
      if (!ctx) return;
      if (req.query.profile) {
        const profile = await resolveUmaProfile(String(req.query.profile));
        return res.json(profile);
      }
      const clubs = await hydrateClubTargets(ctx.guildId, listGuildDashboardClubs(ctx.guildId));
      res.json({
        clubs,
        memberLinks: listMemberLinks(ctx.guildId),
        directory: listMemberDirectory(ctx.guildId),
        user: ctx.user,
        theme: getSite(ctx.guildId).theme,
        staff: [
          ...(ctx.user.isOwner ? [{ discordId: ctx.user.discordId, label: ctx.user.label, source: 'owner', clubIds: ctx.user.clubIds }] : []),
          ...listStaffExtra(ctx.guildId).map((row) => ({ ...row, source: 'staff', clubIds: ctx.user.clubIds })),
        ],
        site: getSite(ctx.guildId),
      });
    } catch (error) {
      jsonError(res, error);
    }
  });

  api.put('/clubs', async (req, res) => {
    try {
      const ctx = await requireManager(req, res);
      if (!ctx) return;
      if (req.body?.site === true) {
        const site = await saveSite(ctx.guildId, { theme: req.body.theme });
        return res.json({ theme: site.theme });
      }
      if (req.body?.staff === true) {
        if (req.body.remove) {
          await removeStaffExtra(ctx.guildId, req.body.discordId);
          return res.json({ ok: true, discordId: req.body.discordId });
        }
        const staff = await addStaffExtra(ctx.guildId, req.body);
        return res.json({ staff: { ...staff, source: 'staff', clubIds: ctx.user.clubIds } });
      }
      if (req.body?.link === true || req.query.link === '1') {
        const saved = await upsertMemberLink(ctx.guildId, req.body.umaId, req.body.discordId);
        return res.json({ umaId: req.body.umaId, discordId: saved?.discordId || null });
      }
      const circleId = String(req.query.circleId || req.body.circleId || '');
      const settings = await upsertClubSettings(ctx.guildId, circleId, {
        dailyTarget: req.body.dailyTarget,
        promotionRatio: req.body.promotionRatio,
        severeRatio: req.body.severeRatio,
        inactiveDays: req.body.inactiveDays,
        promotionEnabled: req.body.promotionEnabled,
        rankGrade: req.body.rankGrade ?? null,
        name: req.body.name,
      });
      res.json({ circleId, ...settings, name: req.body.name });
    } catch (error) {
      jsonError(res, error);
    }
  });

  api.get('/planning', async (req, res) => {
    try {
      const ctx = await requireManager(req, res);
      if (!ctx) return;
      const plan = getPlanning(ctx.guildId);
      res.json({
        ...plan,
        clubs: listGuildDashboardClubs(ctx.guildId),
        user: ctx.user,
      });
    } catch (error) {
      jsonError(res, error);
    }
  });

  api.put('/planning', async (req, res) => {
    try {
      const ctx = await requireManager(req, res);
      if (!ctx) return;
      const plan = await savePlanning(ctx.guildId, req.body.assignments || []);
      res.json(plan);
    } catch (error) {
      jsonError(res, error);
    }
  });

  api.post('/planning', async (req, res) => {
    try {
      const ctx = await requireManager(req, res);
      if (!ctx) return;
      if (req.query.action === 'confirm') {
        return res.json(await confirmPlanning(ctx.guildId));
      }
      res.status(400).json({ error: 'Unknown planning action.' });
    } catch (error) {
      jsonError(res, error);
    }
  });

  api.get('/blacklist', async (req, res) => {
    try {
      const ctx = await requireManager(req, res);
      if (!ctx) return;
      res.json({ entries: listBlacklist(ctx.guildId), user: ctx.user });
    } catch (error) {
      jsonError(res, error);
    }
  });

  api.post('/blacklist', async (req, res) => {
    try {
      const ctx = await requireManager(req, res);
      if (!ctx) return;
      const entry = await addBlacklist(ctx.guildId, {
        ...req.body,
        createdBy: ctx.user.discordId,
      });
      res.status(201).json(entry);
    } catch (error) {
      jsonError(res, error);
    }
  });

  api.delete('/blacklist', async (req, res) => {
    try {
      const ctx = await requireManager(req, res);
      if (!ctx) return;
      const ok = await deleteBlacklist(ctx.guildId, req.query.id);
      res.status(ok ? 204 : 404).end();
    } catch (error) {
      jsonError(res, error);
    }
  });

  api.get('/tournaments', async (req, res) => {
    try {
      const ctx = await requireManager(req, res);
      if (!ctx) return;
      const id = Number(req.query.id);
      if (Number.isInteger(id) && id > 0) {
        const board = getTournamentBoard(ctx.guildId, id);
        if (!board) return res.status(404).json({ error: 'Tournament not found.' });
        return res.json({ ...board, user: ctx.user });
      }
      res.json({ tournaments: listTournaments(ctx.guildId), user: ctx.user });
    } catch (error) {
      jsonError(res, error);
    }
  });

  api.post('/tournaments', async (req, res) => {
    try {
      const ctx = await requireManager(req, res);
      if (!ctx) return;
      const tournament = await createTournament(ctx.guildId, req.body);
      res.status(201).json(tournament);
    } catch (error) {
      jsonError(res, error);
    }
  });

  api.put('/tournaments', async (req, res) => {
    try {
      const ctx = await requireManager(req, res);
      if (!ctx) return;
      const id = Number(req.query.id || req.body?.id);
      if (req.query.roster === '1' || req.body?.roster === true) {
        const players = await replaceTournamentRoster(ctx.guildId, id, req.body.players || []);
        return res.json({ players });
      }
      const tournament = await updateTournament(ctx.guildId, id, req.body);
      if (!tournament) return res.status(404).json({ error: 'Tournament not found.' });
      res.json(tournament);
    } catch (error) {
      jsonError(res, error);
    }
  });

  api.delete('/tournaments', async (req, res) => {
    try {
      const ctx = await requireManager(req, res);
      if (!ctx) return;
      const ok = await deleteTournament(ctx.guildId, req.query.id);
      res.status(ok ? 204 : 404).end();
    } catch (error) {
      jsonError(res, error);
    }
  });

  api.get('/tourney', async (req, res) => {
    try {
      const ctx = await requireUser(req, res);
      if (!ctx) return;
      const id = Number(req.query.id);
      if (Number.isInteger(id) && id > 0) {
        const board = getTournamentBoard(ctx.guildId, id);
        if (!board) return res.status(404).json({ error: 'Tournament not found.' });
        const onRoster = board.players.some((player) => player.discordId === ctx.user.discordId);
        if (!ctx.user.isManager && !onRoster) {
          return res.status(403).json({ error: 'You are not on this tournament roster.' });
        }
        return res.json({
          ...board,
          canEditAll: Boolean(ctx.user.isManager),
          locked: board.tournament.locked,
          user: ctx.user,
        });
      }
      res.json({
        tournaments: listTournamentsForUser(ctx.guildId, ctx.user.discordId, ctx.user.isManager),
        user: ctx.user,
      });
    } catch (error) {
      jsonError(res, error);
    }
  });

  api.put('/tourney', async (req, res) => {
    try {
      const ctx = await requireUser(req, res);
      if (!ctx) return;
      const input = req.body || {};
      const updatedBy = ctx.user.label || ctx.user.globalName || ctx.user.username;
      if (input.characterId == null || input.characterId === '') {
        await clearTournamentPick(ctx.guildId, {
          tournamentId: input.tournamentId,
          playerId: input.playerId,
          round: input.round,
          actorDiscordId: ctx.user.discordId,
          isManager: Boolean(ctx.user.isManager),
        });
        return res.json({ ok: true, cleared: true });
      }
      const character = findCharacter(input.characterId);
      if (!character) return res.status(400).json({ error: 'Unknown character selection.' });
      const pick = await saveTournamentPick(ctx.guildId, {
        tournamentId: input.tournamentId,
        playerId: input.playerId,
        round: input.round,
        characterId: character.id,
        characterName: character.characterName,
        updatedBy,
        actorDiscordId: ctx.user.discordId,
        isManager: Boolean(ctx.user.isManager),
      });
      res.json({ ok: true, pick: { ...pick, label: character.characterName } });
    } catch (error) {
      jsonError(res, error);
    }
  });

  app.use('/api', api);

  const distCandidates = [
    path.resolve(__dirname, '../web/dashboard'),
    path.resolve(__dirname, '../../UmaClubDashboard/dist'),
  ];
  const dist = distCandidates.find((dir) => fs.existsSync(path.join(dir, 'index.html')));
  if (dist) {
    app.use(express.static(dist));
    app.get(['/g/:tenant', '/staff', '/tourney', '/apply'], (_req, res) => {
      res.sendFile(path.join(dist, 'index.html'));
    });
    app.use((req, res, next) => {
      if (req.method !== 'GET') return next();
      if (req.path.startsWith('/api') || req.path.startsWith('/assets') || req.path === '/interactions') return next();
      if (req.path.startsWith('/g/')) {
        return res.sendFile(path.join(dist, 'index.html'));
      }
      return next();
    });
    console.log(`Dashboard UI serving from ${dist}`);
  } else {
    app.get(['/g/:tenant', '/g/:tenant/*'], (req, res) => {
      const guildId = resolveGuildRef(req.params.tenant);
      res.type('html').send(`<!doctype html><meta charset="utf-8"><title>Tazuna dashboard</title>
        <p>Premium dashboard API is running for this bot. Build the UmaClubDashboard frontend into <code>web/dashboard</code> (or <code>UmaClubDashboard/dist</code>) and restart.</p>
        <p>API: <a href="/api/public/dashboard?guild=${encodeURIComponent(guildId || '')}">/api/public/dashboard</a></p>`);
    });
  }
}

export function dashboardPublicUrl(guildId) {
  const base = String(process.env.DASHBOARD_PUBLIC_URL || process.env.SITE_URL || '').replace(/\/$/, '');
  if (!base || !guildId) return null;
  const site = getSite(guildId);
  return `${base}/g/${site.slug || guildId}`;
}
