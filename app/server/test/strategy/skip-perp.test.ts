import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG, SELL_ONLY_RULE, SKIP_SL_NEEDS_STOP, validateConfig, type SignalRule, type Strategy, type StrategyConfig } from '../../src/strategy/types.js';
import { planOfStrategy } from '../../src/report/signal-backtest.js';
import { sessionOf } from '../../src/report/market-day.js';

/**
 * Skip perp SL / Skip perp TGT in the signal strategy form (owner, 18 Oct 2026): a live strategy's trades not closed
 * when the perp reaches a level it skips. The SL skipped needs the option's own stop -- a sold option is never left
 * with nothing under it.
 */
const signal = (rule: Partial<SignalRule> = {}, c: Partial<StrategyConfig> = {}): StrategyConfig => ({
  ...DEFAULT_CONFIG, trigger: 'signal', ...c,
  signal: { mode: 'single', tf: '15m', methods: ['breakout'], target: 'tp1', maxOpen: 10, action: 'sell', ...rule },
});
const skipProblems = (c: StrategyConfig) => validateConfig(c).filter((p) => /skip|only stop/i.test(p));

test('[critical] the perp SL skipped needs an option stop -- a fixed one, one by the clock, or one by volatility', () => {
  assert.deepEqual(skipProblems(signal({ skipPerpSl: true }, { stopLossPct: 2 })), []);
  assert.deepEqual(skipProblems(signal({ skipPerpSl: true }, { stopLossPct: 0, stopSteps: [] })), [SKIP_SL_NEEDS_STOP]);
  assert.deepEqual(skipProblems(signal({ skipPerpSl: true }, { stopLossPct: 0, stopSteps: [{ at: '23:00', value: 1.5 }] })), [], 'a stop from 23:00 by the clock');
  assert.deepEqual(skipProblems(signal({ skipPerpSl: true, slByVol: { on: true, by: 'atr', low: 1, medium: 1.5, high: 2 } }, { stopLossPct: 0 })), []);
  // the TGT alone skipped: the perp SL still stands, nothing more needed
  assert.deepEqual(skipProblems(signal({ skipPerpTgt: true }, { stopLossPct: 0 })), []);
});

test('[critical] a strategy that buys is not taken at all (21 Oct 2026: selling only); and the switches are on or off', () => {
  assert.ok(validateConfig(signal({ action: 'buy', skipPerpTgt: true }, { takeProfitPct: 0, stopLossPct: 0 })).includes(SELL_ONLY_RULE));
  assert.ok(validateConfig(signal({ skipPerpSl: 'yes' as unknown as boolean }, { stopLossPct: 2 })).some((p) => /on or off/.test(p)));
});

test('[critical] the backtest of the strategy skips what it skips: its plan carries the same', () => {
  const { from, to } = sessionOf('2026-10-07');
  const s = (rule: Partial<SignalRule>): Strategy => ({ id: 's', name: 's', enabled: true, accountId: 1, createdAt: 0, updatedAt: 0, config: signal(rule, { stopLossPct: 2 }) });
  assert.deepEqual(planOfStrategy(s({ skipPerpSl: true }), { from, to }).skipPerp, { sl: true, tgt: false });
  assert.equal(planOfStrategy(s({}), { from, to }).skipPerp, undefined);
});
