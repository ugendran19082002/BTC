import { test } from 'node:test';
import assert from 'node:assert/strict';
import { judge, type GlanceReadings } from '../../src/observability/glance.js';

/** The phone's one word for the desk (6 Oct 2026): what makes it "warn", what makes it "down". */

const NOW = Date.UTC(2026, 9, 6, 9, 0, 0);
const healthy = (): GlanceReadings => ({
  now: NOW,
  db: { ok: true, latencyMs: 2 },
  board: { source: 'socket', connected: true, lastAt: NOW - 1_000 },
  tape: { source: 'socket', connected: true, lastAt: NOW - 2_000 },
  delta: { usedPct: 12, rateLimited: 0, failed: 0 },
  passes: { count: 300, late: 0, maxMs: 400 },
  errors: { open: 0, lastAt: null },
  schedulerOn: true,
  mode: 'live',
});

test('a desk with fresh feeds, quota to spare and a clean log is ok, with nothing to say', () => {
  const j = judge(healthy());
  assert.equal(j.health, 'ok');
  assert.deepEqual(j.issues, []);
  assert.equal(j.boardAgeMs, 1_000);
});

test('[critical] option prices that stopped are down; late is a warning', () => {
  assert.equal(judge({ ...healthy(), board: { ...healthy().board, lastAt: NOW - 20_000 } }).health, 'warn');
  const stopped = judge({ ...healthy(), board: { ...healthy().board, lastAt: NOW - 90_000 } });
  assert.equal(stopped.health, 'down');
  assert.match(stopped.issues[0]!.text, /stopped 90 s ago/);
  assert.equal(judge({ ...healthy(), board: { ...healthy().board, lastAt: null } }).health, 'down');
});

test('[critical] a database that does not answer is down', () => {
  assert.equal(judge({ ...healthy(), db: { ok: false, latencyMs: 5_000 } }).health, 'down');
});

test('rate limits, a quota near its end, failed calls, late passes and open errors each warn, each in its own words', () => {
  const j = judge({
    ...healthy(),
    delta: { usedPct: 91, rateLimited: 2, failed: 1 },
    passes: { count: 300, late: 120, maxMs: 1_800 },
    errors: { open: 100, lastAt: NOW },
    tape: { ...healthy().tape, lastAt: NOW - 5 * 60_000 },
  });
  assert.equal(j.health, 'warn');
  const text = j.issues.map((i) => i.text).join(' | ');
  assert.match(text, /rate-limited 2 calls/);
  assert.match(text, /1 call to Delta failed/);
  assert.match(text, /ran over its second 120 of 300 times/);
  assert.match(text, /100 errors in the log/);
  assert.match(text, /tape is 5 min old/);
  // a rate limit already says the quota is gone; the percentage would only repeat it
  assert.doesNotMatch(text, /% of Delta/);
});

test('the scheduler off and paper mode are states to show, not problems', () => {
  assert.equal(judge({ ...healthy(), schedulerOn: false, mode: 'paper' }).health, 'ok');
});

test('[critical] a few passes a little over their second are the network, not a problem (the live desk, 6 Oct 2026)', () => {
  // What the live desk showed as "Needs a look": 12 of about 300 passes late, none slow.
  assert.equal(judge({ ...healthy(), passes: { count: 300, late: 12, maxMs: 1_900 } }).health, 'ok');
  // Too few passes for a share to mean anything.
  assert.equal(judge({ ...healthy(), passes: { count: 10, late: 5, maxMs: 1_500 } }).health, 'ok');
});

test('one pass of five seconds or more warns: the stops were watched that much late', () => {
  const j = judge({ ...healthy(), passes: { count: 300, late: 1, maxMs: 9_000, tradesNow: 0, slowestTrades: 19, slowestAt: NOW - 120_000 } });
  assert.equal(j.health, 'warn');
  // What the live desk showed (6 Oct 2026, evening), said exactly: what waited, and what did not -- with the slow
  // pass's own count, not the latest pass's.
  assert.match(j.issues[0]!.text, /^One pass over the open trades \(19 in it\) took 9 s, 2 min ago/);
  assert.match(j.issues[0]!.text, /Perp SL\/TGT have their own fast watch/);
  assert.doesNotMatch(j.issues[0]!.text, /not the number of trades/);
});

test('[critical] a slow pass with no trades in it says the cause was not the trades (the live desk, 6 Oct 2026, 13:19)', () => {
  // The phone read "(0 open) took 13 s": the latest pass's count beside the slowest pass's time.
  const busy = judge({ ...healthy(), passes: { count: 280, late: 3, maxMs: 13_000, tradesNow: 0, slowestTrades: 0, slowestAt: NOW - 60_000 }, threadMaxMs: 4_200 });
  assert.match(busy.issues[0]!.text, /\(0 in it\) took 13 s/);
  assert.match(busy.issues[0]!.text, /likely the server being busy \(its thread was held up to 4 s\)/);
  const slowAnswer = judge({ ...healthy(), passes: { count: 280, late: 3, maxMs: 13_000, slowestTrades: 1 }, threadMaxMs: 40 });
  assert.match(slowAnswer.issues[0]!.text, /likely a slow answer from Delta or the database/);
});
