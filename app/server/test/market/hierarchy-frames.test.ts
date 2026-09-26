import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { resampleTf, HIERARCHY_TIMEFRAMES } from '../../src/market/moves.js';
import type { Candle } from '../../src/market/delta.js';

/**
 * The frames `docs/New.md`'s hierarchy needs that Delta India does not serve.
 *
 * Measured 26 Sep 2026 against the live endpoint: 30m, 2h and 6h all return
 * bars; **12h returns none**. So the 12-hour frame is folded from 6-hour ones,
 * and the fold has to land on the boundary every other chart would draw, or
 * the slowest and highest-weighted row in the ladder is describing a bar
 * nobody else can see.
 */

/** Six-hour bars starting at a given epoch second. */
function sixes(from: number, n: number, closes?: readonly number[]): Candle[] {
  return Array.from({ length: n }, (_, i) => ({
    time: from + i * 21_600,
    open: 100 + i,
    high: 110 + i,
    low: 90 + i,
    close: closes?.[i] ?? 100 + i,
    volume: 10,
  }));
}

const NOON = 1_700_000_000 - (1_700_000_000 % 43_200); // a 12-hour boundary

describe('folding 6h bars into 12h', () => {
  test('[critical] two 6h bars become one 12h bar: first open, last close, extreme high and low', () => {
    const bars = sixes(NOON, 2, [100, 200]);
    const out = resampleTf(bars, 2);
    assert.equal(out.length, 1);
    assert.equal(out[0]!.time, NOON);
    assert.equal(out[0]!.open, bars[0]!.open);
    assert.equal(out[0]!.close, 200);
    assert.equal(out[0]!.high, Math.max(bars[0]!.high, bars[1]!.high));
    assert.equal(out[0]!.low, Math.min(bars[0]!.low, bars[1]!.low));
    assert.equal(out[0]!.volume, 20);
  });

  test('[critical] the fold lands on 00:00 and 12:00 UTC, not on whatever arrived first', () => {
    // Start one bar BEFORE a boundary: that bar must be dropped, not paired.
    const bars = sixes(NOON - 21_600, 5);
    const out = resampleTf(bars, 2);
    for (const b of out) assert.equal(b.time % 43_200, 0, `${b.time} is not a 12-hour boundary`);
    assert.equal(out[0]!.time, NOON);
  });

  test('a trailing half-pair is dropped rather than shown as a whole bar', () => {
    const out = resampleTf(sixes(NOON, 5), 2);
    assert.equal(out.length, 2, 'the odd fifth bar was emitted as a complete 12h bar');
  });

  test('folding by one is a copy, not a shared reference', () => {
    const bars = sixes(NOON, 3);
    const out = resampleTf(bars, 1);
    assert.deepEqual(out, bars);
    assert.notEqual(out[0], bars[0]);
  });

  test('too few bars to know the step is no bars, not a guess', () => {
    assert.deepEqual(resampleTf([], 2), []);
    assert.deepEqual(resampleTf(sixes(NOON, 1), 2), []);
  });

  test('a fold never invents a price outside what it folded', () => {
    const bars = sixes(NOON, 20);
    const out = resampleTf(bars, 2);
    const hi = Math.max(...bars.map((b) => b.high));
    const lo = Math.min(...bars.map((b) => b.low));
    for (const b of out) {
      assert.ok(b.high <= hi && b.low >= lo);
      assert.ok(b.high >= b.low);
    }
  });
});

describe('the hierarchy list', () => {
  test('[critical] it is exactly the frames New.md names, coarsest first', () => {
    assert.deepEqual([...HIERARCHY_TIMEFRAMES], ['12h', '6h', '4h', '2h', '1h', '30m', '15m', '5m', '1m']);
  });
});
