import { test } from 'node:test';
import assert from 'node:assert/strict';
import { swingLevels, swingsOf } from '../../src/market/moves.js';
import type { Candle } from '../../src/market/delta.js';

const bar = (i: number, high: number, low: number): Candle => ({ time: i * 60, open: (high + low) / 2, high, low, close: (high + low) / 2, volume: 1 } as Candle);

/**
 * A level is a fractal swing: a bar whose high beats the two either side, or
 * whose low undercuts them. The two nearest above the price are resistance,
 * the two nearest below are support, and a swing on top of the price is not
 * a level.
 */
test('[critical] the nearest swing highs above and swing lows below, nearest first', () => {
  // A ridge at bar 3 (high 105) and bar 9 (high 110); troughs at bar 6 (low 95) and bar 12 (low 90).
  const bars = [
    bar(0, 101, 99), bar(1, 102, 100), bar(2, 103, 101), bar(3, 105, 102), bar(4, 103, 100), bar(5, 101, 97),
    bar(6, 99, 95), bar(7, 101, 97), bar(8, 106, 100), bar(9, 110, 104), bar(10, 106, 100), bar(11, 100, 93),
    bar(12, 96, 90), bar(13, 100, 94), bar(14, 102, 97),
  ];
  assert.deepEqual(swingsOf(bars), { highs: [105, 110], lows: [95, 90] });
  assert.deepEqual(swingLevels(bars, 100), { resistance: [105, 110], support: [95, 90] });
  assert.deepEqual(swingLevels(bars, 107), { resistance: [110], support: [95, 90] });
  assert.deepEqual(swingLevels(bars, 105.05), { resistance: [110], support: [95, 90] }, 'a swing on top of the price is not a level');
  assert.deepEqual(swingLevels([], 100), { resistance: [], support: [] });
});
