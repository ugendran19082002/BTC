import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Candle } from '../../src/market/delta.js';
import { atr, lastBreak, lastSweep, openFvgs, orderBlocks, pivots, rvol, trendOf, vwapBand } from '../../src/entry/prims.js';
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

// ------------------------------------------------------------ the 30 Sep 2026 audit

const flat = (i: number, tr: number, volume = 100): Candle => ({ time: 1_790_035_200 + 300 * i, open: 100, close: 100, high: 100 + tr / 2, low: 100 - tr / 2, volume });

test('[critical] ATR(14) is Wilder\'s: the first fourteen averaged, then smoothed a fourteenth a bar', () => {
  const bars = [flat(0, 10), ...Array.from({ length: 14 }, (_, i) => flat(i + 1, 10)), flat(15, 24), flat(16, 24)];
  const wilder = ((10 * 13 + 24) / 14 * 13 + 24) / 14;
  assert.ok(Math.abs(atr(bars)! - wilder) < 1e-9, `Wilder ${wilder}, not the plain average of the last 14 (12)`);
});

test('[critical] RVOL is the volume over the 20-bar average (the reference), not the median', () => {
  const bars = [...Array.from({ length: 19 }, (_, i) => flat(i, 10, 100)), flat(19, 10, 2_100), flat(20, 10, 300)];
  assert.equal(rvol(bars), 1.5, 'average 200: 300 / 200');
  assert.equal(rvol(bars, 20, 19), null, 'the 20th bar has only 19 before it');
});

const at = (i: number, close: number, high: number, low: number): Candle => ({ time: 1_790_035_200 + 300 * i, open: close, close, high, low, volume: 100 });

test('[critical] a swing is the one known at the time: a high confirmed only later is not what a bar broke', () => {
  const bars = [
    at(0, 84_000, 84_005, 83_995), at(1, 84_020, 84_025, 84_000), at(2, 84_050, 84_055, 84_018), at(3, 84_020, 84_045, 84_015),
    at(4, 84_000, 84_022, 83_995), at(5, 84_010, 84_015, 83_998), at(6, 84_030, 84_035, 84_008),
    at(7, 84_040, 84_150, 84_028), // a wick that becomes a swing high -- two bars later
    at(8, 84_080, 84_100, 84_038), // closes over the swing high of bar 2: the break
    at(9, 84_070, 84_090, 84_060), at(10, 84_060, 84_075, 84_050),
  ];
  const br = lastBreak(bars, 3);
  assert.deepEqual(br && [br.dir, br.level, br.i], [1, 84_055, 8]);
});

test('[critical] a swing low already traded through is not liquidity any more; a sweep must clear the buffer', () => {
  const bars = path([84_000, 83_980, 83_950, 83_920, 83_900, 83_940, 83_990, 84_030, 84_000, 83_960, 83_950], { w: 5 });
  bars[8] = { ...bars[8]!, low: 83_880 }; // the first sweep of the 83,895 low
  bars[10] = { ...bars[10]!, low: 83_860, close: 83_950 }; // the same low again
  assert.equal(lastSweep(bars, 3)?.i, 8, 'the first sweep, not the repeat');
  const once = path([84_000, 83_980, 83_950, 83_920, 83_900, 83_940, 83_990, 84_030, 84_000, 83_960, 83_950], { w: 5 });
  once[10] = { ...once[10]!, low: 83_860, close: 83_950 };
  assert.equal(lastSweep(once, 3, 50), null, '35 under the low does not clear a 50 buffer');
  assert.equal(lastSweep(once, 3, 30)?.i, 10);
});

test('[critical] a bullish gap under a bearish bar is not a fair-value gap: the gap must be the displacement\'s own', () => {
  const base = path(wave(30, 84_000, 10, 6));
  const t = base[base.length - 1]!.time;
  const odd = [
    { time: t + 300, open: 84_000, high: 84_010, low: 83_990, close: 84_005, volume: 100 },
    { time: t + 600, open: 84_200, high: 84_210, low: 84_000, close: 84_010, volume: 400 },
    { time: t + 900, open: 84_240, high: 84_250, low: 84_060, close: 84_240, volume: 100 },
  ];
  assert.equal(openFvgs([...base, ...odd]).filter((z) => z.time === t + 600).length, 0);
});

test('[critical] an order block is at the origin of the move: not a down candle ten bars before it', () => {
  const bars = path([...wave(20, 84_000, 10, 6), 83_990, 84_000, 84_004, 84_008, 84_012, 84_016, 84_020, 84_024, 84_028, 84_032], { w: 3 });
  bars[20] = { ...bars[20]!, open: 84_020, close: 83_990 }; // the last down candle, nine bars back
  const t = bars[bars.length - 1]!.time;
  bars.push({ time: t + 300, open: 84_032, high: 84_250, low: 84_030, close: 84_240, volume: 400 });
  assert.equal(orderBlocks(bars).filter((z) => z.time === bars[20]!.time).length, 0);
});

test('VWAP comes with its deviation, so a stretch can be read at a bar\'s extreme, not only at the close', () => {
  const vb = vwapBand(path(wave(40, 84_000, 30, 10)));
  assert.ok(vb && vb.sd > 0 && Math.abs(vb.vwap - 84_000) < 20);
});
