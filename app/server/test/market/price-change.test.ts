import { test } from 'node:test';
import assert from 'node:assert/strict';
import { priceChanges, PRICE_WINDOWS_MIN } from '../../src/market/price-change.js';

/** The Live screen's "Price change" card: every window back, then the desk's marks. */
test('[critical] priceChanges: every window and mark, null where the candles do not reach', () => {
  // No candle cache in a unit test: "then" is null for the windows, and the row still says when it looked.
  const now = Date.UTC(2026, 9, 4, 6, 0, 0);
  const rows = priceChanges(80_000, now, { entryMs: now - 30 * 60_000, dayStartMs: now + 60_000 });
  assert.deepEqual(rows.map((r) => r.minutes), [...PRICE_WINDOWS_MIN, null]);
  assert.equal(rows.at(-1)!.mark, 'entry');
  assert.equal(rows.at(-1)!.at, now - 30 * 60_000);
  assert.ok(rows.every((r) => r.pts === null && r.pct === null));
  assert.deepEqual(rows.slice(0, 3).map((r) => r.at), [now - 60_000, now - 300_000, now - 900_000], 'each window says when "then" is');
  // A day-start mark in the future is not shown; one in the past is, after the entry.
  assert.equal(priceChanges(80_000, now, { dayStartMs: now - 3_600_000 }).at(-1)!.mark, 'dayStart');
  assert.deepEqual(priceChanges(80_000, now, { entryMs: now - 60_000, dayStartMs: now - 3_600_000 }).slice(-2).map((r) => r.mark), ['entry', 'dayStart']);
  // No price now: every figure is empty rather than invented.
  assert.ok(priceChanges(null, now).every((r) => r.pts === null && r.pct === null));
});
