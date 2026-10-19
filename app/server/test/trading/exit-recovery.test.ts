import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crowdRoom, rig, ceProduct, planFor, quote } from './harness.js';
import {
  HOLD_RECHECK_MS, NO_REDUCE_ONLY_ROOM, TARGET_CHURN_LIMIT, TARGET_HOLD_MS, TARGET_RELEASE_LIMIT, clientId,
} from '../../src/trading/engine.js';

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
  // Delta takes the target off -- for no reason it names -- again and again; each time the desk notices on its next look.
  const cancelIt = async (reason?: string) => {
    const o = [...orders.values()].find((x) => x.clientOrderId === target())!;
    await r.ex.cancelOrder(o as never);
    if (reason) o.reason = reason;
    r.advance(30_000);
    await r.engine.poll(id);
  };
  for (let i = 0; i < TARGET_CHURN_LIMIT - 1; i++) { await cancelIt('cancelled_by_exchange'); assert.ok(target(), `put back after cancel ${i + 1}`); }
  assert.equal(r.alarms.filter((a) => /Delta cancelled this trade's target/.test(a.message)).length, 0, 'not yet: three are not a pattern');
  await cancelIt('cancelled_by_exchange');
  const cancels = r.store.peek(id)!.events.filter((e) => e.t === 'sibling_cancelled' && e.role === 'take_profit');
  assert.equal(cancels.length, TARGET_CHURN_LIMIT);
  assert.ok(cancels.every((e) => e.t === 'sibling_cancelled' && e.reason === 'cancelled_by_exchange'), 'Delta\'s own reason, journaled');
  const said = r.alarms.filter((a) => /Delta cancelled this trade's target/.test(a.message));
  assert.equal(said.length, 1, 'said once');
  assert.match(said[0]!.message, /4 times in 10 minutes \(cancelled_by_exchange\)\. It is held off the book for 15 minutes rather than re-placed again; the stop and the perp's exits stay\.$/);
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

test('[critical] Delta\'s "no reduce-only room left" with the room still taken: held at once, said at the first recheck; back after the hold and taken off again, off for the rest of the trade -- two alarms, no more', async () => {
  const { r, id } = await shortWithTarget();
  const room = crowdRoom(r, ceProduct(), 10);
  const orders = (r.ex as unknown as { orders: Map<string, { status: string; reason?: string; clientOrderId: string | null }> }).orders;
  const target = () => r.store.peek(id)!.state.protection.takeProfit;
  const stopBefore = r.store.peek(id)!.state.protection.stopLoss;
  const cancelIt = async () => {
    const o = [...orders.values()].find((x) => x.clientOrderId === target())!;
    await r.ex.cancelOrder(o as never);
    o.reason = NO_REDUCE_ONLY_ROOM;
    r.advance(30_000);
    await r.engine.poll(id);
  };
  const said = () => r.alarms.filter((a) => /Delta cancelled this trade's target/.test(a.message)).map((a) => a.message);
  // the first one with Delta's reason, and the room taken: held at once, for fifteen minutes -- said half a minute on
  await cancelIt();
  assert.equal(target(), null, 'not put back');
  assert.equal(said().length, 0, 'not yet: the room may come back in seconds');
  r.advance(HOLD_RECHECK_MS);
  await r.engine.poll(id);
  assert.equal(target(), null, 'the room still taken: still held');
  assert.equal(said().length, 1);
  assert.match(said()[0]!, /the position has no reduce-only room left for it \(no_position_left_for_reduce_only\)\. It is held off the book for 15 minutes/);
  // after the hold it goes back on, and Delta takes it straight off again with the room taken: off for the rest of the trade
  room.free();
  r.advance(TARGET_HOLD_MS);
  await r.engine.poll(id);
  assert.ok(target(), 'tried once more after the hold');
  room.take();
  await cancelIt();
  assert.equal(said().length, 2, 'for good: said at once');
  assert.match(said()[1]!, /It came straight back after the last hold, so it stays off the book for the rest of this trade; the stop and the perp's exits stay\.$/);
  // hours later: still off while the room is taken, no more alarms, the stop where it was
  for (let i = 0; i < 6; i++) { r.advance(TARGET_HOLD_MS); await r.engine.poll(id); }
  assert.equal(target(), null);
  assert.equal(said().length, 2, 'no quarter-hourly alarm');
  assert.equal(r.store.peek(id)!.state.protection.stopLoss, stopBefore);
});

test('[critical] 19 Oct 2026, C-BTC-83400: another trade\'s stop fills, Delta takes this target with it -- put straight back, no hold, no alarm', async () => {
  const r = rig({ quotes: [quote(CE, 100.5, 101)], limits: { maxShortContracts: 1_000 } });
  const a = planFor(ceProduct(), { tradeId: 'A', strategyId: 'sa', origin: 'strategy', lots: 10, stopPrice: 300, takeProfitPrice: 20 });
  const b = planFor(ceProduct(), { tradeId: 'B', strategyId: 'sb', origin: 'strategy', lots: 10, stopPrice: 300, takeProfitPrice: 20 });
  for (const p of [a, b]) { assert.equal((await r.engine.open(p)).ok, true); await r.engine.poll(p.tradeId); }
  const orders = (r.ex as unknown as { orders: Map<string, { status: string; reason?: string; clientOrderId: string | null }> }).orders;
  const target = (id: string) => r.store.peek(id)!.state.protection.takeProfit;
  // B is out (its stop, at Delta): the position is 10 smaller. Delta trims A's target, not B's; the desk takes B's off.
  const bTarget = [...orders.values()].find((x) => x.clientOrderId === target('B'))!;
  const aTarget = [...orders.values()].find((x) => x.clientOrderId === target('A'))!;
  await r.engine.closeNow('B');
  for (let i = 0; i < 5 && r.store.peek('B')!.state.position !== 0; i++) { r.advance(1_000); await r.engine.poll('B'); }
  assert.equal(r.store.peek('B')!.state.position, 0, 'B is flat');
  assert.notEqual(bTarget.status, 'open', 'B\'s own target is off the book');
  if (aTarget.status === 'open') await r.ex.cancelOrder(aTarget as never);
  aTarget.reason = NO_REDUCE_ONLY_ROOM;
  r.advance(5_000);
  await r.engine.poll('A');
  const steps = r.store.peek('A')!.events.filter((e) => e.t === 'exit_step' && (e.kind === 'held' || e.kind === 'released'));
  assert.deepEqual(steps.map((e) => (e as { kind: string }).kind), ['released'], 'no hold');
  assert.match((steps[0] as { detail?: string }).detail ?? '', /another trade's exit made the position smaller; the room is back \(10 contracts\)/);
  assert.ok(target('A'), 'A\'s target is back');
  assert.ok((await r.ex.getOpenOrders(CE)).some((o) => o.clientOrderId === target('A') && o.status === 'open'), 'on the book');
  assert.deepEqual(r.alarms.filter((x) => /Delta cancelled this trade's target/.test(x.message)), [], 'nothing said');
});

test('[critical] held with the room taken, it comes back once the position has room again -- read off Delta, not counted -- and said never if inside half a minute', async () => {
  const { r, id } = await shortWithTarget();
  const room = crowdRoom(r, ceProduct(), 10);
  const orders = (r.ex as unknown as { orders: Map<string, { status: string; reason?: string; clientOrderId: string | null }> }).orders;
  const target = () => r.store.peek(id)!.state.protection.takeProfit;
  const o = [...orders.values()].find((x) => x.clientOrderId === target())!;
  await r.ex.cancelOrder(o as never);
  o.reason = NO_REDUCE_ONLY_ROOM;
  r.advance(1_000);
  await r.engine.poll(id);
  assert.equal(target(), null, 'held');
  // The other order goes before the first recheck: back on, and nothing said.
  room.free();
  r.advance(HOLD_RECHECK_MS);
  await r.engine.poll(id);
  const back = r.store.peek(id)!.events.filter((e) => e.t === 'exit_step' && e.kind === 'released');
  assert.equal(back.length, 1);
  assert.match((back[0] as { detail?: string }).detail ?? '', /The position has room for it again \(10 contracts free of resting targets\)/);
  assert.ok(target(), 'the target is back');
  assert.deepEqual(r.alarms.filter((x) => /Delta cancelled this trade's target/.test(x.message)), []);
});

test('the room is read at most so often: past the release limit in an hour, a held target waits on its contract\'s other trades, as before', async () => {
  const { r, id } = await shortWithTarget();
  const orders = (r.ex as unknown as { orders: Map<string, { status: string; reason?: string; clientOrderId: string | null }> }).orders;
  const target = () => r.store.peek(id)!.state.protection.takeProfit;
  // Delta takes it off with its reason though the book shows room -- each time a minute apart.
  for (let i = 0; i < TARGET_RELEASE_LIMIT + 2; i++) {
    const o = [...orders.values()].find((x) => x.clientOrderId === target());
    if (o) { await r.ex.cancelOrder(o as never); o.reason = NO_REDUCE_ONLY_ROOM; }
    r.advance(HOLD_RECHECK_MS + 1);
    await r.engine.poll(id);
    r.advance(HOLD_RECHECK_MS + 1);
    await r.engine.poll(id);
  }
  const released = r.store.peek(id)!.events.filter((e) => e.t === 'exit_step' && e.kind === 'released').length;
  assert.equal(released, TARGET_RELEASE_LIMIT, 'put back no more than the limit');
  assert.equal(target(), null, 'then held: alone on the contract when held, it is not counted back');
});
