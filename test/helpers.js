// Shared setup for the bot's tests. Each test file runs in its own process
// (node --test), so every file gets a fresh app, data folder and fetch stub.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
// Discord sends the raw 32-byte key as hex; the SPKI DER form ends with those bytes.
const publicKeyHex = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex');

export const OWNER_ID = '100000000000000001';
export const USER_ID = '200000000000000002';
export const GUILD_ID = '300000000000000003';
export const SESSION_SECRET = 'test-session-secret';

/** Requests the app tried to make to anything other than the test server. */
export const outboundRequests = [];

let started = null;

function configureEnv(dataDir) {
  Object.assign(process.env, {
    // Never pick up a developer's real .env (tokens, API keys) during tests.
    DOTENV_CONFIG_PATH: path.join(dataDir, 'no-such.env'),
    TAZUNA_SKIP_LISTEN: '1',
    TAZUNA_DATA_DIR: dataDir,
    USE_LOCAL_ASSETS: 'true',
    PUBLIC_KEY: publicKeyHex,
    APP_ID: 'test-app-id',
    DISCORD_TOKEN: 'test-discord-token',
    DASHBOARD_SESSION_SECRET: SESSION_SECRET,
    BOT_OWNER_IDS: OWNER_ID,
    NODE_ENV: 'test',
  });
  for (const key of [
    'BOT_OWNER_ID', 'UMA_API_KEY', 'UMA_MOE_API_KEY', 'GITHUB_TOKEN', 'QUIZ_REMOTE_TOKEN',
    'QUIZ_REMOTE_SYNC_ENABLED', 'DASHBOARD_SEED_GUILD_ID', 'DASHBOARD_PUBLIC_URL', 'SITE_URL',
    'OCR_SPACE_KEY', 'BUG_REPORT_CHANNEL_ID', 'PREMIUM_GUILD_IDS',
  ]) delete process.env[key];
}

/** Block real network calls: anything that isn't our own server gets a canned 503. */
function stubFetch() {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input.url ?? String(input);
    if (url.startsWith('http://127.0.0.1:')) return realFetch(input, init);
    outboundRequests.push({ url, method: init?.method || 'GET' });
    return new Response(JSON.stringify({ message: 'network disabled in tests' }), {
      status: 503,
      headers: { 'content-type': 'application/json' },
    });
  };
  return realFetch;
}

/**
 * Import the bot with test env and start it on a random local port.
 * Returns helpers bound to that server.
 */
export async function startTestServer() {
  if (started) return started;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tazuna-test-'));
  configureEnv(dataDir);
  const realFetch = stubFetch();

  const { app } = await import('../scripts/app.js');
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  started = {
    app,
    baseUrl,
    dataDir,
    request(pathname, init = {}) {
      return fetch(`${baseUrl}${pathname}`, init);
    },
    /** POST a Discord interaction signed with the test key pair. */
    interact(body, { signature } = {}) {
      const raw = JSON.stringify(body);
      const timestamp = String(Math.floor(Date.now() / 1000));
      const sig = signature ?? crypto.sign(null, Buffer.from(timestamp + raw), privateKey).toString('hex');
      return fetch(`${baseUrl}/interactions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-signature-ed25519': sig,
          'x-signature-timestamp': timestamp,
        },
        body: raw,
      });
    },
    async close() {
      await new Promise((resolve) => server.close(resolve));
      globalThis.fetch = realFetch;
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
  return started;
}

/** A dashboard session cookie, signed the same way dashboardAuth.signSession does. */
export function sessionCookie(user) {
  const payload = Buffer.from(JSON.stringify(user), 'utf8').toString('base64url');
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
  return `tazuna_dashboard_session=${encodeURIComponent(`${payload}.${sig}`)}`;
}

/** Build a slash command interaction body. */
export function slashCommand(name, options = [], { userId = USER_ID, guildId = GUILD_ID } = {}) {
  return {
    id: 'interaction-1',
    application_id: 'test-app-id',
    type: 2,
    token: 'interaction-token',
    guild_id: guildId,
    channel_id: '400000000000000004',
    member: { user: { id: userId, username: 'tester' }, roles: [], permissions: '0' },
    data: { id: 'cmd-1', name, type: 1, options },
  };
}

/** Build an autocomplete interaction body with one focused option. */
export function autocomplete(name, optionName, value, { subcommand } = {}) {
  const focused = { name: optionName, type: 3, value, focused: true };
  const options = subcommand ? [{ name: subcommand, type: 1, options: [focused] }] : [focused];
  return { ...slashCommand(name, options), type: 4 };
}
