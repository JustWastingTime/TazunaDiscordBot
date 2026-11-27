// /api/admin (data editor) and /api/gamba endpoints used by the dashboard.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { OWNER_ID, USER_ID, outboundRequests, sessionCookie, startTestServer } from './helpers.js';

let t;
before(async () => { t = await startTestServer(); });
after(async () => { await t.close(); });

const owner = { cookie: sessionCookie({ discordId: OWNER_ID, username: 'owner' }) };
const member = { cookie: sessionCookie({ discordId: USER_ID, username: 'member' }) };

async function getJson(pathname, headers = {}) {
  const res = await t.request(pathname, { headers });
  return { status: res.status, body: await res.json() };
}

describe('/api/admin/me', () => {
  test('anonymous', async () => {
    assert.deepEqual(await getJson('/api/admin/me'), {
      status: 200,
      body: { authenticated: false, isOwner: false, quiz: null },
    });
  });

  test('owner vs regular user', async () => {
    const o = await getJson('/api/admin/me', owner);
    assert.equal(o.body.authenticated, true);
    assert.equal(o.body.isOwner, true);
    const m = await getJson('/api/admin/me', member);
    assert.equal(m.body.authenticated, true);
    assert.equal(m.body.isOwner, false);
  });
});

describe('/api/admin/public datasets', () => {
  test('lists the public datasets with entry counts', async () => {
    const { status, body } = await getJson('/api/admin/public/datasets');
    assert.equal(status, 200);
    const names = body.datasets.map((d) => d.name);
    assert.ok(names.includes('skills') && names.includes('supporters') && names.includes('characters'));
    assert.ok(body.datasets.every((d) => d.public === true && d.count > 0));
  });

  test('searches and pages a dataset', async () => {
    const { status, body } = await getJson('/api/admin/public/skills?q=corner&limit=3');
    assert.equal(status, 200);
    assert.ok(body.total > 3);
    assert.equal(body.entries.length, 3);
  });

  test('404s on an unknown dataset', async () => {
    const { status } = await getJson('/api/admin/public/not-a-dataset');
    assert.equal(status, 404);
  });

  test('map and race catalogs', async () => {
    const maps = await getJson('/api/admin/public/catalog/maps');
    assert.equal(maps.status, 200);
    assert.ok(maps.body.maps.length > 0);
    assert.ok(maps.body.meets.length > 0);
    const races = await getJson('/api/admin/public/catalog/races');
    assert.equal(races.status, 200);
    assert.ok(races.body.races.length > 0);
  });
});

describe('/api/admin owner gate', () => {
  test('GET needs a session, then the owner', async () => {
    assert.equal((await getJson('/api/admin/datasets')).status, 401);
    assert.equal((await getJson('/api/admin/datasets', member)).status, 403);
    const ok = await getJson('/api/admin/datasets', owner);
    assert.equal(ok.status, 200);
    assert.ok(ok.body.datasets.length >= 3);
  });

  test('writes need the x-tazuna-admin header (CSRF guard)', async () => {
    const res = await t.request('/api/admin/premium/123', {
      method: 'PUT',
      headers: { ...owner, 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: true }),
    });
    assert.equal(res.status, 403);
    assert.match((await res.json()).error, /header/i);
  });

  test('writes reject a foreign Origin', async () => {
    const res = await t.request('/api/admin/premium/123', {
      method: 'PUT',
      headers: { ...owner, 'content-type': 'application/json', 'x-tazuna-admin': '1', origin: 'https://evil.example' },
      body: JSON.stringify({ enabled: true }),
    });
    assert.equal(res.status, 403);
    assert.match((await res.json()).error, /origin/i);
  });

  test('premium toggle round-trips', async () => {
    const put = (enabled) => t.request('/api/admin/premium/600000000000000006', {
      method: 'PUT',
      headers: { ...owner, 'content-type': 'application/json', 'x-tazuna-admin': '1' },
      body: JSON.stringify({ enabled }),
    }).then((r) => r.json());
    assert.equal((await put(true)).premium, true);
    const list = await getJson('/api/admin/premium', owner);
    assert.ok(list.body.guilds.some((g) => g.guildId === '600000000000000006' && g.premium));
    assert.equal((await put(false)).premium, false);
  });

  test('rejects a non-numeric guild id', async () => {
    const res = await t.request('/api/admin/premium/abc', {
      method: 'PUT',
      headers: { ...owner, 'content-type': 'application/json', 'x-tazuna-admin': '1' },
      body: JSON.stringify({ enabled: true }),
    });
    assert.equal(res.status, 400);
  });
});

describe('/api/gamba', () => {
  test('every route needs a Discord session', async () => {
    for (const pathname of ['/api/gamba/me', '/api/gamba/events', '/api/gamba/leaderboard']) {
      assert.equal((await getJson(pathname)).status, 401, pathname);
    }
  });

  test('signed-in reads', async () => {
    const events = await getJson('/api/gamba/events', member);
    assert.equal(events.status, 200);
    assert.ok(Array.isArray(events.body.events));

    const board = await getJson('/api/gamba/leaderboard', member);
    assert.equal(board.status, 200);
    assert.ok(Array.isArray(board.body.rows));

    const me = await getJson('/api/gamba/me', member);
    assert.equal(me.status, 200);
    assert.equal(me.body.discordId, USER_ID);
    assert.equal(me.body.owner, false);
  });

  test('unknown race 404s', async () => {
    assert.equal((await getJson('/api/gamba/events/does-not-exist', member)).status, 404);
  });
});

test('no test reached a real outside service', () => {
  // The fetch stub records any attempt; Discord/uma.moe calls should only be the
  // role lookups we expect to fail closed.
  for (const req of outboundRequests) {
    assert.match(req.url, /^https:\/\/discord\.com\/api\//, `unexpected outbound call: ${req.url}`);
  }
});
