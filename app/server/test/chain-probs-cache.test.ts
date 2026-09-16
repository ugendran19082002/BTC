import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bucketKey, nearZeroFor, nextExpiry, resetSimulationCache, simulationBacklog } from '../src/market/chain.js';

/**
 * The simulation is never on the request path twice.
 *
 * Measured inside the container on 17 September: 350ms of `liveChain` on a
 * 74-strike board, none of it network -- the tickers were cached -- all of it
 * the near-zero simulation, repeated on every chain request, every strategy
 * tick and every best-pick check. On one thread that is every status and
 * price poll waiting behind it.
 *
 * So: the first sight of a contract pays; a read with the same inputs pays
 * nothing; a read whose inputs moved gets the kept figure now and the fresh
 * one is worked out between requests.
 */

const tick = () => new Promise<void>((r) => setImmediate(() => setImmediate(r)));

test('[critical] the same inputs are never simulated twice', () => {
  resetSimulationCache();
  let runs = 0;
  const compute = () => { runs++; return 0.5; };
  const key = bucketKey(77_000, 0.0007, 0.45);
  assert.equal(nearZeroFor('C-BTC-79000-x', key, compute), 0.5);
  assert.equal(nearZeroFor('C-BTC-79000-x', key, compute), 0.5);
  assert.equal(nearZeroFor('C-BTC-79000-x', key, compute), 0.5);
  assert.equal(runs, 1);
  assert.equal(simulationBacklog(), 0);
});

test('[critical] moved inputs hand back the kept figure now and the fresh one after', async () => {
  resetSimulationCache();
  let value = 0.5;
  let runs = 0;
  const compute = () => { runs++; return value; };
  assert.equal(nearZeroFor('P-BTC-74000-x', bucketKey(77_000, 0.0007, 0.45), compute), 0.5);
  value = 0.7;
  // spot moved $100: a new bucket
  const moved = bucketKey(77_100, 0.0007, 0.45);
  assert.equal(nearZeroFor('P-BTC-74000-x', moved, compute), 0.5, 'the request is not made to wait');
  assert.equal(runs, 1, 'not computed on the request');
  assert.equal(simulationBacklog(), 1);
  await tick();
  assert.equal(runs, 2, 'computed between requests');
  assert.equal(simulationBacklog(), 0);
  assert.equal(nearZeroFor('P-BTC-74000-x', moved, compute), 0.7, 'the fresh figure from then on');
  assert.equal(runs, 2);
});

test('a contract asked about twice before the drain runs is simulated once, with the latest inputs', async () => {
  resetSimulationCache();
  const seen: string[] = [];
  nearZeroFor('C-BTC-80000-x', 'a', () => { seen.push('a'); return 0.1; });
  nearZeroFor('C-BTC-80000-x', 'b', () => { seen.push('b'); return 0.2; });
  nearZeroFor('C-BTC-80000-x', 'c', () => { seen.push('c'); return 0.3; });
  assert.equal(simulationBacklog(), 1, 'one job per contract, the latest');
  await tick();
  assert.deepEqual(seen, ['a', 'c']);
  assert.equal(nearZeroFor('C-BTC-80000-x', 'c', () => 9), 0.3);
});

test('the buckets are coarser than the simulation’s own noise, and no coarser', () => {
  const base = bucketKey(77_000, 0.0007, 0.45);
  assert.equal(bucketKey(77_010, 0.0007, 0.45), base, 'ten dollars of spot is the same bucket');
  assert.notEqual(bucketKey(77_100, 0.0007, 0.45), base, 'a hundred is not');
  assert.equal(bucketKey(77_000, 0.0007, 0.452), base, 'a fifth of a vol point is the same bucket');
  assert.notEqual(bucketKey(77_000, 0.0007, 0.46), base, 'a full point is not');
  assert.notEqual(bucketKey(77_000, 0.0007 + 6 / (365 * 24 * 60), 0.45), base, 'six minutes of expiry is not');
});

// The whole board, once, through the real reader: the OTM strikes are
// simulated at first sight and the closed-form figures come with them.
const expiry = nextExpiry(Math.floor(Date.now() / 1000)).expiry;
const SPOT = 77_000;
const ticker = (cp: 'C' | 'P', strike: number, mark: number) => ({
  symbol: `${cp}-BTC-${strike}-${expiry}`,
  contract_type: cp === 'C' ? 'call_options' : 'put_options',
  underlying_asset_symbol: 'BTC',
  strike_price: String(strike),
  close: mark, mark_price: String(mark), spot_price: String(SPOT), oi: '500', volume: 100,
  greeks: { delta: cp === 'C' ? '0.05' : '-0.05', gamma: '0', theta: '0', vega: '0', rho: '0', spot: String(SPOT) },
  quotes: { best_bid: String(mark - 0.3), best_ask: String(mark + 0.3), bid_size: '100', ask_size: '100', mark_iv: '0.45', bid_iv: null, ask_iv: null },
});
const board = [
  ticker('C', 78_000, 40), ticker('C', 78_200, 30), ticker('C', 78_400, 22), ticker('C', 78_600, 16),
  ticker('P', 76_000, 40), ticker('P', 75_800, 30), ticker('P', 75_600, 22), ticker('P', 75_400, 16),
  ticker('C', 77_000, 300), ticker('P', 77_000, 300),
];

test('[critical] a live board carries the simulated figure from the first read', async () => {
  resetSimulationCache();
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({ success: true, result: board }), { status: 200 })) as typeof fetch;
  try {
    const { liveChain, WHOLE_BOARD } = await import('../src/market/chain.js');
    const a = await liveChain(WHOLE_BOARD);
    const simulated = a.legs.filter((l) => l.probs.nearZero !== null);
    assert.ok(simulated.length >= 4, 'the out-of-the-money strikes were simulated');
    for (const l of simulated) {
      assert.ok(l.probs.expireWorthless !== null && l.probs.touch !== null, 'the closed forms come with it');
    }
    const b = await liveChain(WHOLE_BOARD);
    assert.deepEqual(b.legs.map((l) => l.probs.nearZero), a.legs.map((l) => l.probs.nearZero), 'the same board, the same figures');
    assert.equal(simulationBacklog(), 0);
  } finally {
    globalThis.fetch = realFetch;
  }
});
