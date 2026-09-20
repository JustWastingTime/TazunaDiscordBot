import crypto from 'crypto';
import { DiscordRequest } from './utils.js';
import { isBotOwner, hasTazunaAdminRole } from './adminRole.js';
import { isPremiumGuild } from './clubDatabase.js';
import { listStaffExtra } from './dashboardStore.js';
import {
  DEFAULT_FEATURES,
  getManagerEntry,
  getSite,
  getStoredFeatureOverrides,
  listClubsForDiscordUser,
} from './dashboardStore.js';

export const SESSION_COOKIE = 'tazuna_dashboard_session';

function sessionSecret() {
  const value = String(process.env.DASHBOARD_SESSION_SECRET || process.env.SESSION_SECRET || '').trim();
  if (!value) throw new Error('DASHBOARD_SESSION_SECRET (or SESSION_SECRET) is not configured.');
  return value;
}

export function siteUrl(req) {
  const configured = String(process.env.DASHBOARD_PUBLIC_URL || process.env.SITE_URL || '').trim().replace(/\/$/, '');
  if (configured) return configured;
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const proto = req.headers['x-forwarded-proto'] || (req.secure ? 'https' : 'http');
  return `${proto}://${host}`;
}

function parseCookies(req) {
  const header = String(req.headers.cookie || '');
  const out = {};
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (key) out[key] = decodeURIComponent(value);
  }
  return out;
}

export function signSession(user) {
  const payload = Buffer.from(JSON.stringify(user), 'utf8').toString('base64url');
  const sig = crypto.createHmac('sha256', sessionSecret()).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

export function readSession(req) {
  const token = parseCookies(req)[SESSION_COOKIE];
  if (!token || !token.includes('.')) return null;
  const [payload, sig] = token.split('.');
  const expected = crypto.createHmac('sha256', sessionSecret()).update(payload).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const user = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!user?.discordId) return null;
    if (user.exp && Date.now() > user.exp) return null;
    return user;
  } catch {
    return null;
  }
}

export function setSessionCookie(res, token) {
  const secure = process.env.NODE_ENV === 'production' || reqIsHttps();
  res.append('Set-Cookie', [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    'HttpOnly',
    'Path=/',
    'SameSite=Lax',
    'Max-Age=1209600',
    secure ? 'Secure' : '',
  ].filter(Boolean).join('; '));
}

function reqIsHttps() {
  return String(process.env.DASHBOARD_PUBLIC_URL || process.env.SITE_URL || '').startsWith('https');
}

export function clearSessionCookie(res) {
  const secure = process.env.NODE_ENV === 'production' || reqIsHttps();
  res.append('Set-Cookie', [
    `${SESSION_COOKIE}=`,
    'HttpOnly',
    'Path=/',
    'SameSite=Lax',
    'Max-Age=0',
    secure ? 'Secure' : '',
  ].filter(Boolean).join('; '));
}

export function safeReturnTo(value, fallback = '/') {
  const raw = String(value || '').trim();
  if (!raw.startsWith('/') || raw.startsWith('//') || raw.includes('://')) return fallback;
  return raw;
}

export async function fetchGuildMember(guildId, userId) {
  const res = await DiscordRequest(`guilds/${guildId}/members/${userId}`, { method: 'GET' });
  return res.json();
}

/**
 * Who this Discord user is on this network, and which clubs they may see.
 * `clubIds: null` means every club in the network; an array scopes them.
 */
export async function resolveDashboardAccess(guildId, discordId) {
  const id = String(discordId);
  if (isBotOwner(id)) {
    return { isManager: true, isOwner: true, label: 'Owner', source: 'owner', clubIds: null };
  }
  const entry = getManagerEntry(guildId, id);
  if (entry) {
    return {
      isManager: true,
      isOwner: entry.role === 'owner',
      label: entry.label || 'Manager',
      source: 'manager',
      clubIds: Array.isArray(entry.clubIds) && entry.clubIds.length ? entry.clubIds.map(String) : null,
    };
  }
  try {
    const member = await fetchGuildMember(guildId, id);
    if (await hasTazunaAdminRole(guildId, member)) {
      return { isManager: true, isOwner: false, label: 'Admin', source: 'role', clubIds: null };
    }
  } catch (err) {
    console.warn(`[dashboard] member lookup failed guild=${guildId} user=${id}:`, err.message);
  }
  const extra = listStaffExtra(guildId).find((row) => String(row.discordId) === id);
  if (extra) {
    return {
      isManager: true,
      isOwner: false,
      label: extra.label || 'Staff',
      source: 'staff',
      clubIds: Array.isArray(extra.clubIds) && extra.clubIds.length ? extra.clubIds.map(String) : null,
    };
  }
  // Regular member: scope to the clubs their linked trainer is currently in.
  return {
    isManager: false,
    isOwner: false,
    label: null,
    source: null,
    clubIds: listClubsForDiscordUser(guildId, id),
  };
}

/** Features a network is entitled to. Overview is always on; the rest need premium. */
export function resolveFeatures(guildId) {
  const site = guildId ? getSite(guildId) : null;
  const premium = Boolean(guildId) && (isPremiumGuild(guildId) || site?.premium === true);
  const stored = guildId ? getStoredFeatureOverrides(guildId) : {};
  // Overview is always on. Every other feature requires premium, and a premium
  // network can still switch an individual feature off explicitly.
  const features = { overview: true };
  for (const key of Object.keys(DEFAULT_FEATURES)) {
    if (key === 'overview') continue;
    features[key] = premium && (typeof stored[key] === 'boolean' ? stored[key] : true);
  }
  return features;
}

export function hasFeature(guildId, feature) {
  return resolveFeatures(guildId)[feature] === true;
}

/** Gate a single premium feature without locking the whole dashboard. */
export function requireFeature(guildId, feature) {
  if (!guildId || !hasFeature(guildId, feature)) {
    const err = new Error(
      feature === 'overview'
        ? 'This club dashboard is not available.'
        : 'This feature is part of Tazuna premium.',
    );
    err.statusCode = 403;
    throw err;
  }
}

export function requirePremiumGuild(guildId) {
  const entitled = Boolean(guildId) && (isPremiumGuild(guildId) || getSite(guildId).premium === true);
  if (!entitled) {
    const err = new Error('This club dashboard is a Tazuna premium feature.');
    err.statusCode = 403;
    throw err;
  }
}

export function jsonError(res, error, fallback = 'Unexpected server error.') {
  const status = Number(error?.statusCode) || 500;
  const message = error instanceof Error ? error.message : fallback;
  if (status >= 500) console.error(error);
  return res.status(status).json({ error: message || fallback });
}
