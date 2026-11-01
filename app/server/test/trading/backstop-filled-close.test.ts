import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rig, ceProduct, planFor, quote, type Rig } from './harness.js';
import { ownsClientId, type TradePlan } from '../../src/trading/engine.js';

/**
 * A backstop that filled while the desk was closing (30 Oct 2026, account 1, C-BTC-79000-301026). The desk judged a
 * stop reached at 10:41:48 and set about closing; the trade's backstop at Delta had triggered and filled at 254 at
 * 10:41:49.6; the desk's look-up of it said "not open", read that as cancelled, and sent its own close, which filled at
 * 248 -- two contracts bought back for one. With other trades on the contract the second came out of theirs: one was
 * found flat on Delta at 11:03 with nothing booked for it, and the day's ledger was ₹12.74 off. Read back from Delta's
 * own fills and orders (backstop 010261793325012609S0, order 1640673114).
 */

const CE = ceProduct().symbol;
const strategy = (id: string, over: Partial<TradePlan> = {}) => planFor(ceProduct(), { tradeId: `${id}-trade`, strategyId: id, origin: 'strategy', ...over });
const net = async (r: Rig) => (await r.ex.getPositions()).find((p) => p.symbol === CE)?.size ?? 0;

async function both() {
  const r = rig({ limits: { maxShortContracts: 1_000 } });
  // A's stop well under B's, so A's backstop can fire alone.
  const A = strategy('a', { takeProfitPrice: 20, stopPrice: 110 });
  const B = strategy('b', { takeProfitPrice: 20, stopPrice: 200 });
  for (const plan of [A, B]) {
    const res = await r.engine.open(plan);
    assert.equal(res.ok, true, JSON.stringify(res));
    await r.engine.poll(plan.tradeId);
  }
  await r.engine.poll(A.tradeId);
  await r.engine.poll(B.tradeId);
  return { r, A, B };
}

/**
 * The backstop fills in the moment the desk takes it off: after the position was read, as the cancel goes out -- the
 * order of 30 Oct, where the look-up after the cancel was the first to see it filled.
 */
function fillDuringCancel(r: Rig, orderId: string, fill: () => void) {
  const cancel = r.ex.cancelOrder.bind(r.ex);
  let done = false;
  r.ex.cancelOrder = async (o) => {
    if (!done && o.orderId === orderId) { done = true; fill(); }
    return cancel(o);
  };
}

test('[critical] a backstop that filled is the exit: the close that follows sends nothing, and the other trade on the contract keeps its contracts', async () => {
  const { r, A, B } = await both();
  assert.equal(await net(r), -200);
  const backstop = (await r.ex.getOpenOrders(CE)).find((o) => o.reduceOnly && o.stopPrice !== null && ownsClientId(A.tradeId, o.clientOrderId));
  assert.ok(backstop, 'A has a backstop at Delta');
  // The run: through A's backstop, short of B's -- as the desk sends the cancel.
  fillDuringCancel(r, backstop!.orderId, () => r.ex.tick(quote(CE, backstop!.stopPrice! + 1, backstop!.stopPrice! + 2, { ts: r.now() })));
  const placed: string[] = [];
  const place = r.ex.placeOrder.bind(r.ex);
  r.ex.placeOrder = async (req) => { placed.push(`${req.role} ${req.side} ${req.size}`); return place(req); };

  // The desk, judging A's stop reached on the offer, closes it.
  const after = await r.engine.closeNow(A.tradeId, 'stop reached');

  assert.deepEqual(placed, [], 'no second buy-back sent');
  assert.equal(await net(r), -100, 'B\'s contracts are still B\'s');
  assert.equal(after!.position, 0, 'A is flat');
  const fill = after!.fills.find((f) => f.role === 'stop_loss');
  assert.ok(fill, 'A\'s backstop fill booked as its exit');
  assert.equal(fill!.orderId, backstop!.orderId);
  assert.ok(!r.store.peek(A.tradeId)!.events.some((e) => e.t === 'exit_submitted'), 'no close written');
  assert.equal(r.store.peek(B.tradeId)!.state.position, -100);
});

test('[critical] a backstop that filled in part as it was taken off: the close sends only the rest', async () => {
  const { r, A } = await both();
  const backstop = (await r.ex.getOpenOrders(CE)).find((o) => o.reduceOnly && o.stopPrice !== null && ownsClientId(A.tradeId, o.clientOrderId))!;
  const book = r.ex as unknown as { orders: Map<string, { filledSize: number; averageFillPrice: number | null; status: string }>; forcePosition(s: string, n: number): void };
  // Delta filled 40 of the 100 at the backstop as the cancel went out; the cancel took the other 60.
  fillDuringCancel(r, backstop.orderId, () => {
    const o = book.orders.get(backstop.orderId)!;
    o.filledSize = 40; o.averageFillPrice = backstop.stopPrice! + 1; o.status = 'partial';
    book.forcePosition(CE, -160);
  });
  const placed: number[] = [];
  const place = r.ex.placeOrder.bind(r.ex);
  r.ex.placeOrder = async (req) => { if (req.role === 'exit') placed.push(req.size); return place(req); };
  const after = await r.engine.closeNow(A.tradeId, 'stop reached');
  assert.deepEqual(placed, [60], 'the close is of what is still held: 100 less the 40 the backstop bought');
  assert.equal(after!.fills.filter((f) => f.role === 'stop_loss').reduce((n, f) => n + f.size, 0), 40, 'the 40 booked as the backstop\'s');
});
