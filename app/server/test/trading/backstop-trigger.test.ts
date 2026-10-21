import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { BACKSTOP_LAST_BELOW, backstopTriggerFor } from '../../src/trading/engine.js';
import { orderBody, resetLastTriggerForTest } from '../../src/trading/exchange/delta.js';
import type { PlaceOrderRequest } from '../../src/trading/types.js';
import { rig, ceProduct, planFor, quote } from './harness.js';

/**
 * The backstop of a cheap option armed by the last trade, not the mark (21 Oct 2026). Delta's mark for an option
 * offered under 5 was more than twice the offer in 10.8% of a week's minutes, and on 19 Oct eighteen backstops fired on
 * it with nothing traded near them -- each bought back under the desk's own stop. Armed by the last trade, none of the
 * fifteen in the record would have fired.
 */
const CE = 'C-BTC-80000-080926';
const stop = (o: Partial<PlaceOrderRequest> = {}): PlaceOrderRequest => ({
  clientOrderId: 'abc123S0', symbol: 'P-BTC-74000-110926', productId: 151997, side: 'buy', type: 'stop_limit', size: 1,
  stopPrice: 27.5, limitPrice: 31.7, reduceOnly: true, role: 'stop_loss', ...o,
});

test('[critical] a premium under 20 is armed by the last trade; 20 or more, and one not known, by the mark', () => {
  assert.equal(BACKSTOP_LAST_BELOW, 20);
  assert.equal(backstopTriggerFor(5.5), 'last');
  assert.equal(backstopTriggerFor(19.9), 'last');
  assert.equal(backstopTriggerFor(20), 'mark');
  assert.equal(backstopTriggerFor(80), 'mark');
  assert.equal(backstopTriggerFor(null), 'mark');
  assert.equal(backstopTriggerFor(0), 'mark');
});

test('[critical] sent to Delta as it was asked for: the last trade, or the mark by default', () => {
  assert.equal(orderBody(stop({ triggerOn: 'last' })).stop_trigger_method, 'last_traded_price');
  assert.equal(orderBody(stop()).stop_trigger_method, 'mark_price');
  assert.equal(orderBody(stop({ triggerOn: 'mark' })).stop_trigger_method, 'mark_price');
  assert.equal(orderBody({ ...stop({ triggerOn: 'last' }), type: 'limit', stopPrice: undefined }).stop_trigger_method, undefined, 'only a stop has a trigger');
});

test('[critical] the engine arms each trade\'s backstop by its own premium', async () => {
  for (const [premium, want] of [[10, 'last'], [50, 'mark']] as const) {
    const r = rig({ products: [ceProduct()], quotes: [quote(CE, premium - 0.5, premium)] });
    const asked: PlaceOrderRequest[] = [];
    const place = r.ex.placeOrder.bind(r.ex);
    r.ex.placeOrder = async (req) => { asked.push(req); return place(req); };
    const plan = planFor(ceProduct(), { tradeId: 't', stopPrice: premium * 2, takeProfitPrice: premium * 0.2, lots: 1 });
    const opened = await r.engine.open({ ...plan, entry: { ...plan.entry, limitPrice: premium - 0.5 } });
    assert.equal(opened.ok, true, JSON.stringify(opened).slice(0, 200));
    for (let i = 0; i < 6; i++) { r.advance(1_250); await r.engine.poll('t'); }
    const sl = asked.find((x) => x.role === 'stop_loss');
    assert.ok(sl, `${premium}: a backstop placed`);
    assert.equal(sl!.triggerOn, want, `${premium}: armed by the ${want}`);
  }
});

// ------------------------------------------------ Delta refusing the last trade: the mark, at once
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; resetLastTriggerForTest(); });
const { DeltaExchange } = await import('../../src/trading/exchange/delta.js');
const { OrderRejected } = await import('../../src/trading/exchange/port.js');
function answers(...replies: { status: number; body: unknown }[]) {
  const sent: Record<string, unknown>[] = [];
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    if (String(url).includes('/v2/orders') && init?.method === 'POST') {
      sent.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      const r = replies[Math.min(sent.length - 1, replies.length - 1)]!;
      return new Response(JSON.stringify(r.body), { status: r.status });
    }
    return new Response(JSON.stringify({ success: true, result: [] }), { status: 200 });
  }) as typeof fetch;
  return sent;
}
const resting = { status: 200, body: { success: true, result: { id: 7, product_id: 151997, product_symbol: 'P-BTC-74000-110926', side: 'buy', order_type: 'limit_order', size: 1, unfilled_size: 1, state: 'pending', stop_price: '27.5' } } };
const triggerRefused = { status: 400, body: { success: false, error: { code: 'bad_schema', context: { schema_errors: [{ code: 'invalid', field: 'stop_trigger_method' }] } } } };

test('[critical] Delta refusing a stop armed by the last trade: placed at once on the mark, said once, and the mark from then on', async () => {
  const sent = answers(triggerRefused, resting);
  const ex = new DeltaExchange({ key: 'k', secret: 's' });
  const o = await ex.placeOrder(stop({ triggerOn: 'last' }));
  assert.equal(o.orderId, '7', 'a backstop on the book');
  assert.deepEqual(sent.map((b) => b.stop_trigger_method), ['last_traded_price', 'mark_price']);
  assert.equal(sent[1]!.client_order_id, 'abc123S0', 'the same id: a duplicate is impossible');
  // the next one goes on the mark straight away
  const again = answers(resting);
  await ex.placeOrder(stop({ triggerOn: 'last', clientOrderId: 'abc123S1' }));
  assert.deepEqual(again.map((b) => b.stop_trigger_method), ['mark_price']);
});

test('[critical] a refusal that is not about the trigger is not sent around, and does not turn the last trade off', async () => {
  const noRoom = { status: 400, body: { success: false, error: { code: 'no_position_for_reduce_only' } } };
  const sent = answers(noRoom);
  const ex = new DeltaExchange({ key: 'k', secret: 's' });
  await assert.rejects(ex.placeOrder(stop({ triggerOn: 'last' })), OrderRejected);
  assert.equal(sent.length, 1);
  const next = answers(resting);
  await ex.placeOrder(stop({ triggerOn: 'last', clientOrderId: 'abc123S2' }));
  assert.deepEqual(next.map((b) => b.stop_trigger_method), ['last_traded_price'], 'still the last trade');
});
