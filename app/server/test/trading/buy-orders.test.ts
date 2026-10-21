import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rig, ceProduct, planFor, quote } from './harness.js';
import { type TradePlan, type TradeRecord } from '../../src/trading/engine.js';
import { failureCodes } from '../../src/trading/precheck.js';
import { initialTrade, replay } from '../../src/trading/machine.js';
import { closePreview } from '../../src/trading/close-preview.js';
import { unrealisedPnlUsd } from '../../src/trading/margin.js';
import { orderOutcomeOf } from '../../src/trading/status.js';
import { DEFAULT_CONFIG, SELL_ONLY_RULE, validateConfig, type StrategyConfig } from '../../src/strategy/types.js';

/**
 * Selling only (owner, 21 Oct 2026: "I only SELL and exit -- I will not use BUY, no BUY-side entry; remove it").
 *
 * Buying an option to open is refused wherever it is asked for -- the engine's gate, a strategy's save -- and nothing
 * is sent. What stays: a bought position's record and P&L read as they always did (the 36 of the history), and one
 * found on the account is not managed -- nothing placed behind it, said once -- but can still be closed by hand.
 */

const CE = 'C-BTC-80000-080926';

test('[critical] a plan to buy is refused by the gate, whoever asks, and nothing reaches the exchange', async () => {
  const r = rig({ quotes: [quote(CE, 100, 101)] });
  const res = await r.engine.open(planFor(ceProduct(), { tradeId: 't-buy', lots: 10, action: 'buy', takeProfitPrice: null, stopPrice: null }));
  assert.equal(res.ok, false);
  assert.deepEqual(failureCodes(res.precheck!), ['SELL_ONLY']);
  assert.deepEqual(await r.ex.getOpenOrders(CE), []);
  assert.equal((await r.ex.getPositions()).find((p) => p.symbol === CE)?.size ?? 0, 0);
  // previewed too: the same gate
  const p = await r.engine.previewOpen(planFor(ceProduct(), { tradeId: 't-buy-2', action: 'buy' }));
  assert.equal(p.ok, false);
});

test('[critical] a strategy saved to buy is refused, in words; one that sells is as before', () => {
  const sig = (action?: 'buy' | 'sell'): StrategyConfig => ({
    ...DEFAULT_CONFIG, trigger: 'signal',
    signal: { mode: 'single', tf: '15m', tfs: ['15m'], methods: ['breakout'], target: 'tp1', maxOpen: 5, enterOn: 'zone', ...(action ? { action } : {}) },
  } as StrategyConfig);
  assert.ok(validateConfig(sig('buy')).includes(SELL_ONLY_RULE));
  assert.ok(!validateConfig(sig('sell')).includes(SELL_ONLY_RULE));
  assert.ok(!validateConfig(sig()).includes(SELL_ONLY_RULE), 'no action: sold, as every strategy');
});

/** A bought position on the account and a record of the desk's for it: an old trade, or one bought by hand. */
async function heldLong() {
  const r = rig({ quotes: [quote(CE, 100, 101)] });
  await r.ex.placeOrder({ clientOrderId: 'byhand', symbol: CE, productId: ceProduct().productId, side: 'buy', type: 'market', size: 10, role: 'entry' });
  const s0 = initialTrade({ tradeId: 'old-long', symbol: CE, productId: ceProduct().productId, optionSide: 'CE', requestedSize: 10, at: r.now() });
  const state = replay(s0, [{ t: 'fill', role: 'entry', side: 'buy', size: 10, price: 101, orderId: 'byhand', at: r.now() }]);
  const plan: TradePlan = planFor(ceProduct(), { tradeId: 'old-long', lots: 10, action: 'buy', takeProfitPrice: null, stopPrice: null });
  await r.store.save({ plan, events: [], state } as TradeRecord);
  return r;
}

test('[critical] a bought position found is not managed: nothing placed behind it -- a buy-back would add to it -- and said once', async () => {
  const r = await heldLong();
  for (let i = 0; i < 3; i++) { r.advance(1_250); await r.engine.poll('old-long'); }
  assert.deepEqual(await r.ex.getOpenOrders(CE), [], 'no reduce-only buy, no target, no stop');
  const said = (await r.store.get('old-long'))!.events.filter((e) => e.t === 'protection_failed');
  assert.equal(said.length, 1, 'once');
  assert.match((said[0] as { reason: string }).reason, /only sells options and does not manage it\. Close it by hand/);
  assert.equal((await r.ex.getPositions()).find((p) => p.symbol === CE)?.size, 10, 'still held: nothing sold for it');
});

test('[critical] a bought position\'s exits are not edited -- and it can still be closed by hand, with a sale', async () => {
  const r = await heldLong();
  const closed = await r.engine.closeNow('old-long', 'by hand');
  assert.equal(closed!.position, 0);
  assert.equal(closed!.fills.find((f) => f.role === 'exit')!.side, 'sell');
  assert.equal((await r.ex.getPositions()).find((p) => p.symbol === CE)?.size ?? 0, 0);
});

test('[critical] a sale is refused on a contract this account holds bought: it would sell that position down', async () => {
  const r = await heldLong();
  const sale = await r.engine.open(planFor(ceProduct(), { tradeId: 't-sell-after', lots: 1, entry: { type: 'limit', limitPrice: 100, timeoutMs: 5_000, marketFallback: false } }));
  assert.equal(sale.ok, false);
  assert.ok(failureCodes(sale.precheck!).includes('DUPLICATE_POSITION'));
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

test('a close asked for a size that is not a number is refused, and sends nothing', async () => {
  const r = rig({ quotes: [quote(CE, 100.5, 101)] });
  await r.engine.open(planFor(ceProduct(), { lots: 5 }));
  const s = await r.engine.closeNow('t-CE-1', 'by hand', Number.NaN);
  assert.equal(s!.position, -5, 'still held');
  assert.equal((await r.ex.getPositions()).find((p) => p.symbol === CE)?.size, -5);
});
