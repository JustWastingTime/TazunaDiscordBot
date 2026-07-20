import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.resolve(__dirname, '..', 'data');
const SIGNUPS_PATH = path.join(DATA_DIR, 'signups.json');

function ensureDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function readJson(filePath, fallback) {
  ensureDataDir();
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    throw err;
  }
}

function writeJson(filePath, data) {
  ensureDataDir();
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

function loadStore() {
  return readJson(SIGNUPS_PATH, {});
}

function saveStore(store) {
  writeJson(SIGNUPS_PATH, store);
}

export function createSignup({
  id: providedId,
  name,
  guildId,
  channelId,
  messageId,
  hours,
  endsAt: providedEndsAt,
  createdBy,
}) {
  const id = providedId ? String(providedId) : crypto.randomBytes(6).toString('hex');
  const createdAt = new Date().toISOString();
  const endsAt = providedEndsAt
    ? new Date(providedEndsAt).toISOString()
    : new Date(Date.now() + Number(hours) * 60 * 60 * 1000).toISOString();
  const signup = {
    id,
    name: String(name),
    guildId: String(guildId),
    channelId: String(channelId),
    messageId: String(messageId),
    hours: Number(hours),
    createdAt,
    endsAt,
    createdBy: createdBy ? String(createdBy) : null,
    status: 'open',
    closedAt: null,
    registrants: [],
  };

  const store = loadStore();
  store[id] = signup;
  saveStore(store);
  return signup;
}

export function newSignupId() {
  return crypto.randomBytes(6).toString('hex');
}

export function getSignup(id) {
  if (!id) return null;
  const store = loadStore();
  return store[String(id)] || null;
}

export function listOpenSignups() {
  return Object.values(loadStore()).filter((signup) => signup.status === 'open');
}

export function saveSignup(signup) {
  if (!signup?.id) throw new Error('signup.id is required');
  const store = loadStore();
  store[signup.id] = signup;
  saveStore(store);
  return signup;
}

export function toggleRegistrant(signupId, userId, displayName) {
  const signup = getSignup(signupId);
  if (!signup) return { ok: false, error: 'Signup not found.' };
  if (signup.status !== 'open') {
    return { ok: false, error: 'Signup is closed.' };
  }
  if (Date.now() >= new Date(signup.endsAt).getTime()) {
    return { ok: false, error: 'Signup has expired.', expired: true, signup };
  }

  const existingIndex = signup.registrants.findIndex((r) => r.userId === String(userId));
  if (existingIndex >= 0) {
    signup.registrants.splice(existingIndex, 1);
    saveSignup(signup);
    return { ok: true, action: 'cancelled', signup };
  }

  signup.registrants.push({
    userId: String(userId),
    displayName: String(displayName || 'Unknown'),
    signedUpAt: new Date().toISOString(),
  });
  saveSignup(signup);
  return { ok: true, action: 'signed_up', signup };
}

export function closeSignup(signupId) {
  const signup = getSignup(signupId);
  if (!signup) return null;
  if (signup.status === 'closed') return signup;

  signup.status = 'closed';
  signup.closedAt = new Date().toISOString();
  return saveSignup(signup);
}
