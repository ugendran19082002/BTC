import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { orderBody } from '../../src/trading/exchange/delta.js';
import { stopFillLimit } from '../../src/trading/money.js';
import { PaperExchange } from '../../src/trading/exchange/paper.js';
import { rig, ceProduct, planFor, quote } from './harness.js';
import { anchorExits } from '../../src/trading/engine.js';
import type { PlaceOrderRequest, ProductSpec } from '../../src/trading/types.js';

/**
 * The stop, after 12 September 2026.
 *
 * Six stop orders were refused live that morning, all with Delta's `unsupported`
 * -- their wording: "Market order couldn't be validated for price impact as
 * orderbook data isn't available." A stop went to Delta as a *market* order, and
 * a market order cannot be accepted for an option with an empty book. So the
 * position had no stop on the exchange at exactly the time a stop is worth
 * having, and the desk's own watch was all that was left.
 *
 * A stop now goes as a limit order priced through its own trigger, which Delta
 * accepts with no book at all.
 */

const req = (over: Partial<PlaceOrderRequest> = {}): PlaceOrderRequest => ({
  clientOrderId: 'abc123S0',
  symbol: 'P-BTC-74000-110926',
  productId: 151997,
  side: 'buy',
  type: 'stop_limit',
  size: 850,
  stopPrice: 10.5,
  limitPrice: 15.75,
  reduceOnly: true,
  role: 'stop_loss',
  ...over,
});

// ------------------------------------------------------------- the body

test('[critical] a stop goes to Delta as a limit order with a trigger, never as a market order', () => {
  const body = orderBody(req());
  assert.equal(body.order_type, 'limit_order', 'a market order needs an orderbook Delta may not have');
  assert.equal(body.stop_order_type, 'stop_loss_order');
  assert.equal(body.stop_price, '10.5');
  assert.equal(body.limit_price, '15.75');
  assert.equal(body.stop_trigger_method, 'mark_price');
  assert.equal(body.reduce_only, true);
  assert.equal(body.time_in_force, 'gtc');
});

test('the refused order from 12 September, sent the new way, is a limit order', () => {
  // the exact order Delta refused six times: size 850, trigger 10.5, market
  const before = orderBody(req({ type: 'stop_market', limitPrice: undefined }));
  assert.equal(before.order_type, 'market_order', 'the old shape, kept only for reading orders back');
  assert.equal(orderBody(req()).order_type, 'limit_order');
});

// ------------------------------------------------------- where the limit sits

test('[critical] the limit is through the trigger, so the stop still fills -- and no further', () => {
  /*
   * 15% through, rounded towards filling. It was 50% until 24 September 2026,
   * which is a market order wearing a hat: a stop at 70 went out as a buy limit
   * at 105 and filled at 79, nine points against the desk, and nothing measured
   * it. Fifteen clears a normal book and bounds the damage on a thin one.
   */
  assert.equal(stopFillLimit('buy', 10.5, 0.1), 12.1);
  assert.equal(stopFillLimit('buy', 45, 0.5), 52);
  assert.equal(stopFillLimit('buy', 70, 0.1), 80.5, 'the trade that started this');
});

test('on a penny option the minimum is five ticks, not a percentage of nothing', () => {
  // 0.2 + 15% is 0.23, which rounds to one tick away: not enough room to fill.
  assert.equal(stopFillLimit('buy', 0.2, 0.1), 0.7);
});

test('a sell stop is priced the other way, and never below one tick', () => {
  assert.equal(stopFillLimit('sell', 10, 0.1), 8.5);
  assert.equal(stopFillLimit('sell', 0.2, 0.1), 0.1);
});

// ------------------------------------------------------------- on the book

const PE: ProductSpec = { ...ceProduct(), symbol: 'P-BTC-74000-110926', productId: 151997, optionSide: 'PE', strike: 74_000 };

test('[critical] a stop limit rests until its trigger, and does not fill on arrival', async () => {
  const ex = new PaperExchange({ balanceUsd: 10_000 });
  ex.addProduct(PE).setQuote(quote(PE.symbol, 5, 5.5, { mark: 5.2 }));
  ex.forcePosition(PE.symbol, -10, 12);
  const o = await ex.placeOrder(req({ size: 10, stopPrice: 10.5, limitPrice: 15.8 }));
  assert.equal(o.status, 'open', 'the mark is 5.20, nowhere near the 10.50 trigger');
  assert.equal(o.filledSize, 0);
});

test('[critical] it fills once the mark reaches the trigger -- at the offer, not at its own limit', async () => {
  const ex = new PaperExchange({ balanceUsd: 10_000 });
  ex.addProduct(PE).setQuote(quote(PE.symbol, 5, 5.5, { mark: 5.2 }));
  ex.forcePosition(PE.symbol, -10, 12);
  await ex.placeOrder(req({ size: 10, stopPrice: 10.5, limitPrice: 15.8 }));
  ex.tick(quote(PE.symbol, 10.5, 11, { mark: 10.6 }));
  const [o] = await ex.getOpenOrders(PE.symbol);
  const done = o ?? (await ex.getOrderByClientId('abc123S0'))!;
  assert.equal(done.filledSize, 10);
  assert.equal(done.averageFillPrice, 11, 'the offer it actually paid, not the 15.80 ceiling');
});

test('a gap past the limit leaves it resting, which is the cost of a limit', async () => {
  const ex = new PaperExchange({ balanceUsd: 10_000 });
  ex.addProduct(PE).setQuote(quote(PE.symbol, 5, 5.5, { mark: 5.2 }));
  ex.forcePosition(PE.symbol, -10, 12);
  await ex.placeOrder(req({ size: 10, stopPrice: 10.5, limitPrice: 15.8 }));
  ex.tick(quote(PE.symbol, 40, 45, { mark: 42 }));
  const [o] = await ex.getOpenOrders(PE.symbol);
  assert.equal(o?.filledSize, 0, 'the offer is 45, the limit is 15.80');
  // which is why the desk watches the stop itself and closes at the market
});

test('[critical] the engine places the stop as a stop limit, and moving it moves both prices', async () => {
  const r = rig();
  const plan = planFor(ceProduct(), { lots: 1, stopPrice: 110 });
  await r.engine.open(plan);
  await r.engine.poll(plan.tradeId);
  const [stop] = (await r.ex.getOpenOrders(ceProduct().symbol)).filter((o) => o.type === 'stop_limit');
  assert.ok(stop, 'the stop leg is a stop limit');
  assert.equal(stop.stopPrice, 110);
  assert.equal(stop.limitPrice, 126.5, 'priced through the trigger, 15% of it');

  await r.engine.updateProtection(plan.tradeId, { stopPrice: 130 });
  const [moved] = (await r.ex.getOpenOrders(ceProduct().symbol)).filter((o) => o.type === 'stop_limit');
  assert.equal(moved?.stopPrice, 130);
  assert.equal(moved?.limitPrice, 149.5, 'the limit travels with the trigger');
});

// ------------------------------------- when Delta cannot price a market order

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

const { DeltaExchange } = await import('../../src/trading/exchange/delta.js');

/** Answers each request in turn, and records the bodies sent. */
function answers(...replies: { status: number; body: unknown }[]) {
  const sent: Record<string, unknown>[] = [];
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    const path = String(url);
    if (path.includes('/v2/orders') && init?.method === 'POST') {
      sent.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      const r = replies[Math.min(sent.length - 1, replies.length - 1)]!;
      return new Response(JSON.stringify(r.body), { status: r.status });
    }
    if (path.includes('/v2/tickers/')) {
      return new Response(JSON.stringify({ success: true, result: { symbol: 'P-BTC-74000-110926', mark_price: '11', quotes: { best_bid: '10.5', best_ask: '11.5' } } }), { status: 200 });
    }
    if (path.includes('/v2/products/')) {
      return new Response(JSON.stringify({ success: true, result: { id: 151997, symbol: 'P-BTC-74000-110926', contract_type: 'put_options', tick_size: '0.1', contract_value: '0.001', state: 'live', trading_status: 'operational' } }), { status: 200 });
    }
    return new Response(JSON.stringify({ success: true, result: [] }), { status: 200 });
  }) as typeof fetch;
  return sent;
}

const unpriceable = { status: 400, body: { success: false, error: { code: 'unsupported' } } };
const filled = { status: 200, body: { success: true, result: { id: 1, product_id: 151997, product_symbol: 'P-BTC-74000-110926', side: 'buy', order_type: 'limit_order', size: 850, unfilled_size: 0, state: 'closed' } } };

test('[critical] a reduce-only market exit Delta cannot price is retried once, as a limit through the touch', async () => {
  const sent = answers(unpriceable, filled);
  const ex = new DeltaExchange({ key: 'k', secret: 's' });
  const o = await ex.placeOrder({
    clientOrderId: 'abc123X1', symbol: 'P-BTC-74000-110926', productId: 151997,
    side: 'buy', type: 'market', size: 850, reduceOnly: true, role: 'exit',
  });
  assert.equal(o.filledSize, 850);
  assert.equal(sent.length, 2, 'once as a market order, once as a limit');
  assert.equal(sent[0]!.order_type, 'market_order');
  assert.equal(sent[1]!.order_type, 'limit_order');
  /*
   * The offer is 11.50 and the limit goes 15% through it: enough to clear the
   * touch, bounded where it used to be 50% -- which is how a stop asked for at
   * 70 came back filled at 79 on 24 September.
   */
  assert.equal(sent[1]!.limit_price, '13.3');
  assert.equal(sent[1]!.reduce_only, true);
  assert.equal(sent[1]!.client_order_id, 'abc123X1', 'the same id: a duplicate is impossible');
});

test('[critical] an entry is never retried that way -- only an exit is worth any price', async () => {
  const { OrderRejected } = await import('../../src/trading/exchange/port.js');
  const sent = answers(unpriceable);
  const ex = new DeltaExchange({ key: 'k', secret: 's' });
  await assert.rejects(ex.placeOrder({
    clientOrderId: 'abc123E0', symbol: 'P-BTC-74000-110926', productId: 151997,
    side: 'sell', type: 'market', size: 850, role: 'entry',
  }), OrderRejected);
  assert.equal(sent.length, 1);
});

test('a refusal that is not about pricing is not retried', async () => {
  const { OrderRejected } = await import('../../src/trading/exchange/port.js');
  const sent = answers({ status: 400, body: { success: false, error: { code: 'insufficient_margin' } } });
  const ex = new DeltaExchange({ key: 'k', secret: 's' });
  await assert.rejects(ex.placeOrder({
    clientOrderId: 'abc123X2', symbol: 'P-BTC-74000-110926', productId: 151997,
    side: 'buy', type: 'market', size: 850, reduceOnly: true, role: 'exit',
  }), OrderRejected);
  assert.equal(sent.length, 1);
});

/*
 * A stop watched on the close.
 *
 * A wick through a level is not a break, and an option's mark can print a
 * price nothing traded at -- so a stop on the touch exits on noise a close
 * would have ridden out. The strategy chooses; the resting stop at Delta still
 * triggers on the mark underneath either way, which is why `close` makes this
 * desk patient and not the venue.
 */
const bar = (close: number, at = 0): Candle =>
  ({ time: at, open: close, high: close + 1, low: close - 1, close, volume: 10 });

test('[critical] on the close, a wick through the stop is not an exit', async () => {
  // The mark is through the stop, and the last closed bar is not.
  const r = rig({
    quotes: [quote(ceProduct().symbol, 129.5, 130.5)],
    candles: async () => [bar(104, 1), bar(107, 2), bar(131, 3)],
  });
  const plan = { ...planFor(ceProduct(), { lots: 1, stopPrice: 110 }), monitorOn: 'close' as const };
  await r.engine.open(plan);
  await r.engine.poll(plan.tradeId);

  const after = (await r.store.get(plan.tradeId))!;
  assert.notEqual(after.state.position, 0, 'the bar being formed is not a closed bar');
});

test('[critical] on the close, a bar that finishes through the stop is an exit', async () => {
  // The second-to-last bar is the last finished one, and it closed through.
  const r = rig({
    quotes: [quote(ceProduct().symbol, 103.5, 104.5)],
    candles: async () => [bar(104, 1), bar(118, 2), bar(107, 3)],
  });
  const plan = { ...planFor(ceProduct(), { lots: 1, stopPrice: 110 }), monitorOn: 'close' as const };
  await r.engine.open(plan);
  await r.engine.poll(plan.tradeId);

  const after = (await r.store.get(plan.tradeId))!;
  assert.equal(after.state.position, 0, 'closed on the bar, not on the wick');
});

test('a close-watched stop with no candles does nothing, rather than falling back to the touch', async () => {
  // A stop that fires because a candle request failed is a stop that fires at
  // random. The resting stop at the exchange is still there on the mark.
  const r = rig({
    quotes: [quote(ceProduct().symbol, 139.5, 140.5)],
    candles: async () => { throw new Error('feed down'); },
  });
  const plan = { ...planFor(ceProduct(), { lots: 1, stopPrice: 110 }), monitorOn: 'close' as const };
  await r.engine.open(plan);
  await r.engine.poll(plan.tradeId);
  assert.notEqual((await r.store.get(plan.tradeId))!.state.position, 0);
});

/*
 * A fixed price the fill has overtaken.
 *
 * `stopAt: 70` means seventy whatever the entry -- which is what a strategy
 * wants right up until the entry fills at seventy-five. The "stop" is then
 * under the position, `stopIfReached` sees the mark already past it, and the
 * trade opens and shuts inside a second for a loss nobody can explain.
 */
test('[critical] a fixed stop under the actual fill is refused, not acted on', () => {
  const rec = {
    plan: {
      tradeId: 't', symbol: 'C-BTC-80000-080926', optionSide: 'CE' as const, lots: 1, leverage: 100,
      entry: { kind: 'market' as const }, takeProfitPrice: null, stopPrice: 70,
      exitAsk: { stopAt: 70 },
    },
    state: { entryAvgPrice: 75, wantsProtection: true },
  } as unknown as Parameters<typeof anchorExits>[0];

  const after = anchorExits(rec);
  assert.equal(after.plan.stopPrice, null, 'a stop under the entry is no stop');
  assert.equal(after.state.wantsProtection, false);
  assert.match(after.plan.exitProblem ?? '', /must be over the 75 entry/);
});

test('[critical] a fixed target the fill has already passed goes the same way', () => {
  const rec = {
    plan: {
      tradeId: 't', symbol: 'C-BTC-80000-080926', optionSide: 'CE' as const, lots: 1, leverage: 100,
      entry: { kind: 'market' as const }, takeProfitPrice: 20, stopPrice: null,
      exitAsk: { takeProfitAt: 20 },
    },
    state: { entryAvgPrice: 18, wantsProtection: false },
  } as unknown as Parameters<typeof anchorExits>[0];

  const after = anchorExits(rec);
  assert.equal(after.plan.takeProfitPrice, null);
  assert.match(after.plan.exitProblem ?? '', /must be under the 18 entry/);
});

test('a fill on the right side of both prices anchors as usual', () => {
  const rec = {
    plan: {
      tradeId: 't', symbol: 'C-BTC-80000-080926', optionSide: 'CE' as const, lots: 1, leverage: 100,
      entry: { kind: 'market' as const }, takeProfitPrice: null, stopPrice: null,
      exitAsk: { stopAt: 70, takeProfitAt: 5 },
    },
    state: { entryAvgPrice: 15, wantsProtection: false },
  } as unknown as Parameters<typeof anchorExits>[0];

  const after = anchorExits(rec);
  assert.equal(after.plan.stopPrice, 70);
  assert.equal(after.plan.takeProfitPrice, 5);
  assert.equal(after.plan.exitProblem, undefined);
  assert.equal(after.state.wantsProtection, true);
});
