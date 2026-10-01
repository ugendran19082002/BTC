import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Candle } from '../../src/market/delta.js';
import { METHODS, type Setup } from '../../src/entry/methods.js';
import { atr, ema, trendOf } from '../../src/entry/prims.js';
import type { EntryContext, MethodId } from '../../src/entry/types.js';
import { ctxOf, path, wave } from './bars.js';

/**
 * Each of the twelve methods' own chain, on candles shaped to be that setup.
 * What the engine then does with it -- gates, targets, the timeframe chain --
 * is engine.test.ts.
 */

function detect(id: MethodId, bars: readonly Candle[], ctx: Partial<EntryContext> = {}): Setup | null {
  const m = METHODS.find((x) => x.id === id)!;
  return m.detect({ bars, a: atr(bars)!, trend: trendOf(bars), ctx: ctxOf(ctx) });
}
const oks = (s: Setup | null) => s?.steps.map((x) => x.ok);
const add = (bars: Candle[], ...xs: Omit<Candle, 'time' | 'volume'>[]) => {
  for (const x of xs) bars.push({ time: bars[bars.length - 1]!.time + 300, volume: 100, ...x });
  return bars;
};

test('[critical] the twelve first, numbered 1-12, then every other method by the owner\'s numbers -- each id once, in the four groups', () => {
  assert.deepEqual(METHODS.slice(0, 12).map((m) => m.n), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  assert.equal(METHODS.length, 74);
  assert.ok(METHODS.slice(12).every((m) => m.n > 12));
  assert.equal(new Set(METHODS.map((m) => m.id)).size, METHODS.length);
  assert.deepEqual([...new Set(METHODS.map((m) => m.group))].sort(), ['breakout', 'flow', 'pullback', 'reversal']);
});

test('2. breakout + retest: broke, came back, held, rejected', () => {
  const bars = add(path(wave(40, 84_000, 30, 10)),
    { open: 84_020, high: 84_155, low: 84_015, close: 84_150 },
    { open: 84_150, high: 84_152, low: 84_080, close: 84_090 },
    { open: 84_090, high: 84_095, low: 84_040, close: 84_060 },
    { open: 84_060, high: 84_125, low: 84_030, close: 84_120 });
  const s = detect('breakout-retest', bars);
  assert.equal(s?.dir, 1);
  assert.deepEqual(oks(s), [true, true, true, true]);
});

test('[critical] 3. a sweep without the structure break is only its first step', () => {
  const bars = path([...wave(20, 84_000, 10, 6), 84_000, 83_980, 83_950, 83_920, 83_900, 83_940, 83_990, 84_030, 84_000, 83_960, 83_950]);
  bars[bars.length - 1] = { ...bars[bars.length - 1]!, low: 83_860, close: 83_950 };
  const s = detect('liquidity-sweep', bars);
  assert.equal(s?.dir, 1);
  assert.deepEqual(oks(s), [true, true, false], 'swept and recovered, but no MSS yet');
  assert.equal(s?.stop, 83_860, 'the stop is past the sweep');
});

test('4. FVG: a gap left by displacement, price back into it, a reaction out', () => {
  const bars = add(path(wave(30, 84_000, 10, 6)),
    { open: 84_000, high: 84_010, low: 83_990, close: 84_005 },
    { open: 84_005, high: 84_200, low: 84_000, close: 84_190 },
    { open: 84_190, high: 84_230, low: 84_060, close: 84_220 },
    { open: 84_220, high: 84_225, low: 84_050, close: 84_070 },
    { open: 84_070, high: 84_150, low: 84_065, close: 84_140 });
  const s = detect('fvg-retest', bars);
  assert.equal(s?.dir, 1);
  assert.deepEqual(s?.zone, [84_035, 84_060], 'from the edge price reaches first (the top) to the middle of the 84,010-84,060 gap');
  assert.deepEqual(oks(s), [true, true, true]);
  assert.equal(s?.stop, 84_000, "SL at the displacement's origin -- the low of the candle that left the gap (the engine adds 0.25 ATR)");
});

test('5. order block: back into the block, and rejected there', () => {
  const bars = path([...wave(20, 84_000, 10, 6), 84_000, 84_030, 84_060, 84_030, 84_000, 84_010, 83_990, 83_980], { w: 5 });
  add(bars,
    { open: 83_980, high: 84_200, low: 83_975, close: 84_190 },
    { open: 84_190, high: 84_195, low: 83_990, close: 84_000 },
    { open: 84_000, high: 84_060, low: 83_995, close: 84_050 });
  const s = detect('ob-retest', bars);
  assert.equal(s?.dir, 1);
  assert.deepEqual(oks(s), [true, true, true]);
});

test('6. BOS: an uptrend closing through its last swing high by displacement', () => {
  const bars = path(wave(80, 84_000, 40, 10, 6));
  const top = Math.max(...bars.slice(-12).map((b) => b.high));
  const c = bars[bars.length - 1]!.close;
  add(bars, { open: c, high: top + 125, low: c - 5, close: top + 120 });
  const s = detect('bos', bars);
  assert.equal(s?.dir, 1);
  assert.deepEqual(oks(s), [true, true, true], 'the break, by displacement, with the trend');
});

test('[critical] 6 and 7: the same close through a swing is a BOS with the trend and a CHoCH against it', () => {
  const down = path(wave(80, 84_000, 40, 10, -6));
  const top = Math.max(...down.slice(-12).map((b) => b.high));
  const c = down[down.length - 1]!.close;
  add(down, { open: c, high: top + 125, low: c - 5, close: top + 120 });
  assert.equal(oks(detect('bos', down))?.[2], false, 'not a BOS to take: the trend was down');
  const s = detect('mss', down);
  assert.equal(s?.dir, 1, 'a change of character');
  assert.equal(oks(s)?.[0], true);
});

test('8. momentum: a 1.5 ATR body on heavy volume, closed near its high', () => {
  const bars = path(wave(60, 84_000, 20, 10));
  const c = bars[bars.length - 1]!.close;
  bars.push({ time: bars[bars.length - 1]!.time + 300, open: c, high: c + 125, low: c - 3, close: c + 120, volume: 500 });
  const s = detect('momentum', bars);
  assert.equal(s?.dir, 1);
  assert.deepEqual(oks(s), [true, true, true, false], 'the follow-through is still to come');
  assert.equal(s?.blocked, undefined, 'not yet extended');
  add(bars, { open: c + 120, high: c + 150, low: c + 110, close: c + 145 });
  const t = detect('momentum', bars);
  assert.deepEqual(oks(t), [true, true, true, true], 'the next bar closed further up');
  assert.equal(t?.triggerTime, bars[bars.length - 2]!.time, 'anchored to the signal bar');
});

test('9. pullback: an uptrend back to its 20 EMA, then resuming', () => {
  const bars = path(wave(80, 84_000, 40, 10, 6));
  const e = ema(bars, 20)!;
  const c = bars[bars.length - 1]!.close;
  add(bars,
    { open: c, high: c + 2, low: e - 1, close: e + 2 },
    { open: e + 2, high: c + 35, low: e, close: c + 30 });
  const s = detect('pullback', bars);
  assert.equal(s?.dir, 1);
  assert.deepEqual(oks(s), [true, true, true, true]);
});

test('[critical] 10. mean reversion is off on a trend day, however stretched', () => {
  const closes = Array.from({ length: 60 }, (_, i) => 84_000 - 12 * i);
  const bars = path(closes);
  const c = bars[bars.length - 1]!.close;
  add(bars, { open: c, high: c + 5, low: c - 400, close: c - 380 }, { open: c - 380, high: c - 300, low: c - 385, close: c - 310 });
  const s = detect('vwap-reversion', bars);
  assert.equal(s?.dir, 1, 'stretched far under VWAP');
  assert.match(s?.blocked ?? '', /trend day/);
  assert.match(s?.targets?.[0]?.why ?? '', /^VWAP/);
});

test('[critical] 11. order flow with no recorded tape says "not read", never confirmed', () => {
  const bars = path([...wave(40, 84_000, 30, 10), 84_010, 83_990, 83_975, 83_985, 83_978]);
  const s = detect('order-flow', bars);
  assert.equal(s?.dir, 1, 'at support');
  assert.equal(oks(s)?.[1], null, 'the tape was not read');
});

test('11. order flow: sellers hit support, it held, the delta turned', () => {
  const bars = path([...wave(40, 84_000, 30, 10), 84_010, 83_990, 83_975, 83_985, 83_978]);
  const nowSec = bars[bars.length - 1]!.time + 300 + 5;
  const minute = (k: number, buy: number, sell: number, largeBuy = 0) => ({ time: nowSec - 60 * k, buy, sell, largeBuy, largeSell: 0 });
  const flow = [minute(7, 10, 60), minute(6, 10, 60), minute(5, 10, 60), minute(4, 10, 50), minute(3, 60, 10, 30), minute(2, 70, 10, 30)];
  const one = path([84_000, 83_995, 83_990, 83_992, 83_996, 84_000, 84_004], { step: 60, t0: nowSec - 8 * 60, w: 2 });
  const s = detect('order-flow', bars, { now: nowSec * 1000, flow, frames: { '1m': one } });
  assert.deepEqual(oks(s), [true, true, true, true, true]);
});

test('12. options: at the put OI wall, reacting, with the big-move reading unread', () => {
  const bars = path(wave(60, 84_000, 20, 10));
  const c = bars[bars.length - 1]!.close;
  add(bars, { open: c, high: c + 2, low: 83_950, close: 83_960 }, { open: 83_960, high: c + 40, low: 83_955, close: c + 35 });
  const s = detect('options-flow', bars, {
    options: { spot: c, atmIv: 0.4, emDay: 1_500, callWall: 86_000, putWall: 83_950, maxPain: 84_500, toSettleSec: 20_000 },
  });
  assert.equal(s?.dir, 1);
  assert.deepEqual(oks(s), [true, true, true, true, null, null], 'the wall held, price rejected it, structure not against; big move and tape unread');
  assert.match(s?.tp3?.why ?? '', /max pain 84,500/, 'max pain is its TP3 (owner\'s SL/TP table), not TP1');
});

test('12. with no option board there is no options setup', () => {
  assert.equal(detect('options-flow', path(wave(60))), null);
});

// ------------------------------------------------------------ the 30 Sep 2026 audit

test('[critical] 10. the stretch is read at the extreme of the last bars: the reversal that brings the close back is still the setup', () => {
  const bars = add(path(wave(50, 84_000, 30, 10)),
    { open: 84_000, high: 84_005, low: 83_700, close: 83_720 },
    { open: 83_720, high: 84_015, low: 83_710, close: 84_010 });
  const s = detect('vwap-reversion', bars);
  assert.equal(s?.dir, 1, 'the close is back near VWAP, but the low two bars ago was far under it');
  assert.deepEqual(oks(s), [true, true, null, true], 'stretched, a reversal candle, the tape unread, returning');
  assert.equal(s?.stop, 83_700);
});

test('[critical] 12. a big-move reading with no direction is not against a trade', () => {
  const bars = path(wave(60, 84_000, 20, 10));
  const c = bars[bars.length - 1]!.close;
  add(bars, { open: c, high: c + 2, low: 83_950, close: 83_960 }, { open: 83_960, high: c + 40, low: 83_955, close: c + 35 });
  const s = detect('options-flow', bars, {
    options: { spot: c, atmIv: 0.4, emDay: 1_500, callWall: 86_000, putWall: 83_950, maxPain: 84_500, toSettleSec: 20_000 },
    bigMove: { band: 'normal', direction: null },
  });
  assert.equal(oks(s)?.[4], true);
});

test('[critical] 6. BOS: a counter-trend break is shown, and refused, not hidden', () => {
  const down = path(wave(80, 84_000, 40, 10, -6));
  const top = Math.max(...down.slice(-12).map((b) => b.high));
  const c = down[down.length - 1]!.close;
  add(down, { open: c, high: top + 125, low: c - 5, close: top + 120 });
  const s = detect('bos', down);
  assert.equal(s?.steps[2]?.label.startsWith('trend aligned'), true);
  assert.equal(s?.steps[2]?.ok, false);
});
