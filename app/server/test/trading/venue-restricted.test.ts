import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { rig, ceProduct, planFor, T0 } from './harness.js';
import { applyEvent as step, initialTrade } from '../../src/trading/machine.js';

const { DeltaExchange, resetVenueState } = await import('../../src/trading/exchange/delta.js');
const { ExchangeUnavailable, VenueRestricted } = await import('../../src/trading/exchange/port.js');

/**
 * Delta's night of 18 Oct 2026, 1:02-1:37 AM IST: nineteen minutes of HTTP 502 to everything, then seven of
 * "market_disrupted_cancel_only_mode" -- cancels taken, nothing new. At the 1:30 target step the desk moved 49 trades'
 * targets into it: each edit refused, each fell back to cancel-and-replace, the cancel taken and the new order not --
 * the desk took its own resting targets off the book -- and 388 refusals and 49 "POSITION UNPROTECTED" (over stops
 * that never moved) followed, one a second.
 */

const plan = () => planFor(ceProduct());
const open = async () => {
  const r = rig();
  const p = plan();
  await r.engine.open(p);
  const s = await r.engine.poll(p.tradeId);
  assert.ok(s?.protection.takeProfit && s.protection.stopLoss, 'a target and a stop on the book to begin with');
  return { r, p, s: s! };
};
const resting = async (r: Awaited<ReturnType<typeof open>>['r'], symbol: string) => (await r.ex.getOpenOrders(symbol)).filter((o) => o.status === 'open');

test('[critical] cancel-only, before the desk knows: a target moved is refused as an edit and left resting where it was -- never cancelled with nothing to put back; the stop untouched, no alarm', async () => {
  const { r, p, s } = await open();
  const before = await resting(r, p.symbol);
  r.ex.configure({ cancelOnly: { until: T0 + 60_000, told: false } });
  const after = await r.engine.updateProtection(p.tradeId, { takeProfitPrice: 85 });
  const book = await resting(r, p.symbol);
  assert.deepEqual(book.map((o) => [o.clientOrderId, o.limitPrice, o.stopPrice]), before.map((o) => [o.clientOrderId, o.limitPrice, o.stopPrice]), 'the book exactly as it was');
  assert.equal(after?.protection.takeProfit, s.protection.takeProfit);
  assert.equal(after?.protection.stopLoss, s.protection.stopLoss);
  assert.equal(after?.alarm, null, 'the stop rests: not an unprotected position');
  assert.notEqual(after?.phase, 'unprotected');
  assert.match(after?.note ?? '', /could not place the target: .*cancel_only/);
  const failed = r.store.peek(p.tradeId)!.events.filter((e) => e.t === 'protection_failed');
  assert.deepEqual(failed.map((e) => (e as { leg?: string }).leg), ['take_profit']);
  assert.equal(r.alarms.length, 0, 'nobody is woken for a target');
});

test('[critical] cancel-only, once the desk knows: nothing on the book is touched until the hold ends -- then the target moves to its new level', async () => {
  const { r, p } = await open();
  const before = await resting(r, p.symbol);
  r.ex.configure({ cancelOnly: { until: T0 + 60_000 } });
  const held = await r.engine.updateProtection(p.tradeId, { takeProfitPrice: 85 });
  assert.deepEqual((await resting(r, p.symbol)).map((o) => o.clientOrderId), before.map((o) => o.clientOrderId));
  assert.equal(held?.alarm, null);
  assert.equal(r.store.peek(p.tradeId)!.events.filter((e) => e.t === 'protection_failed').length, 0, 'not even tried: no refusal to count');
  // Inside the hold: still not asked.
  r.advance(30_000);
  await r.engine.poll(p.tradeId);
  assert.equal((await resting(r, p.symbol)).find((o) => o.type === 'limit')?.limitPrice, before.find((o) => o.type === 'limit')?.limitPrice);
  // Delta takes orders again; past the hold, the target goes to 85.
  r.ex.configure({ cancelOnly: undefined });
  r.advance(31_000);
  const moved = await r.engine.poll(p.tradeId);
  assert.equal((await resting(r, p.symbol)).find((o) => o.type === 'limit')?.limitPrice, 85);
  assert.equal(moved?.phase, 'protected');
});

test('[critical] the stop failing is still an unprotected position, whatever the target did', () => {
  let s = initialTrade({ tradeId: 'T', symbol: 'C-BTC-80000-080926', productId: 1, optionSide: 'CE', requestedSize: 100, at: T0, wantsProtection: true });
  s = { ...s, position: -100, phase: 'position_open', protection: { takeProfit: 'tp', stopLoss: null, size: 100 } };
  const stop = step(s, { t: 'protection_failed', reason: 'refused', at: T0 });
  assert.equal(stop.phase, 'unprotected');
  assert.match(stop.alarm ?? '', /POSITION UNPROTECTED/);
  // A target alone, said as the target's -- but with no stop resting either, the position is still unprotected.
  const noStop = step(s, { t: 'protection_failed', reason: 'refused', at: T0, leg: 'take_profit' });
  assert.equal(noStop.phase, 'unprotected');
  const covered = step({ ...s, protection: { takeProfit: null, stopLoss: 'sl', size: 100 } }, { t: 'protection_failed', reason: 'refused', at: T0, leg: 'take_profit' });
  assert.deepEqual([covered.phase, covered.alarm], ['position_open', null]);
});

// ------------------------------------------------------------------------------------------------ the Delta adapter

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; resetVenueState(); });
type Reply = { status: number; body: unknown };
function answers(pick: (method: string, url: string) => Reply) {
  const seen: string[] = [];
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    const m = init?.method ?? 'GET';
    seen.push(`${m} ${String(url).replace(/^https:\/\/[^/]+/, '')}`);
    const r = pick(m, String(url));
    return new Response(JSON.stringify(r.body), { status: r.status });
  }) as typeof fetch;
  return seen;
}
const creds = { key: 'k', secret: 's' };
const cancelOnly: Reply = { status: 400, body: { success: false, error: { code: 'market_disrupted_cancel_only_mode' } } };
const order = (over: Record<string, unknown> = {}) => ({
  clientOrderId: 'c1', symbol: 'C-BTC-80000-080926', productId: 1, side: 'sell' as const, type: 'limit' as const, size: 1, limitPrice: 10, ...over,
});
const placed = { status: 200, body: { success: true, result: { id: 5, client_order_id: 'c9', product_id: 1, product_symbol: 'C-BTC-80000-080926', side: 'buy', size: 1, unfilled_size: 1, order_type: 'limit_order', limit_price: '9', state: 'open', reduce_only: true } } };

test('[critical] Delta in cancel-only mode: the refusal is the venue\'s, held 30s -- no entry and no leverage change is sent meanwhile, but a close still is, and the first order taken clears it', async () => {
  let mode: 'restricted' | 'open' = 'restricted';
  const seen = answers(() => (mode === 'restricted' ? cancelOnly : placed));
  const ex = new DeltaExchange(creds);
  await assert.rejects(ex.placeOrder(order({ reduceOnly: true, side: 'buy' })), (e: unknown) => e instanceof VenueRestricted);
  assert.match(ex.restriction()?.reason ?? '', /cancel-only mode/);
  const sent = seen.length;
  // An entry, and the leverage before one: not sent at all.
  await assert.rejects(ex.placeOrder(order()), (e: unknown) => e instanceof VenueRestricted && /not sent/.test((e as Error).message));
  await assert.rejects(ex.setLeverage(1, 200), (e: unknown) => e instanceof VenueRestricted);
  assert.equal(seen.length, sent, 'nothing reached Delta');
  // A close is still sent -- it is the order that must go the moment Delta takes orders again.
  mode = 'open';
  await ex.placeOrder(order({ reduceOnly: true, side: 'buy', type: 'market', limitPrice: undefined }));
  assert.equal(seen.length, sent + 1);
  assert.equal(ex.restriction(), null, 'taken: the restriction is over');
});

test('[critical] Delta in cancel-only mode refuses an edit: said as the venue\'s refusal, not a reason to cancel', async () => {
  answers(() => cancelOnly);
  const ex = new DeltaExchange(creds);
  await assert.rejects(ex.editOrder({ orderId: '5', productId: 1 }, { limitPrice: 9 }), (e: unknown) => e instanceof VenueRestricted);
  assert.ok(ex.restriction());
});

test('[critical] Delta not answering: after three reads in a row fail, reads are held back -- answered as the outage at once, without asking -- and asked again after the hold', async () => {
  const outage: Reply = { status: 502, body: '' };
  let down = true;
  const seen = answers(() => (down ? outage : { status: 200, body: { success: true, result: [] } }));
  const ex = new DeltaExchange(creds);
  for (let i = 0; i < 3; i++) await assert.rejects(ex.getOpenOrders(), ExchangeUnavailable);
  assert.equal(seen.length, 6, 'each asked twice, as a read is');
  await assert.rejects(ex.getOpenOrders(), (e: unknown) => e instanceof ExchangeUnavailable && /held back/.test((e as Error).message));
  assert.equal(seen.length, 6, 'held: Delta not asked');
  // The hold is two seconds the first time: past it, asked again -- and an answer ends the outage.
  down = false;
  await new Promise((done) => setTimeout(done, 2_100));
  assert.deepEqual(await ex.getOpenOrders(), []);
  assert.deepEqual(await ex.getOpenOrders(), [], 'and reads go as usual');
  assert.equal(seen.length, 8);
});

/*
 * One contract Delta will only reduce (19 Oct 2026, the error log: two sales of P-BTC-78800-191026 refused 7 minutes
 * apart, "only_reduce_only_orders_allowed"). The contract's, not the market's: noted, and the strike picker passes
 * over it, so the next signal sells the next strike out.
 */
const { isReduceOnly, clearReduceOnly, REDUCE_ONLY_HOLD_MS } = await import('../../src/trading/contract-restrictions.js');
const { sellable } = await import('../../src/strategy/runner.js');
const { OrderRejected } = await import('../../src/trading/exchange/port.js');
const reduceOnlyRefusal: Reply = { status: 400, body: { success: false, error: { code: 'only_reduce_only_orders_allowed' } } };

test('[critical] a contract on reduce-only: the sale refused as the order\'s, the contract noted -- not the market held up', async () => {
  clearReduceOnly();
  answers(() => reduceOnlyRefusal);
  const ex = new DeltaExchange(creds);
  const sym = 'P-BTC-78800-191026';
  await assert.rejects(ex.placeOrder(order({ symbol: sym })), (e: unknown) => e instanceof OrderRejected && !(e instanceof VenueRestricted));
  assert.equal(isReduceOnly(sym), true);
  assert.equal(ex.restriction(), null, 'every other contract still takes orders');
  assert.equal(isReduceOnly('P-BTC-78600-191026'), false);
  // held a while, not for ever
  assert.equal(isReduceOnly(sym, Date.now() + REDUCE_ONLY_HOLD_MS + 1), false);
  // a close refused so is not a reason to note it: nothing to pass over
  clearReduceOnly();
  await assert.rejects(ex.placeOrder(order({ symbol: sym, reduceOnly: true, side: 'buy' })), OrderRejected);
  assert.equal(isReduceOnly(sym), false);
});

test('[critical] the strike picker, with no contract noted, offers every strike', () => {
  clearReduceOnly();
  const c = (cp: 'C' | 'P', strike: number) => ({ cp, strike, sellPrice: 50, pOtm: 0.9, moneyness: 0.97, ask: 52, oi: 10, emBuffer: 1, delta: -0.07 });
  const board = [c('P', 78_800), c('P', 78_600), c('C', 83_400)];
  const now = Date.now();
  assert.deepEqual(sellable('191026', board, now).map((x) => x.strike), [78_800, 78_600, 83_400], 'none noted: every strike');
});

test('[critical] the strike picker passes over a contract on reduce-only, and only it: the next strike out is the pick', async () => {
  const { noteReduceOnly } = await import('../../src/trading/contract-restrictions.js');
  clearReduceOnly();
  const c = (cp: 'C' | 'P', strike: number) => ({ cp, strike, sellPrice: 50, pOtm: 0.9, moneyness: 0.97, ask: 52, oi: 10, emBuffer: 1, delta: -0.07 });
  const now = Date.now();
  noteReduceOnly('P-BTC-78800-191026', now);
  assert.deepEqual(sellable('191026', [c('P', 78_800), c('P', 78_600), c('C', 78_800)], now).map((x) => `${x.cp}${x.strike}`), ['P78600', 'C78800']);
  assert.deepEqual(sellable('201026', [c('P', 78_800)], now).map((x) => x.strike), [78_800], 'the next day\'s contract is another contract');
  clearReduceOnly();
});

/* A contract full of the account's orders (19 Oct 2026, 13:32 IST: 61 trades open on C-BTC-83400-191026, "max_orders_count_exceeded"). */
test('[critical] a contract full of the account\'s orders: the sale refused as the order\'s, the contract passed over for a while -- protection never so', async () => {
  const { isContractFull, FULL_HOLD_MS } = await import('../../src/trading/contract-restrictions.js');
  clearReduceOnly();
  answers(() => ({ status: 400, body: { success: false, error: { code: 'max_orders_count_exceeded' } } }));
  const ex = new DeltaExchange(creds);
  const sym = 'C-BTC-83400-191026';
  await assert.rejects(ex.placeOrder(order({ symbol: sym })), (e: unknown) => e instanceof OrderRejected && !(e instanceof VenueRestricted));
  assert.equal(isContractFull(sym), true);
  assert.equal(isContractFull(sym, Date.now() + FULL_HOLD_MS + 1), false, 'held a while: the cap frees as its trades close');
  const c = (strike: number) => ({ cp: 'C' as const, strike, sellPrice: 12, pOtm: 0.9, moneyness: 1.02, ask: 13, oi: 10, emBuffer: 1, delta: 0.08 });
  assert.deepEqual(sellable('191026', [c(83_400), c(83_600)]).map((x) => x.strike), [83_600], 'the next strike out');
  // a stop or a target refused so is not noted: it is not a strike to pass over, and it is still an error
  clearReduceOnly();
  await assert.rejects(ex.placeOrder(order({ symbol: sym, reduceOnly: true, side: 'buy' })), OrderRejected);
  assert.equal(isContractFull(sym), false);
});
