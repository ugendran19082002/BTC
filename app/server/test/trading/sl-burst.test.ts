import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OptionStopWatch, stopWatchedOf } from '../../src/trading/stop-watch.js';
import { ceProduct, planFor, quote, rig } from './harness.js';
import { withLatency } from './venue-latency.js';

/**
 * Fifty stops at once (21 Oct 2026, the architecture plan's step 1; timed in full by `npm run bench:sl`). On the real
 * engine and stop watch, with every exchange call taking real time: all fifty are bought back once each, together --
 * the time of one stop, not fifty. Closed one after another, as before 21 Oct, the same fifty took 50 times as long.
 */

test('[critical] fifty trades on one contract through their stops together: each bought back once, all in the time of one', async () => {
  const p = ceProduct();
  const r = rig({ products: [p], quotes: [quote(p.symbol, 100.5, 101)], limits: { allowPyramiding: true, maxShortContracts: 100_000 }, balanceUsd: 10_000_000 });
  const N = 50;
  for (let i = 0; i < N; i++) {
    assert.equal((await r.engine.open(planFor(p, { tradeId: `t${i}`, stopPrice: 110, lots: 1 }))).ok, true);
    await r.engine.poll(`t${i}`);
  }
  const board = { at: r.now(), asks: new Map([[p.symbol, 112]]) };
  const w = new OptionStopWatch({ asks: () => board, quotaUsedPct: () => 0, now: () => r.now(), check: (s, ids) => r.engine.checkStops(s, ids) });
  w.note(stopWatchedOf(await r.store.open()));
  r.ex.tick(quote(p.symbol, 111, 112, { ts: r.now(), mark: 111.5 }));

  const ONE = 40; // ms a call
  const venue = withLatency(r.ex, { readMs: ONE, writeMs: ONE });
  const t0 = performance.now();
  w.tick();
  await w.settle();
  const took = performance.now() - t0;
  venue.restore();

  for (let i = 0; i < N; i++) assert.equal((await r.store.get(`t${i}`))!.state.position, 0, `t${i} flat`);
  const exits = venue.calls.filter((c) => c.method === 'placeOrder' && c.role === 'exit');
  assert.equal(exits.length, N, 'one buy-back a trade: none twice, none missed');
  assert.equal(venue.calls.filter((c) => c.method === 'cancelOrder').length, 2 * N, 'each trade\'s target and backstop taken off');
  assert.equal(venue.calls.filter((c) => c.method === 'getQuote').length, 1, 'one quote read for the contract');
  // A trade's own path is a handful of calls in a row; fifty in a row would be fifty times it.
  const oneTrade = 8 * ONE;
  assert.ok(took < 3 * oneTrade, `all fifty in ${Math.round(took)} ms: the time of one (~${oneTrade} ms), not fifty`);
  assert.ok(venue.mostInFlight() >= N, `${venue.mostInFlight()} calls in flight at once`);
});
