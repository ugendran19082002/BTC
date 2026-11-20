import { test } from 'node:test';
import assert from 'node:assert/strict';
import { orderPlan, type PlaceInput } from '../../src/trading/order-plan.js';
import { rig, ceProduct, quote, type Rig } from './harness.js';

/**
 * An entry Delta acknowledged and then no longer showed anywhere (16 Nov 2026, 09:30 IST, P-BTC-63000-161126, account 1).
 * Delta took it off unfilled; its look-up by client id answered "not found", and a busy strike had pushed it past the
 * contract's newest two hundred orders. The poll acted only on an entry it could see, so its five-minute window never
 * closed: "entry pending" for eight hours, every pass of the account waiting on its look-ups.
 */
const { ENTRY_NOWHERE_MS, ENTRY_UNPRICED_MS } = await import('../../src/trading/engine.js');
const CE = 'C-BTC-80000-080926';
const base: PlaceInput = { symbol: CE, optionSide: 'CE', strike: 80_000, expiryTs: 1_700_040_000, lots: 1, leverage: 200 };
const WINDOW_MS = 300_000;

async function resting(r: Rig, id = 'T') {
  await r.engine.open(orderPlan({ ...base, limitPrice: 15.5, timeoutMs: WINDOW_MS, takeProfitPct: 0.8, stopLossPct: 3 }, id));
  const rec = r.store.peek(id)!;
  assert.equal(rec.state.phase, 'entry_pending', 'resting unfilled');
  return rec;
}

/** Every way the desk looks for the entry stops finding it -- as Delta answered on 16 Nov. */
function hideEntry(r: Rig, cid: string) {
  const byId = r.ex.getOrderByClientId.bind(r.ex);
  const open = r.ex.getOpenOrders.bind(r.ex);
  const history = r.ex.getOrderHistory.bind(r.ex);
  r.ex.getOrderByClientId = async (c, s) => (c === cid ? null : byId(c, s));
  r.ex.getOpenOrders = async (s) => (await open(s)).filter((o) => o.clientOrderId !== cid);
  r.ex.getOrderHistory = async (s, n) => (await history(s, n)).filter((o) => o.clientOrderId !== cid);
}

async function pollFor(r: Rig, ms: number, every = 5_000, id = 'T') {
  for (let t = 0; t < ms; t += every) { r.advance(every); await r.engine.poll(id); }
}

test('[critical] an entry Delta took off unfilled and no longer shows -- not by its id, not on the book, not in the fills -- is given up two minutes on, inside its window (20 Nov 2026)', async () => {
  const r = rig({ products: [ceProduct()], quotes: [quote(CE, 15, 15.5)] });
  const rec = await resting(r);
  const cid = rec.state.entryOrderId!;
  const order = (await r.ex.getOrderByClientId(cid))!;
  await r.ex.cancelOrder(order);
  hideEntry(r, cid);

  await pollFor(r, ENTRY_NOWHERE_MS - 20_000);
  assert.equal(r.store.peek('T')!.state.phase, 'entry_pending', 'not before two minutes nowhere');
  await pollFor(r, 40_000);
  const after = r.store.peek('T')!.state;
  assert.equal(after.phase, 'aborted', 'before its five-minute window: no place held under "at most open" for the rest of it');
  assert.equal(after.position, 0);
  assert.match(after.note ?? '', /not found on Delta nor on its book/);
});

test('[critical] inside its window, an entry still on the resting book is never given up, though its look-up says "not found"', async () => {
  const r = rig({ products: [ceProduct()], quotes: [quote(CE, 15, 15.5)] });
  const rec = await resting(r);
  const cid = rec.state.entryOrderId!;
  const byId = r.ex.getOrderByClientId.bind(r.ex);
  r.ex.getOrderByClientId = async (c, s) => (c === cid ? null : byId(c, s));   // the look-up alone misses it

  await pollFor(r, WINDOW_MS - 10_000);
  assert.equal(r.store.peek('T')!.state.phase, 'entry_pending', 'resting on the book: waited for');
});

test('[critical] inside its window, a book that cannot be read decides nothing', async () => {
  const r = rig({ products: [ceProduct()], quotes: [quote(CE, 15, 15.5)] });
  const rec = await resting(r);
  const cid = rec.state.entryOrderId!;
  await r.ex.cancelOrder((await r.ex.getOrderByClientId(cid))!);
  hideEntry(r, cid);
  r.ex.getRestingBook = async () => null;

  await pollFor(r, WINDOW_MS - 10_000);
  assert.equal(r.store.peek('T')!.state.phase, 'entry_pending');
});

/* ---------------------------------------- "closed" with nothing priced (20 Nov 2026) --- */

/** Delta answering the entry as closed, nothing unfilled, no fill price -- as it did for 22 entries on 20 Nov. */
function unpriced(r: Rig, cid: string) {
  const byId = r.ex.getOrderByClientId.bind(r.ex);
  r.ex.getOrderByClientId = async (c, s) => {
    const o = await byId(c, s);
    return o && c === cid ? { ...o, status: 'filled', filledSize: o.size, averageFillPrice: null } : o;
  };
}

test('[critical] closed, unpriced, and no fill of it on Delta: taken off unfilled after its wait -- no position, its place under "at most open" given back', async () => {
  const r = rig({ products: [ceProduct()], quotes: [quote(CE, 15, 15.5)] });
  const rec = await resting(r);
  const cid = rec.state.entryOrderId!;
  await r.ex.cancelOrder((await r.ex.getOrderByClientId(cid))!);
  unpriced(r, cid);

  await pollFor(r, ENTRY_UNPRICED_MS - 10_000);
  assert.equal(r.store.peek('T')!.state.phase, 'entry_pending', 'waited first: Delta may yet price it');
  await pollFor(r, 20_000);
  const after = r.store.peek('T')!.state;
  assert.equal(after.phase, 'aborted');
  assert.equal(after.position, 0);
  assert.equal(after.entrySize, 0);
  assert.match(after.note ?? '', /entry cancelled unfilled/);
});

test('[critical] closed, unpriced, but filled on Delta: the fill is taken at its own price from the fills, and the trade is protected', async () => {
  const r = rig({ products: [ceProduct()], quotes: [quote(CE, 15, 15.5)] });
  const rec = await resting(r);
  const cid = rec.state.entryOrderId!;
  r.ex.tick(quote(CE, 15.5, 16, { ts: r.now() }));                  // it fills at the venue
  const filled = (await r.ex.getFills(CE, 0))[0]!;
  unpriced(r, cid);

  for (let t = 0; t < ENTRY_UNPRICED_MS + 20_000; t += 5_000) {
    r.advance(5_000);
    r.ex.tick(quote(CE, 15, 15.5, { ts: r.now() }));
    await r.engine.poll('T');
  }
  const after = r.store.peek('T')!.state;
  assert.equal(after.entrySize, 1);
  assert.equal(after.position, -1);
  assert.equal(after.entryAvgPrice, filled.price, 'priced as Delta filled it');
  assert.ok(after.protection.stopLoss, 'its stop on');
});

test('[critical] closed, unpriced, and the fills cannot be read: nothing decided, waited for', async () => {
  const r = rig({ products: [ceProduct()], quotes: [quote(CE, 15, 15.5)] });
  const rec = await resting(r);
  const cid = rec.state.entryOrderId!;
  await r.ex.cancelOrder((await r.ex.getOrderByClientId(cid))!);
  unpriced(r, cid);
  r.ex.getFills = async () => { throw new Error('No answer from Delta'); };

  await pollFor(r, ENTRY_UNPRICED_MS + 60_000);
  assert.equal(r.store.peek('T')!.state.phase, 'entry_pending');
});

test('[critical] look-ups that cannot be asked are not "nowhere": the entry is waited for, however long', async () => {
  const r = rig({ products: [ceProduct()], quotes: [quote(CE, 15, 15.5)] });
  const rec = await resting(r);
  const cid = rec.state.entryOrderId!;
  const byId = r.ex.getOrderByClientId.bind(r.ex);
  r.ex.getOrderByClientId = async (c, s) => { if (c === cid) throw new Error('No answer from Delta'); return byId(c, s); };

  await pollFor(r, WINDOW_MS + 3 * ENTRY_NOWHERE_MS, 10_000);
  assert.equal(r.store.peek('T')!.state.phase, 'entry_pending', 'nothing given up on a read that failed');
});

test('[critical] an entry that filled while the look-ups could not see it is found in the fills -- an open trade, not given up', async () => {
  const r = rig({ products: [ceProduct()], quotes: [quote(CE, 15, 15.5)] });
  const rec = await resting(r);
  const cid = rec.state.entryOrderId!;
  hideEntry(r, cid);
  r.ex.tick(quote(CE, 15.5, 16, { ts: r.now() }));
  assert.equal((await r.ex.getFills(CE, 0)).length, 1, 'filled at the venue');

  for (let t = 0; t < WINDOW_MS + ENTRY_NOWHERE_MS + 20_000; t += 5_000) {
    r.advance(5_000);
    r.ex.tick(quote(CE, 15, 15.5, { ts: r.now() }));
    await r.engine.poll('T');
  }
  const after = r.store.peek('T')!.state;
  assert.notEqual(after.phase, 'aborted');
  assert.equal(after.entrySize, 1);
  assert.equal(after.position, -1);
});

test('an entry missing for a while and then seen again starts its count afresh', async () => {
  const r = rig({ products: [ceProduct()], quotes: [quote(CE, 15, 15.5)] });
  const rec = await resting(r);
  const cid = rec.state.entryOrderId!;
  const byId = r.ex.getOrderByClientId.bind(r.ex);
  let hidden = true;
  r.ex.getOrderByClientId = async (c, s) => (hidden && c === cid ? null : byId(c, s));
  const open = r.ex.getOpenOrders.bind(r.ex);
  r.ex.getOpenOrders = async (s) => (await open(s)).filter((o) => !hidden || o.clientOrderId !== cid);

  await pollFor(r, ENTRY_NOWHERE_MS - 20_000);
  hidden = false;
  await r.engine.poll('T');
  // Seen: its own window closes it the ordinary way.
  await pollFor(r, WINDOW_MS);
  const after = r.store.peek('T')!;
  assert.equal(after.state.phase, 'aborted');
  assert.ok(after.events.some((e) => e.t === 'entry_timeout'), 'closed by its own window, not given up');
});
