import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rig, ceProduct, planFor, quote } from './harness.js';
import { TARGET_CHURN_LIMIT, TARGET_HOLD_MS, clientId } from '../../src/trading/engine.js';

/**
 * 14 Oct 2026: on contracts shared by 17 to 55 trades the desk cancelled and re-placed targets 3,000 times in a
 * night, and 30 positions then closed at Delta with "no buy-back of the desk's" to explain them -- their P&L
 * uncounted. The order history it searched, a contract's newest orders, no longer reached the order that filled.
 * Delta's fills do, by its own order id; and a target Delta keeps taking off is held back rather than fought over.
 */

const CE = ceProduct().symbol;

/** A short of 10 sold at 100.5, its target resting at the plan's price. */
async function shortWithTarget() {
  const r = rig({ quotes: [quote(CE, 100.5, 101)] });
  const plan = planFor(ceProduct(), { lots: 10, stopPrice: 300, takeProfitPrice: 20 });
  await r.engine.open(plan);
  await r.engine.poll(plan.tradeId);
  const rec = r.store.peek(plan.tradeId)!;
  assert.equal(rec.state.position, -10);
  assert.ok(rec.state.protection.takeProfit, 'the target is on the book');
  return { r, plan, id: plan.tradeId };
}

/**
 * The scene as it was: a buy-back of this trade's -- one of its many re-placed targets, a counter the record no
 * longer carries -- fills at Delta; and the contract's order history, flooded, does not reach it.
 */
async function lostExit() {
  const s = await shortWithTarget();
  const { r, id } = s;
  // Take the record's own target off, as the churn did, and send the one the record lost track of.
  for (const o of await r.ex.getOpenOrders(CE)) if (o.clientOrderId === r.store.peek(id)!.state.protection.takeProfit) await r.ex.cancelOrder(o);
  await r.ex.placeOrder({ clientOrderId: clientId(id, 'take_profit', 97), symbol: CE, productId: ceProduct().productId, side: 'buy', type: 'limit', size: 10, limitPrice: 20, reduceOnly: true, role: 'take_profit' });
  r.ex.tick(quote(CE, 18, 19.5));
  assert.equal((await r.ex.getPositions()).find((p) => p.symbol === CE)?.size ?? 0, 0, 'flat at the exchange');
  r.ex.getOrderHistory = async () => [];
  return s;
}

test('[critical] an exit the order history no longer reaches is found in the fills: booked at its own price, no "closed on Delta" alarm', async () => {
  const { r, id } = await lostExit();
  await r.engine.reconcile(id);
  const st = r.store.peek(id)!.state;
  assert.equal(st.position, 0, 'flat on the record too');
  assert.equal(st.phase, 'flat');
  const exit = st.fills.filter((f) => f.role === 'take_profit');
  assert.deepEqual(exit.map((f) => [f.size, f.side]), [[10, 'buy']], 'the buy-back, as the target it was');
  assert.ok(exit[0]!.price <= 20, `at the target's price or better: ${exit[0]!.price}`);
  assert.ok(Math.abs(st.realisedPnl - (100.5 - exit[0]!.price) * 10 * 0.001) < 1e-9, 'and its money counted');
  assert.ok(!r.alarms.some((a) => /closed on Delta itself/.test(a.message)), r.alarms.map((a) => a.message).join(' / '));
});

test('a venue without fills: as before, the close is said out loud rather than guessed', async () => {
  const { r, id } = await lostExit();
  (r.ex as unknown as { getFills?: unknown }).getFills = undefined;
  await r.engine.reconcile(id);
  assert.ok(r.alarms.some((a) => /no buy-back of the desk's explains it -- closed on Delta itself/.test(a.message)), r.alarms.map((a) => a.message).join(' / '));
  assert.equal(r.store.peek(id)!.state.fills.filter((f) => f.role === 'take_profit').length, 0, 'nothing booked that was not found');
});

test('another trade\'s fill on the same contract is not this trade\'s: only its own client ids are taken', async () => {
  const { r, id } = await shortWithTarget();
  // A buy of someone else's on the contract -- another trade's stem.
  await r.ex.placeOrder({ clientOrderId: clientId('C-BTC-80000-080926-999', 'take_profit', 0), symbol: CE, productId: ceProduct().productId, side: 'buy', type: 'limit', size: 3, limitPrice: 20, reduceOnly: false, role: 'take_profit' });
  r.ex.tick(quote(CE, 18, 19.5));
  r.ex.getOrderHistory = async () => [];
  await r.engine.reconcile(id);
  const st = r.store.peek(id)!.state;
  assert.ok(!st.fills.some((f) => f.size === 3), 'the other trade\'s three are not on this record');
});

test('[critical] a target the exchange keeps cancelling is held off the book after a few -- said once, with its reason -- and the stop stays', async () => {
  const { r, id } = await shortWithTarget();
  const orders = (r.ex as unknown as { orders: Map<string, { status: string; reason?: string; clientOrderId: string | null }> }).orders;
  const target = () => r.store.peek(id)!.state.protection.takeProfit;
  const stop = () => r.store.peek(id)!.state.protection.stopLoss;
  const stopBefore = stop();
  // Delta takes the target off, with its reason, again and again; each time the desk notices on its next look.
  for (let i = 0; i < TARGET_CHURN_LIMIT; i++) {
    const cid = target();
    assert.ok(cid, `a target is on the book before cancel ${i + 1}`);
    const o = [...orders.values()].find((x) => x.clientOrderId === cid)!;
    await r.ex.cancelOrder(o as never);
    o.reason = 'reduce_only_order_cancelled';
    r.advance(30_000);
    await r.engine.poll(id);
  }
  const cancels = r.store.peek(id)!.events.filter((e) => e.t === 'sibling_cancelled' && e.role === 'take_profit');
  assert.equal(cancels.length, TARGET_CHURN_LIMIT);
  assert.ok(cancels.every((e) => e.t === 'sibling_cancelled' && e.reason === 'reduce_only_order_cancelled'), 'Delta\'s own reason, journaled');
  const said = r.alarms.filter((a) => /Delta cancelled this trade's target/.test(a.message));
  assert.equal(said.length, 1, 'said once');
  assert.match(said[0]!.message, /\(reduce_only_order_cancelled\)\. It is held off the book for 15 minutes rather than re-placed again; the stop stays/);
  // held: the next looks place no target, and the stop is where it was
  r.advance(60_000);
  await r.engine.poll(id);
  assert.equal(target(), null, 'no target re-placed while held');
  assert.equal(stop(), stopBefore, 'the stop untouched');
  assert.equal((await r.ex.getOpenOrders(CE)).filter((o) => o.type === 'limit').length, 0);
  // and after the hold, it goes back on
  r.advance(TARGET_HOLD_MS);
  await r.engine.poll(id);
  assert.ok(target(), 'the target is back once the hold is over');
  assert.equal(r.alarms.filter((a) => /Delta cancelled this trade's target/.test(a.message)).length, 1);
});
