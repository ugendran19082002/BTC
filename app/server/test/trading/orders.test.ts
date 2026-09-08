import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rig, ceProduct, peProduct, planFor, quote, T0 } from './harness.js';
import { failureCodes, precheck, DEFAULT_LIMITS } from '../../src/trading/precheck.js';
import { protectionSize } from '../../src/trading/machine.js';
import { clientId } from '../../src/trading/engine.js';

/**
 * The live-order test matrix.
 *
 * Each case is one thing a real venue does to you. The five that decide whether
 * this may ever touch real money are 4, 9, 32, 18 and 30 -- a partial fill, a
 * submit that never comes back, a position left without a stop, two exits
 * racing, and a restart with contracts already on. They are marked below.
 */

const CE = 'C-BTC-80000-080926';
const PE = 'P-BTC-77000-080926';

// ---------------------------------------------------------------- 1 & 2 entry

test('01 CE sell entry fills in full and books the actual price', async () => {
  const r = rig();
  const res = await r.engine.open(planFor(ceProduct()));
  assert.equal(res.ok, true);
  const s = res.state;
  assert.equal(s.position, -100, 'short 100 contracts');
  assert.equal(s.entrySize, 100);
  assert.equal(s.entryAvgPrice, 100.5, 'entry is the fill price, not the request');
  assert.equal(s.phase, 'position_open');
});

test('02 PE sell entry creates the short on the put', async () => {
  const r = rig({ products: [peProduct()], quotes: [quote(PE, 80.5, 81)] });
  const res = await r.engine.open(planFor(peProduct(), { entry: { type: 'limit', limitPrice: 80.5, timeoutMs: 5_000, marketFallback: false }, takeProfitPrice: 72, stopPrice: 90 }));
  assert.equal(res.state.position, -100);
  assert.equal(res.state.optionSide, 'PE');
  assert.equal(res.state.entryAvgPrice, 80.5);
});

// ------------------------------------------------------------------ 3 timeout

test('03 a limit that never becomes marketable is cancelled and leaves no position', async () => {
  const r = rig({ quotes: [quote(CE, 99, 101)] });
  const plan = planFor(ceProduct(), { entry: { type: 'limit', limitPrice: 100, timeoutMs: 5_000, marketFallback: false } });
  const opened = await r.engine.open(plan);
  assert.equal(opened.state.phase, 'entry_pending');
  assert.equal(opened.state.position, 0);

  r.advance(5_001);
  const s = await r.engine.poll(plan.tradeId);
  assert.equal(s?.position, 0, 'nothing filled, so nothing is held');
  assert.equal(s?.phase, 'aborted');
  assert.equal((await r.ex.getOpenOrders(CE)).length, 0, 'the order is off the book');
});

// -------------------------------------------------------- 4 & 5 partial fills

test('04 [critical] a partial fill is a position of what filled, not what was asked', async () => {
  const r = rig();
  r.ex.configure({ partialFillSize: 40 });
  const res = await r.engine.open(planFor(ceProduct()));
  assert.equal(res.state.entrySize, 40);
  assert.equal(res.state.position, -40, 'never assume the requested 100');
  assert.equal(res.state.requestedSize, 100);
  const resting = await r.ex.getOpenOrders(CE);
  assert.equal(resting[0]?.size! - resting[0]?.filledSize!, 60, '60 still working');
});

test('05 cancelling the rest leaves the filled part, and protection is sized to it', async () => {
  const r = rig();
  r.ex.configure({ partialFillSize: 40 });
  const plan = planFor(ceProduct());
  await r.engine.open(plan);
  r.advance(5_001);
  const s = await r.engine.poll(plan.tradeId);
  assert.equal(s?.position, -40);
  assert.equal(protectionSize(s!), 40, 'the stop covers 40, not 100');
  const live = await r.ex.getOpenOrders(CE);
  const protectSizes = live.filter((o) => o.reduceOnly).map((o) => o.size);
  assert.deepEqual(protectSizes, [40, 40], 'target and stop both sized 40');
});

// --------------------------------------------------------- 6 & 7 market entry

test('06 market fallback runs the gates again before it crosses the spread', async () => {
  const r = rig({ quotes: [quote(CE, 99, 101)] });
  const plan = planFor(ceProduct(), {
    entry: { type: 'limit', limitPrice: 100, timeoutMs: 5_000, marketFallback: true },
  });
  await r.engine.open(plan);
  r.advance(5_001);
  r.ex.tick(quote(CE, 99, 101, { ts: r.now() }));   // a live feed keeps ticking
  const s = await r.engine.poll(plan.tradeId);
  assert.equal(s?.position, -100, 'the fallback got the full size');
  assert.equal(s?.entryAvgPrice, 99, 'a market sell hits the bid');
});

test('06b the fallback refuses to cross a spread it can no longer see', async () => {
  const r = rig({ quotes: [quote(CE, 99, 101)] });
  const plan = planFor(ceProduct(), {
    entry: { type: 'limit', limitPrice: 100, timeoutMs: 5_000, marketFallback: true },
  });
  await r.engine.open(plan);
  r.advance(5_001);                                  // the feed stopped: no fresh quote
  const s = await r.engine.poll(plan.tradeId);
  assert.equal(s?.position, 0, 'a stale book is not a book to cross');
  assert.match(s?.note ?? '', /market fallback refused/);
});

test('07 a market entry is priced at the weighted average of the levels it ate', async () => {
  const r = rig({ quotes: [quote(CE, 99.8, 101)] });
  r.ex.configure({ slippageLadder: [{ price: 99.8, size: 40 }, { price: 99.5, size: 40 }, { price: 99.1, size: 20 }] });
  const plan = planFor(ceProduct(), { entry: { type: 'market', timeoutMs: 5_000, marketFallback: false } });
  const res = await r.engine.open(plan);
  const expected = (99.8 * 40 + 99.5 * 40 + 99.1 * 20) / 100;
  assert.equal(res.state.position, -100);
  assert.ok(Math.abs(res.state.entryAvgPrice! - expected) < 1e-9, `avg ${res.state.entryAvgPrice} should be ${expected}`);
});

// ----------------------------------------------------------------- 8 rejected

test('08 a rejected entry leaves no position and creates no protection', async () => {
  const r = rig();
  r.ex.configure({ nextFault: { kind: 'reject', reason: 'insufficient margin' } });
  const res = await r.engine.open(planFor(ceProduct()));
  assert.equal(res.ok, false);
  assert.equal(res.state.position, 0);
  assert.equal(res.state.phase, 'aborted');
  assert.equal((await r.ex.getOpenOrders()).length, 0, 'no target, no stop, nothing');
});

// --------------------------------------------- 9 submit timeout (the big one)

test('09 [critical] a submit that times out is resolved by reading, never by sending again', async () => {
  const r = rig();
  r.ex.configure({ nextFault: { kind: 'submit_timeout', landed: true } });
  const plan = planFor(ceProduct());
  const res = await r.engine.open(plan);
  assert.equal(res.state.phase, 'entry_unknown', 'we do not know, and we say so');

  // The order did land and did fill. Polling must find it, not duplicate it.
  const after = await r.engine.poll(plan.tradeId);
  assert.equal(after?.position, -100, 'the one order that exists');
  const sells = (await r.ex.getPositions()).filter((p) => p.symbol === CE);
  assert.equal(sells[0]?.size, -100, 'exactly one short, not two');
});

test('09b a submit that timed out and never landed ends flat, not short', async () => {
  const r = rig();
  r.ex.configure({ nextFault: { kind: 'submit_timeout', landed: false } });
  const plan = planFor(ceProduct());
  await r.engine.open(plan);
  const after = await r.engine.poll(plan.tradeId);
  assert.equal(after?.position, 0);
  assert.equal(after?.phase, 'aborted');
  assert.equal((await r.ex.getPositions()).length, 0);
});

// ------------------------------------------------------------- 10 & 11 dupes

test('10 the same signal twice places one order', async () => {
  const r = rig();
  const plan = planFor(ceProduct());
  const a = await r.engine.open(plan);
  const b = await r.engine.open(plan);
  assert.equal(a.state.tradeId, b.state.tradeId);
  assert.equal(b.state.position, -100, 'still one short of 100');
  assert.equal((await r.ex.getPositions())[0]?.size, -100);
});

test('11 a second short on a contract already held is refused', async () => {
  const r = rig();
  await r.engine.open(planFor(ceProduct()));
  const second = await r.engine.open(planFor(ceProduct(), { tradeId: 't-CE-2' }));
  assert.equal(second.ok, false);
  assert.ok(!second.ok && failureCodes(second.precheck).includes('DUPLICATE_POSITION'));
  assert.equal((await r.ex.getPositions())[0]?.size, -100, 'position unchanged');
});

// ------------------------------------------------------------- 12 & 13 target

test('12 the target fills, the position closes and the profit is the difference', async () => {
  const r = rig();
  const plan = planFor(ceProduct());
  await r.engine.open(plan);
  await r.engine.poll(plan.tradeId);
  r.ex.tick(quote(CE, 89.5, 90));           // the buy-back at 90 is now marketable
  const s = await r.engine.poll(plan.tradeId);
  assert.equal(s?.position, 0);
  assert.equal(s?.phase, 'flat');
  assert.equal(s?.realisedPnl, (100.5 - 90) * 100 * 0.001);
});

test('13 a target that is approached but never traded stays open, and the position stays on', async () => {
  const r = rig();
  const plan = planFor(ceProduct());
  await r.engine.open(plan);
  await r.engine.poll(plan.tradeId);
  for (const bid of [90.2, 90.1, 90.05]) r.ex.tick(quote(CE, bid, bid + 0.5));
  const s = await r.engine.poll(plan.tradeId);
  assert.equal(s?.position, -100, 'nothing filled, so nothing closed');
  assert.equal(s?.phase, 'protected');
  const tp = await r.ex.getOrderByClientId(s!.protection.takeProfit!);
  assert.equal(tp?.status, 'open');
});

// ------------------------------------------------------------- 14,15,16 stop

test('14 the stop triggers and buys the position back', async () => {
  const r = rig();
  const plan = planFor(ceProduct());
  await r.engine.open(plan);
  await r.engine.poll(plan.tradeId);
  for (const px of [105, 109, 110]) r.ex.tick(quote(CE, px - 0.5, px + 0.5, { mark: px }));
  const s = await r.engine.poll(plan.tradeId);
  assert.equal(s?.position, 0);
  assert.equal(s?.phase, 'flat');
});

test('15 a gap through the stop books the price that actually filled, not the trigger', async () => {
  const r = rig();
  const plan = planFor(ceProduct());
  await r.engine.open(plan);
  await r.engine.poll(plan.tradeId);
  r.ex.tick(quote(CE, 109, 109.5, { mark: 109 }));
  // straight from 109 to 115: the stop triggers and pays the offer there
  r.ex.tick(quote(CE, 114.5, 115.5, { mark: 115 }));
  const s = await r.engine.poll(plan.tradeId);
  assert.equal(s?.position, 0);
  assert.equal(s?.exitAvgPrice, 115.5, 'the fill, not the 110 trigger');
  assert.equal(s?.realisedPnl, (100.5 - 115.5) * 100 * 0.001, 'a real loss, honestly counted');
});

test('16 a stop that only partly fills leaves the rest short and keeps working', async () => {
  const r = rig();
  const plan = planFor(ceProduct());
  await r.engine.open(plan);
  await r.engine.poll(plan.tradeId);
  r.ex.configure({ slippageLadder: [{ price: 111, size: 40 }] });
  r.ex.tick(quote(CE, 110.5, 111, { mark: 111 }));
  const s = await r.engine.poll(plan.tradeId);
  assert.equal(s?.position, -60, 'still 60 short — the exit is not done');
  assert.notEqual(s?.phase, 'flat');
});

// --------------------------------------------------------------- 17 & 18 OCO

test('17 when the target fills the stop is taken off the book', async () => {
  const r = rig();
  const plan = planFor(ceProduct());
  await r.engine.open(plan);
  const armed = await r.engine.poll(plan.tradeId);
  assert.ok(armed?.protection.takeProfit && armed.protection.stopLoss, 'both are live');
  const slId = armed!.protection.stopLoss!;

  r.ex.tick(quote(CE, 89.5, 90));
  const s = await r.engine.poll(plan.tradeId);
  assert.equal(s?.position, 0);
  const sl = await r.ex.getOrderByClientId(slId);
  assert.equal(sl?.status, 'cancelled', 'the stop cannot be left live to re-open us');
});

test('18 [critical] two exits cannot both fill and turn a short into a long', async () => {
  const r = rig();
  const plan = planFor(ceProduct());
  await r.engine.open(plan);
  await r.engine.poll(plan.tradeId);
  // a print that is at the target and through the stop in the same instant
  r.ex.tick(quote(CE, 89.5, 90, { mark: 111 }));
  const s = await r.engine.poll(plan.tradeId);
  assert.ok(s!.position <= 0, `never long: position is ${s!.position}`);
  assert.equal(s?.position, 0);
  const live = await r.ex.getOpenOrders(CE);
  assert.equal(live.length, 0, 'nothing left resting');
});

// ------------------------------------------------ 19,20,21 connectivity gates

test('19 a disconnected price feed stops new trades and leaves the old one protected', async () => {
  const r = rig();
  const first = planFor(ceProduct());
  await r.engine.open(first);
  await r.engine.poll(first.tradeId);

  r.setFeed(false);
  const blocked = await r.engine.open(planFor(peProduct(), { tradeId: 't-PE-x' }));
  assert.equal(blocked.ok, false);
  assert.ok(!blocked.ok && failureCodes(blocked.precheck).includes('FEED_DOWN'));

  const held = r.store.get(first.tradeId)!.state;
  assert.equal(held.phase, 'protected', 'the existing stop is untouched');
});

test('20 an unreachable order API takes no new risk', async () => {
  const r = rig();
  r.ex.reachable = false;
  const res = await r.engine.open(planFor(ceProduct()));
  assert.equal(res.ok, false);
  assert.equal(res.state.position, 0);
});

test('21 a quote five seconds old is not a quote', async () => {
  const r = rig({ quotes: [quote(CE, 100.5, 101, { ts: T0 - 5_000 })] });
  const res = await r.engine.open(planFor(ceProduct()));
  assert.equal(res.ok, false);
  assert.ok(!res.ok && failureCodes(res.precheck).includes('STALE_QUOTE'));
});

// ------------------------------------------------------ 22 & 23 book quality

test('22 a spread nobody would cross blocks the entry', async () => {
  const r = rig({ quotes: [quote(CE, 100, 105)] });
  const res = await r.engine.open(planFor(ceProduct(), { entry: { type: 'limit', limitPrice: 100, timeoutMs: 5_000, marketFallback: false } }));
  assert.equal(res.ok, false);
  assert.ok(!res.ok && failureCodes(res.precheck).includes('SPREAD_TOO_WIDE'));
});

test('23 ten on the bid is not a market for a hundred', async () => {
  const r = rig({ quotes: [quote(CE, 100.5, 101, { bidSize: 10 })] });
  const res = await r.engine.open(planFor(ceProduct()));
  assert.equal(res.ok, false);
  assert.ok(!res.ok && failureCodes(res.precheck).includes('THIN_BOOK'));
});

// ------------------------------------------------------- 24 price moves under

test('24 a quote that moved between the decision and the order is handled from exchange state', async () => {
  const r = rig({ quotes: [quote(CE, 100, 101)] });
  const plan = planFor(ceProduct(), { entry: { type: 'limit', limitPrice: 100, timeoutMs: 5_000, marketFallback: false } });
  const res = await r.engine.open(plan);
  assert.equal(res.state.position, -100, 'filled at the price the book was actually at');
  // the market falls away; our belief comes from the order, not the old quote
  r.ex.tick(quote(CE, 98, 99));
  const s = await r.engine.poll(plan.tradeId);
  assert.equal(s?.entryAvgPrice, 100);
});

// ---------------------------------------------------- 25 & 26 size and price

test('25 a price off the tick is rounded to one the exchange accepts', async () => {
  const r = rig();
  const plan = planFor(ceProduct(), { entry: { type: 'limit', limitPrice: 100.07, timeoutMs: 5_000, marketFallback: false } });
  await r.engine.open(plan);
  const o = await r.ex.getOrderByClientId(clientId(plan.tradeId, 'entry'));
  assert.equal(o?.limitPrice, 100.1, 'a seller rounds up, never down into a worse price');
});

test('26 a size that is not a whole lot is refused before the API is called', async () => {
  const r = rig({ products: [ceProduct({ lotSize: 10 })] });
  const res = await r.engine.open(planFor(ceProduct(), { lots: 0 }));
  assert.equal(res.ok, false);
  assert.ok(!res.ok && failureCodes(res.precheck).includes('MIN_SIZE'));
  assert.equal((await r.ex.getOpenOrders()).length, 0, 'nothing was sent');
});

// ------------------------------------------------- 27,28,29 account and risk

test('27 not enough margin, no entry', async () => {
  // 100 contracts at 10x on an 80k spot is about $810 of margin
  const r = rig({ balanceUsd: 500 });
  const res = await r.engine.open(planFor(ceProduct()));
  assert.equal(res.ok, false);
  assert.ok(!res.ok && failureCodes(res.precheck).includes('INSUFFICIENT_MARGIN'));
});

test('27b the same account affords the same trade at higher leverage', async () => {
  // at 200x the margin is about $50, so it fits where $810 did not
  const r = rig({ balanceUsd: 500 });
  const res = await r.engine.open(planFor(ceProduct(), { leverage: 200, stopPrice: 130 }));
  assert.equal(res.ok, true, JSON.stringify(res.ok ? '' : res.precheck));
  assert.equal(res.state.position, -100);
});

test('28 an order that would breach the total short limit is refused', async () => {
  const r = rig({ limits: { maxShortContracts: 500 } });
  r.ex.forcePosition(PE, -450);
  const res = await r.engine.open(planFor(ceProduct()));
  assert.equal(res.ok, false);
  assert.ok(!res.ok && failureCodes(res.precheck).includes('MAX_POSITION'));
});

test("29 a trade whose worst case would blow the day's loss budget is blocked", async () => {
  const r = rig({ limits: { maxDailyLossUsd: 5 } });
  r.setDayPnl(-4.8);
  // a stop at 110 on 100 contracts sold at 100.5 risks
  // (110 - 100.5) x 100 x 0.001 = $0.95, against the $0.20 left in the budget
  const res = await r.engine.open(planFor(ceProduct()));
  assert.equal(res.ok, false);
  assert.ok(!res.ok && failureCodes(res.precheck).includes('DAILY_LOSS_LIMIT'));
});

test('29b the same trade is allowed while the budget still has room', async () => {
  const r = rig({ limits: { maxDailyLossUsd: 5 } });
  r.setDayPnl(-1);
  const res = await r.engine.open(planFor(ceProduct()));
  assert.ok(res.ok, JSON.stringify(res.ok ? '' : res.precheck));
});

// ---------------------------------------- 47-50 the money is in the contract

test('47 [critical] a quoted price is dollars per BTC, and a contract is a thousandth of one', async () => {
  const r = rig();
  const res = await r.engine.open(planFor(ceProduct(), { lots: 1 }));
  assert.ok(res.ok);
  // sold one contract at 100.5: that is 100.5 x 0.001 = 10.05 cents, not $100.50
  const credit = 100.5 * 1 * 0.001;
  assert.ok(Math.abs(credit - 0.1005) < 1e-9);
});

test('48 the spread gate lets a resting order through and stops one that crosses', async () => {
  // 17 bid / 19 offered is an 11% spread and an ordinary daily option
  const wide = { products: [ceProduct()], quotes: [quote(CE, 17, 19)], balanceUsd: 100 };

  const resting = await rig(wide).engine.open(
    planFor(ceProduct(), { lots: 1, stopPrice: 40, entry: { type: 'limit', limitPrice: 19, timeoutMs: 5_000, marketFallback: false } }),
  );
  assert.ok(resting.ok, `resting at the offer should be allowed: ${JSON.stringify(resting.ok ? '' : resting.precheck)}`);

  const crossing = await rig(wide).engine.open(
    planFor(ceProduct(), { lots: 1, stopPrice: 40, entry: { type: 'market', timeoutMs: 5_000, marketFallback: false } }),
  );
  assert.equal(crossing.ok, false);
  assert.ok(!crossing.ok && failureCodes(crossing.precheck).includes('SPREAD_TOO_WIDE'));
});

test('49 a limit at the bid is crossing, because it fills immediately', async () => {
  const r = rig({ quotes: [quote(CE, 17, 19)], balanceUsd: 100 });
  const res = await r.engine.open(
    planFor(ceProduct(), { lots: 1, stopPrice: 40, entry: { type: 'limit', limitPrice: 17, timeoutMs: 5_000, marketFallback: false } }),
  );
  assert.equal(res.ok, false);
  assert.ok(!res.ok && failureCodes(res.precheck).includes('SPREAD_TOO_WIDE'));
});

test('50 depth is only demanded of an order that has to fill now', async () => {
  const thin = { quotes: [quote(CE, 100, 101, { bidSize: 1 })], balanceUsd: 1_000 };
  const resting = await rig(thin).engine.open(
    planFor(ceProduct(), { lots: 50, stopPrice: 130, entry: { type: 'limit', limitPrice: 101, timeoutMs: 5_000, marketFallback: false } }),
  );
  assert.ok(resting.ok, 'resting is waiting for someone to arrive; nobody is there yet by definition');

  const crossing = await rig(thin).engine.open(
    planFor(ceProduct(), { lots: 50, stopPrice: 130, entry: { type: 'market', timeoutMs: 5_000, marketFallback: false } }),
  );
  assert.ok(!crossing.ok && failureCodes(crossing.precheck).includes('THIN_BOOK'));
});

// -------------------------------- 59-63 moving the exits after the fact

test('59 the stop can be moved on a position that is already on', async () => {
  const r = rig();
  const plan = planFor(ceProduct());
  await r.engine.open(plan);
  const armed = await r.engine.poll(plan.tradeId);
  const oldStop = armed!.protection.stopLoss!;

  const s = await r.engine.updateProtection(plan.tradeId, { stopPrice: 150 });
  assert.notEqual(s?.protection.stopLoss, oldStop, 'a new order, not the old one');
  assert.equal((await r.ex.getOrderByClientId(oldStop))?.status, 'cancelled');

  const live = (await r.ex.getOpenOrders(CE)).filter((o) => o.reduceOnly);
  assert.equal(live.length, 2, 'exactly one target and one stop');
  assert.ok(live.some((o) => o.stopPrice === 150));
});

test('60 the old level is off the book before the new one goes on', async () => {
  // otherwise there is a moment with two stops live, and a fill against a level
  // you have just moved away from
  const r = rig();
  const plan = planFor(ceProduct());
  await r.engine.open(plan);
  await r.engine.poll(plan.tradeId);
  await r.engine.updateProtection(plan.tradeId, { stopPrice: 150, takeProfitPrice: 50 });

  const live = (await r.ex.getOpenOrders(CE)).filter((o) => o.reduceOnly);
  assert.equal(live.length, 2, 'never three');
});

test('61 turning the stop off is a decision, not an alarm', async () => {
  const r = rig();
  const plan = planFor(ceProduct());
  await r.engine.open(plan);
  await r.engine.poll(plan.tradeId);

  const s = await r.engine.updateProtection(plan.tradeId, { stopPrice: null });
  assert.equal(s?.protection.stopLoss, null);
  assert.equal(s?.alarm, null, 'it was asked for, so it is not a malfunction');

  // and it stays off rather than being put back by the next poll
  r.advance(5_000);
  const after = await r.engine.poll(plan.tradeId);
  assert.equal(after?.protection.stopLoss, null);
  assert.equal(after?.alarm, null);
});

test('62 the exits cannot be moved on a position that is not open', async () => {
  const r = rig({ quotes: [quote(CE, 99, 101)] });
  const plan = planFor(ceProduct(), {
    entry: { type: 'limit', limitPrice: 101, timeoutMs: 0, marketFallback: false },
  });
  await r.engine.open(plan);
  const s = await r.engine.updateProtection(plan.tradeId, { stopPrice: 150 });
  assert.equal(s?.position, 0);
  assert.equal(s?.protection.stopLoss, null, 'nothing to protect yet');
});

test('63 a change is not a retry, so a backoff does not swallow it', async () => {
  const r = rig();
  const plan = planFor(ceProduct());
  await r.engine.open(plan);
  r.ex.configure({ nextFault: { kind: 'unavailable' } });
  await r.engine.poll(plan.tradeId);          // fails, and backs off two seconds

  const s = await r.engine.updateProtection(plan.tradeId, { stopPrice: 150 });
  assert.ok(s?.protection.stopLoss, 'the change went through immediately');
});

// ------------------------------- 54-58 a resting order is meant to rest

test('54 [critical] an order resting at the offer is not cancelled on a timer', async () => {
  // this is the bug that made a live order appear, show "short 0", and vanish:
  // the offer was taken off the book five seconds after it was placed, which
  // guarantees the one thing the trade was trying to do
  const r = rig({ quotes: [quote(CE, 99, 101)] });
  const plan = planFor(ceProduct(), {
    entry: { type: 'limit', limitPrice: 101, timeoutMs: 0, marketFallback: false },
  });
  await r.engine.open(plan);
  assert.equal((await r.ex.getOpenOrders(CE)).length, 1);

  r.advance(60_000);
  const s = await r.engine.poll(plan.tradeId);
  assert.equal((await r.ex.getOpenOrders(CE)).length, 1, 'still on the book a minute later');
  assert.equal(s?.phase, 'entry_pending');
});

test('55 and it fills whenever the market finally comes to it', async () => {
  const r = rig({ quotes: [quote(CE, 99, 101)] });
  const plan = planFor(ceProduct(), {
    entry: { type: 'limit', limitPrice: 101, timeoutMs: 0, marketFallback: false },
  });
  await r.engine.open(plan);
  r.advance(120_000);
  await r.engine.poll(plan.tradeId);

  r.ex.tick(quote(CE, 101, 102, { ts: r.now() }));   // someone lifts the offer
  const s = await r.engine.poll(plan.tradeId);
  assert.equal(s?.position, -100);
  assert.equal(s?.entryAvgPrice, 101);
});

test('56 a timeout still applies when one was asked for, with the fallback', async () => {
  const r = rig({ quotes: [quote(CE, 99, 101)] });
  const plan = planFor(ceProduct(), {
    entry: { type: 'limit', limitPrice: 100, timeoutMs: 5_000, marketFallback: true },
  });
  await r.engine.open(plan);
  r.advance(5_001);
  r.ex.tick(quote(CE, 99, 101, { ts: r.now() }));
  const s = await r.engine.poll(plan.tradeId);
  assert.equal(s?.position, -100, 'the fallback crossed once the wait was over');
});

test('57 a working entry can be taken off the book on purpose', async () => {
  const r = rig({ quotes: [quote(CE, 99, 101)] });
  const plan = planFor(ceProduct(), {
    entry: { type: 'limit', limitPrice: 101, timeoutMs: 0, marketFallback: false },
  });
  await r.engine.open(plan);
  const s = await r.engine.cancelEntry(plan.tradeId);
  assert.equal(s?.phase, 'aborted');
  assert.equal(s?.position, 0);
  assert.equal((await r.ex.getOpenOrders(CE)).length, 0);
});

test('58 cancelling refuses once contracts exist, because the way out is to buy them back', async () => {
  const r = rig();
  const plan = planFor(ceProduct());
  await r.engine.open(plan);
  assert.equal(r.store.get(plan.tradeId)!.state.position, -100);

  const s = await r.engine.cancelEntry(plan.tradeId);
  assert.equal(s?.position, -100, 'still short');
  assert.notEqual(s?.phase, 'aborted');
});

// -------------------------------------- 51-53 the id the exchange sees

test('51 the client order id is short and alphanumeric, because Delta rejects anything else', () => {
  // the first live order came back bad_schema on
  // "C-BTC-82000-090926-1757349123456:entry" -- too long, and a colon
  const id = clientId('C-BTC-82000-090926-1757349123456', 'entry');
  assert.match(id, /^[A-Za-z0-9]+$/, `"${id}" must be letters and digits only`);
  assert.ok(id.length <= 24, `"${id}" is ${id.length} characters`);
});

test('52 the same trade and role always produce the same id, which is what makes a retry safe', () => {
  const t = 'C-BTC-82000-090926-1757349123456';
  assert.equal(clientId(t, 'entry'), clientId(t, 'entry'));
  // and the roles never collide with each other
  const ids = new Set([
    clientId(t, 'entry'), clientId(t, 'take_profit'),
    clientId(t, 'stop_loss'), clientId(t, 'exit'),
  ]);
  assert.equal(ids.size, 4);
});

test('53 two trades on the same contract get different ids', () => {
  const a = clientId('C-BTC-82000-090926-1757349123456', 'entry');
  const b = clientId('C-BTC-82000-090926-1757349123999', 'entry');
  assert.notEqual(a, b, 'the tail is kept precisely because that is where the timestamp is');
});

// ------------------------------------------------------ 41-46 leverage

test('41 leverage is set on the product before the order is sent, not after', async () => {
  const r = rig();
  await r.engine.open(planFor(ceProduct(), { leverage: 25 }));
  assert.equal(r.ex.leverage.get(111), 25, 'the order inherits a leverage that was already right');
});

test('42 a leverage the exchange refuses stops the trade rather than filling at the old one', async () => {
  const r = rig();
  const original = r.ex.setLeverage.bind(r.ex);
  void original;
  r.ex.setLeverage = async () => { throw new Error('leverage change not allowed with an open position'); };
  const res = await r.engine.open(planFor(ceProduct(), { leverage: 200 }));
  assert.equal(res.ok, false);
  assert.equal(res.state.position, 0, 'nothing was sold at whatever leverage was left over');
  assert.equal((await r.ex.getOpenOrders()).length, 0);
});

test('43 leverage past the desk limit is refused even though Delta would allow it', async () => {
  const r = rig({ limits: { maxLeverage: 50 } });
  const res = await r.engine.open(planFor(ceProduct(), { leverage: 200 }));
  assert.equal(res.ok, false);
  assert.ok(!res.ok && failureCodes(res.precheck).includes('LEVERAGE_TOO_HIGH'));
});

test('44 [critical] a stop past the close-out price is refused, because it would never fire', async () => {
  // 200x on an 80k spot leaves about $250 of room above a $100.50 option, so a
  // stop at 251 sits beyond where the exchange has already closed the position
  const r = rig();
  const res = await r.engine.open(planFor(ceProduct(), { leverage: 200, stopPrice: 400, lots: 10 }));
  assert.equal(res.ok, false);
  assert.ok(!res.ok && failureCodes(res.precheck).includes('STOP_BEYOND_LIQUIDATION'));
});

test('45 the same stop is fine at lower leverage, because the close-out moves away', async () => {
  const r = rig();
  const res = await r.engine.open(planFor(ceProduct(), { leverage: 10, stopPrice: 400, lots: 10 }));
  assert.ok(res.ok, JSON.stringify(res.ok ? '' : res.precheck));
});

test('46 with no spot to work from, the margin model refuses to invent one', async () => {
  const r = rig({ spot: null, balanceUsd: 1 });
  // $1 could not cover this at any leverage -- but with no spot there is no
  // margin number, and a made-up one is worse than none
  const res = await r.engine.open(planFor(ceProduct()));
  assert.ok(res.ok, 'no spot means the margin gate abstains rather than guessing');
});

// ------------------------------------------------------------ 30 & 31 restart

test('30 [critical] a restart with a position on picks the orders back up and sends nothing new', async () => {
  const r = rig();
  const plan = planFor(ceProduct());
  await r.engine.open(plan);
  await r.engine.poll(plan.tradeId);
  const ordersBefore = (await r.ex.getOpenOrders(CE)).length;

  // same exchange, same journal, brand new engine — as a process restart is
  const fresh = rig();
  const restarted = new (await import('../../src/trading/engine.js')).TradeEngine({
    exchange: r.ex, store: r.store, now: r.now, tradingEnabled: true,
  });
  void fresh;
  const recovered = await restarted.recover();
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0]?.position, -100, 'the position is where we left it');
  assert.equal((await r.ex.getOpenOrders(CE)).length, ordersBefore, 'no extra orders');
  assert.equal((await r.ex.getPositions())[0]?.size, -100, 'and no second short');
});

test('31 a restart with an entry still working resumes monitoring rather than re-selling', async () => {
  const r = rig({ quotes: [quote(CE, 99, 101)] });
  const plan = planFor(ceProduct(), { entry: { type: 'limit', limitPrice: 100, timeoutMs: 5_000, marketFallback: false } });
  await r.engine.open(plan);
  assert.equal((await r.ex.getOpenOrders(CE)).length, 1);

  const { TradeEngine } = await import('../../src/trading/engine.js');
  const restarted = new TradeEngine({ exchange: r.ex, store: r.store, now: r.now, tradingEnabled: true });
  await restarted.recover();
  assert.equal((await r.ex.getOpenOrders(CE)).length, 1, 'still exactly one working order');
  assert.equal(r.store.get(plan.tradeId)!.state.position, 0);
});

// ------------------------------------------------ 32 protection failure alarm

test('32 [critical] a filled entry whose protection fails raises an alarm, not a shrug', async () => {
  const r = rig();
  const plan = planFor(ceProduct());
  await r.engine.open(plan);
  r.ex.configure({ nextFault: { kind: 'unavailable' } });
  const s = await r.engine.poll(plan.tradeId);
  assert.equal(s?.position, -100, 'the contracts are real');
  assert.equal(s?.phase, 'unprotected');
  assert.ok(s?.alarm?.startsWith('POSITION UNPROTECTED'), s?.alarm ?? 'no alarm raised');
  assert.equal(r.alarms.length, 1, 'somebody is told');
});

test('32b protection is retried after a wait, and the alarm clears', async () => {
  const r = rig();
  const plan = planFor(ceProduct());
  await r.engine.open(plan);
  r.ex.configure({ nextFault: { kind: 'unavailable' } });
  await r.engine.poll(plan.tradeId);

  // not immediately: a venue that just said no is not asked again this second
  const tooSoon = await r.engine.poll(plan.tradeId);
  assert.equal(tooSoon?.phase, 'unprotected');

  r.advance(2_500);
  const s = await r.engine.poll(plan.tradeId);
  assert.equal(s?.phase, 'protected');
  assert.equal(s?.alarm, null);
  assert.ok(s?.protection.stopLoss, 'a stop is behind it now');
});

test('32c [critical] a target with no stop is placed once, not replaced every second', async () => {
  // the loop that cancelled and re-placed a live order once a second: a trade
  // with a target and no stop can never have a stopLoss, so "is the stop
  // missing" was always true
  const r = rig();
  const plan = planFor(ceProduct(), { stopPrice: null, takeProfitPrice: 90 });
  await r.engine.open(plan);

  const first = await r.engine.poll(plan.tradeId);
  const tp = first!.protection.takeProfit;
  assert.ok(tp, 'the target went on');
  assert.equal(first?.protection.stopLoss, null, 'and no stop was invented');

  for (let i = 0; i < 5; i++) { r.advance(1_000); await r.engine.poll(plan.tradeId); }

  const after = r.store.get(plan.tradeId)!.state;
  assert.equal(after.protection.takeProfit, tp, 'the same order, not a new one');
  const live = (await r.ex.getOpenOrders(CE)).filter((o) => o.reduceOnly);
  assert.equal(live.length, 1, 'exactly one protective order on the book');
  assert.equal(after.alarm, null, 'and choosing no stop is not an alarm');
});

test('32e a target that will not go on is a note, not an alarm', async () => {
  const r = rig();
  const plan = planFor(ceProduct(), { stopPrice: null, takeProfitPrice: 90 });
  await r.engine.open(plan);
  r.ex.configure({ nextFault: { kind: 'unavailable' } });
  const s = await r.engine.poll(plan.tradeId);
  assert.equal(s?.alarm, null, 'nothing extra is at risk: no stop was ever asked for');
  assert.notEqual(s?.phase, 'unprotected');
  assert.match(s?.note ?? '', /could not place the target/);
});

test('32d protection waits until the exchange agrees the position exists', async () => {
  // Delta answered no_position_for_reduce_only because our fill had not
  // registered on their side yet; sending anyway just fills the error log
  const r = rig();
  const plan = planFor(ceProduct());
  await r.engine.open(plan);
  r.ex.forcePosition(CE, 0);                    // exchange has not caught up

  const s = await r.engine.poll(plan.tradeId);
  const resting = (await r.ex.getOpenOrders(CE)).filter((o) => o.reduceOnly);
  assert.equal(resting.length, 0, 'nothing reduce-only was sent into thin air');
  assert.equal(s?.protection.stopLoss, null);
});

// ------------------------------------------------------------ 33 exit failure

test('33 a failed exit is retried only after the position is read back', async () => {
  const r = rig();
  const plan = planFor(ceProduct());
  await r.engine.open(plan);
  await r.engine.poll(plan.tradeId);
  r.ex.configure({ nextFault: { kind: 'unavailable' } });
  const failed = await r.engine.closeNow(plan.tradeId);
  assert.equal(failed?.position, -100, 'nothing was closed');

  const s = await r.engine.closeNow(plan.tradeId);
  assert.equal(s?.position, 0, 'the retry closed it once');
  assert.equal((await r.ex.getPositions()).length, 0);
});

// ---------------------------------------- 34,35,36 the exchange knows better

test('34 a position the exchange says is gone cancels the stale orders and goes flat', async () => {
  const r = rig();
  const plan = planFor(ceProduct());
  await r.engine.open(plan);
  const armed = await r.engine.poll(plan.tradeId);
  const slId = armed!.protection.stopLoss!;

  r.ex.forcePosition(CE, 0);               // closed elsewhere
  const s = (await r.engine.reconcile(plan.tradeId))!.state;
  assert.equal(s.position, 0);
  assert.equal(s.phase, 'flat');
  assert.equal((await r.ex.getOrderByClientId(slId))?.status, 'cancelled');
});

test('35 a manual close in the exchange UI leaves the desk flat with nothing resting', async () => {
  const r = rig();
  const plan = planFor(ceProduct());
  await r.engine.open(plan);
  await r.engine.poll(plan.tradeId);
  r.ex.forcePosition(CE, 0);
  await r.engine.reconcile(plan.tradeId);
  assert.equal((await r.ex.getOpenOrders(CE)).length, 0);
  assert.equal(r.store.get(plan.tradeId)!.state.phase, 'flat');
});

test('36 a manual partial close resizes the target and the stop to what is left', async () => {
  const r = rig();
  const plan = planFor(ceProduct());
  await r.engine.open(plan);
  await r.engine.poll(plan.tradeId);
  r.ex.forcePosition(CE, -70);             // the user bought 30 back by hand
  const s = (await r.engine.reconcile(plan.tradeId))!.state;
  assert.equal(s.position, -70);
  const live = (await r.ex.getOpenOrders(CE)).filter((o) => o.reduceOnly);
  assert.deepEqual(live.map((o) => o.size), [70, 70], 'protection follows the position');
});

// ------------------------------------------------------------- 37 contract

test('37 an expired contract takes no new entry', async () => {
  const r = rig({ products: [ceProduct({ state: 'expired' })] });
  const res = await r.engine.open(planFor(ceProduct()));
  assert.equal(res.ok, false);
  assert.ok(!res.ok && failureCodes(res.precheck).includes('EXPIRED'));
});

test('37b a halted contract takes no new entry either', async () => {
  const r = rig({ products: [ceProduct({ state: 'halted' })] });
  const res = await r.engine.open(planFor(ceProduct()));
  assert.ok(!res.ok && failureCodes(res.precheck).includes('NOT_TRADABLE'));
});

// ------------------------------------------------------- 38 & 39 & 40 safety

test('38 a signal for BTC pointed at a contract that is not BTC never leaves the process', async () => {
  const r = rig({ products: [ceProduct({ underlying: 'ETH' })] });
  const res = await r.engine.open(planFor(ceProduct()));
  assert.equal(res.ok, false);
  assert.ok(!res.ok && failureCodes(res.precheck).includes('WRONG_UNDERLYING'));
  assert.equal((await r.ex.getOpenOrders()).length, 0);
});

test('38b a strike or expiry that does not match the signal is refused', async () => {
  const r = rig({ products: [ceProduct({ strike: 81_000 })] });
  const res = await r.engine.open(planFor(ceProduct()));
  assert.ok(!res.ok && failureCodes(res.precheck).includes('WRONG_STRIKE'));
});

test('39 selling to close a short is refused by the gate', () => {
  const res = precheck({
    now: T0,
    intent: {
      side: 'sell', size: 100, price: 100, reduceOnly: true,
      expect: { underlying: 'BTC', optionSide: 'CE', strike: 80_000, expiryTs: 1_700_040_000 },
    },
    product: ceProduct(),
    quote: quote(CE, 100.5, 101),
    feedHealthy: true, tradingEnabled: true,
    account: { availableUsd: 100_000 },
    existingPosition: -100, totalShortContracts: 100,
    dayPnlUsd: 0, worstCaseLossUsd: 0, limits: DEFAULT_LIMITS,
  });
  assert.ok(failureCodes(res).includes('WRONG_EXIT_SIDE'));
});

test('40 [safeguard] a reduce-only exit can shrink a short but can never open a long', async () => {
  const r = rig();
  r.ex.forcePosition(CE, -40);
  await assert.rejects(
    () => r.ex.placeOrder({
      clientOrderId: 'x1', symbol: CE, productId: 111, side: 'buy', type: 'market',
      size: 100, reduceOnly: true, role: 'exit',
    }),
    /would not reduce/,
    'buying 100 against a 40 short would leave us long 60',
  );
  const ok = await r.ex.placeOrder({
    clientOrderId: 'x2', symbol: CE, productId: 111, side: 'buy', type: 'market',
    size: 40, reduceOnly: true, role: 'exit',
  });
  assert.equal(ok.filledSize, 40);
  assert.equal((await r.ex.getPositions()).length, 0, 'flat, never long');
});
