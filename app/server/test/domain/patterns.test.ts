import { test } from 'node:test';
import assert from 'node:assert/strict';
import { candlePatterns, relevant, structurePatterns, type Pattern } from '../../src/domain/patterns.js';
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
