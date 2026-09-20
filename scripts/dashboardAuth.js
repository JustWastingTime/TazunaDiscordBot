import crypto from 'crypto';
import { DiscordRequest } from './utils.js';
import { isBotOwner, hasTazunaAdminRole } from './adminRole.js';
import { isPremiumGuild } from './clubDatabase.js';
import { listStaffExtra } from './dashboardStore.js';

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

export async function resolveDashboardAccess(guildId, discordId) {
  const id = String(discordId);
  if (isBotOwner(id)) {
    return { isManager: true, isOwner: true, label: 'Owner', source: 'owner' };
  }
  try {
    const member = await fetchGuildMember(guildId, id);
    if (await hasTazunaAdminRole(guildId, member)) {
      return { isManager: true, isOwner: false, label: 'Admin', source: 'role' };
    }
  } catch (err) {
    console.warn(`[dashboard] member lookup failed guild=${guildId} user=${id}:`, err.message);
  }
  const extra = listStaffExtra(guildId).find((row) => String(row.discordId) === id);
  if (extra) {
    return { isManager: true, isOwner: false, label: extra.label || 'Staff', source: 'staff' };
  }
  return { isManager: false, isOwner: false, label: null, source: null };
}

export function requirePremiumGuild(guildId) {
  if (!guildId || !isPremiumGuild(guildId)) {
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
