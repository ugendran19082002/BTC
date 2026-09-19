import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { closePool, one, query } from '../src/db/pool.js';
import { chainBoard, noteChainFeatures, chainHistory, SKEW_STEPS } from '../src/market/chain-features.js';
import { closeOiHistory, marketSchema } from '../src/market/oi-history.js';

/**
 * The option board as figures a measurement can use, and the record of them.
 *
 * Two properties matter here. **Node never buckets**: it sends marks and
 * volumes, and the analytics service decides "large" or "puts dearer" with the
 * same functions that labelled the history — a verdict formed on this side is
 * how the two languages come apart. And **the record is written**, because the
 * readings nobody can measure yet (open interest, its change, the walls, max
 * pain) have no history at all until this has been running a year.
 */

const T0 = 1_789_000_000;
const snap = { atm: 76_000, step: 200, hoursToExpiry: 10.9, expiry: '170926', ts: T0, spot: 76_050 };

const leg = (cp: 'C' | 'P', strike: number, mark: number | null, volume: number | null) =>
  ({ cp, strike, mark, volume, oi: 1_000 } as never);

/** A board: marks at the money and 2/3/4 strikes out, with volume on both sides. */
const legs = () => [
  leg('C', 76_000, 500, 10), leg('P', 76_000, 488, 12),
  ...SKEW_STEPS.map((n, i) => leg('C', 76_000 + n * 200, [198, 128, 84][i]!, 100)),
  ...SKEW_STEPS.map((n, i) => leg('P', 76_000 - n * 200, [200, 130, 80][i]!, 150)),
  // in the money on each side: never counted in the out-of-the-money volume
  leg('C', 75_000, 1_100, 999), leg('P', 77_000, 1_150, 999),
];

// One database for the file; each case starts its table empty.
beforeEach(async () => {
  closeOiHistory();
  await marketSchema();
  await query('TRUNCATE market.chain_features');
});
after(() => closePool());

// ---------------------------------------------------------------------------

test('[critical] the board is raw marks and volumes — no bucket, no verdict', async () => {
  const b = chainBoard(snap, legs());
  assert.equal(b.callAtm, 500);
  assert.equal(b.putAtm, 488);
  assert.deepEqual(b.putMarks, [200, 130, 80]);
  assert.deepEqual(b.callMarks, [198, 128, 84]);
  // out of the money only: puts below the money, calls above it
  assert.equal(b.putVolume, 450);
  assert.equal(b.callVolume, 300);
  assert.equal(b.hoursLeft, 10.9);
  assert.equal(Object.values(b).some((v) => typeof v === 'string'), false);
});

test('a strike with no mark is a hole, not a zero', async () => {
  const b = chainBoard(snap, legs().filter((l) => (l as { strike: number }).strike !== 76_600));
  assert.deepEqual(b.callMarks, [198, null, 84]);
  const zeroed = chainBoard(snap, [leg('C', 76_000, 0, 5), leg('P', 76_000, 488, 5)]);
  assert.equal(zeroed.callAtm, null);
});

test('an empty board reads as nothing anywhere', async () => {
  const b = chainBoard(snap, []);
  assert.deepEqual(
    [b.callAtm, b.putAtm, b.putVolume, b.callVolume, b.putMarks, b.callMarks],
    [null, null, null, null, [null, null, null], [null, null, null]],
  );
});

const record = (ts: number) => ({
  expiry: '170926', ts, spot: 76_050, hoursLeft: 10.9, atmIv: 0.3,
  board: chainBoard(snap, legs()),
  pcrOi: 0.34, pcrVolume: 0.76, ceOi: 9_000, peOi: 3_400, ivSkewPts: 1.2,
  ceWall: 78_400, peWall: 72_800, maxPain: 76_000, ceOiChange: 120, peOiChange: -40,
});

test('[critical] one row per five-minute bucket per expiry, however often it is called', async () => {
  assert.equal(await noteChainFeatures(record(T0)), Math.floor(T0 / 300) * 300_000);
  assert.equal(await noteChainFeatures(record(T0 + 60)), null);      // same bucket
  assert.notEqual(await noteChainFeatures(record(T0 + 300)), null);  // the next one
  assert.equal((await chainHistory()).rows, 2);
  assert.equal((await chainHistory()).since, Math.floor(T0 / 300) * 300_000);
});

test('[critical] what has no history yet is recorded, so that one day it has one', async () => {
  await noteChainFeatures(record(T0));
  const row = (await one<Record<string, unknown>>('SELECT * FROM market.chain_features LIMIT 1'))!;
  assert.equal(row.pcr_oi, 0.34);
  assert.equal(row.ce_wall, 78_400);
  assert.equal(row.pe_wall, 72_800);
  assert.equal(row.max_pain, 76_000);
  assert.equal(row.ce_oi_change, 120);
  assert.equal(row.pe_oi_change, -40);
  assert.equal(row.atm_iv, 0.3);
  assert.deepEqual(row.put_marks, [200, 130, 80]);
});

test('a table that cannot be read is no history, not a crash', async () => {
  closeOiHistory();
  // nothing recorded yet in a fresh table: the runbook's "since" is absent, not zero-dated
  assert.deepEqual(
    { rows: (await chainHistory()).rows, since: (await chainHistory()).since },
    { rows: 0, since: null },
  );
});
