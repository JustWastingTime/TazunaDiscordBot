// The /api endpoints the DustBunnyDashboard frontend calls on the bot.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { GUILD_ID, OWNER_ID, USER_ID, sessionCookie, startTestServer } from './helpers.js';

let t;
before(async () => { t = await startTestServer(); });
after(async () => { await t.close(); });

const owner = { cookie: sessionCookie({ discordId: OWNER_ID, username: 'owner' }) };
const member = { cookie: sessionCookie({ discordId: USER_ID, username: 'member' }) };

async function getJson(pathname, headers = {}) {
  const res = await t.request(pathname, { headers });
  return { status: res.status, body: await res.json() };
}

/** Owner-only write the admin dashboard uses to turn premium on for a guild. */
async function setPremium(guildId, enabled) {
  const res = await t.request(`/api/admin/premium/${guildId}`, {
    method: 'PUT',
    headers: { ...owner, 'content-type': 'application/json', 'x-tazuna-admin': '1' },
    body: JSON.stringify({ enabled }),
  });
  assert.equal(res.status, 200);
  return res.json();
}

describe('public endpoints', () => {
  test('GET /api/health', async () => {
    assert.deepEqual(await getJson('/api/health'), { status: 200, body: { ok: true, dashboard: true } });
  });

  test('GET /api/public/tenants is empty on a fresh install', async () => {
    assert.deepEqual(await getJson('/api/public/tenants'), { status: 200, body: { tenants: [] } });
  });

  test('GET /api/public/dashboard needs a guild', async () => {
    const { status, body } = await getJson('/api/public/dashboard');
    assert.equal(status, 400);
    assert.match(body.error, /guild/i);
  });

  test('GET /api/public/dashboard returns the overview shape for a guild', async () => {
    const { status, body } = await getJson(`/api/public/dashboard?guild=${GUILD_ID}`);
    assert.equal(status, 200);
    assert.equal(body.schemaVersion, 1);
    assert.equal(body.guildId, GUILD_ID);
    assert.ok(Array.isArray(body.clubs));
    assert.ok(Array.isArray(body.applicants));
    assert.equal(typeof body.features, 'object');
    assert.equal(body.site.applyWebhookUrl, undefined, 'webhook URL must never be public');
  });

  test('the guild can also come from the x-tazuna-guild header', async () => {
    const { status, body } = await getJson('/api/public/dashboard', { 'x-tazuna-guild': GUILD_ID });
    assert.equal(status, 200);
    assert.equal(body.guildId, GUILD_ID);
  });
});

describe('auth', () => {
  test('GET /api/auth/me without a session', async () => {
    assert.deepEqual(await getJson('/api/auth/me'), { status: 200, body: { authenticated: false } });
  });

  test('GET /api/auth/me ignores a tampered session cookie', async () => {
    const forged = owner.cookie.replace(/\.[^.]+$/, '.not-the-signature');
    assert.deepEqual(await getJson('/api/auth/me', { cookie: forged }), { status: 200, body: { authenticated: false } });
  });

  test('GET /api/auth/me ignores an expired session', async () => {
    const cookie = sessionCookie({ discordId: OWNER_ID, exp: Date.now() - 1000 });
    assert.deepEqual(await getJson('/api/auth/me', { cookie }), { status: 200, body: { authenticated: false } });
  });

  test('GET /api/auth/me with a session and a guild resolves dashboard access', async () => {
    const { status, body } = await getJson(`/api/auth/me?guild=${GUILD_ID}`, owner);
    assert.equal(status, 200);
    assert.equal(body.authenticated, true);
    assert.equal(body.user.discordId, OWNER_ID);
    assert.equal(body.user.isOwner, true);
  });

  test('POST /api/auth/me signs out by clearing the cookie', async () => {
    const res = await t.request('/api/auth/me', { method: 'POST', headers: owner });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('set-cookie') || '', /tazuna_dashboard_session=;.*Max-Age=0/);
  });
});

describe('premium-only staff endpoints', () => {
  const premiumGuild = '500000000000000005';

  test('are refused for a guild without premium', async () => {
    for (const pathname of ['/api/apply', '/api/clubs', '/api/applicants', '/api/planning', '/api/blacklist']) {
      const { status, body } = await getJson(`${pathname}?guild=${GUILD_ID}`, owner);
      assert.equal(status, 403, pathname);
      assert.match(body.error, /premium/i, pathname);
    }
  });

  test('work once the owner turns premium on', async () => {
    const result = await setPremium(premiumGuild, true);
    assert.equal(result.premium, true);

    const apply = await getJson(`/api/apply?guild=${premiumGuild}`);
    assert.deepEqual(apply, { status: 200, body: { clubs: [] } });

    const clubs = await getJson(`/api/clubs?guild=${premiumGuild}`, owner);
    assert.equal(clubs.status, 200);
    assert.deepEqual(clubs.body.clubs, []);
    assert.equal(clubs.body.user.isOwner, true);
  });

  test('need a signed-in manager', async () => {
    await setPremium(premiumGuild, true);
    const anon = await getJson(`/api/clubs?guild=${premiumGuild}`);
    assert.equal(anon.status, 401);
    // A non-owner with no staff role (Discord lookups are blocked in tests) is not a manager.
    const notStaff = await getJson(`/api/clubs?guild=${premiumGuild}`, member);
    assert.equal(notStaff.status, 401);
    assert.match(notStaff.body.error, /manager/i);
  });

  test('POST /api/apply validates input before saving anything', async () => {
    await setPremium(premiumGuild, true);
    const post = (body) => t.request(`/api/apply?guild=${premiumGuild}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

    let res = await post({ umaId: 'abc', discordUsername: 'trainer' });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /digits/);

    res = await post({ umaId: '123456789', discordUsername: 'x' });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /username/i);

    res = await post({ umaId: '123456789', discordUsername: 'trainer', targetClubId: 'nope' });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /not accepting/);
  });
});

describe('static pages', () => {
  for (const [pathname, heading] of [['/terms', 'Terms of Service'], ['/privacy', 'Privacy Policy']]) {
    test(`GET ${pathname} serves the policy page, not a dashboard slug`, async () => {
      const res = await t.request(pathname);
      assert.equal(res.status, 200);
      assert.match(await res.text(), new RegExp(`<h1>${heading}</h1>`));
    });
  }
});
