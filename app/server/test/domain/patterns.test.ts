import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  candlePatterns, marketStructure, relevant, structurePatterns, trendLines, type Pattern,
} from '../../src/domain/patterns.js';
import type { Candle } from '../../src/market/delta.js';

let t = 0;
const c = (open: number, high: number, low: number, close: number, volume = 100): Candle =>
  ({ time: ++t, open, high, low, close, volume });

const names = (ps: readonly Pattern[]) => ps.map((p) => p.name);
const has = (ps: readonly Pattern[], name: string) => names(ps).includes(name);

// ------------------------------------------------------------------ candles

test('a doji is a bar that opened and closed in the same place', () => {
  // A bar with no body has all its range in its wicks, so one of them is
  // always at least half of it. The three cases cover every such bar: which
  // wick dominates, or neither.
  assert.ok(has(candlePatterns([c(100, 105, 95, 100)]), 'Doji'), 'even wicks either side');
  assert.ok(has(candlePatterns([c(100, 101, 90, 100)]), 'Dragonfly Doji'), 'sold down and bought back');
  assert.ok(has(candlePatterns([c(100, 110, 99, 100)]), 'Gravestone Doji'), 'bought up and sold back');
});

test('a marubozu is all body and a spinning top is all wick', () => {
  assert.ok(has(candlePatterns([c(100, 110, 100, 110)]), 'Bullish Marubozu'));
  assert.ok(has(candlePatterns([c(110, 110, 100, 100)]), 'Bearish Marubozu'));
  assert.ok(has(candlePatterns([c(100, 106, 94, 103)]), 'Spinning Top'));
});

test('[critical] the same shape is a hammer under a fall and a hanging man after a rise', () => {
  const shape = c(100, 101, 90, 100.5);
  // The bar is identical; only what came before it differs, and that is the
  // whole difference between "buyers stepped in" and "be careful".
  assert.ok(has(candlePatterns([c(120, 121, 110, 112), c(112, 113, 104, 105), shape]), 'Hammer'));
  assert.ok(has(candlePatterns([c(80, 90, 79, 89), c(89, 97, 88, 96), shape]), 'Hanging Man'));
});

test('engulfing needs the whole of the bar before it, not most of it', () => {
  const after = [c(110, 111, 104, 105), c(104, 112, 103, 111)];
  assert.ok(has(candlePatterns(after), 'Bullish Engulfing'));
  // One tick short of covering the open is not an engulfing.
  const short = [c(110, 111, 104, 105), c(104, 109, 103, 109)];
  assert.ok(!has(candlePatterns(short), 'Bullish Engulfing'));
  assert.ok(has(candlePatterns([c(104, 112, 103, 111), c(111, 112, 103, 104)]), 'Bearish Engulfing'));
});

test('harami, piercing and dark cloud are told apart by where the second bar opens', () => {
  assert.ok(has(candlePatterns([c(120, 121, 100, 101), c(108, 112, 106, 110)]), 'Bullish Harami'));
  assert.ok(has(candlePatterns([c(120, 121, 100, 101), c(98, 114, 97, 113)]), 'Piercing Line'));
  assert.ok(has(candlePatterns([c(100, 121, 99, 120), c(123, 124, 105, 106)]), 'Dark Cloud Cover'));
});

test('tweezers are two bars refusing the same price', () => {
  assert.ok(has(candlePatterns([c(110, 111, 100, 102), c(102, 108, 100, 107)]), 'Tweezer Bottom'));
  assert.ok(has(candlePatterns([c(100, 120, 99, 118), c(118, 120, 110, 111)]), 'Tweezer Top'));
});

test('the three-bar patterns need all three', () => {
  const morning = [c(120, 121, 108, 109), c(108, 110, 106, 107), c(107, 120, 106, 118)];
  assert.ok(has(candlePatterns(morning), 'Morning Star'));
  assert.equal(candlePatterns(morning).find((p) => p.name === 'Morning Star')!.barsAgo, 2);
  const evening = [c(100, 112, 99, 111), c(111, 113, 110, 112), c(112, 113, 100, 101)];
  assert.ok(has(candlePatterns(evening), 'Evening Star'));
  const soldiers = [c(100, 106, 99, 105), c(105, 111, 104, 110), c(110, 116, 109, 115)];
  assert.ok(has(candlePatterns(soldiers), 'Three White Soldiers'));
  const crows = [c(115, 116, 109, 110), c(110, 111, 104, 105), c(105, 106, 99, 100)];
  assert.ok(has(candlePatterns(crows), 'Three Black Crows'));
});

test('more than one pattern can be true at once, and all of them are returned', () => {
  // The third bar of a morning star is often also a bullish engulfing. Picking
  // one to report would throw away the more interesting half at random.
  const both = [c(120, 121, 108, 109), c(109, 110, 106, 108.5), c(106, 122, 105, 121)];
  const found = names(candlePatterns(both));
  assert.ok(found.includes('Morning Star'), found.join(', '));
  assert.ok(found.includes('Bullish Engulfing'), found.join(', '));
});

test('a bar with no range at all names nothing rather than dividing by zero', () => {
  assert.deepEqual(candlePatterns([c(100, 100, 100, 100)]), []);
  assert.deepEqual(candlePatterns([]), []);
});

// ---------------------------------------------------------------- structure

/** Twenty bars making higher lows into a flat ceiling at 86,800. */
const ascending = (): Candle[] => {
  const out: Candle[] = [];
  for (let i = 0; i < 10; i++) {
    const low = 86_200 + i * 40;
    out.push(c(low + 100, 86_800, low, low + 200));
    out.push(c(low + 200, 86_790, low + 60, low + 150));
  }
  return out;
};

test('[critical] higher lows into one flat ceiling is an ascending triangle', () => {
  const found = names(structurePatterns({
    bars: ascending(), level: { resistance: 86_800, support: 86_200 }, atr: 400,
  }));
  assert.ok(found.includes('Higher Lows'), found.join(', '));
  assert.ok(found.includes('Ascending Triangle'), found.join(', '));
});

test('a level touched more than once is named with how many times', () => {
  const found = structurePatterns({ bars: ascending(), level: { resistance: 86_800, support: 86_200 }, atr: 400 });
  const test1 = found.find((p) => p.name.startsWith('Resistance Test'));
  assert.ok(test1, names(found).join(', '));
  assert.match(test1!.name, /Resistance Test \(\d+x\)/);
  assert.match(test1!.note, /Tested 86,800/);
});

test('bars getting smaller is compression, which is what precedes a break', () => {
  const wide = Array.from({ length: 15 }, () => c(100, 140, 60, 110));
  const tight = Array.from({ length: 5 }, () => c(100, 108, 96, 104));
  const found = names(structurePatterns({ bars: [...wide, ...tight], level: { resistance: null, support: null }, atr: 40 }));
  assert.ok(found.includes('Compression'), found.join(', '));
});

test('each bar busier than the last is a volume buildup', () => {
  const quiet = Array.from({ length: 16 }, () => c(100, 104, 96, 100, 100));
  const busy = [c(100, 104, 96, 101, 120), c(101, 105, 97, 102, 140), c(102, 106, 98, 103, 160), c(103, 107, 99, 104, 200)];
  const found = names(structurePatterns({ bars: [...quiet, ...busy], level: { resistance: null, support: null }, atr: 8 }));
  assert.ok(found.includes('Volume Buildup'), found.join(', '));
});

test('too few bars to have a shape names nothing', () => {
  assert.deepEqual(structurePatterns({ bars: [c(1, 2, 0, 1)], level: { resistance: null, support: null }, atr: 1 }), []);
});

// ----------------------------------------------------------------- picking

const p = (name: string, bias: Pattern['bias'], kind: Pattern['kind'], barsAgo = 0): Pattern =>
  ({ name, bias, kind, note: '', barsAgo });

test('[critical] only a few are shown, structure first', () => {
  const all = [
    p('Doji', 'NEUTRAL', 'candle'),
    p('Ascending Triangle', 'BULLISH', 'structure'),
    p('Higher Lows', 'BULLISH', 'structure'),
    p('Hammer', 'BULLISH', 'candle', 2),
    p('Spinning Top', 'NEUTRAL', 'candle'),
  ];
  const shown = names(relevant(all, 'BREAKOUT_WATCH', 'UP'));
  assert.equal(shown.length, 4, 'a card with everything on it is a card nobody reads');
  assert.ok(shown.slice(0, 2).includes('Ascending Triangle'));
  assert.ok(shown.slice(0, 2).includes('Higher Lows'));
});

test('[critical] while a level is being tested, the pattern that contradicts the push wins', () => {
  /*
   * Price is pushing at resistance. A bearish engulfing on this bar is what a
   * rejection looks like as it forms, and it is worth more to the person
   * watching than one more bullish candle agreeing with the push.
   */
  const all = [p('Bearish Engulfing', 'BEARISH', 'candle'), p('Bullish Pin Bar', 'BULLISH', 'candle')];
  assert.equal(relevant(all, 'BREAKOUT_WATCH', 'UP', 1)[0]!.name, 'Bearish Engulfing');
  // Once it has actually broken, agreement is what matters again.
  assert.equal(relevant(all, 'BREAKOUT_CONFIRMED', 'UP', 1)[0]!.name, 'Bullish Pin Bar');
});

test('an older pattern ranks under a newer one of the same standing', () => {
  const all = [p('Hammer', 'BULLISH', 'candle', 2), p('Bullish Pin Bar', 'BULLISH', 'candle', 0)];
  assert.equal(relevant(all, 'BREAKOUT_CONFIRMED', 'UP', 1)[0]!.name, 'Bullish Pin Bar');
});

/*
 * The lines a chart reader would draw. One only says anything where price has
 * not been yet, so it is carried forward to the newest bar rather than
 * stopping at the last swing it was drawn through.
 */
const swingBar = (low: number, high: number): Candle =>
  ({ time: 0, open: (low + high) / 2, high, low, close: (low + high) / 2, volume: 100 });

test('[critical] the support line runs through the last two swing lows, carried to the newest bar', () => {
  // Swing lows at bar 2 (100) and bar 6 (140): ten a bar, two bars on to the end.
  const bars = [
    swingBar(120, 200), swingBar(115, 200), swingBar(100, 200), swingBar(130, 200),
    swingBar(150, 200), swingBar(145, 200), swingBar(140, 200), swingBar(160, 200), swingBar(170, 200),
  ];
  const support = trendLines(bars).find((l) => l.kind === 'support');
  assert.ok(support);
  assert.equal(support.bias, 'BULLISH');
  assert.deepEqual(support.from, { barsAgo: 6, price: 100 });
  assert.deepEqual(support.to, { barsAgo: 0, price: 160 });
});

test('no line where there are not two swings to draw one through', () => {
  const flat = Array.from({ length: 6 }, () => swingBar(100, 200));
  assert.deepEqual(trendLines(flat), []);
  assert.deepEqual(trendLines([swingBar(100, 200), swingBar(101, 201)]), []);
});

/*
 * Market structure: the swings themselves, and the shapes they make. The
 * fixtures are built swing by swing, because a detector that fires on
 * "roughly the right shape" fires on everything.
 */
const sw = (low: number, high: number, close?: number): Candle =>
  ({ time: 0, open: (low + high) / 2, high, low, close: close ?? (low + high) / 2, volume: 100 });

/** A series of pivots: each turn is a bar higher (or lower) than its neighbours. */
const series = (points: number[][]): Candle[] => points.map(([l, h, c]) => sw(l!, h!, c));

test('[critical] the four labels: higher high, higher low, lower high, lower low', () => {
  const up = marketStructure({
    bars: series([
      [100, 120], [90, 110], [105, 125], [95, 115], [115, 140], [110, 130], [125, 150], [120, 145], [130, 160], [128, 155],
    ]),
    atr: 5,
  });
  const names = up.map((p) => p.name);
  assert.ok(names.includes('Higher High'), names.join(', '));
  assert.ok(names.includes('Higher Low'));
  assert.ok(!names.includes('Lower High'));
});

test('[critical] a sweep is the wick going through and the close not', () => {
  /*
   * The one shape where more of the move is evidence against it: the stops
   * above the high were taken and the price was handed straight back.
   */
  const bars = series([
    [100, 120], [95, 130], [100, 150], [95, 125], [100, 118], [98, 122], [100, 120], [96, 124], [99, 121], [97, 123],
  ]);
  // the next bar spikes through the earlier swing high at 150 and closes back under it
  bars.push(sw(118, 168, 121));
  bars.push(sw(115, 125, 118));
  const names = marketStructure({ bars, atr: 4 }).map((p) => p.name);
  assert.ok(names.includes('Liquidity Sweep (High)'), names.join(', '));
});

test('a double top is the same price refused twice, with a real dip between', () => {
  const bars = series([
    [100, 120], [95, 150], [90, 110], [85, 105], [88, 112], [92, 116], [95, 149], [92, 118], [90, 115], [89, 114], [88, 113],
  ]);
  const found = marketStructure({ bars, atr: 6 }).find((p) => p.name === 'Double Top');
  assert.ok(found);
  assert.equal(found.bias, 'BEARISH');
});

test('two pushes to the same price with no dip between them is not a pattern', () => {
  // Two highs in consecutive bars are one high.
  const bars = series([
    [100, 120], [118, 150], [119, 149], [100, 120], [95, 118], [92, 115], [90, 112], [88, 110], [87, 109], [86, 108], [85, 107],
  ]);
  const names = marketStructure({ bars, atr: 6 }).map((p) => p.name);
  assert.ok(!names.includes('Double Top'), names.join(', '));
});

test('nothing is claimed from too few bars to have a structure', () => {
  assert.deepEqual(marketStructure({ bars: series([[100, 120], [95, 115]]), atr: 5 }), []);
});
