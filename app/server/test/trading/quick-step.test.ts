import { test } from 'node:test';
import assert from 'node:assert/strict';
import { orderPlan, protectionFor, type PlaceInput } from '../../src/trading/order-plan.js';
import { clientId } from '../../src/trading/engine.js';
import { OrderGone } from '../../src/trading/exchange/port.js';
import { rig, ceProduct, quote, type Rig } from './harness.js';

/**
 * A strategy's time step off the shared book (22 Nov 2026, `TradeEngine.quickStep`). At 12:03 IST Income's 12:00 step
 * moved 372 targets through `protect()`, three fresh reads and an edit each, and Delta answered 429 for sixteen seconds.
 * Where the shared book already holds both of a trade's exits as recorded, the step is the edit alone. These hold it to
 * the one promise that matters: the book ends exactly as the whole way leaves it -- the same orders, the same prices,
 * the same record -- and anything out of the ordinary goes the whole way.
 */
const CE = 'C-BTC-80000-080926';
const base: PlaceInput = { symbol: CE, optionSide: 'CE', strike: 80_000, expiryTs: 1_700_040_000, lots: 1, leverage: 200 };

async function sold(r: Rig, id = 'T') {
  await r.engine.open(orderPlan({ ...base, limitPrice: 15, takeProfitPct: 0.8, stopLossPct: 3 }, id));
  for (let i = 0; i < 12; i++) { r.advance(1_250); await r.engine.poll(id); }
  return r.store.peek(id)!;
}

/** Counts the calls the whole way makes and the quick one does not. */
function count(r: Rig) {
  const n = { positions: 0, contractReads: 0, edits: 0, byId: 0 };
  const pos = r.ex.getPositions.bind(r.ex);
  r.ex.getPositions = async () => { n.positions++; return pos(); };
  const open = r.ex.getOpenOrders.bind(r.ex);
  r.ex.getOpenOrders = async (symbol?: string) => { if (symbol) n.contractReads++; return open(symbol); };
  const edit = r.ex.editOrder.bind(r.ex);
  r.ex.editOrder = async (...a: Parameters<typeof edit>) => { n.edits++; return edit(...a); };
  const byId = r.ex.getOrderByClientId.bind(r.ex);
  r.ex.getOrderByClientId = async (...a: Parameters<typeof byId>) => { n.byId++; return byId(...a); };
  return n;
}

/** The trade's resting exits on the venue: what the book holds, not what the record says. */
async function legs(r: Rig) {
  const book = (await r.ex.getRestingBook())!;
  const rec = r.store.peek('T')!;
  const tp = book.get(rec.state.protection.takeProfit!);
  const sl = book.get(rec.state.protection.stopLoss!);
  const mine = [...book.values()].filter((o) => o.symbol === CE && o.reduceOnly);
  return { tp: tp && { id: tp.orderId, price: tp.limitPrice, size: tp.size }, sl: sl && { id: sl.orderId, stop: sl.stopPrice, limit: sl.limitPrice, size: sl.size }, resting: mine.length };
}

/** The book without the venue's order ids, which run on across rigs in one process. */
const shape = (l: Awaited<ReturnType<typeof legs>>) => ({ ...l, tp: l.tp && { ...l.tp, id: undefined }, sl: l.sl && { ...l.sl, id: undefined } });

async function withQuick<T>(on: boolean, run: () => Promise<T>): Promise<T> {
  const was = process.env.DELTA_QUICK_STEP;
  if (on) delete process.env.DELTA_QUICK_STEP; else process.env.DELTA_QUICK_STEP = 'off';
  try { return await run(); } finally { if (was === undefined) delete process.env.DELTA_QUICK_STEP; else process.env.DELTA_QUICK_STEP = was; }
}

/** One trade sold, then stepped: the target to 95%, and the stop too when asked. */
async function stepped(on: boolean, stopToo: boolean) {
  return withQuick(on, async () => {
    const r = rig({ products: [ceProduct()], quotes: [quote(CE, 15, 15.5)] });
    await sold(r);
    const before = await legs(r);
    const n = count(r);
    const ask = stopToo ? { takeProfitPct: 0.95, stopLossPct: 3.4 } : { takeProfitPct: 0.95 };
    await r.engine.updateProtection('T', protectionFor(15, ask), ask, stopToo ? '1:1' : '1:0');
    const rec = r.store.peek('T')!;
    return { r, n, before, after: await legs(r), plan: rec.plan, protection: rec.state.protection, events: rec.events.map((e) => e.t) };
  });
}

test('[critical] a target step off the shared book ends exactly as the whole way does: same orders, same prices, same record -- one edit, no fresh reads', async () => {
  const quick = await stepped(true, false);
  const whole = await stepped(false, false);
  assert.notEqual(quick.before.tp!.price, quick.after.tp!.price, 'the target moved');
  assert.deepEqual(shape(quick.after), shape(whole.after), 'the book the same both ways');
  assert.equal(whole.after.tp!.id, whole.before.tp!.id, 'the whole way edits in place too');
  assert.deepEqual(quick.protection, whole.protection, 'the record the same both ways');
  assert.deepEqual(quick.plan.takeProfitPrice, whole.plan.takeProfitPrice);
  assert.deepEqual(quick.events, whole.events, 'the same journal');
  assert.equal(quick.after.tp!.id, quick.before.tp!.id, 'moved in place, not replaced');
  assert.equal(quick.after.resting, 2, 'one target and one stop');
  assert.deepEqual(quick.n, { positions: 0, contractReads: 0, edits: 1, byId: 0 }, 'the edit alone');
  assert.ok(whole.n.positions > 0 && whole.n.contractReads > 0, 'the whole way reads first');
});

test('[critical] the stop and the target stepping together: both edited in place, the stop first, its new level written -- as the whole way', async () => {
  const quick = await stepped(true, true);
  const whole = await stepped(false, true);
  assert.notEqual(quick.before.sl!.stop, quick.after.sl!.stop, 'the stop moved');
  assert.deepEqual(shape(quick.after), shape(whole.after));
  assert.equal(quick.after.sl!.id, quick.before.sl!.id, 'the stop moved in place');
  assert.deepEqual(quick.protection, whole.protection, 'stopAt written the same');
  assert.deepEqual(quick.events, whole.events);
  assert.equal(quick.n.edits, 2);
  assert.equal(quick.n.positions, 0);
});

test('a move by hand from the Edit exits sheet always goes the whole way', async () => {
  const r = rig({ products: [ceProduct()], quotes: [quote(CE, 15, 15.5)] });
  await sold(r);
  const n = count(r);
  await r.engine.updateProtection('T', protectionFor(15, { takeProfitPct: 0.95 }), { takeProfitPct: 0.95 });
  assert.ok(n.positions > 0 && n.contractReads > 0);
});

test('DELTA_QUICK_STEP=off: every step goes the whole way', async () => {
  const off = await stepped(false, false);
  assert.ok(off.n.positions > 0);
});

/** A step in the rig as given, and whether it went the whole way (it read the positions). */
async function stepWent(r: Rig) {
  const n = count(r);
  await r.engine.updateProtection('T', protectionFor(15, { takeProfitPct: 0.95 }), { takeProfitPct: 0.95 }, '1:0');
  return { whole: n.positions > 0, n };
}

test('[critical] an order the desk wrote since the shared read: the whole way, read afresh', async () => {
  const r = rig({ products: [ceProduct()], quotes: [quote(CE, 15, 15.5)] });
  const rec = await sold(r);
  const snap = r.ex.getRestingSnapshot.bind(r.ex);
  r.ex.getRestingSnapshot = async () => {
    const s = (await snap())!;
    return { rows: s.rows, written: new Set([s.rows.get(rec.state.protection.takeProfit!)!.orderId]) };
  };
  assert.equal((await stepWent(r)).whole, true);
  assert.equal((await legs(r)).tp!.price, r.store.peek('T')!.plan.takeProfitPrice, 'and moved all the same');
});

test('[critical] a target already part-filled on the read: the whole way, which cancels and replaces it for what is left', async () => {
  const r = rig({ products: [ceProduct()], quotes: [quote(CE, 15, 15.5)] });
  const rec = await sold(r);
  const snap = r.ex.getRestingSnapshot.bind(r.ex);
  r.ex.getRestingSnapshot = async () => {
    const s = (await snap())!;
    const rows = new Map(s.rows);
    const tp = rows.get(rec.state.protection.takeProfit!)!;
    rows.set(tp.clientOrderId!, { ...tp, filledSize: 1, status: 'partial' });
    return { rows, written: s.written };
  };
  assert.equal((await stepWent(r)).whole, true);
});

test('[critical] a stray order of the trade resting beside its exits: the whole way, which takes it off', async () => {
  const r = rig({ products: [ceProduct()], quotes: [quote(CE, 15, 15.5)] });
  const rec = await sold(r);
  await r.ex.placeOrder({
    clientOrderId: clientId('T', 'take_profit', 7), symbol: CE, productId: ceProduct().productId, side: 'buy', type: 'limit',
    size: rec.state.protection.size, limitPrice: 1, reduceOnly: true, role: 'take_profit',
  });
  assert.equal((await stepWent(r)).whole, true);
  assert.equal((await legs(r)).resting, 2, 'the stray is gone: one target, one stop');
});

test('[critical] the target fills as it is moved (the edit answers "already filled"): the whole way takes the fill in', async () => {
  const r = rig({ products: [ceProduct()], quotes: [quote(CE, 15, 15.5)] });
  await sold(r);
  const edit = r.ex.editOrder.bind(r.ex);
  r.ex.editOrder = async (o, c) => { if (c.limitPrice !== undefined) throw new OrderGone(o.orderId); return edit(o, c); };
  assert.equal((await stepWent(r)).whole, true);
});

test('[critical] a venue taking no changes (cancel-only): the whole way, which leaves the orders resting where they are', async () => {
  const r = rig({ products: [ceProduct()], quotes: [quote(CE, 15, 15.5)] });
  await sold(r);
  const before = await legs(r);
  r.ex.restriction = () => ({ reason: 'cancel-only', until: Date.now() + 60_000 });
  const went = await stepWent(r);
  assert.equal(went.n.edits, 0, 'nothing edited quickly');
  assert.equal((await legs(r)).tp!.id, before.tp!.id, 'the target still on the book');
});

test('the shared read could not be had: the whole way', async () => {
  const r = rig({ products: [ceProduct()], quotes: [quote(CE, 15, 15.5)] });
  await sold(r);
  r.ex.getRestingSnapshot = async () => null;
  assert.equal((await stepWent(r)).whole, true);
});
