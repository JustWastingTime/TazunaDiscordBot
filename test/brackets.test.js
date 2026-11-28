// Bracket pick'em: structure, pick propagation, scoring and the /api/brackets flow.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { OWNER_ID, USER_ID, outboundRequests, sessionCookie, startTestServer } from './helpers.js';

let t;
let brackets;
before(async () => {
  t = await startTestServer();
  brackets = await import('../scripts/gambaBrackets.js');
});
after(async () => { await t.close(); });

const owner = { cookie: sessionCookie({ discordId: OWNER_ID, username: 'owner' }) };
const member = { cookie: sessionCookie({ discordId: USER_ID, username: 'member', globalName: 'Member' }) };
const TEAMS = ['Sobb', 'Light', 'Vivi', 'Tach', 'Plinko', 'LittleBear', 'Sharky', 'Santa'];

async function call(method, pathname, who, body) {
  const res = await t.request(pathname, {
    method,
    headers: { ...(who || {}), ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json() };
}

function describeSlot(slot) {
  if (slot.type === 'team') return slot.teamId;
  return `${slot.type === 'winner' ? 'W' : 'L'}${slot.matchId.slice(1)}`;
}

describe('double elimination layout', () => {
  test('8 teams matches the 14-match bracket (upper 1-4, 7-8, 11; lower 5-6, 9-10, 12, 13; final 14)', () => {
    const matches = brackets.buildDoubleElimination(['t1', 't2', 't3', 't4', 't5', 't6', 't7', 't8']);
    const shape = Object.fromEntries(matches.map((match) => [match.number, `${match.side}:${match.slots.map(describeSlot).join(',')}`]));
    assert.deepEqual(shape, {
      1: 'upper:t1,t2',
      2: 'upper:t3,t4',
      3: 'upper:t5,t6',
      4: 'upper:t7,t8',
      5: 'lower:L1,L2',
      6: 'lower:L3,L4',
      7: 'upper:W1,W2',
      8: 'upper:W3,W4',
      9: 'lower:L8,W5',
      10: 'lower:L7,W6',
      11: 'upper:W7,W8',
      12: 'lower:W9,W10',
      13: 'lower:L11,W12',
      14: 'final:W11,W13',
    });
    assert.equal(matches.find((m) => m.number === 11).label, 'Upper final');
    assert.equal(matches.find((m) => m.number === 13).label, 'Lower final');
    assert.equal(matches.find((m) => m.number === 14).label, 'Grand final');
  });

  test('4 and 16 teams have 2n-2 matches and every team can reach the final', () => {
    for (const size of [4, 16]) {
      const ids = Array.from({ length: size }, (_, i) => `t${i + 1}`);
      const matches = brackets.buildDoubleElimination(ids);
      assert.equal(matches.length, 2 * size - 2);
      // Every match's sources come earlier in play order.
      for (const match of matches) {
        for (const slot of match.slots) {
          if (slot.type !== 'team') assert.ok(Number(slot.matchId.slice(1)) < match.number);
        }
      }
    }
  });
});

describe('picks and scoring', () => {
  const bracket = () => ({
    teams: TEAMS.map((name, i) => ({ id: `t${i + 1}`, name })),
    matches: brackets.buildDoubleElimination(TEAMS.map((_, i) => `t${i + 1}`)),
    results: {},
  });

  test('losers drop into the lower bracket from the picks', () => {
    const b = bracket();
    const picks = { m1: 't1', m2: 't4', m3: 't5', m4: 't8', m7: 't1', m8: 't8' };
    assert.deepEqual(brackets.slotTeams(b, picks, 'm5'), ['t2', 't3']);
    assert.deepEqual(brackets.slotTeams(b, picks, 'm11'), ['t1', 't8']);
    assert.deepEqual(brackets.slotTeams(b, picks, 'm9'), ['t5', null]);
    assert.deepEqual(brackets.slotTeams(b, picks, 'm10'), ['t4', null]);
  });

  test('changing an early pick clears the later picks that relied on it', () => {
    const b = bracket();
    const picks = { m1: 't1', m2: 't3', m5: 't2', m7: 't1', m3: 't5', m4: 't7', m8: 't5', m11: 't1' };
    const next = brackets.cleanWinners(b, { ...picks, m1: 't2' });
    assert.equal(next.m1, 't2');
    assert.equal(next.m7, undefined, 't1 no longer plays match 7');
    assert.equal(next.m11, undefined);
    assert.equal(next.m5, undefined, 't2 is not in the lower bracket any more');
    assert.equal(next.m8, 't5');
  });

  test('scores correct picks and marks picks that can no longer happen', () => {
    const b = { ...bracket(), results: { m1: 't2' } };
    const score = brackets.scorePicks(b, { m1: 't1', m7: 't1', m5: 't2', m2: 't3' });
    assert.equal(score.status.m1, 'wrong');
    assert.equal(score.status.m7, 'dead');
    assert.equal(score.status.m5, 'dead', 't2 won, so it is not in the lower bracket');
    assert.equal(score.status.m2, 'open');
    const good = brackets.scorePicks(b, { m1: 't2', m7: 't2' });
    assert.equal(good.points, 1);
    assert.equal(good.status.m7, 'open');
  });
});

describe('/api/brackets', () => {
  let id;

  test('only the owner can create a bracket', async () => {
    const denied = await call('POST', '/api/brackets', member, { name: 'Cup', teams: TEAMS });
    assert.equal(denied.status, 403);
    const made = await call('POST', '/api/brackets', owner, {
      name: 'Winter Cup',
      teams: TEAMS,
      carrots: { m1: 50, m14: 500 },
    });
    assert.equal(made.status, 200);
    id = made.body.bracket.id;
    assert.equal(id, 'winter-cup');
    assert.equal(made.body.bracket.matches.length, 14);
    assert.equal(made.body.bracket.status, 'open');
    assert.equal(made.body.bracket.matches.find((m) => m.id === 'm1').carrots, 50);
  });

  test('anyone can read it; picks need a login', async () => {
    const list = await call('GET', '/api/brackets');
    assert.equal(list.body.brackets[0].id, id);
    const anon = await call('PUT', `/api/brackets/${id}/picks`, null, { picks: { m1: 't1' } });
    assert.equal(anon.status, 401);
  });

  test('a player saves a full bracket and bad picks are dropped', async () => {
    const picks = {
      m1: 't1', m2: 't3', m3: 't5', m4: 't7',
      m5: 't2', m6: 't6', m7: 't1', m8: 't5',
      m9: 't2', m10: 't3', m11: 't1', m12: 't3', m13: 't5', m14: 't1',
      m99: 't1',
    };
    const saved = await call('PUT', `/api/brackets/${id}/picks`, member, { picks });
    assert.equal(saved.status, 200);
    assert.equal(Object.keys(saved.body.mine.picks).length, 14);
    assert.equal(saved.body.mine.picks.m99, undefined);
    assert.equal(saved.body.standings[0].complete, true);
  });

  test('other players can not see picks before the lock', async () => {
    const peek = await call('GET', `/api/brackets/${id}/entries/${USER_ID}`, null);
    assert.equal(peek.status, 403);
  });

  test('results pay carrots per correct pick, and a corrected result takes them back', async () => {
    const before = (await call('GET', '/api/gamba/me', member)).body.carrots;

    const early = await call('POST', `/api/brackets/${id}/results`, owner, { matchId: 'm7', teamId: 't1' });
    assert.equal(early.status, 400, 'match 7 needs results 1 and 2 first');

    const first = await call('POST', `/api/brackets/${id}/results`, owner, { matchId: 'm1', teamId: 't1' });
    assert.equal(first.status, 200);
    assert.equal(first.body.bracket.status, 'locked');
    assert.equal(first.body.standings[0].points, 1);
    assert.equal(first.body.standings[0].carrots, 50);
    assert.equal((await call('GET', '/api/gamba/me', member)).body.carrots, before + 50);

    const fixed = await call('POST', `/api/brackets/${id}/results`, owner, { matchId: 'm1', teamId: 't2' });
    assert.equal(fixed.body.standings[0].points, 0);
    assert.equal(fixed.body.standings[0].carrots, 0);
    assert.equal((await call('GET', '/api/gamba/me', member)).body.carrots, before);

    const locked = await call('PUT', `/api/brackets/${id}/picks`, member, { picks: { m1: 't2' } });
    assert.equal(locked.status, 400);

    const peek = await call('GET', `/api/brackets/${id}/entries/${USER_ID}`, null);
    assert.equal(peek.status, 200);
    assert.equal(peek.body.entry.status.m7, 'dead');
  });

  test('picks can not reopen once results are in, and nothing goes to Discord', async () => {
    const reopen = await call('POST', `/api/brackets/${id}/lock`, owner, { locked: false });
    assert.equal(reopen.status, 400);
    assert.equal(outboundRequests.filter((req) => req.url.includes('discord')).length, 0);
  });
});
