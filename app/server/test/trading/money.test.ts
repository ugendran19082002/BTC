import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isWholeLots, lotsToContracts, midOf, priceFor, roundToTick, spreadPct, stopPriceFor, tickDecimals,
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
