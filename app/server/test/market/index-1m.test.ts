import { after, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  INDEX_BUCKET_MS, indexBetween, indexSchema, moveOver,
} from '../../src/market/index-1m.js';
import { closePool, query } from '../../src/db/pool.js';

/**
 * BTC, once a minute, kept.
 *
 * Every other recorder keeps a reading and carries the price as a column at
 * its own cadence, so "what did BTC do between 13:18 and 13:33" needed a round
 * trip to Delta and a signal's points moved could not be checked afterwards at
 * all. This is the price on its own -- the series every "+350 pts" on the
 * screen is measured against.
 */

const T0 = Math.floor(Date.UTC(2026, 8, 24, 6, 0) / INDEX_BUCKET_MS) * INDEX_BUCKET_MS;
const put = (minute: number, price: number) =>
  query('INSERT INTO index_1m (at, price, mark) VALUES ($1, $2, $3) ON CONFLICT (at) DO NOTHING',
    [T0 + minute * INDEX_BUCKET_MS, price, price + 1]);

beforeEach(async () => { await indexSchema(); await query('TRUNCATE index_1m'); });
after(() => closePool());

test('[critical] the minute is the key, so the same minute cannot be written twice', async () => {
  // A restart, a double timer and a replayed snapshot all land on the same
  // bucket; the table refuses the second rather than growing a duplicate.
  await put(0, 84_100);
  await put(0, 99_999);
  const series = await indexBetween(T0, T0 + 60 * INDEX_BUCKET_MS);
  assert.equal(series.length, 1);
  assert.equal(series[0]?.price, 84_100, 'the first reading of the minute stands');
});

test('[critical] the move over a window is measured off the minutes actually recorded', async () => {
  await put(0, 84_100);
  await put(7, 84_320);
  await put(15, 84_450);
  const move = await moveOver(T0, T0 + 15 * INDEX_BUCKET_MS);
  assert.ok(move);
  assert.equal(move.points, 350);
  assert.equal(move.pct, 0.42);
  assert.equal(move.minutes, 15);
  assert.equal(move.from.price, 84_100);
  assert.equal(move.to.price, 84_450);
});

test('a window with a gap says how long it actually covered', async () => {
  /*
   * A move measured over 40 minutes of a 60-minute window is a different
   * figure from one measured over the hour, and a reader who cannot see which
   * they were given cannot use either.
   */
  await put(0, 84_000);
  await put(40, 84_400);
  const move = await moveOver(T0, T0 + 60 * INDEX_BUCKET_MS);
  assert.equal(move?.minutes, 40);
  assert.equal(move?.points, 400);
});

test('one minute, or none, is not a move', async () => {
  assert.equal(await moveOver(T0, T0 + 60 * INDEX_BUCKET_MS), null, 'nothing recorded');
  await put(3, 84_000);
  assert.equal(await moveOver(T0, T0 + 60 * INDEX_BUCKET_MS), null, 'one end is not two');
});

test('the series comes back oldest first, whatever order it went in', async () => {
  await put(9, 84_900);
  await put(1, 84_100);
  await put(5, 84_500);
  assert.deepEqual((await indexBetween(T0, T0 + 60 * INDEX_BUCKET_MS)).map((p) => p.price),
    [84_100, 84_500, 84_900]);
});
