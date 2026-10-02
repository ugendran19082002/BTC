import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rig, ceProduct, planFor, quote, holdOffer, T0, type Rig } from './harness.js';
import { TradeEngine, UNEXPLAINED_ALARM_MS, ownsClientId, type TradePlan } from '../../src/trading/engine.js';
import { DEFAULT_LIMITS, failureCodes } from '../../src/trading/precheck.js';
import { nextTradeMs } from '../../src/trading/service.js';

/**
 * Two strategies on one contract (decision 0011, 30 Sep 2026).
 *
 * `5-01-copy` at 15:55 and `5-01` at 17:01 chose the same strikes on 26, 27 and
 * 29 Sep, and the second was refused "Already holding -10 on this contract",
 * because the engine held one trade per contract: it wrote Delta's net
 * position into the trade and treated every reduce-only order on the symbol as
 * its own. Two trades on one contract now each keep their own orders, fills and
 * exits, and Delta's position is their sum. Each case below is a way the old
 * engine would have crossed the two.
 *
 * What these cannot say is whether Delta holds four reduce-only orders on one
 * contract -- two targets and two stop triggers -- when they total more than
 * the position. That is a one-lot live test (decision 0002).
 */

const CE = ceProduct().symbol;
const strategy = (id: string, over: Partial<TradePlan> = {}) => planFor(ceProduct(), {
  tradeId: `${id}-trade`, strategyId: id, origin: 'strategy', ...over,
});

/** Two strategies, both filled and protected: A with its target at 90, B at 80. */
async function both(): Promise<{ r: Rig; A: TradePlan; B: TradePlan }> {
  const r = rig({ limits: { maxShortContracts: 1_000 } });
  const A = strategy('a', { takeProfitPrice: 90, stopPrice: 110 });
  const B = strategy('b', { takeProfitPrice: 80, stopPrice: 112 });
  for (const plan of [A, B]) {
    const res = await r.engine.open(plan);
    assert.equal(res.ok, true, JSON.stringify(res));
    await r.engine.poll(plan.tradeId);
  }
  // A second pass, as the service polls every trade every second.
  await r.engine.poll(A.tradeId);
  await r.engine.poll(B.tradeId);
  return { r, A, B };
}

const own = async (r: Rig, tradeId: string) =>
  (await r.ex.getOpenOrders(CE)).filter((o) => o.reduceOnly && ownsClientId(tradeId, o.clientOrderId));
const net = async (r: Rig) => (await r.ex.getPositions()).find((p) => p.symbol === CE)?.size ?? 0;

test('[critical] a second strategy may sell the contract a first one holds', async () => {
  const { r, A, B } = await both();
  assert.equal(r.store.peek(A.tradeId)!.state.position, -100);
  assert.equal(r.store.peek(B.tradeId)!.state.position, -100, 'each trade holds its own 100, not the 200 Delta holds');
  assert.equal(await net(r), -200);
});

test('[critical] each keeps its own target and stop on the book -- neither moves the other\'s', async () => {
  const { r, A, B } = await both();
  const a = await own(r, A.tradeId);
  const b = await own(r, B.tradeId);
  assert.deepEqual(a.filter((o) => o.type === 'limit').map((o) => o.limitPrice), [90]);
  assert.deepEqual(b.filter((o) => o.type === 'limit').map((o) => o.limitPrice), [80]);
  assert.equal(a.length, 2);
  assert.equal(b.length, 2);
  assert.equal((await r.ex.getOpenOrders(CE)).filter((o) => o.reduceOnly).length, 4, 'nothing cancelled as "unwanted"');
});

test('[critical] one target fills: that trade is flat, the other still short with its exits intact', async () => {
  const { r, A, B } = await both();
  r.ex.tick(quote(CE, 89, 90, { ts: r.now() }));
  await r.engine.poll(A.tradeId);
  await r.engine.poll(B.tradeId);
  assert.equal(r.store.peek(A.tradeId)!.state.position, 0);
  assert.equal(r.store.peek(B.tradeId)!.state.phase, 'protected');
  assert.equal(r.store.peek(B.tradeId)!.state.position, -100);
  assert.equal((await own(r, B.tradeId)).length, 2, 'B\'s target and stop still resting');
  assert.equal((await own(r, A.tradeId)).length, 0, 'A\'s stop went with its target');
  assert.equal(await net(r), -100);
});

test('[critical] closing one by hand buys back its own contracts, never the other\'s', async () => {
  const { r, A, B } = await both();
  await r.engine.closeNow(A.tradeId);
  await r.engine.poll(A.tradeId);
  await r.engine.poll(B.tradeId);
  assert.equal(r.store.peek(A.tradeId)!.state.position, 0);
  assert.equal(r.store.peek(B.tradeId)!.state.position, -100);
  assert.equal(await net(r), -100, 'bought back 100, not 200');
  assert.equal((await own(r, B.tradeId)).length, 2);
});

test('[critical] one stop reached, the other not: only that trade is closed', async () => {
  const { r, A, B } = await both();
  // The offer holds at 111: through A's 110 stop, under B's 112.
  await holdOffer(r, CE, 110, 111, A.tradeId);
  await r.engine.poll(B.tradeId);
  assert.equal(r.store.peek(A.tradeId)!.state.position, 0);
  assert.equal(r.store.peek(B.tradeId)!.state.position, -100);
});

test('[critical] a restart picks both back up, each at its own size', async () => {
  const { r, A, B } = await both();
  const again = new TradeEngine({ exchange: r.ex, store: r.store, now: r.now, limits: { ...DEFAULT_LIMITS, maxShortContracts: 1_000 } });
  await again.recover();
  assert.equal(r.store.peek(A.tradeId)!.state.position, -100);
  assert.equal(r.store.peek(B.tradeId)!.state.position, -100);
  assert.equal(r.store.peek(A.tradeId)!.events.some((e) => e.t === 'reconciled'), false, 'nothing rewritten');
  assert.equal((await r.ex.getOpenOrders(CE)).filter((o) => o.reduceOnly).length, 4);
});

test('[critical] a gap nobody can attribute is not written into either trade -- and is said once it lasts', async () => {
  const { r, A, B } = await both();
  r.ex.forcePosition(CE, -250, 100);        // 50 more than the two trades hold, from nowhere
  // Reconcile is where the desk compares its trades with Delta's position.
  await r.engine.reconcile(A.tradeId);
  await r.engine.reconcile(B.tradeId);
  assert.equal(r.store.peek(A.tradeId)!.state.position, -100);
  assert.equal(r.store.peek(B.tradeId)!.state.position, -100);
  assert.equal(r.alarms.length, 0, 'not at once: a sibling may just not have absorbed its fill yet');
  r.advance(UNEXPLAINED_ALARM_MS);
  await r.engine.reconcile(A.tradeId);
  assert.equal(r.alarms.filter((a) => /across 2 trades/.test(a.message)).length, 1);
  await r.engine.reconcile(A.tradeId);
  assert.equal(r.alarms.filter((a) => /across 2 trades/.test(a.message)).length, 1, 'said once, not every second');
});

test('[critical] a contract closed on Delta by hand ends both trades', async () => {
  const { r, A, B } = await both();
  r.ex.forcePosition(CE, 0);
  await r.engine.reconcile(A.tradeId);
  await r.engine.reconcile(B.tradeId);
  assert.equal(r.store.peek(A.tradeId)!.state.position, 0);
  assert.equal(r.store.peek(B.tradeId)!.state.position, 0);
});

test('[critical] the same strategy twice on one contract is still refused', async () => {
  const { r } = await both();
  const again = await r.engine.previewOpen(strategy('a', { tradeId: 'a-again' }));
  assert.ok(failureCodes(again).includes('DUPLICATE_POSITION'));
});

test('[critical] a manual ticket keeps the desk-wide rule: anything held on the contract', async () => {
  const { r } = await both();
  const manual = await r.engine.previewOpen(planFor(ceProduct(), { tradeId: 'by-hand' }));
  assert.ok(failureCodes(manual).includes('DUPLICATE_POSITION'));
});

test('a third strategy is let through that gate too', async () => {
  const { r } = await both();
  const third = await r.engine.previewOpen(strategy('c'));
  assert.ok(!failureCodes(third).includes('DUPLICATE_POSITION'));
});

test('two orders in the same millisecond get different trade ids', () => {
  const at = T0 + 123;
  const a = nextTradeMs(at);
  const b = nextTradeMs(at);
  assert.ok(b > a, 'the second moves on rather than repeat -- a repeated id is read as the first order re-sent');
});

test('[critical] one read of Delta with the contract missing writes nothing off; flat twice is written off, out loud', async () => {
  // 2 Oct 2026: two trades on the 88,800 CE "closed" by the startup check a minute after a restart, no buy-back.
  const r = rig({ quotes: [quote(CE, 100.5, 101)] });
  const plan = planFor(ceProduct(), { lots: 10, stopPrice: null, takeProfitPrice: 4 });
  await r.engine.open(plan);
  await r.engine.poll(plan.tradeId);
  assert.equal(r.store.peek(plan.tradeId)!.state.position, -10);

  // Delta answers once without the contract, then with it again
  const real = r.ex.getPositions.bind(r.ex);
  let n = 0;
  r.ex.getPositions = async () => (n++ === 0 ? [] : real());
  await r.engine.reconcile(plan.tradeId);
  assert.equal(r.store.peek(plan.tradeId)!.state.position, -10, 'not written off on one read');
  assert.equal(r.store.peek(plan.tradeId)!.events.some((e) => e.t === 'reconciled'), false);
  assert.ok(r.alarms.some((a) => /answered once with no position, then with -10\. Nothing written off/.test(a.message)));

  // Delta flat twice, nothing of the desk's filled: closed on Delta itself -- written off, and said
  r.ex.getPositions = async () => [];
  await r.engine.reconcile(plan.tradeId);
  assert.equal(r.store.peek(plan.tradeId)!.state.position, 0);
  assert.ok(r.alarms.some((a) => /no buy-back of the desk's explains it -- closed on Delta itself/.test(a.message)));
});
