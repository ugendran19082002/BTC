import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rig, ceProduct, planFor, quote } from './harness.js';
import { failureCodes } from '../../src/trading/precheck.js';
import { orderPlan } from '../../src/trading/order-plan.js';
import { validateConfig, DEFAULT_CONFIG, type StrategyConfig } from '../../src/strategy/types.js';

/**
 * A strategy's own premium floor.
 *
 * 30 Sep 2026: the 17:01 strategy was refused every day it ran, partly because
 * 29 minutes before settlement most strikes pay under the desk's $5 floor, and
 * AlgoTest sold them. The floor stays the desk's for everything -- the ticket,
 * best-pick, every strategy that does not say otherwise -- and a strategy may
 * name its own.
 */

const CE = ceProduct().symbol;
const cheap = (over: Parameters<typeof planFor>[1] = {}) => planFor(ceProduct(), {
  lots: 10, takeProfitPrice: 0.1, stopPrice: 3,
  entry: { type: 'limit', limitPrice: 1, timeoutMs: 0, marketFallback: false, chase: null },
  ...over,
});

test('[critical] without its own floor a $1 leg is refused by the desk\'s', async () => {
  const r = rig({ quotes: [quote(CE, 1, 1.1)] });
  const res = await r.engine.previewOpen(cheap());
  assert.ok(failureCodes(res).includes('PREMIUM_TOO_LOW'));
});

test('[critical] a strategy floor of $0.50 lets the $1 leg through that gate', async () => {
  const r = rig({ quotes: [quote(CE, 1, 1.1)] });
  const res = await r.engine.previewOpen(cheap({ minPremiumUsd: 0.5 }));
  assert.ok(!failureCodes(res).includes('PREMIUM_TOO_LOW'), JSON.stringify(res));
});

test('a strategy floor can be stricter than the desk\'s, too', async () => {
  const r = rig({ quotes: [quote(CE, 6, 6.2)] });
  const res = await r.engine.previewOpen(cheap({
    minPremiumUsd: 8, entry: { type: 'limit', limitPrice: 6, timeoutMs: 0, marketFallback: false, chase: null },
  }));
  assert.ok(failureCodes(res).includes('PREMIUM_TOO_LOW'));
});

test('the plan carries it only when it was asked for', () => {
  const base = { symbol: CE, optionSide: 'CE' as const, strike: 80_000, expiryTs: 1, lots: 10, limitPrice: 1 };
  assert.equal('minPremiumUsd' in orderPlan(base, 'a'), false, 'the ticket never sets it');
  assert.equal(orderPlan({ ...base, minPremiumUsd: 0.5 }, 'b').minPremiumUsd, 0.5);
});

test('validateConfig: empty is the desk\'s floor; under one tick is refused', () => {
  const v = (over: Partial<StrategyConfig>) => validateConfig({ ...DEFAULT_CONFIG, ...over });
  assert.deepEqual(v({ minPremiumUsd: null }), []);
  assert.deepEqual(v({ minPremiumUsd: 0.5 }), []);
  assert.match(v({ minPremiumUsd: 0.05 }).join(' '), /at least \$0\.10/);
});

test('validateConfig: an entry in the 5:30-5:35 PM launch auction is refused; 5:35 is fine', () => {
  const v = (entryTime: string) => validateConfig({ ...DEFAULT_CONFIG, entryTime, exitTime: '05:00' });
  assert.match(v('17:30').join(' '), /launch auction/);
  assert.match(v('17:34').join(' '), /launch auction/);
  assert.deepEqual(v('17:35'), []);
  assert.deepEqual(v('17:29').filter((m) => /auction/.test(m)), []);
});
