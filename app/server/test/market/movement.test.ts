import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify, flowRead, priceChanges, strengthOf, thresholdsFor } from '../../src/market/movement.js';

/**
 * The four types are price and OI past their thresholds, nothing subtler:
 * a call inside the threshold is mixed, and a missing OI cannot name a type.
 */
test('[critical] the four types from price and OI; inside the thresholds is mixed', () => {
  const t = thresholdsFor(5);
  assert.deepEqual(classify(0.35, 2.1, t), { type: 'LONG_BUILDUP', direction: 'UP' });
  assert.deepEqual(classify(0.45, -2.8, t), { type: 'SHORT_COVERING', direction: 'UP' });
  assert.deepEqual(classify(-0.40, 3.0, t), { type: 'SHORT_BUILDUP', direction: 'DOWN' });
  assert.deepEqual(classify(-0.32, -2.4, t), { type: 'LONG_UNWINDING', direction: 'DOWN' });
  assert.deepEqual(classify(0.02, 3.0, t), { type: 'MIXED', direction: null }, 'price inside its threshold');
  assert.deepEqual(classify(0.5, 0.1, t), { type: 'MIXED', direction: 'UP' }, 'OI inside its threshold: a direction, not a type');
  assert.deepEqual(classify(0.5, null, t), { type: 'MIXED', direction: 'UP' });
  assert.deepEqual(classify(null, 3, t), { type: null, direction: null });
});

test('thresholds grow with the square root of the window', () => {
  assert.ok(Math.abs(thresholdsFor(20).pricePct - 0.16) < 1e-9);
  assert.ok(Math.abs(thresholdsFor(720).oiPct - 0.25 * 12) < 1e-9);
});

test('strength is volume against the day\'s pace; the tape confirms or diverges', () => {
  assert.equal(strengthOf(0.8), 'WEAK'); assert.equal(strengthOf(1.2), 'MODERATE'); assert.equal(strengthOf(1.8), 'STRONG'); assert.equal(strengthOf(2.2), 'EXTREME'); assert.equal(strengthOf(null), null);
  assert.equal(flowRead('UP', 0.62), 'CONFIRMS'); assert.equal(flowRead('UP', 0.40), 'DIVERGES'); assert.equal(flowRead('DOWN', 0.50), 'FLAT'); assert.equal(flowRead(null, 0.6), null);
});

test('priceChanges: every window and mark, null where the candles do not reach', () => {
  // No candle cache in a unit test: "then" is null for the windows, and the row still says when it looked.
  const now = Date.UTC(2026, 8, 21, 6, 0, 0);
  const rows = priceChanges(80_000, now, { entryMs: now - 30 * 60_000, dayStartMs: now + 60_000 });
  assert.deepEqual(rows.map((r) => r.minutes), [1, 5, 15, 30, 60, 120, 240, 360, 720, null]);
  assert.equal(rows.at(-1)!.mark, 'entry');
  assert.equal(rows.at(-1)!.at, now - 30 * 60_000);
  assert.ok(rows.every((r) => r.pts === null && r.pct === null));
  // A day-start mark in the future is not shown; one in the past is.
  assert.equal(priceChanges(80_000, now, { dayStartMs: now - 3_600_000 }).at(-1)!.mark, 'dayStart');
});
