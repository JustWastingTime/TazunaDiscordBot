import { isBotOwner } from './adminRole.js';
import { readSession, siteUrl } from './dashboardAuth.js';

const writes = new Map();
const WRITE_LIMIT = 30;
const WRITE_WINDOW_MS = 60_000;

export function httpError(statusCode, message) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

export function assertWriteOrigin(req) {
  if (!originAllowed(req)) throw httpError(403, 'Origin rejected.');
}

function originAllowed(req) {
  const origin = String(req.headers.origin || '').trim();
  if (!origin) return true;

  const allowed = new Set();
  const configured = String(process.env.DASHBOARD_PUBLIC_URL || process.env.SITE_URL || '').trim().replace(/\/$/, '');
  if (configured) allowed.add(configured);
  try {
    allowed.add(siteUrl(req));
  } catch {
    // siteUrl only throws when nothing can be inferred; the header check still applies.
  }

  if (process.env.NODE_ENV !== 'production') {
    try {
      const host = new URL(origin).hostname;
      if (host === 'localhost' || host === '127.0.0.1') return true;
    } catch {
      return false;
    }
  }
  return allowed.has(origin);
}

function rateLimit(discordId) {
  const now = Date.now();
  const recent = (writes.get(discordId) || []).filter((ts) => now - ts < WRITE_WINDOW_MS);
  if (recent.length >= WRITE_LIMIT) {
    throw httpError(429, 'Too many saves. Wait a minute and try again.');
  }
  recent.push(now);
  writes.set(discordId, recent);
}

/** Owner session required. Mutations also need the CSRF header and a matching Origin. */
export function requireOwner(req, _res, next) {
  try {
    const mutating = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method);
    if (mutating) {
      if (String(req.headers['x-tazuna-admin'] || '') !== '1') {
        throw httpError(403, 'Missing admin header.');
      }
      if (!originAllowed(req)) {
        throw httpError(403, 'Origin rejected.');
      }
    }
    const session = readSession(req);
    if (!session?.discordId) throw httpError(401, 'Discord login required.');
    if (!isBotOwner(session.discordId)) throw httpError(403, 'Owner only.');
    if (mutating) rateLimit(session.discordId);
    req.adminUser = session;
    next();
  } catch (error) {
    next(error);
  }
}
