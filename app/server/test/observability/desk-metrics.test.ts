import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { costOf, deskMetrics, noteDeltaCall, notePass, noteSignalRun, quotaKeyOf, quotaUsedPctOf, resetDeskMetrics, DELTA_WINDOW_MS, QUOTA_LADDER } from '../../src/observability/desk-metrics.js';

/**
 * The desk's gauges (4 Oct 2026): calls to Delta and the quota they use, how
 * long a pass over the open trades takes, how long the signal run holds the
 * thread. Counting only -- nothing here decides anything.
 */
beforeEach(resetDeskMetrics);
const T = 1_800_000_000_000;

test('[critical] a call is charged Delta\'s documented weight for what it is', () => {
  assert.deepEqual(costOf('POST', '/v2/orders'), { kind: 'place, edit or cancel', units: 5 });
  assert.deepEqual(costOf('PUT', '/v2/orders'), { kind: 'place, edit or cancel', units: 5 });
  assert.deepEqual(costOf('DELETE', '/v2/orders'), { kind: 'place, edit or cancel', units: 5 });
  assert.deepEqual(costOf('POST', '/v2/orders/batch'), { kind: 'place, edit or cancel', units: 25 });
  assert.deepEqual(costOf('GET', '/v2/orders/client_order_id/abc'), { kind: 'order lookup', units: 3 });
  assert.deepEqual(costOf('GET', '/v2/orders'), { kind: 'order lookup', units: 3 });
  assert.deepEqual(costOf('GET', '/v2/orders/history'), { kind: 'order history and fills', units: 10 });
  assert.deepEqual(costOf('GET', '/v2/fills'), { kind: 'order history and fills', units: 10 });
  assert.deepEqual(costOf('GET', '/v2/positions/margined'), { kind: 'positions, balances, products', units: 3 });
  assert.deepEqual(costOf('GET', '/v2/wallet/balances'), { kind: 'positions, balances, products', units: 3 });
  assert.deepEqual(costOf('GET', '/v2/profile'), { kind: 'other', units: 1 });
});

test('[critical] the window is the last five minutes: units, share of the quota, by kind, response time and every 429', () => {
  for (let i = 0; i < 10; i++) noteDeltaCall({ method: 'GET', path: '/v2/orders/client_order_id/x', ms: 100 + i * 10, outcome: 'ok' }, T + i * 1_000);
  noteDeltaCall({ method: 'POST', path: '/v2/orders', ms: 400, outcome: 'ok' }, T + 11_000);
  noteDeltaCall({ method: 'GET', path: '/v2/orders/history', ms: 900, outcome: 'refused' }, T + 12_000);
  noteDeltaCall({ method: 'GET', path: '/v2/positions/margined', ms: 5, outcome: 'rate-limited' }, T + 13_000);
  noteDeltaCall({ method: 'GET', path: '/v2/positions/margined', ms: 20_000, outcome: 'failed' }, T + 14_000);
  const m = deskMetrics(T + 15_000).delta;
  assert.equal(m.calls, 14);
  assert.equal(m.units, 10 * 3 + 5 + 10 + 3 + 3);
  assert.equal(m.usedPct, 0.3, '51 of 20,000');
  assert.deepEqual(m.byKind[0], { kind: 'order lookup', calls: 10, units: 30 }, 'the dearest kind first');
  assert.deepEqual([m.refused, m.failed], [1, 1]);
  assert.deepEqual(m.rateLimited, { inWindow: 1, sinceStart: 1, lastAt: T + 13_000 });
  assert.equal(m.response.maxMs, 900, 'a call that never answered is not a response time');

  // Five minutes on, the window is empty -- but a 429 is remembered since the start.
  const later = deskMetrics(T + 15_000 + DELTA_WINDOW_MS + 1).delta;
  assert.deepEqual([later.calls, later.units, later.usedPct], [0, 0, 0]);
  assert.deepEqual(later.rateLimited, { inWindow: 0, sinceStart: 1, lastAt: T + 13_000 });
});

test('[critical] a pass over a second is a late one; the signal run reports how long it held the thread', () => {
  for (const [i, ms] of [200, 300, 1_500, 250, 2_200].entries()) notePass(ms, 20, T + i * 1_000);
  noteSignalRun(120, 480, { early: false, afterCloseMs: 3_900 }, T);
  noteSignalRun(90, 300, { early: true, afterCloseMs: 1_800 }, T + 60_000);
  const m = deskMetrics(T + 61_000);
  assert.equal(m.passes.count, 5);
  assert.equal(m.passes.late, 2);
  assert.equal(m.passes.maxMs, 2_200);
  assert.equal(m.passes.tradesNow, 20);
  assert.equal(m.signalRun.count, 2);
  assert.equal(m.signalRun.calc.maxMs, 480);
  assert.equal(m.signalRun.read.maxMs, 120);
  assert.equal(m.signalRun.early, 1, 'one of the two went early, on a verified candle');
  assert.equal(m.signalRun.afterClose.maxMs, 3_900, 'and how long after the close the signals were ready');
});

test('nothing noted is nothing shown, and a note can never throw', () => {
  const m = deskMetrics(T);
  assert.deepEqual([m.delta.calls, m.passes.count, m.signalRun.count], [0, 0, 0]);
  assert.equal(m.delta.response.p50Ms, null);
  assert.doesNotThrow(() => noteDeltaCall({ method: 'GET', path: undefined as unknown as string, ms: 1, outcome: 'ok' }));
});

/**
 * Each login on its own quota (21 Oct 2026): Delta throttles authenticated requests by user ID, and the desk trades two
 * accounts. It counted them as one -- 132.7% at 3:02 PM with nothing refused -- and the stop watch stood down for it.
 */
test('[critical] each login counted against its own 20,000; the share said is the busiest login\'s, never their sum', () => {
  const a = quotaKeyOf({ key: 'key-of-account-one' }), b = quotaKeyOf({ key: 'key-of-account-two' });
  assert.notEqual(a, b);
  assert.match(a, /^[0-9a-f]{12}$/, 'a short hash: the key itself is never kept');
  assert.ok(!a.includes('key'));
  // 13,200 units each: 66% of each login's own quota
  for (const q of [a, b]) for (let i = 0; i < 2_640; i++) noteDeltaCall({ method: 'POST', path: '/v2/orders', ms: 1, outcome: 'ok', quota: q }, T + i);
  assert.equal(quotaUsedPctOf(a, T + 10_000), 66);
  assert.equal(quotaUsedPctOf(b, T + 10_000), 66);
  const m = deskMetrics(T + 10_000);
  assert.equal(m.delta.usedPct, 66, 'not 132');
  assert.equal(m.delta.units, 26_400, 'the units of both, as they were');
  assert.deepEqual(m.delta.logins.map((l) => l.usedPct), [66, 66]);
  assert.equal(quotaKeyOf(null), 'none');
});

test('[critical] who steps back first as a login\'s quota fills: the rest, then the target, then the stop', () => {
  assert.ok(QUOTA_LADDER.others < QUOTA_LADDER.target && QUOTA_LADDER.target < QUOTA_LADDER.stop && QUOTA_LADDER.stop < QUOTA_LADDER.stopRun);
  assert.ok(QUOTA_LADDER.stopRun < 100, 'and never to Delta saying no');
});

test('[critical] a signed call is counted against its own login: two accounts\' calls are two quotas', async () => {
  const { signed } = await import('../../src/delta/signed.js');
  const real = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({ success: true, result: [] }), { status: 200 })) as typeof fetch;
  try {
    const one = { key: 'key-one', secret: 's1' }, two = { key: 'key-two', secret: 's2' };
    for (let i = 0; i < 4; i++) await signed(one, { method: 'GET', path: '/v2/positions/margined' });
    await signed(two, { method: 'POST', path: '/v2/orders', body: {} });
    const m = deskMetrics();
    const by = new Map(m.delta.logins.map((l) => [l.quota, l.units]));
    assert.equal(by.get(quotaKeyOf(one)), 12, 'four reads of 3 on the first login');
    assert.equal(by.get(quotaKeyOf(two)), 5, 'one order of 5 on the second');
    assert.equal(by.get('none'), undefined, 'none uncounted');
  } finally { globalThis.fetch = real; }
});
