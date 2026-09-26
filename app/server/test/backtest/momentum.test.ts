import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Candle } from '../../src/market/delta.js';
import { add, emptyTally, POLICIES, resample, simulate, trendSeries, type Signal } from '../../src/backtest/momentum.js';

const bar = (time: number, high: number, low: number, close = (high + low) / 2, volume = 1): Candle =>
  ({ time, open: (high + low) / 2, high, low, close, volume });

const signal = (p: Partial<Signal> & Pick<Signal, 'side' | 'entry' | 'level' | 'atr'>): Signal => ({
  tf: '15m', time: 0, barExtreme: p.side === 'UP' ? p.entry - p.atr / 2 : p.entry + p.atr / 2,
  plan: {
    trigger: p.level,
    target1: p.level + (p.side === 'UP' ? 1 : -1) * p.atr,
    invalidation: p.level - (p.side === 'UP' ? 1 : -1) * p.atr,
  },
  features: { year: 2025, h1: 0, h4: 0, compression: null, volumeRatio: null, overshootAtr: 0, hourIst: 0 },
  ...p,
});

const live = POLICIES.find((p) => p.name.startsWith('live'))!;
const oneToTwo = POLICIES.find((p) => p.name === 'entry 1 ATR : 2 ATR')!;

test('[critical] a target already behind the entry is not a win: no room, not scored', () => {
  /*
   * The artefact that made "late entry" look 98% right (26 Sep 2026). The live
   * plan's target is the level plus one ATR; a bar that closed 1.5 ATR past the
   * level has passed its own target before the call is made. Scored with an
   * absolute value it was a winner every time, and the best ten "filters" were
   * all this one fact.
   */
  const s = signal({ side: 'UP', level: 100, atr: 10, entry: 115 });
  const r = simulate(s, [bar(1, 116, 110)], live, 8, 0);
  assert.equal(r.outcome, 'NO_ROOM');
  const t = emptyTally();
  add(t, r);
  assert.deepEqual([t.n, t.noRoom], [0, 1]);
});

test('a target reached pays its distance over the risk, signed, for both sides', () => {
  const up = simulate(signal({ side: 'UP', level: 100, atr: 10, entry: 101 }), [bar(1, 125, 100)], oneToTwo, 8, 0);
  assert.deepEqual([up.outcome, up.r], ['TARGET', 2]);
  const down = simulate(signal({ side: 'DOWN', level: 100, atr: 10, entry: 99 }), [bar(1, 100, 75)], oneToTwo, 8, 0);
  assert.deepEqual([down.outcome, down.r], ['TARGET', 2]);
});

test('[critical] a bar that reaches both the stop and the target is the stop', () => {
  const r = simulate(signal({ side: 'UP', level: 100, atr: 10, entry: 101 }), [bar(1, 130, 80)], oneToTwo, 8, 0);
  assert.deepEqual([r.outcome, r.r], ['STOP', -1]);
});

test('at the horizon the trade closes at the last bar\'s close', () => {
  const r = simulate(signal({ side: 'UP', level: 100, atr: 10, entry: 100 }), [bar(1, 104, 98, 103), bar(2, 106, 99, 105), bar(3, 200, 0)], oneToTwo, 2, 0);
  assert.equal(r.outcome, 'TIME');
  assert.equal(r.r, 0.5);
});

test('fees are charged on both sides, in R', () => {
  // Entry 100,000, risk 100: 0.05% each side is $100 round trip, one whole R.
  const s = signal({ side: 'UP', level: 100_000, atr: 100, entry: 100_000 });
  const r = simulate(s, [bar(1, 100_300, 99_950)], oneToTwo, 8, 0.0005);
  assert.equal(r.r, 2);
  assert.equal(r.rNet, 1);
});

test('resample keeps whole buckets on the clock and drops a partial one', () => {
  const five = [0, 300, 600, 900, 1200].map((t, i) => bar(t, 10 + i, 5 - i, 7 + i, 2));
  const fifteen = resample(five, 3);
  assert.equal(fifteen.length, 1);
  assert.deepEqual(fifteen[0], { time: 0, open: five[0]!.open, high: 12, low: 3, close: 9, volume: 6 });
});

test('[critical] a higher timeframe is read only from bars that had closed', () => {
  // A rising hourly series; the trend at a moment must not see the hour still forming.
  const hours = Array.from({ length: 40 }, (_, i) => bar(i * 3600, 100 + i + 1, 100 + i - 1, 100 + i));
  const at = trendSeries(hours, 3600, 5);
  assert.equal(at(0), 0, 'before the first hour has closed there is no trend');
  assert.equal(at(39 * 3600 + 3599), at(38 * 3600 + 3600), 'the last hour counts only once it has closed');
  assert.equal(at(40 * 3600), 1);
});
