import { test } from 'node:test';
import assert from 'node:assert/strict';
import { anchorExits, type TradeRecord } from '../../src/trading/engine.js';
import { followingAsk, orderPlan, protectionFor, stopAsked, stopFor, stopHeldWords, stopRoomInside, STOP_INSIDE_CLOSE_OUT, type PlaceInput } from '../../src/trading/order-plan.js';
import { liquidationPrice, liquidationRoom } from '../../src/trading/margin.js';
import { rig, ceProduct, quote, SPOT, type Rig } from './harness.js';

/**
 * Exits follow the entry that happened, not the price on the ticket.
 *
 * Asked 22 September: "whatever the entry is, the stop is the entry plus the
 * distance". An offer that walks to the bid, a Bid-now order, a market order
 * that eats two levels -- each fills somewhere other than the ticket's price,
 * and a stop 55 over "the entry" has to be 55 over the entry that printed.
 * These run the real engine on the paper exchange and read the orders it
 * leaves on the book.
 *
 * Since 29 Sep 2026 the stop *on the book* is the backstop, not the stop: the
 * stop the trader set is watched by the desk on the offer, and the trigger at
 * Delta sits at `backstopFor(stop, entry)` -- the stop plus its distance from
 * the fill. So each case pins both: the plan's stop, which is what follows the
 * fill, and the backstop on the book, which follows the stop.
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
  assert.equal(rec.plan.stopPrice, 70, 'the stop as typed');
  assert.deepEqual(await book(r), { target: [5], stop: [126] }, 'the target as typed; the backstop 70 + 56');
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
  assert.equal(rec.plan.stopPrice, 40, '150% over 16');
  assert.deepEqual(await book(r), { target: [3.2], stop: [64] }, 'the backstop 40 + 24');
});

test('[critical] a market entry gets its exits off the fill -- before this it got none at all', async () => {
  const r = rig({ products: [ceProduct()], quotes: [quote(CE, 20, 21)], limits: { maxShortContracts: 5_000 } });
  r.ex.configure({ slippageLadder: [{ price: 20, size: 60 }, { price: 19, size: 40 }] });
  const rec = await sell(r, { stopLossPoints: 30, takeProfitPct: 0.5 });
  r.ex.configure({ slippageLadder: undefined });
  assert.equal(rec.state.position, -100);
  assert.equal(rec.state.entryAvgPrice, 19.6, '60 at 20 and 40 at 19');
  assert.equal(rec.plan.stopPrice, 49.6, '30 points over the 19.6 fill');
  assert.deepEqual(await book(r), { target: [9.8], stop: [79.6] }, 'the backstop 49.6 + 30');
});

test('a fill in pieces at two prices moves the levels with the average, and keeps one of each on the book', async () => {
  const r = rig({ products: [ceProduct()], quotes: [quote(CE, 15, 15.5)], limits: { maxShortContracts: 5_000 } });
  r.ex.configure({ partialFillSize: 50 });
  await r.engine.open(orderPlan({ ...base, limitPrice: 15, stopLossPoints: 10 }, 'P'));
  await r.engine.poll('P');
  assert.equal(r.store.peek('P')!.plan.stopPrice, 25, 'first 50 at 15: stop 25');
  assert.deepEqual((await book(r)).stop, [35], 'backstop 25 + 10');
  r.ex.configure({ partialFillSize: undefined });
  r.ex.tick(quote(CE, 17, 17.5, { ts: r.now() }));
  for (let i = 0; i < 4; i++) { r.advance(1_000); await r.engine.poll('P'); }
  const rec = r.store.peek('P')!;
  assert.equal(rec.state.position, -100);
  assert.equal(rec.state.entryAvgPrice, 16, 'the rest filled at 17');
  assert.equal(rec.plan.stopPrice, 26, 'the stop moved to 10 over the new average');
  assert.deepEqual((await book(r)).stop, [36], 'and its backstop with it -- one order, edited');
});

test('[critical] a trade placed with exact prices behaves exactly as before: pinned where it was put', async () => {
  const r = rig({ products: [ceProduct()], quotes: [quote(CE, 16, 16.5)], limits: { maxShortContracts: 5_000 } });
  const rec = await sell(r, { limitPrice: 15, stopPrice: 40, takeProfitPrice: 3 });
  assert.equal(rec.plan.exitAsk, undefined);
  assert.equal(rec.plan.stopPrice, 40, 'pinned where it was put');
  assert.deepEqual(await book(r), { target: [3], stop: [64] }, 'the backstop 40 + 24 from the 16 fill');
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

/* ------------------------------------------- a stop held inside the close-out --- */

/*
 * 8 Oct 2026: the evening the delta rule first sold $65-78 strikes, every order was refused -- "Stop at 304.00 is
 * past the 278.53 close-out at 200x". The strategies carried a 300% stop, and at 200x a short is closed out about
 * 0.25% of BTC over what it was sold for, whatever that was: 300% fits under it on a $50 premium and not on a $70
 * one. A strategy's share or points stop is now held to the last level that is still a stop.
 */
const ROOM = liquidationRoom({ spot: SPOT, premium: 0, leverage: 200 })!;     // 200 with BTC at 80,000
const HELD = stopRoomInside(ROOM)!;                                           // 180

test('[critical] the hold: nine tenths of the close-out\'s room, and only ever a tightening', () => {
  assert.equal(ROOM, 200);
  assert.equal(HELD, 180);
  assert.equal(STOP_INSIDE_CLOSE_OUT, 0.9);
  assert.equal(stopRoomInside(null), undefined, 'no room known: no hold, and the gate judges the stop as asked');
  assert.equal(stopRoomInside(202.565), 182.3, 'rounded down, never up');
  // 300% of 76 is 304: past the 276 close-out. Held, it is 76 + 180.
  assert.equal(stopAsked(76, { stopLossPct: 3, stopMaxPoints: HELD }), 304);
  assert.equal(stopFor(76, { stopLossPct: 3, stopMaxPoints: HELD }), 256);
  assert.ok(stopFor(76, { stopLossPct: 3, stopMaxPoints: HELD })! < liquidationPrice({ spot: SPOT, premium: 76, leverage: 200 })!);
  // A stop already inside the room is left exactly as asked: 300% of 50 is 200, 150 over.
  assert.equal(stopFor(50, { stopLossPct: 3, stopMaxPoints: HELD }), 200);
  assert.equal(stopFor(15, { stopLossPct: 1.5, stopMaxPoints: HELD }), 37.5);
  // Points the same way.
  assert.equal(stopFor(76, { stopLossPoints: 250, stopMaxPoints: HELD }), 256);
  assert.equal(stopFor(76, { stopLossPoints: 55, stopMaxPoints: HELD }), 131);
  // The level is rounded down to the tick: never a tick past the hold.
  assert.equal(stopFor(76, { stopLossPct: 3, stopMaxPoints: 182.37 }), 258.3);
  // A price somebody named is that price, and no stop asked for is still none.
  assert.equal(stopFor(76, { stopAt: 400, stopMaxPoints: HELD }), 400);
  assert.equal(stopFor(76, { stopLossPct: 0, stopMaxPoints: HELD }), null);
  // Without a hold nothing changes: every plan written before today.
  assert.equal(stopFor(76, { stopLossPct: 3 }), 304);
});

test('the hold follows the fill with the stop it holds, and is said in the trade\'s line only when it moved the stop', () => {
  assert.deepEqual(followingAsk({ ...base, stopLossPct: 3, stopMaxPoints: HELD }, 76), { stopLossPct: 3, stopMaxPoints: HELD });
  assert.deepEqual(followingAsk({ ...base, stopLossPoints: 250, stopMaxPoints: HELD }, 76), { stopLossPoints: 250, stopMaxPoints: HELD });
  assert.equal(followingAsk({ ...base, stopAt: 300, stopMaxPoints: HELD }, 76), undefined, 'a price is pinned: nothing follows, so no hold is kept');
  assert.deepEqual(followingAsk({ ...base, takeProfitPct: 0.9, stopMaxPoints: HELD }, 76), { takeProfitPct: 0.9 }, 'no stop, no hold');
  const rec = {
    plan: { takeProfitPrice: 7.6, stopPrice: 256, exitAsk: { stopLossPct: 3, takeProfitPct: 0.9, stopMaxPoints: HELD } },
    state: { entryAvgPrice: 70, wantsProtection: true },
  } as unknown as TradeRecord;
  assert.equal(anchorExits(rec).plan.stopPrice, 250, 'filled at 70: 300% is 280, held at 70 + 180');
  assert.equal(anchorExits({ ...rec, state: { ...rec.state, entryAvgPrice: 50 } } as TradeRecord).plan.stopPrice, 200, 'filled at 50: 300% fits, and stands');
  assert.equal(stopHeldWords(76, { stopLossPct: 3, stopMaxPoints: HELD }), ' · option SL 256 (asked 304, held inside the close-out)');
  assert.equal(stopHeldWords(50, { stopLossPct: 3, stopMaxPoints: HELD }), '');
  assert.equal(stopHeldWords(76, { stopLossPct: 0, stopMaxPoints: HELD }), '');
});

test('[critical] 300% on a $76 premium at 200x: refused as asked -- the ticket\'s answer still -- and placed when held, the stop following the fill', async () => {
  const r = rig({ products: [ceProduct()], quotes: [quote(CE, 76, 76.5)], limits: { maxShortContracts: 5_000 } });
  const refused = await r.engine.open(orderPlan({ ...base, limitPrice: 76, stopLossPct: 3 }, 'R'));
  assert.equal(refused.ok, false);
  assert.match(JSON.stringify(refused), /Stop at 304\.00 is past the 276\.00 close-out at 200x/);
  assert.deepEqual(await r.ex.getOpenOrders(CE), [], 'nothing reached the book');

  const rec = await sell(r, { limitPrice: 76, stopLossPct: 3, takeProfitPct: 0.9, stopMaxPoints: HELD });
  assert.equal(rec.state.entryAvgPrice, 76);
  assert.equal(rec.plan.stopPrice, 256);
  assert.deepEqual(rec.plan.exitAsk, { takeProfitPct: 0.9, stopLossPct: 3, stopMaxPoints: HELD });
  assert.equal(rec.state.wantsProtection, true);
  assert.equal((await book(r)).target[0], 7.6);
});

test('[critical] a fill above the ticket\'s price moves the held stop with it, never back out past the close-out', async () => {
  // Offered at 76, filled at the 78 bid: 300% of 78 is 312; the close-out is 278. Held: 78 + 180.
  const r = rig({ products: [ceProduct()], quotes: [quote(CE, 78, 78.5)], limits: { maxShortContracts: 5_000 } });
  const rec = await sell(r, { limitPrice: 76, stopLossPct: 3, stopMaxPoints: HELD });
  assert.equal(rec.state.entryAvgPrice, 78);
  assert.equal(rec.plan.stopPrice, 258);
  assert.ok(rec.plan.stopPrice! < liquidationPrice({ spot: SPOT, premium: 78, leverage: 200 })!);
});

test('[critical] moved later: a new share keeps the hold, a price typed by hand drops it, and a cheap premium was never touched', async () => {
  const r = rig({ products: [ceProduct()], quotes: [quote(CE, 76, 76.5)], limits: { maxShortContracts: 5_000 } });
  await sell(r, { limitPrice: 76, stopLossPct: 3, stopMaxPoints: HELD });
  // What TradingService.updateExits sends for a stop stepped to 250% by the strategy's time steps.
  await r.engine.updateProtection('T', protectionFor(76, { stopLossPct: 2.5, stopMaxPoints: HELD }), { stopLossPct: 2.5, stopLossPoints: 0 });
  let rec = r.store.peek('T')!;
  assert.equal(rec.plan.stopPrice, 256, '250% of 76 is 266: still past the hold');
  assert.equal(rec.plan.exitAsk?.stopMaxPoints, HELD, 'the hold stays with a stop that follows the fill');
  await r.engine.updateProtection('T', protectionFor(76, { stopLossPct: 1, stopMaxPoints: HELD }), { stopLossPct: 1, stopLossPoints: 0 });
  assert.equal(r.store.peek('T')!.plan.stopPrice, 152, '100% fits, and stands as asked');
  await r.engine.updateProtection('T', protectionFor(76, { stopAt: 200 }), {});
  rec = r.store.peek('T')!;
  assert.equal(rec.plan.stopPrice, 200);
  assert.equal(rec.plan.exitAsk?.stopMaxPoints, undefined, 'a level typed as a price is the level: nothing left to hold');

  const cheap = rig({ products: [ceProduct()], quotes: [quote(CE, 15, 15.5)], limits: { maxShortContracts: 5_000 } });
  const c = await sell(cheap, { limitPrice: 15, stopLossPct: 3, stopMaxPoints: HELD }, 'C');
  assert.equal(c.plan.stopPrice, 60, '300% of 15, as it always was');
});
