import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { autocomplete, OWNER_ID, slashCommand, startTestServer } from './helpers.js';

// Discord interaction / response type numbers, spelled out so a failure reads clearly.
const PING = 1;
const PONG = 1;
const CHANNEL_MESSAGE = 4;
const AUTOCOMPLETE_RESULT = 8;
const EPHEMERAL = 64;

let t;
before(async () => { t = await startTestServer(); });
after(async () => { await t.close(); });

const opt = (name, value, type = 3) => ({ name, type, value });

async function send(body) {
  const res = await t.interact(body);
  assert.equal(res.status, 200, `expected 200, got ${res.status}`);
  return res.json();
}

describe('/interactions request verification', () => {
  test('answers a signed PING with PONG', async () => {
    assert.deepEqual(await send({ type: PING }), { type: PONG });
  });

  test('rejects a request with a bad signature', async () => {
    const res = await t.interact({ type: PING }, { signature: '00'.repeat(64) });
    assert.equal(res.status, 401);
  });

  test('rejects an unknown interaction type', async () => {
    const res = await t.interact({ type: 99, data: {} });
    assert.equal(res.status, 400);
  });
});

describe('autocomplete', () => {
  test('/skill name waits for 3 characters before suggesting', async () => {
    const body = await send(autocomplete('skill', 'name', 'gr'));
    assert.equal(body.type, AUTOCOMPLETE_RESULT);
    assert.deepEqual(body.data.choices, []);
  });

  test('/skill name suggests matches, names starting with the query first', async () => {
    const body = await send(autocomplete('skill', 'name', 'ground'));
    assert.equal(body.type, AUTOCOMPLETE_RESULT);
    const names = body.data.choices.map((c) => c.name);
    assert.ok(names.length > 0 && names.length <= 25);
    assert.match(names[0], /^ground/i);
    for (const choice of body.data.choices) {
      assert.ok(choice.name.length <= 100, 'Discord caps choice names at 100 chars');
    }
  });

  test('/club leaderboard offers only "All Clubs" for a guild with no clubs', async () => {
    const body = await send(autocomplete('club', 'clubname', '', { subcommand: 'leaderboard' }));
    assert.equal(body.type, AUTOCOMPLETE_RESULT);
    assert.deepEqual(body.data.choices, [{ name: 'All Clubs', value: 'all' }]);
  });
});

describe('/supporter', () => {
  test('offers a dropdown when several cards match', async () => {
    const body = await send(slashCommand('supporter', [opt('name', 'kitasan')]));
    assert.equal(body.type, CHANNEL_MESSAGE);
    assert.match(body.data.content, /Found \d+ matches/);
    const select = body.data.components[0].components[0];
    assert.equal(select.custom_id, 'supporter_select');
    assert.ok(select.options.length >= 2 && select.options.length <= 25);
    assert.ok(select.options.every((o) => /Kitasan/i.test(o.description)));
  });

  test('shows an embed when exactly one card matches', async () => {
    const body = await send(slashCommand('supporter', [opt('name', 'kitasan ssr'), opt('limitbreak', 4, 4)]));
    assert.equal(body.type, CHANNEL_MESSAGE);
    assert.equal(body.data.embeds?.length, 1);
    assert.ok(body.data.embeds[0].title || body.data.embeds[0].author, 'embed has a heading');
  });

  test('says so when nothing matches', async () => {
    const body = await send(slashCommand('supporter', [opt('name', 'zzzz-not-a-card')]));
    assert.match(body.data.content, /not found/);
  });
});

describe('/skill', () => {
  test('offers a dropdown when several skills match', async () => {
    const body = await send(slashCommand('skill', [opt('name', 'corner')]));
    assert.equal(body.type, CHANNEL_MESSAGE);
    const select = body.data.components[0].components[0];
    assert.equal(select.custom_id, 'skill_select');
    assert.ok(select.options.length <= 25);
    for (const o of select.options) {
      assert.ok(o.description.length <= 80, 'descriptions are trimmed for Discord');
    }
  });

  test('says so when nothing matches', async () => {
    const body = await send(slashCommand('skill', [opt('name', 'zzzz-not-a-skill')]));
    assert.match(body.data.content, /not found/);
  });
});

describe('/uma', () => {
  test('offers a dropdown of outfits for a character', async () => {
    const body = await send(slashCommand('uma', [opt('name', 'special week')]));
    assert.equal(body.type, CHANNEL_MESSAGE);
    const select = body.data.components[0].components[0];
    assert.equal(select.custom_id, 'uma_select');
    assert.ok(select.options.every((o) => o.label === 'Special Week'));
  });
});

describe('/setcm (owner only)', () => {
  test('refuses anyone who is not a bot owner', async () => {
    const body = await send(slashCommand('setcm', [opt('start', 1, 4), opt('end', 2, 4)]));
    assert.equal(body.data.flags, EPHEMERAL);
    assert.match(body.data.content, /not allowed/);
  });

  test('lets the owner set a range of loaded CMs', async () => {
    const { default: cache } = await import('../scripts/githubCache.js');
    const numbers = cache.champsmeets.map((cm) => Number(cm.number)).filter(Number.isFinite).sort((a, b) => a - b);
    assert.ok(numbers.length > 0, 'champsmeet.json has CMs');
    const n = numbers.at(-1);
    const body = await send(slashCommand('setcm', [opt('start', n, 4), opt('end', n, 4)], { userId: OWNER_ID }));
    assert.equal(body.data.flags, EPHEMERAL);
    assert.match(body.data.content, new RegExp(`range set to \\*\\*${n}–${n}\\*\\*`));
  });

  test('rejects a range with no CMs in it', async () => {
    const body = await send(slashCommand('setcm', [opt('start', 9000, 4), opt('end', 9001, 4)], { userId: OWNER_ID }));
    assert.match(body.data.content, /^❌/);
    assert.match(body.data.content, /Available:/);
  });
});
