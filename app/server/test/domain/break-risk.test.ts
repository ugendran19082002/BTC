import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Candle } from '../../src/market/delta.js';
import { breakRisk, confirmedBreaks, resample, type CarryStats, type Tf } from '../../src/domain/break-risk.js';

/*
 * Bars are built on a 15-minute grid and split into the five-minute bars the
 * card is fed, so the resampled 15m bars are exactly the ones written here.
 */
type Q = { o: number; h: number; l: number; c: number; v: number };
const T0 = 1_790_000_100 - (1_790_000_100 % 3600);

function fiveFrom(quarters: readonly Q[]): Candle[] {
  const out: Candle[] = [];
  quarters.forEach((q, k) => {
    const t = T0 + k * 900;
    const mid = (q.o + q.c) / 2;
    out.push({ time: t, open: q.o, high: q.h, low: q.l, close: mid, volume: q.v / 3 });
    out.push({ time: t + 300, open: mid, high: mid, low: mid, close: mid, volume: q.v / 3 });
    out.push({ time: t + 600, open: mid, high: Math.max(mid, q.c), low: Math.min(mid, q.c), close: q.c, volume: q.v / 3 });
  });
  return out;
}

// A quiet range around 100, then one strong bar up through its top.
const quiet = (n: number): Q[] => Array.from({ length: n }, (_, i) => (i % 2 ? { o: 100, h: 101, l: 99, c: 100.5, v: 30 } : { o: 100.5, h: 101, l: 99, c: 100, v: 30 }));
const pushUp: Q = { o: 100, h: 104.2, l: 99.9, c: 104, v: 120 };

const stats = (tf: Tf): CarryStats => ({
  tf, n: 1000, from: '2024-04-01', to: '2026-09-26', keptGoing: 0.46, keptGoingByYear: { 2025: { n: 400, keptGoing: 0.45 } },
  withAtr: [1, 2, 3, 4], againstAtr: [1.5, 2.5, 3.5, 4.5], eitherAtr: [2, 5], baselineEitherAtr: [1.6, 4],
  reachWith: [1, 0.5, 0], reachAgainst: [1, 0.4, 0],
});
const TABLE = (['15m', '30m', '1h'] as const).map(stats);
const STEPS = [0, 1, 2];
const closeOf = (bars: readonly Candle[]) => bars[bars.length - 1]!.time + 300;

test('a quiet range raises nothing', () => {
  const bars = fiveFrom(quiet(100));
  assert.equal(breakRisk(bars, closeOf(bars), TABLE, STEPS), null);
});

test('[critical] a 15m break raises the measured hour, in points of its own ATR', () => {
  const bars = fiveFrom([...quiet(99), pushUp]);
  const now = closeOf(bars);
  const r = breakRisk(bars, now, TABLE, STEPS);
  assert.ok(r, 'the break is seen');
  assert.equal(r.tf, '15m', 'too little history for 30m or 1h to have a window');
  assert.equal(r.side, 'UP');
  assert.equal(r.level, 101);
  assert.equal(r.entry, 104);
  assert.equal(r.at, now * 1000);
  assert.equal(r.until, (now + 3600) * 1000);
  assert.deepEqual(r.withPts, [1, 2, 3, 4].map((k) => Math.round(k * r.atr)));
  assert.deepEqual(r.eitherPts, [Math.round(2 * r.atr), Math.round(5 * r.atr)]);
  assert.equal(Math.round(r.bigger * 100), 25, '2 ATR against a usual 1.6 is a quarter bigger');
  assert.equal(r.keptGoing, 0.46, 'the direction is said as the coin flip it measured');
});

test('[critical] the hour ends: an hour and a second later the card has nothing to say', () => {
  const bars = fiveFrom([...quiet(99), pushUp]);
  assert.ok(breakRisk(bars, closeOf(bars) + 3599, TABLE, STEPS));
  assert.equal(breakRisk(bars, closeOf(bars) + 3601, TABLE, STEPS), null);
});

test('[critical] a bar still forming never breaks: the measurement was made at closes', () => {
  const bars = fiveFrom([...quiet(99), pushUp]);
  // One second before the breakout quarter's last five minutes close.
  assert.equal(breakRisk(bars, closeOf(bars) - 1, TABLE, STEPS), null);
});

test('where the hour and the quarter both broke, the hour wins: its hour was measured bigger', () => {
  // Sixty-odd hours of range, then the push on the last quarter of an hour.
  const bars = fiveFrom([...quiet(4 * 64 - 1), pushUp]);
  const r = breakRisk(bars, closeOf(bars), TABLE, STEPS);
  assert.ok(r);
  assert.equal(r.tf, '1h');
});

test('one push counts once: a second break the same way inside the cooldown is the same move', () => {
  const q = [...quiet(99), pushUp, { o: 104, h: 108.2, l: 103.9, c: 108, v: 150 }];
  const bars15 = resample(fiveFrom(q), 3);
  const found = confirmedBreaks(bars15, 60);
  assert.equal(found.length, 1);
  assert.equal(found[0]!.i, 99);
});
