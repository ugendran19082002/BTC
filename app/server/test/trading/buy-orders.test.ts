import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rig, ceProduct, planFor, quote, T0 } from './harness.js';
import { STOP_CONFIRM_MS, type TradePlan } from '../../src/trading/engine.js';
import { DEFAULT_LIMITS, failureCodes, precheckBuy } from '../../src/trading/precheck.js';
import { initialTrade, replay } from '../../src/trading/machine.js';
import { orderPlan } from '../../src/trading/order-plan.js';
import { closePreview } from '../../src/trading/close-preview.js';
import { unrealisedPnlUsd } from '../../src/trading/margin.js';
import { orderOutcomeOf } from '../../src/trading/status.js';

/**
 * Buying an option to open (5 Oct 2026): a BUY-side signal strategy's real orders.
 *
 * Bought at the offer, sold to close, a long position counted from fills, profit as sold less paid, the
 * buyer's own gate, and the option's own target and stop judged by the desk on the bid. Every sell-side case
 * in orders.test.ts runs unchanged beside these.
 */

const CE = 'C-BTC-80000-080926';
const buyPlan = (over: Partial<TradePlan> = {}): TradePlan => planFor(ceProduct(), {
  tradeId: 't-buy-1', lots: 10, action: 'buy',
  entry: { type: 'limit', limitPrice: 101, timeoutMs: 5_000, marketFallback: false },
  takeProfitPrice: null, stopPrice: null,
  ...over,
});

test('[critical] the record of a bought option: position counted up from buys, profit is sold less paid', () => {
  const s0 = initialTrade({ tradeId: 'b', symbol: CE, productId: 1, optionSide: 'CE', requestedSize: 10, at: 0 });
  const held = replay(s0, [{ t: 'fill', role: 'entry', side: 'buy', size: 10, price: 20, orderId: 'e', at: 1 }]);
  assert.equal(held.position, 10, 'long 10');
  const half = replay(held, [{ t: 'fill', role: 'exit', side: 'sell', size: 4, price: 30, orderId: 'x', at: 2 }]);
  assert.equal(half.position, 6);
  assert.ok(Math.abs(half.realisedPnl - (30 - 20) * 4 * 0.001) < 1e-12, 'sold 4 at 30 that cost 20: a gain');
  const out = replay(half, [{ t: 'fill', role: 'exit', side: 'sell', size: 6, price: 12, orderId: 'y', at: 3 }]);
  assert.equal(out.position, 0);
  assert.equal(out.phase, 'flat');
  assert.ok(Math.abs(out.realisedPnl - ((30 * 4 + 12 * 6) / 10 - 20) * 10 * 0.001) < 1e-12);
  assert.equal(orderOutcomeOf(out), 'bought 10, sold back at 19.20');
  // A sold option's record is untouched.
  const short = replay(s0, [{ t: 'fill', role: 'entry', side: 'sell', size: 10, price: 20, orderId: 'e', at: 1 }]);
  assert.equal(short.position, -10);
  assert.equal(orderOutcomeOf(short), 'short 10');
});

test('[critical] open P&L and the close preview turn over for a bought position', () => {
  assert.equal(unrealisedPnlUsd({ entryPrice: 20, markPrice: 25, size: 10, long: true }), (25 - 20) * 10 * 0.001);
  assert.equal(unrealisedPnlUsd({ entryPrice: 20, markPrice: 25, size: -10 }), (20 - 25) * 10 * 0.001, 'a short as before');
  const s0 = initialTrade({ tradeId: 'b', symbol: CE, productId: 1, optionSide: 'CE', requestedSize: 10, at: 0 });
  const held = replay(s0, [{ t: 'fill', role: 'entry', side: 'buy', size: 10, price: 20, orderId: 'e', at: 1 }]);
  const p = closePreview({ state: held, quote: quote(CE, 24, 26), spot: 80_000 });
  assert.equal(p.buysBackAt, 24, 'a bought position is sold at the bid');
  assert.ok(Math.abs(p.bookedUsd! - (24 - 20) * 10 * 0.001) < 1e-12);
});

test('[critical] the buyer\'s gate: no margin or short cap, the premium in the free balance, never on a contract held short', () => {
  const base = {
    now: T0, size: 10, expect: { underlying: 'BTC', optionSide: 'CE' as const, strike: 80_000, expiryTs: ceProduct().expiryTs },
    product: ceProduct(), quote: quote(CE, 20, 21), feedHealthy: true, tradingEnabled: true,
    availableUsd: 1, costUsd: 0.22, existingPosition: 0, dayPnlUsd: 0, limits: { ...DEFAULT_LIMITS, maxShortContracts: 0 },
  };
  assert.deepEqual(precheckBuy(base), { ok: true }, 'a short cap of 0 does not stop a buy');
  assert.deepEqual(failureCodes(precheckBuy({ ...base, costUsd: 2 })), ['INSUFFICIENT_MARGIN']);
  assert.deepEqual(failureCodes(precheckBuy({ ...base, existingPosition: -5 })), ['DUPLICATE_POSITION']);
  assert.deepEqual(failureCodes(precheckBuy({ ...base, quote: quote(CE, 10, 21) })), ['SPREAD_TOO_WIDE']);
  assert.deepEqual(failureCodes(precheckBuy({ ...base, quote: { ...quote(CE, 20, 21), ts: T0 - 60_000 } })), ['STALE_QUOTE']);
  assert.deepEqual(failureCodes(precheckBuy({ ...base, dayPnlUsd: -24.9, limits: { ...base.limits, maxDailyLossUsd: 25 } })), ['DAILY_LOSS_LIMIT']);
});

test('[critical] a plan to buy rests nothing at the exchange: its exits are the desk\'s to judge', () => {
  const plan = orderPlan({
    symbol: CE, optionSide: 'CE', strike: 80_000, expiryTs: 1, lots: 1, limitPrice: 20, takeProfitPct: 0.5, stopLossPct: 2,
    action: 'buy', longExits: { target: { mode: 'pct', value: 1 }, stop: { mode: 'pct', value: 0.5 } },
  }, 't');
  assert.deepEqual([plan.action, plan.takeProfitPrice, plan.stopPrice, plan.exitAsk], ['buy', null, null, undefined]);
  assert.deepEqual(plan.longExits, { target: { mode: 'pct', value: 1 }, stop: { mode: 'pct', value: 0.5 } });
  // The ticket's plan is a sale, exactly as before.
  const sold = orderPlan({ symbol: CE, optionSide: 'CE', strike: 80_000, expiryTs: 1, lots: 1, limitPrice: 20, takeProfitPct: 0.5, stopLossPct: 2 }, 't');
  assert.equal(sold.action, 'sell');
  assert.equal(sold.stopPrice, 60);
});

test('[critical] bought at the offer, the target resting at Delta as a reduce-only sale, and filled there', async () => {
  const r = rig({ quotes: [quote(CE, 100, 101)] });
  const res = await r.engine.open(buyPlan({ longExits: { target: { mode: 'pct', value: 0.5 }, stop: { mode: 'pct', value: 0.4 } } }));
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.deepEqual([res.state.position, res.state.entryAvgPrice], [10, 101], 'long 10, bought at the offer');
  assert.equal((await r.ex.getPositions()).find((p) => p.symbol === CE)?.size, 10);

  const held = await r.engine.poll('t-buy-1');
  // 150% of 101 is 151.5: a sale rests there, reduce-only, for all 10 -- and no stop order (the desk judges it).
  const book = await r.ex.getOpenOrders(CE);
  assert.deepEqual(book.map((o) => [o.side, o.type, o.limitPrice, o.size, o.reduceOnly]), [['sell', 'limit', 151.5, 10, true]]);
  assert.equal(held!.protection.takeProfit, book[0]!.clientOrderId, 'the record knows its target');
  assert.equal(held!.protection.stopLoss, null);

  // The bid reaches it: the resting sale is the exit, at its price.
  r.ex.tick(quote(CE, 152, 153, { ts: r.now() }));
  const s = await r.engine.poll('t-buy-1');
  assert.equal(s!.position, 0);
  assert.equal(s!.phase, 'flat');
  const exit = s!.fills.find((f) => f.role !== 'entry')!;
  assert.equal(exit.side, 'sell');
  assert.ok(exit.price >= 151.5, `sold at the target or better, not under it: ${exit.price}`);
  assert.ok(s!.realisedPnl > 0);
  assert.deepEqual(await r.ex.getOpenOrders(CE), [], 'nothing left resting');
});

test('[critical] with no resting target (Delta refused it) the desk still sells at the target on the bid', async () => {
  const r = rig({ quotes: [quote(CE, 100, 101)] });
  await r.engine.open(buyPlan({ longExits: { target: { mode: 'pct', value: 0.5 }, stop: null } }));
  // Every reduce-only sale refused, as an exchange might while it registers the fill.
  const place = r.ex.placeOrder.bind(r.ex);
  r.ex.placeOrder = async (o) => { if (o.reduceOnly && o.role === 'take_profit') throw new Error('refused'); return place(o); };
  const held = await r.engine.poll('t-buy-1');
  assert.equal(held!.protection.takeProfit, null);
  assert.equal(held!.alarm, null, 'no alarm: a bought option wants no stop order');
  r.ex.setQuote(quote(CE, 152, 153, { ts: r.now() }));
  const s = await r.engine.poll('t-buy-1');
  assert.equal(s!.position, 0);
  assert.match(s!.exitReason ?? '', /option target reached: the bid at 152 \(target 151.5, bought at 101\)/);
});

test('[critical] editing a bought position\'s exits moves its own: the target over the price paid with no ceiling, never the short\'s stop', async () => {
  const r = rig({ quotes: [quote(CE, 100, 101)] });
  await r.engine.open(buyPlan({ longExits: { target: { mode: 'pct', value: 0.5 }, stop: null } }));
  await r.engine.poll('t-buy-1');
  // 350% over 101 is 454.5; a 50% stop is 50.5.
  const s = await r.engine.updateLongExits('t-buy-1', { target: { mode: 'pct', value: 3.5 }, stop: { mode: 'pct', value: 0.5 } });
  assert.equal(s!.position, 10);
  const rec = await r.store.get('t-buy-1');
  assert.deepEqual(rec!.plan.longExits, { target: { mode: 'pct', value: 3.5 }, stop: { mode: 'pct', value: 0.5 } });
  assert.deepEqual([rec!.plan.takeProfitPrice, rec!.plan.stopPrice], [null, null], 'the short\'s fields stay empty on a long');
  const book = await r.ex.getOpenOrders(CE);
  assert.deepEqual(book.map((o) => [o.side, o.limitPrice, o.size]), [['sell', 454.5, 10]], 'moved, not doubled');
  // A bid over the old "stop" reading of a short does not sell it: nothing at 120 is a level for a long.
  r.ex.setQuote(quote(CE, 120, 121, { ts: r.now() }));
  r.advance(STOP_CONFIRM_MS);
  r.ex.setQuote(quote(CE, 120, 121, { ts: r.now() }));
  assert.equal((await r.engine.poll('t-buy-1'))!.position, 10, 'still held');
  // Target off: the resting sale comes off.
  await r.engine.updateLongExits('t-buy-1', { target: null, stop: { mode: 'pct', value: 0.5 } });
  assert.deepEqual(await r.ex.getOpenOrders(CE), []);
});

test('[critical] the edit sheet\'s words read as a long\'s: a target under the price paid or a stop over it is refused', async () => {
  const { longExitsFor } = await import('../../src/trading/order-plan.js');
  assert.deepEqual(longExitsFor(40, { takeProfitPct: 3.5 }, undefined), { exits: { target: { mode: 'pct', value: 3.5 }, stop: null } });
  assert.deepEqual(longExitsFor(40, { stopLossPct: 0.5 }, { target: { mode: 'pct', value: 1 } }),
    { exits: { target: { mode: 'pct', value: 1 }, stop: { mode: 'pct', value: 0.5 } } }, 'a leg not asked about keeps what it had');
  assert.deepEqual(longExitsFor(40, { takeProfitPct: 0 }, { target: { mode: 'pct', value: 1 } }), { exits: { target: null, stop: null } }, 'zero is off');
  assert.deepEqual(longExitsFor(40, { takeProfitAt: 180 }, undefined), { exits: { target: { mode: 'price', value: 180 }, stop: null } });
  assert.ok('problem' in longExitsFor(40, { takeProfitAt: 30 }, undefined), 'a target under the price paid');
  assert.ok('problem' in longExitsFor(40, { stopAt: 45 }, undefined), 'a stop over the price paid');
  assert.ok('problem' in longExitsFor(40, { stopLossPct: 1 }, undefined), 'a 100% stop is no stop: zero is not a price');
});

test('[critical] the stop is judged on the bid and has to hold, like a short\'s on the offer', async () => {
  const r = rig({ quotes: [quote(CE, 100, 101)] });
  await r.engine.open(buyPlan({ longExits: { target: null, stop: { mode: 'pct', value: 0.4 } } }));
  // 40% lost from 101 is 60.6. A bid there once is not enough.
  r.ex.setQuote(quote(CE, 60, 61, { ts: r.now() }));
  assert.equal((await r.engine.poll('t-buy-1'))!.position, 10, 'one quote at the stop does not sell');
  r.advance(STOP_CONFIRM_MS);
  r.ex.setQuote(quote(CE, 60, 61, { ts: r.now() }));
  const s = await r.engine.poll('t-buy-1');
  assert.equal(s!.position, 0, 'held for the confirm time: sold');
  assert.ok(s!.realisedPnl < 0);
  assert.ok(s!.realisedPnl >= -101 * 10 * 0.001, 'never more than was paid');
});

test('[critical] the signal\'s perp levels close a bought option with a sale; a manual close sells it too', async () => {
  let perp = 85_000;
  const r = rig({ quotes: [quote(CE, 100, 101)], underlying: () => ({ price: perp, at: T0 }) });
  await r.engine.open(buyPlan({ underlying: { dir: 1, stop: 84_600, target: 85_500, source: 'BTC perp' } }));
  perp = 85_600;
  const s = await r.engine.exitOnUnderlying('t-buy-1');
  assert.equal(s!.position, 0);
  assert.equal(s!.fills.find((f) => f.role === 'exit')!.side, 'sell');

  const r2 = rig({ quotes: [quote(CE, 100, 101)] });
  await r2.engine.open(buyPlan());
  const closed = await r2.engine.closeNow('t-buy-1', 'manual exit');
  assert.equal(closed!.position, 0);
  assert.equal(closed!.fills.find((f) => f.role === 'exit')!.side, 'sell');
});

test('a close asked for a size that is not a number is refused, and sends nothing', async () => {
  const r = rig({ quotes: [quote(CE, 100.5, 101)] });
  await r.engine.open(planFor(ceProduct(), { lots: 5 }));
  const s = await r.engine.closeNow('t-CE-1', 'by hand', Number.NaN);
  assert.equal(s!.position, -5, 'still held');
  assert.equal((await r.ex.getPositions()).find((p) => p.symbol === CE)?.size, -5);
});

test('[critical] what the account cannot pay for is refused by the gate, and nothing is sent', async () => {
  const r = rig({ quotes: [quote(CE, 100, 101)], balanceUsd: 0.5 });
  const res = await r.engine.open(buyPlan());
  assert.equal(res.ok, false);
  assert.ok(failureCodes(res.precheck!).includes('INSUFFICIENT_MARGIN'));
  assert.deepEqual(await r.ex.getOpenOrders(CE), []);
  assert.equal((await r.ex.getPositions()).find((p) => p.symbol === CE)?.size ?? 0, 0);
});

test('[critical] a sale is refused on a contract this account holds bought, and a buy on one it holds short', async () => {
  const r = rig({ quotes: [quote(CE, 100, 101)] });
  await r.engine.open(buyPlan());
  const sale = await r.engine.open(planFor(ceProduct(), { tradeId: 't-sell-after', lots: 1, entry: { type: 'limit', limitPrice: 100, timeoutMs: 5_000, marketFallback: false } }));
  assert.equal(sale.ok, false);
  assert.ok(failureCodes(sale.precheck!).includes('DUPLICATE_POSITION'));

  const r2 = rig({ quotes: [quote(CE, 100.5, 101)] });
  await r2.engine.open(planFor(ceProduct(), { lots: 5 }));
  const buy = await r2.engine.open(buyPlan({ tradeId: 't-buy-after' }));
  assert.equal(buy.ok, false);
  assert.deepEqual(failureCodes(buy.precheck!), ['DUPLICATE_POSITION']);
});

test('[critical] the long limit: a buy past it is refused like a sale past the short limit', () => {
  const base = {
    now: T0, size: 10, expect: { underlying: 'BTC', optionSide: 'CE' as const, strike: 80_000, expiryTs: ceProduct().expiryTs },
    product: ceProduct(), quote: quote(CE, 20, 21), feedHealthy: true, tradingEnabled: true,
    availableUsd: 100, costUsd: 0.22, existingPosition: 0, dayPnlUsd: 0, limits: { ...DEFAULT_LIMITS, maxLongContracts: 25 },
  };
  assert.deepEqual(precheckBuy({ ...base, totalLongContracts: 15 }), { ok: true }, '15 + 10 is the limit: allowed');
  const over = precheckBuy({ ...base, totalLongContracts: 16 });
  assert.deepEqual(failureCodes(over), ['MAX_POSITION']);
  assert.equal(over.ok ? '' : over.failures[0]!.message, 'Would take total long to 26, limit is 25.');
});

test('[critical] the room left on each side: the gates\' own numbers, before an order', async () => {
  const { roomOf } = await import('../../src/http/routes/trade.routes.js');
  const r = roomOf({ trades: [-97, 5, -3], freeUsd: 28.81, spot: 85_000, shortLimit: 159, longLimit: 40, lossRoomUsd: 37.84 });
  assert.deepEqual([r.sell.held, r.sell.byLimit, r.buy.held, r.buy.byLimit], [100, 59, 5, 35]);
  // 200x: 85,000 / 200 x 0.001 = 0.425 a lot (plus a fee of nothing on a premium of 0): 28.81 carries 67.
  assert.equal(r.sell.byMargin, 67);
  assert.equal(r.sell.lots, 59, 'the smaller of the limit and the margin');
  const at50 = r.buy.byPremium.find((x) => x.premium === 50)!;
  assert.ok(Math.abs(at50.perLotUsd - (0.05 + 0.05 * 0.035 * 1.18)) < 1e-9, 'premium and fee, as Delta charges it');
  assert.equal(at50.lots, 35, 'the limit binds before the balance or the loss budget');
  const at200 = r.buy.byPremium.find((x) => x.premium === 200)!;
  assert.equal(at200.lots, Math.min(35, Math.floor(28.81 / at200.perLotUsd)));
});
