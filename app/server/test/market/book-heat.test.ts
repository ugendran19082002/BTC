import { after, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  bookHeatSchema, flushBookHeat, heatMinutes, minuteOfSamples, persistentWalls, resetBookHeat,
  sampleBook, sampleOf, type HeatMinute,
} from '../../src/market/book-heat.js';
import { closePool, one, query } from '../../src/db/pool.js';

const T0 = Date.UTC(2026, 8, 29, 6, 0, 0);
const MIN = 60_000;
const level = (price: number, size: number) => ({ price: String(price), size });

beforeEach(async () => {
  await bookHeatSchema();
  await query('TRUNCATE book_heat_1m');
  resetBookHeat();
});
after(() => closePool());

test('[critical] a snapshot is contracts per $10 of price, each side, with the touch', () => {
  const s = sampleOf({ buy: [level(81_009.5, 5), level(81_001, 3), level(80_990, 7)], sell: [level(81_010.5, 2), level(81_025, 9)] }, T0);
  assert.deepEqual([...s.bid], [[8_100, 8], [8_099, 7]]);
  assert.deepEqual([...s.ask], [[8_101, 2], [8_102, 9]]);
  assert.deepEqual([s.bestBid, s.bestAsk], [81_009.5, 81_010.5]);
});

test('[critical] a minute is each bin averaged over its snapshots: an order in one of two shows at half', () => {
  const a = sampleOf({ buy: [level(81_000, 10), level(80_900, 40)], sell: [level(81_100, 6)] }, T0);
  const b = sampleOf({ buy: [level(81_000, 10)], sell: [level(81_100, 6)] }, T0 + 10_000);
  const m = minuteOfSamples(T0, [a, b])!;
  assert.equal(m.base, 80_900);
  assert.equal(m.samples, 2);
  assert.equal(m.bid[0], 20, 'the 80,900 bid, in one snapshot of two');
  assert.equal(m.bid[10], 10);
  assert.equal(m.ask[20], 6);
  assert.equal(minuteOfSamples(T0, []), null);
});

test('[critical] completed minutes are written once, the one in progress waits, and both are read back', async () => {
  const book = (bid: number) => async () => ({ buy: [level(bid, 5)], sell: [level(bid + 20, 5)] });
  await sampleBook(T0 + 5_000, book(81_000));
  await sampleBook(T0 + MIN + 5_000, book(81_050));
  await sampleBook(T0 + 2 * MIN + 5_000, book(81_100));
  assert.equal(await sampleBook(T0 + 2 * MIN + 15_000, async () => null), false, 'a failed read is skipped');

  assert.equal(await flushBookHeat(T0 + 2 * MIN + 20_000), 2);
  assert.equal(await flushBookHeat(T0 + 2 * MIN + 40_000), 0, 'nothing new');
  assert.equal((await one<{ n: number }>('SELECT COUNT(*)::int AS n FROM book_heat_1m'))?.n, 2);

  const minutes = await heatMinutes(T0);
  assert.deepEqual(minutes.map((m) => m.at), [T0, T0 + MIN, T0 + 2 * MIN], 'written, then the one in progress');
  assert.deepEqual(minutes.map((m) => m.bestBid), [81_000, 81_050, 81_100]);
});

const minute = (at: number, bins: Record<number, number>, side: 'bid' | 'ask' = 'bid'): HeatMinute => {
  const ks = Object.keys(bins).map(Number);
  const lo = Math.min(...ks);
  const arr = new Array<number>(Math.max(...ks) - lo + 1).fill(0);
  for (const k of ks) arr[k - lo] = bins[k]!;
  const empty = arr.map(() => 0);
  return { at, base: lo * 10, step: 10, bid: side === 'bid' ? arr : empty, ask: side === 'ask' ? arr : empty, samples: 6, bestBid: null, bestAsk: null };
};

test('[critical] a wall is persistent only when it has held five minutes running, up to now', () => {
  // A bid of 500 at 81,000 every minute; a new one of 900 at 80,500 for the last two; median bins of 10.
  const base = { 8_050: 10, 8_060: 10, 8_070: 10, 8_080: 10, 8_090: 10 };
  const ms = Array.from({ length: 8 }, (_, i) => minute(T0 + i * MIN, { ...base, 8_100: 500, ...(i >= 6 ? { 8_000: 900 } : {}) }));
  const walls = persistentWalls(ms, 10);
  assert.deepEqual(walls, [{ side: 'bid', price: 81_005, size: 500, minutes: 8 }]);
  // Gone in the latest minute: no longer a wall, however long it held.
  const gone = [...ms.slice(0, 7), minute(T0 + 7 * MIN, base)];
  assert.deepEqual(persistentWalls(gone, 10), []);
});
