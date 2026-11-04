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

/**
 * At the morning's start (owner, 4 Nov 2026: "morning start aakum pothu ... PRICE CHANGES check panunum"): 07:00 IST, the
 * contract's day start 13 h 30 m back at the 17:30 settlement. The cache holds the last 220 one-minute bars and two days
 * of five-minute ones, as the desk fetches them; BTC climbs a point a minute, so each "then" is known exactly. Every
 * window and the day start has its figure: the short ones off the minute bars, 4 h on off the five-minute ones.
 */
test('[critical] the morning: every window and the day start read -- the minute bars where they reach, the five-minute ones beyond', async () => {
  const { setSeriesForTest } = await import('../../src/market/moves.js');
  const now = Date.parse('2026-11-04T07:00:00+05:30');
  const priceAt = (sec: number) => 70_000 + (sec - (now / 1000 - 3 * 86_400)) / 60;
  const bars = (step: number, n: number) => Array.from({ length: n }, (_, i) => {
    const time = Math.floor(now / 1000 / step) * step - (n - i) * step;
    return { time, open: priceAt(time), high: priceAt(time), low: priceAt(time), close: priceAt(time), volume: 1 };
  });
  setSeriesForTest([['1m', bars(60, 220)], ['5m', bars(300, 600)]], now);
  try {
    const dayStart = Date.parse('2026-11-03T17:30:00+05:30');
    const spot = priceAt(now / 1000);
    const rows = priceChanges(spot, now, { dayStartMs: dayStart });
    assert.ok(rows.every((r) => r.pts !== null), `every row read: ${rows.filter((r) => r.pts === null).map((r) => r.minutes ?? r.mark).join(', ')}`);
    // "Then" is the close of a bar at or just before the moment: within a bar's length of it -- a point a minute.
    for (const r of rows.filter((x) => x.minutes !== null)) {
      const barMin = r.minutes! <= 220 ? 1 : 5;
      assert.ok(Math.abs(r.then! - priceAt(r.at / 1000)) <= 2 * barMin, `${r.minutes}m: then ${r.then} against ${priceAt(r.at / 1000)}`);
    }
    const day = rows.find((r) => r.mark === 'dayStart')!;
    assert.ok(Math.abs(day.pts! - 13.5 * 60) <= 5, `since 17:30 the climb is ~810 points, read ${day.pts}`);
    assert.ok(Math.abs(rows.find((r) => r.minutes === 720)!.pts! - 720) <= 5, '12 h back, ~720 points');
  } finally {
    setSeriesForTest(null);
  }
});
