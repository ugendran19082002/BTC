import { test } from 'node:test';
import assert from 'node:assert/strict';
import { anchorExits, type TradeRecord } from '../../src/trading/engine.js';
import { followingAsk, orderPlan, protectionFor, type PlaceInput } from '../../src/trading/order-plan.js';
import { rig, ceProduct, quote, type Rig } from './harness.js';

/**
 * Exits follow the entry that happened, not the price on the ticket.
 *
 * Asked 22 September: "whatever the entry is, the stop is the entry plus the
 * distance". An offer that walks to the bid, a Bid-now order, a market order
 * that eats two levels -- each fills somewhere other than the ticket's price,
 * and a stop 55 over "the entry" has to be 55 over the entry that printed.
 * These run the real engine on the paper exchange and read the orders it
 * leaves on the book.
 */

const CE = 'C-BTC-80000-080926';
const base: PlaceInput = { symbol: CE, optionSide: 'CE', strike: 80_000, expiryTs: 1_700_040_000, lots: 100, leverage: 200 };

const book = async (r: Rig) => {
  const open = (await r.ex.getOpenOrders(CE)).filter((o) => o.reduceOnly);
  return {
    target: open.filter((o) => o.type === 'limit').map((o) => o.limitPrice),
    stop: open.filter((o) => o.type === 'stop_limit' || o.type === 'stop_market').map((o) => o.stopPrice),
  };
};

async function sell(r: Rig, input: Partial<PlaceInput>, id = 'T') {
  await r.engine.open(orderPlan({ ...base, ...input }, id));
  for (let i = 0; i < 12; i++) { r.advance(1_250); await r.engine.poll(id); }
  return r.store.peek(id)!;
}

/* ------------------------------------------------------------------ pure */

test('[critical] a price typed is the level: it does not follow the fill; a % or points does', () => {
  assert.equal(followingAsk({ ...base, limitPrice: 15, stopAt: 70, takeProfitAt: 5 }, 15), undefined);
  assert.deepEqual(followingAsk({ ...base, stopLossPct: 1.5, takeProfitPct: 0.8 }, 15), { stopLossPct: 1.5, takeProfitPct: 0.8 });
  assert.deepEqual(followingAsk({ ...base, stopAt: 70, takeProfitPct: 0.8 }, 15), { takeProfitPct: 0.8 }, 'each leg on its own');
});

test('an exact price from a caller, or a price with no entry to measure from, follows nothing', () => {
  assert.equal(followingAsk({ ...base, stopPrice: 40, takeProfitPrice: 3 }, 15), undefined);
  assert.equal(followingAsk({ ...base, stopAt: 70 }, null), undefined);
  assert.equal(followingAsk({ ...base }, 15), undefined, 'no exits, nothing to follow');
});

test('anchorExits re-reads the levels off the average fill, and leaves a record alone when nothing moves', () => {
  const rec = {
    plan: { takeProfitPrice: 3, stopPrice: 70, exitAsk: { stopLossPoints: 55, takeProfitPct: 0.8 } },
    state: { entryAvgPrice: 14, wantsProtection: true },
  } as unknown as TradeRecord;
  const moved = anchorExits(rec);
  assert.equal(moved.plan.stopPrice, 69);
  assert.equal(moved.plan.takeProfitPrice, 2.8);
  assert.equal(anchorExits(moved), moved, 'same levels, same record');
  const old = { ...rec, plan: { ...rec.plan, exitAsk: undefined } } as TradeRecord;
  assert.equal(anchorExits(old), old, 'a plan written before this follows nothing');
});

test('protectionFor on a following ask is the same arithmetic the plan gets', () => {
  assert.deepEqual(protectionFor(14, { stopLossPoints: 55, takeProfitPct: 0.8 }), { stopPrice: 69, takeProfitPrice: 2.8 });
});

/* ------------------------------------------------------------------ the engine, on the paper exchange */

test('[critical] Offer at 15 that walks to a 14 bid: stop typed as 70 stays at 70 -- the balance is 56 now, not 55', async () => {
  // Asked 22 Sep: "70 SL set, subtract the entry from 70, the balance is the SL".
  const r = rig({ products: [ceProduct()], quotes: [quote(CE, 14, 15)], limits: { maxShortContracts: 5_000 } });
  const rec = await sell(r, { limitPrice: 15, chaseSeconds: 4, stopAt: 70, takeProfitAt: 5 });
  assert.equal(rec.state.entryAvgPrice, 14, 'the chase ended at the bid');
  assert.deepEqual(await book(r), { target: [5], stop: [70] }, 'the levels as typed');
  assert.equal(rec.plan.stopPrice! - rec.state.entryAvgPrice!, 56, 'the balance, re-measured from the fill');
  assert.equal(rec.plan.exitAsk, undefined, 'nothing follows the fill');
});

test('[critical] a stop typed at or under the entry is refused before anything is sent', async () => {
  const r = rig({ products: [ceProduct()], quotes: [quote(CE, 15, 15.5)], limits: { maxShortContracts: 5_000 } });
  const res = await r.engine.open(orderPlan({ ...base, limitPrice: 15, stopAt: 12 }, 'W'));
  assert.equal(res.ok, false);
  assert.match(JSON.stringify(res), /A stop of 12 must be over the 15 entry/);
  assert.deepEqual(await r.ex.getOpenOrders(CE), [], 'no order reached the book');
});

test('a target typed at or over the entry is refused the same way', async () => {
  const r = rig({ products: [ceProduct()], quotes: [quote(CE, 15, 15.5)], limits: { maxShortContracts: 5_000 } });
  const res = await r.engine.open(orderPlan({ ...base, limitPrice: 15, takeProfitAt: 15 }, 'W2'));
  assert.equal(res.ok, false);
  assert.match(JSON.stringify(res), /A target of 15 must be under the 15 entry/);
});

test('[critical] Bid now improved to 16: a 150% stop is 150% of 16, not of the 15 on the ticket', async () => {
  const r = rig({ products: [ceProduct()], quotes: [quote(CE, 16, 16.5)], limits: { maxShortContracts: 5_000 } });
  const rec = await sell(r, { limitPrice: 15, stopLossPct: 1.5, takeProfitPct: 0.8 });
  assert.equal(rec.state.entryAvgPrice, 16);
  assert.deepEqual(await book(r), { target: [3.2], stop: [40] });
});

test('[critical] a market entry gets its exits off the fill -- before this it got none at all', async () => {
  const r = rig({ products: [ceProduct()], quotes: [quote(CE, 20, 21)], limits: { maxShortContracts: 5_000 } });
  r.ex.configure({ slippageLadder: [{ price: 20, size: 60 }, { price: 19, size: 40 }] });
  const rec = await sell(r, { stopLossPoints: 30, takeProfitPct: 0.5 });
  r.ex.configure({ slippageLadder: undefined });
  assert.equal(rec.state.position, -100);
  assert.equal(rec.state.entryAvgPrice, 19.6, '60 at 20 and 40 at 19');
  assert.deepEqual(await book(r), { target: [9.8], stop: [49.6] });
});

test('a fill in pieces at two prices moves the levels with the average, and keeps one of each on the book', async () => {
  const r = rig({ products: [ceProduct()], quotes: [quote(CE, 15, 15.5)], limits: { maxShortContracts: 5_000 } });
  r.ex.configure({ partialFillSize: 50 });
  await r.engine.open(orderPlan({ ...base, limitPrice: 15, stopLossPoints: 10 }, 'P'));
  await r.engine.poll('P');
  assert.deepEqual((await book(r)).stop, [25], 'first 50 at 15: stop 25');
  r.ex.configure({ partialFillSize: undefined });
  r.ex.tick(quote(CE, 17, 17.5, { ts: r.now() }));
  for (let i = 0; i < 4; i++) { r.advance(1_000); await r.engine.poll('P'); }
  const rec = r.store.peek('P')!;
  assert.equal(rec.state.position, -100);
  assert.equal(rec.state.entryAvgPrice, 16, 'the rest filled at 17');
  assert.deepEqual((await book(r)).stop, [26], 'the stop moved to 10 over the new average -- one order, edited');
});

test('[critical] a trade placed with exact prices behaves exactly as before: pinned where it was put', async () => {
  const r = rig({ products: [ceProduct()], quotes: [quote(CE, 16, 16.5)], limits: { maxShortContracts: 5_000 } });
  const rec = await sell(r, { limitPrice: 15, stopPrice: 40, takeProfitPrice: 3 });
  assert.equal(rec.plan.exitAsk, undefined);
  assert.deepEqual(await book(r), { target: [3], stop: [40] });
});

test('editing a stop as a price pins it; editing it as points keeps it following', async () => {
  const r = rig({ products: [ceProduct()], quotes: [quote(CE, 15, 15.5)], limits: { maxShortContracts: 5_000 } });
  await sell(r, { limitPrice: 15, stopLossPoints: 10, takeProfitPct: 0.8 });
  // pinned: what TradingService.updateExits does for a level typed as a price
  await r.engine.updateProtection('T', protectionFor(15, { stopAt: 50 }), {});
  let rec = r.store.peek('T')!;
  assert.equal(rec.plan.stopPrice, 50);
  assert.deepEqual(rec.plan.exitAsk, { takeProfitPct: 0.8 }, 'the stop left the ask; the target still follows');
  // following again: points
  await r.engine.updateProtection('T', protectionFor(15, { stopLossPoints: 20 }), { stopLossPct: 0, stopLossPoints: 20 });
  rec = r.store.peek('T')!;
  assert.equal(rec.plan.stopPrice, 35);
  assert.equal(rec.plan.exitAsk?.stopLossPoints, 20);
});
