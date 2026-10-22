import { test } from 'node:test';
import assert from 'node:assert/strict';
import { orderPlan, protectionFor, type PlaceInput } from '../../src/trading/order-plan.js';
import { rig, ceProduct, quote, type Rig } from './harness.js';

/**
 * A target the book read did not show is looked up before another is placed (20 Oct 2026, 13:01 IST). The 1:00 PM step
 * moved every target on C-BTC-83000-201026 to 95%. For one trade the read of the contract's open orders came back without
 * its target T0, so nothing was edited or cancelled and T1 went on beside it: two reduce-only buy-backs for one contract,
 * for two and a half minutes -- until T0 filled at its old 3.4 -- and Delta trimmed a sibling's target to fit them
 * (`no_position_left_for_reduce_only`). An absence in a list is not proof: the order the record holds is asked for by its
 * own id first. A stop is still placed when that cannot be asked -- two stops are safer than none; a target is not.
 */
const CE = 'C-BTC-80000-080926';
const base: PlaceInput = { symbol: CE, optionSide: 'CE', strike: 80_000, expiryTs: 1_700_040_000, lots: 1, leverage: 200 };

async function sold(r: Rig, id = 'T') {
  await r.engine.open(orderPlan({ ...base, limitPrice: 15, takeProfitPct: 0.8, stopLossPct: 3 }, id));
  for (let i = 0; i < 12; i++) { r.advance(1_250); await r.engine.poll(id); }
  return r.store.peek(id)!;
}
/** The venue's own book, not as a read shows it. */
const targets = async (r: Rig) => (await REAL.get(r)!(CE)).filter((o) => o.reduceOnly && o.type === 'limit' && (o.status === 'open' || o.status === 'partial'));
const REAL = new WeakMap<Rig, (s?: string) => ReturnType<Rig['ex']['getOpenOrders']>>();
/** The next `n` reads of the contract's open orders leave out the trade's resting target. */
function missTarget(r: Rig, n = 1) {
  const read = r.ex.getOpenOrders.bind(r.ex);
  REAL.set(r, read);
  let left = n;
  r.ex.getOpenOrders = async (symbol?: string) => {
    const book = await read(symbol);
    if (left <= 0) return book;
    left--;
    return book.filter((o) => !(o.reduceOnly && o.type === 'limit'));
  };
}

test('[critical] a target the read missed is found by its id and moved in place: never a second one beside it', async () => {
  const r = rig({ products: [ceProduct()], quotes: [quote(CE, 15, 15.5)] });
  const rec = await sold(r);
  assert.ok(rec.state.protection.takeProfit, 'a target on');
  missTarget(r);
  assert.equal((await targets(r)).length, 1);
  await r.engine.updateProtection('T', protectionFor(15, { takeProfitPct: 0.95 }), { takeProfitPct: 0.95 });
  for (let i = 0; i < 3; i++) { r.advance(1_250); await r.engine.poll('T'); }
  const on = await targets(r);
  assert.equal(on.length, 1, 'one buy-back for the one contract');
  assert.equal(on[0]!.size - on[0]!.filledSize, 1);
  assert.equal(on[0]!.limitPrice, r.store.peek('T')!.plan.takeProfitPrice, 'at the new level');
});

test('[critical] where it cannot be asked for, no target is placed this time; the stop stays, and the next poll puts it right', async () => {
  const r = rig({ products: [ceProduct()], quotes: [quote(CE, 15, 15.5)] });
  await sold(r);
  missTarget(r, 1);
  const byId = r.ex.getOrderByClientId.bind(r.ex);
  let down = true;
  r.ex.getOrderByClientId = async (...a: Parameters<typeof byId>) => { if (down && /T\d+$/.test(a[0])) throw new Error('No answer from Delta'); return byId(...a); };
  await r.engine.updateProtection('T', protectionFor(15, { takeProfitPct: 0.95 }), { takeProfitPct: 0.95 });
  assert.ok((await targets(r)).length <= 1, 'not a second target while the first could not be checked');
  down = false;
  for (let i = 0; i < 6; i++) { r.advance(6_000); await r.engine.poll('T'); }
  const on = await targets(r);
  assert.equal(on.length, 1);
  assert.equal(on[0]!.limitPrice, r.store.peek('T')!.plan.takeProfitPrice);
  const stops = (await REAL.get(r)!(CE)).filter((o) => o.reduceOnly && o.type !== 'limit' && o.status === 'open');
  assert.equal(stops.length, 1, 'the stop stayed on throughout');
});

/**
 * 22 Oct 2026, 14:00:55: the 2 PM step moved C-BTC-83400-221026's targets and one trade's T1 went on while its T0 still
 * rested -- the look-up had answered "nowhere", and nowhere was taken for gone. And a cancel Delta refused
 * (`expired_signature`, 13:51) was taken for one made.
 */
const { TARGET_NOWHERE_MS } = await import('../../src/trading/engine.js');

test('[critical] the read misses the target and the look-up finds it nowhere: still not a second one beside it -- and the next read moves it in place', async () => {
  const r = rig({ products: [ceProduct()], quotes: [quote(CE, 15, 15.5)] });
  await sold(r);
  missTarget(r, 1);
  const byId = r.ex.getOrderByClientId.bind(r.ex);
  let nowhere = true;
  r.ex.getOrderByClientId = async (...a: Parameters<typeof byId>) => (nowhere && /T\d+$/.test(a[0]) ? null : byId(...a));
  await r.engine.updateProtection('T', protectionFor(15, { takeProfitPct: 0.95 }), { takeProfitPct: 0.95 });
  assert.equal((await targets(r)).length, 1, 'T0 alone: nothing put beside it');
  nowhere = false;
  for (let i = 0; i < 3; i++) { r.advance(1_250); await r.engine.poll('T'); }
  const on = await targets(r);
  assert.equal(on.length, 1);
  assert.equal(on[0]!.limitPrice, r.store.peek('T')!.plan.takeProfitPrice, 'moved in place');
});

test('[critical] a target really gone and found nowhere goes back on when the step moves it -- a minute after it was first missed, not at once', async () => {
  const r = rig({ products: [ceProduct()], quotes: [quote(CE, 15, 15.5)] });
  const rec = await sold(r);
  const onBook = async () => (await r.ex.getOpenOrders(CE)).filter((o) => o.reduceOnly && o.type === 'limit' && (o.status === 'open' || o.status === 'partial'));
  // Gone at the venue, and its look-up says nothing of it.
  await r.ex.cancelOrder((await onBook())[0]!);
  const byId = r.ex.getOrderByClientId.bind(r.ex);
  r.ex.getOrderByClientId = async (...a: Parameters<typeof byId>) => (a[0] === rec.state.protection.takeProfit ? null : byId(...a));
  const move = (pct: number) => r.engine.updateProtection('T', protectionFor(15, { takeProfitPct: pct }), { takeProfitPct: pct });
  await move(0.9);
  assert.equal((await onBook()).length, 0, 'not at once');
  r.advance(TARGET_NOWHERE_MS - 1_000);
  await move(0.92);
  assert.equal((await onBook()).length, 0, 'not inside the minute');
  r.advance(2_000);
  await move(0.95);
  const on = await onBook();
  assert.equal(on.length, 1, 'back on after it');
  assert.equal(on[0]!.limitPrice, r.store.peek('T')!.plan.takeProfitPrice);
  const stops = (await r.ex.getOpenOrders(CE)).filter((o) => o.reduceOnly && o.type !== 'limit' && o.status === 'open');
  assert.equal(stops.length, 1, 'the stop stayed on throughout');
});

test('[critical] a cancel the venue refused is not a cancel: found nowhere after it, no replacement is sent', async () => {
  const r = rig({ products: [ceProduct()], quotes: [quote(CE, 15, 15.5)] });
  const rec = await sold(r);
  // The edit is refused, so the move goes the long way: cancel, check, place.
  r.ex.editOrder = async () => { throw new Error('edit refused'); };
  r.ex.cancelOrder = async () => { throw new Error('Delta refused the request (expired_signature).'); };
  const byId = r.ex.getOrderByClientId.bind(r.ex);
  r.ex.getOrderByClientId = async (...a: Parameters<typeof byId>) => (a[0] === rec.state.protection.takeProfit ? null : byId(...a));
  await r.engine.updateProtection('T', protectionFor(15, { takeProfitPct: 0.95 }), { takeProfitPct: 0.95 });
  assert.equal((await r.ex.getOpenOrders(CE)).filter((o) => o.reduceOnly && o.type === 'limit' && o.status === 'open').length, 1, 'the one target, not two');
});
