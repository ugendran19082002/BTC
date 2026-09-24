import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isWholeLots, lotsToContracts, midOf, priceFor, roundToTick, slippageOf, spreadPct, stopFillLimit, stopPriceFor, tickDecimals,
} from '../../src/trading/money.js';

test('rounding lands exactly on a tick, with no floating point tail', () => {
  assert.equal(roundToTick(100.07, 0.1, 'up'), 100.1);
  assert.equal(roundToTick(100.07, 0.1, 'down'), 100);
  assert.equal(roundToTick(100.04, 0.1, 'nearest'), 100);
  assert.equal(roundToTick(100.06, 0.1, 'nearest'), 100.1);
  assert.equal(roundToTick(0.3, 0.1, 'nearest'), 0.3, '0.1 arithmetic must not leak');
  assert.equal(roundToTick(2.675, 0.005, 'nearest'), 2.675);
});

test('a price already on the tick is left alone in every direction', () => {
  for (const dir of ['up', 'down', 'nearest'] as const) {
    assert.equal(roundToTick(100.5, 0.1, dir), 100.5, dir);
  }
});

test('rounding never moves the price against the side placing it', () => {
  // a seller would rather ask for more than accidentally offer for less
  assert.equal(priceFor('sell', 100.07, 0.1), 100.1);
  // a buyer would rather bid less than accidentally pay more
  assert.equal(priceFor('buy', 100.07, 0.1), 100);
});

test('a stop rounds towards getting out, not towards a better price', () => {
  assert.equal(stopPriceFor('buy', 110.03, 0.1), 110.1, 'a buy stop triggers rather than misses');
  assert.equal(stopPriceFor('sell', 89.97, 0.1), 89.9);
});

test('a zero or missing tick is a passthrough, not a divide by zero', () => {
  assert.equal(roundToTick(100.07, 0), 100.07);
});

test('lots convert to whole contracts and fractions are dropped, never rounded up', () => {
  assert.equal(lotsToContracts(7, 10), 70);
  assert.equal(lotsToContracts(7.9, 10), 70, 'never size up on a fraction');
  assert.equal(lotsToContracts(0, 10), 0);
});

test('a size the exchange would refuse is caught before it is sent', () => {
  assert.equal(isWholeLots(70, 10), true);
  assert.equal(isWholeLots(7, 10), false);
  assert.equal(isWholeLots(0, 10), false);
  assert.equal(isWholeLots(10, 0), false);
});

test('a one-sided book has no mid and no measurable spread', () => {
  assert.equal(midOf(100, null), null);
  assert.equal(midOf(null, 101), null);
  assert.equal(spreadPct(100, null), null);
  assert.equal(midOf(100, 101), 100.5);
});

test('spread is measured against the mid', () => {
  assert.ok(Math.abs(spreadPct(100, 105)! - 5 / 102.5) < 1e-12);
  assert.equal(spreadPct(100, 100), 0);
});

test('tick decimals are read from the tick, so formatting matches the venue', () => {
  assert.equal(tickDecimals(0.1), 1);
  assert.equal(tickDecimals(0.005), 3);
  assert.equal(tickDecimals(1), 0);
});

/*
 * The stop that cost nine points.
 *
 * 24 September 2026: a stop asked for at 70 filled at 79. It was not latency
 * and it was not the exchange -- the desk sent the stop as a limit priced 50%
 * through its own trigger, which is a market order wearing a hat, and the
 * trigger swept every offer up to 105 until it filled. Nothing measured it, so
 * nothing said so.
 */
test('[critical] the stop limit clears the book without being a blank cheque', () => {
  // A stop at 70: the limit is 15% through, not half again.
  assert.equal(stopFillLimit('buy', 70, 0.1), 80.5);
  assert.ok(stopFillLimit('buy', 70, 0.1) < 70 * 1.2, 'nowhere near the old 105');
  // A penny option: a percentage of nothing is nothing, so the floor is ticks.
  assert.equal(stopFillLimit('buy', 0.5, 0.1), 1);
});

test('[critical] slippage is measured against what was asked for, and signed against the desk', () => {
  /*
   * A stop is a buy-back, so paying more is worse; a target is a sell, so
   * receiving less is worse. Both read as "points against you", because the
   * one question is what the exit cost.
   */
  assert.deepEqual(slippageOf('stop_loss', 70, 79), { points: 9, pct: 12.9 });
  assert.deepEqual(slippageOf('take_profit', 20, 18), { points: 2, pct: 10 });
  // Better than asked for is negative: it happens, and it is not a problem.
  assert.deepEqual(slippageOf('stop_loss', 70, 69.5), { points: -0.5, pct: -0.7 });
});

test('nothing to compare against is not zero slippage', () => {
  // Zero would read as "the fill was perfect", which is a different claim.
  assert.equal(slippageOf('stop_loss', null, 79), null);
  assert.equal(slippageOf('stop_loss', 70, null), null);
  assert.equal(slippageOf('stop_loss', 0, 79), null);
});
