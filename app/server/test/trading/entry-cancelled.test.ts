import { test } from 'node:test';
import assert from 'node:assert/strict';
import { orderPlan, type PlaceInput } from '../../src/trading/order-plan.js';
import { rig, ceProduct, quote, type Rig } from './harness.js';

/**
 * An entry Delta itself cancelled or rejected (17 Nov 2026, 11:05 and 12:35 IST): read back as no longer working, it
 * matched neither way the poll ended an entry -- its own deadline (which cancels an entry still resting) or not being
 * found at all -- and the trade read "entry pending" for hours, asked after every pass.
 */
const CE = 'C-BTC-80000-080926';
const base: PlaceInput = { symbol: CE, optionSide: 'CE', strike: 80_000, expiryTs: 1_700_040_000, lots: 2, leverage: 200 };

async function resting(r: Rig, id = 'T') {
  await r.engine.open(orderPlan({ ...base, limitPrice: 15.5, timeoutMs: 300_000, takeProfitPct: 0.8, stopLossPct: 3 }, id));
  assert.equal(r.store.peek(id)!.state.phase, 'entry_pending');
  return r.store.peek(id)!;
}
/** How many times the entry is looked up from here on. */
function countEntryReads(r: Rig, cid: string) {
  const byId = r.ex.getOrderByClientId.bind(r.ex);
  const seen = { n: 0 };
  r.ex.getOrderByClientId = async (c, s) => { if (c === cid) seen.n++; return byId(c, s); };
  return seen;
}

test('[critical] an unfilled entry Delta cancelled ends the trade at the next poll -- "no position taken" -- and is asked after no more', async () => {
  const r = rig({ products: [ceProduct()], quotes: [quote(CE, 15, 15.5)] });
  const rec = await resting(r);
  const cid = rec.state.entryOrderId!;
  await r.ex.cancelOrder((await r.ex.getOrderByClientId(cid))!);    // Delta's own cancel, not the desk's
  const reads = countEntryReads(r, cid);
  r.advance(1_250); await r.engine.poll('T');
  const after = r.store.peek('T')!;
  assert.equal(after.state.phase, 'aborted');
  assert.equal(after.state.position, 0);
  assert.match(after.state.note ?? '', /entry cancelled unfilled/);
  const n = reads.n;
  for (let i = 0; i < 5; i++) { r.advance(5_000); await r.engine.poll('T'); }
  assert.equal(reads.n, n, 'not asked after again');
});

test('[critical] an entry Delta rejected after taking it ends the same way', async () => {
  const r = rig({ products: [ceProduct()], quotes: [quote(CE, 15, 15.5)] });
  const rec = await resting(r);
  const cid = rec.state.entryOrderId!;
  const byId = r.ex.getOrderByClientId.bind(r.ex);
  r.ex.getOrderByClientId = async (c, s) => { const o = await byId(c, s); return o && c === cid ? { ...o, status: 'rejected' } : o; };
  r.advance(1_250); await r.engine.poll('T');
  assert.equal(r.store.peek('T')!.state.phase, 'aborted');
});

test('[critical] part filled, then Delta cancelled the rest: an open trade of what filled, with its stop -- and the entry asked after no more', async () => {
  const r = rig({ products: [ceProduct()], quotes: [quote(CE, 15, 15.5)] });
  const rec = await resting(r);
  const cid = rec.state.entryOrderId!;
  r.ex.configure({ partialFillSize: 1 });
  r.ex.tick(quote(CE, 15.5, 16, { ts: r.now() }));                  // one of the two sells
  const order = (await r.ex.getOrderByClientId(cid))!;
  assert.equal(order.filledSize, 1);
  await r.ex.cancelOrder(order);                                    // Delta cancels the rest
  r.ex.tick(quote(CE, 15, 15.5, { ts: r.now() }));
  const reads = countEntryReads(r, cid);
  for (let i = 0; i < 4; i++) { r.advance(1_250); r.ex.tick(quote(CE, 15, 15.5, { ts: r.now() })); await r.engine.poll('T'); }
  const after = r.store.peek('T')!;
  assert.notEqual(after.state.phase, 'aborted');
  assert.notEqual(after.state.phase, 'entry_pending');
  assert.equal(after.state.entrySize, 1);
  assert.equal(after.state.position, -1);
  assert.ok(after.state.protection.stopLoss, 'the stop is on for the one that filled');
  const n = reads.n;
  for (let i = 0; i < 4; i++) { r.advance(5_000); r.ex.tick(quote(CE, 15, 15.5, { ts: r.now() })); await r.engine.poll('T'); }
  assert.equal(reads.n, n, 'the cancelled rest is not asked after again');
});

test('an entry still resting is left to its own deadline, as before', async () => {
  const r = rig({ products: [ceProduct()], quotes: [quote(CE, 15, 15.5)] });
  await resting(r);
  for (let i = 0; i < 10; i++) { r.advance(5_000); await r.engine.poll('T'); }
  assert.equal(r.store.peek('T')!.state.phase, 'entry_pending', 'inside its five minutes');
  for (let i = 0; i < 60; i++) { r.advance(5_000); await r.engine.poll('T'); }
  const after = r.store.peek('T')!;
  assert.equal(after.state.phase, 'aborted');
  assert.ok(after.events.some((e) => e.t === 'entry_timeout'), 'closed by its own deadline');
});
