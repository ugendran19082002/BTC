import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rig, ceProduct, planFor, quote } from './harness.js';
import { failureCodes, type PrecheckResult } from '../../src/trading/precheck.js';
import { orderPlan } from '../../src/trading/order-plan.js';

/**
 * A strategy's own Max spread in the order's check (owner, 3 Nov 2026: "spread strategy-la vachu irukala, anka irunthu
 * call paniko, hardcode pana vena"). An order that sells into the bid was held to the desk's 15% whatever the strategy
 * said; the strategy's Max spread only steered its walk from the offer. Now the plan carries it, as it carries the
 * strategy's premium floor, and the ticket keeps the desk's.
 */

const CE = ceProduct().symbol;
// Sold at the bid: the order crosses the spread, so the spread is checked.
const atBid = (bid: number, over: Parameters<typeof planFor>[1] = {}) => planFor(ceProduct(), {
  lots: 1, takeProfitPrice: 1, stopPrice: bid * 3,
  entry: { type: 'limit', limitPrice: bid, timeoutMs: 0, marketFallback: false, chase: null },
  ...over,
});
const spreadSaid = (res: PrecheckResult) => (res.ok ? null : res.failures.find((f) => f.code === 'SPREAD_TOO_WIDE')?.message ?? null);

test('[critical] no Max spread of its own: an 18% spread is refused at the desk\'s 15%', async () => {
  const r = rig({ quotes: [quote(CE, 10, 12)] });
  assert.equal(spreadSaid(await r.engine.previewOpen(atBid(10))), 'Spread is 18.2%, limit is 15% for an order that crosses it.');
});

test('[critical] a strategy\'s 30% lets the 18% spread through; its 10% refuses a 12% one, in its own number', async () => {
  const wide = rig({ quotes: [quote(CE, 10, 12)] });
  const loose = await wide.engine.previewOpen(atBid(10, { maxSpreadPct: 0.3 }));
  assert.ok(!failureCodes(loose).includes('SPREAD_TOO_WIDE'), JSON.stringify(loose));
  const tight = rig({ quotes: [quote(CE, 10, 11.2)] });
  assert.equal(spreadSaid(await tight.engine.previewOpen(atBid(10, { maxSpreadPct: 0.1 }))), 'Spread is 11.3%, limit is 10% for an order that crosses it.');
});

test('the plan carries it only when a strategy gives it: the ticket never does', () => {
  const base = { symbol: CE, optionSide: 'CE' as const, strike: 80_000, expiryTs: 1, lots: 10, limitPrice: 1 };
  assert.equal('maxSpreadPct' in orderPlan(base, 'a'), false);
  assert.equal(orderPlan({ ...base, maxSpreadPct: 0.3 }, 'b').maxSpreadPct, 0.3);
});
