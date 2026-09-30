import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { slippageAlert, PROBLEM_REPEAT_MS } from '../../src/notify/messages.js';
import { slippageOf, SLIPPAGE_ALERT_PCT } from '../../src/trading/money.js';
import type { TradeState } from '../../src/trading/types.js';
import type { TradePlan } from '../../src/trading/engine.js';

/**
 * The exit that printed a long way from the price that asked for it.
 *
 * The arithmetic was always right; the *delivery* was not. `onAlarm` pushed the
 * message onto a fifty-entry array in memory that no screen drew and no restart
 * survived, so a stop asked at 56.5 and filled at 65 on 27 Sep 2026 — 15% through
 * its own trigger — was found by reading the day's fills by hand, exactly as on
 * 24 Sep before the alarm existed.
 */

const state = { tradeId: 'C-BTC-85200-270926-1', symbol: 'C-BTC-85200-270926' } as unknown as TradeState;
const plan = {
  symbol: 'C-BTC-85200-270926', lots: 10,
  expect: { strike: 85_200, optionSide: 'CE', underlying: 'BTC', expiryTs: 1_790_510_400 },
} as unknown as TradePlan;

describe('the real fill that went unreported', () => {
  test('[critical] 56.5 asked, 65 filled is over the alert threshold', () => {
    const slip = slippageOf('stop_loss', 56.5, 65);
    assert.ok(slip);
    assert.equal(slip!.points, 8.5);
    assert.equal(slip!.pct, 15);
    assert.ok(slip!.pct >= SLIPPAGE_ALERT_PCT, 'the day it cost 8.5 points it did not clear the bar');
  });

  test('a tick or two is below the bar and must not alert', () => {
    const slip = slippageOf('stop_loss', 56.5, 57);
    assert.ok(slip!.pct < SLIPPAGE_ALERT_PCT);
  });

  test('a target that fills better than asked is not slippage against the desk', () => {
    // A target buys a short back: 0.2 against an asked 0.3 is cheaper, which is better.
    const slip = slippageOf('take_profit', 0.3, 0.2);
    assert.ok(slip!.points < 0, 'paying less than asked was reported as a cost');
  });
});

describe('the alert it now becomes', () => {
  const a = slippageAlert({ mode: 'live' }, state, plan, 'Stop asked 56.5, filled 65.0 — +8.5 points against it (15%).', 1_790_504_127_241);

  test('[critical] it carries the numbers, not just a warning', () => {
    assert.match(a.text, /56\.5/);
    assert.match(a.text, /65\.0/);
    assert.match(a.text, /8\.5 points/);
  });

  test('[critical] it says the exit worked — this is a cost, not a failure to exit', () => {
    assert.match(a.text, /not a failure to exit/i);
  });

  test('several pieces of one violent exit are one message, not five', () => {
    const b = slippageAlert({ mode: 'live' }, state, plan, 'a second piece', 1_790_504_127_999);
    assert.equal(a.key, b.key, 'two pieces of one exit had different keys');
    assert.equal(a.repeatAfterMs, PROBLEM_REPEAT_MS);
  });

  test('the key is per trade, so two trades slipping do not silence each other', () => {
    const other = { ...state, tradeId: 'P-BTC-84800-270926-2' } as TradeState;
    assert.notEqual(a.key, slippageAlert({ mode: 'live' }, other, plan, 'x', 1).key);
  });

  test('paper is marked as paper — a paper fill may never reach the phone dressed as live', () => {
    const paper = slippageAlert({ mode: 'paper' }, state, plan, 'x', 1);
    assert.notEqual(paper.text, slippageAlert({ mode: 'live' }, state, plan, 'x', 1).text);
  });
});
