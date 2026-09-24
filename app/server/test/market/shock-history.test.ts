import { after, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  HEARTBEAT_MS, OUTCOME_MS, SCORE_STEP, noteShock, recentShocks, settleShocks,
  shockHistorySchema, shockOutcomes, worthWriting,
} from '../../src/market/shock-history.js';
import { closePool, one, query } from '../../src/db/pool.js';
import type { SuddenMove } from '../../src/domain/shock.js';

/*
 * The warning, written down. A warning nobody can look back at is a warning
 * nobody should act on -- but a row per poll would be a journal of how often
 * the screen was open, so what is pinned here is the policy for which readings
 * earn a row, and that the move after each one is recorded rather than
 * recomputed from whenever somebody next looks.
 */

const read = (over: Partial<SuddenMove> = {}): SuddenMove => ({
  score: 40, band: 'watch', window: 5,
  parts: [{ name: 'Volume burst', value: 0.8, weight: 2, note: '2.4x median' }],
  reasons: ['Volume burst'],
  direction: -0.4, directionLabel: 'Downside', directionParts: [{ name: 'Momentum', value: -0.4 }],
  odds: null,
  ...over,
} as SuddenMove);

beforeEach(async () => { await shockHistorySchema(); await query('TRUNCATE shock_snapshots'); });
after(() => closePool());

test('[critical] a band change is always news; a quiet repeat is not', () => {
  const last = { at: 1_000_000, band: 'watch', score: 40 };
  assert.equal(worthWriting(null, { at: 1_000_000, band: 'calm', score: 3 }), true, 'the first reading');
  assert.equal(worthWriting(last, { at: last.at + 60_000, band: 'high', score: 41 }), true, 'the band moved');
  assert.equal(worthWriting(last, { at: last.at + 60_000, band: 'watch', score: 41 }), false, 'a point of drift');
});

test('[critical] a score step earns a row, and so does the heartbeat', () => {
  /*
   * Without the step the series misses the build-up; without the heartbeat a
   * flat afternoon leaves a hole where the record should show it was flat.
   */
  const last = { at: 1_000_000, band: 'watch', score: 40 };
  assert.equal(worthWriting(last, { at: last.at + 60_000, band: 'watch', score: 40 + SCORE_STEP }), true);
  assert.equal(worthWriting(last, { at: last.at + 60_000, band: 'watch', score: 40 + SCORE_STEP - 1 }), false);
  assert.equal(worthWriting(last, { at: last.at + HEARTBEAT_MS, band: 'watch', score: 40 }), true);
});

test('[critical] the whole reading goes in, and the same reading twice does not', async () => {
  const at = Date.now();
  const id = await noteShock(read(), at, 84_500);
  assert.ok(id);
  assert.equal(await noteShock(read(), at + 60_000, 84_505), null, 'nothing new to say');

  const row = await one<{ score: number; band: string; parts: { name: string }[]; reasons: string[]; spot: number }>(
    'SELECT score, band, parts, reasons, spot FROM shock_snapshots WHERE id = $1', [id],
  );
  assert.equal(row?.band, 'watch');
  assert.equal(row?.parts[0]?.name, 'Volume burst');
  assert.deepEqual(row?.reasons, ['Volume burst']);
  assert.equal(row?.spot, 84_500);
});

test('[critical] the move after the warning is recorded, not worked out later', async () => {
  /*
   * The warning claims something is about to move, so the honest measure is
   * the size of what followed. Recorded at the time, or the figure would
   * depend on when somebody next opened the screen.
   */
  const at = Date.now() - OUTCOME_MS - 60_000;
  await noteShock(read({ band: 'sudden', score: 82 }), at, 84_000);
  const settled = await settleShocks(Date.now(), 84_840);
  assert.equal(settled, 1);

  const [row] = await recentShocks(5, 5);
  assert.equal(row?.movePts, 840);
  assert.equal(row?.movePct, 1);
  assert.ok(row?.outcomeAt);
});

test('a reading whose bars have not happened yet is left alone', async () => {
  await noteShock(read(), Date.now(), 84_000);
  assert.equal(await settleShocks(Date.now(), 84_500), 0);
  const [row] = await recentShocks(5, 5);
  assert.equal(row?.outcomeAt, null);
});

test('the outcomes are given per band, with the count behind them', async () => {
  // A mean over four readings is not a finding, so the count goes with it.
  const old = Date.now() - OUTCOME_MS - 60_000;
  await noteShock(read({ band: 'sudden', score: 90 }), old, 84_000);
  await settleShocks(Date.now(), 84_840);
  const out = await shockOutcomes(5);
  assert.equal(out.length, 1);
  assert.equal(out[0]?.band, 'sudden');
  assert.equal(out[0]?.n, 1);
  assert.equal(out[0]?.meanAbsPct, 1);
});
