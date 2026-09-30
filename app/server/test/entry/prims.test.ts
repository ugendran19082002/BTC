import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lastBreak, lastSweep, openFvgs, orderBlocks, pivots, trendOf } from '../../src/entry/prims.js';
import { path, wave } from './bars.js';

/**
 * The pieces, pinned on candles built to have exactly one answer. Closed bars
 * only: a swing is not a swing until PIVOT_K bars after it exist.
 */

test('[critical] a swing low is only a swing once two bars after it exist', () => {
  const closes = [100, 99, 98, 97, 96, 97, 98, 99];
  assert.deepEqual(pivots(path(closes, { w: 0.5 }), 'low').map((p) => p.i), [4]);
  assert.deepEqual(pivots(path(closes.slice(0, 6), { w: 0.5 }), 'low'), [], 'one bar after it is not enough');
});

test('[critical] a sweep takes a swing low and closes back above it', () => {
  // Down to a swing low at 83,900 (bar 4), up, back down, and bar 10 wicks under it and closes above.
  const bars = path([84_000, 83_980, 83_950, 83_920, 83_900, 83_940, 83_990, 84_030, 84_000, 83_960, 83_950], { w: 5 });
  bars[10] = { ...bars[10]!, low: 83_860, close: 83_950 };
  const s = lastSweep(bars, 3);
  assert.equal(s?.dir, 1);
  assert.equal(s?.level, 83_895, 'the swing low, wick included');
  assert.equal(s?.extreme, 83_860);
});

test('a close that stays under the swing low is a break, not a sweep', () => {
  const bars = path([84_000, 83_980, 83_950, 83_920, 83_900, 83_940, 83_990, 84_030, 84_000, 83_960, 83_850], { w: 5 });
  assert.notEqual(lastSweep(bars, 3)?.dir, 1);
});

test('[critical] a close over the last swing high is a break up', () => {
  const bars = path([84_000, 84_020, 84_050, 84_020, 84_000, 84_010, 84_030, 84_080]);
  assert.deepEqual(lastBreak(bars, 3) && { dir: lastBreak(bars, 3)!.dir, level: lastBreak(bars, 3)!.level }, { dir: 1, level: 84_055 });
});

test('a displacement leaves a fair-value gap, until a close fills it', () => {
  const base = path(wave(30, 84_000, 10, 6));
  const last = base[base.length - 1]!;
  const t = last.time;
  const gap = [
    { time: t + 300, open: 84_000, high: 84_010, low: 83_990, close: 84_005, volume: 100 },
    { time: t + 600, open: 84_005, high: 84_200, low: 84_000, close: 84_190, volume: 400 },
    { time: t + 900, open: 84_190, high: 84_230, low: 84_060, close: 84_220, volume: 100 },
  ];
  const z = openFvgs([...base, ...gap])[0];
  assert.deepEqual(z && [z.dir, z.lo, z.hi], [1, 84_010, 84_060]);
  const filled = [...base, ...gap, { time: t + 1200, open: 84_220, high: 84_225, low: 84_000, close: 84_005, volume: 100 }];
  assert.equal(openFvgs(filled).length, 0);
});

test('an order block is the last down candle before a displacement through a swing', () => {
  // Twenty quiet bars so there is an ATR to measure displacement against.
  const bars = path([...wave(20, 84_000, 10, 6), 84_000, 84_030, 84_060, 84_030, 84_000, 84_010, 83_990, 83_980], { w: 5 });
  const t = bars[bars.length - 1]!.time;
  const down = bars[bars.length - 1]!;
  bars.push({ time: t + 300, open: 83_980, high: 84_200, low: 83_975, close: 84_190, volume: 400 });
  const ob = orderBlocks(bars)[0];
  assert.equal(ob?.dir, 1);
  assert.deepEqual([ob?.lo, ob?.hi], [down.low, down.high], 'the down candle before it');
});

test('[critical] a trend needs the EMA stack and the swings to agree', () => {
  assert.equal(trendOf(path(wave(80, 84_000, 40, 10, 6))), 1);
  assert.equal(trendOf(path(wave(80, 84_000, 40, 10, -6))), -1);
  assert.equal(trendOf(path(wave(80, 84_000, 40, 10, 0))), 0, 'sideways is neither');
});
