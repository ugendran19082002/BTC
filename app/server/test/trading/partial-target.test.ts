import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rig, ceProduct, planFor, quote } from './harness.js';
import { missingProtection } from '../../src/trading/engine.js';

/**
 * A target that fills in pieces.
 *
 * 11 September 2026, 09:08 IST: a 425-contract PE short with its target at 0.70
 * bought back 200, then 3 more, and 222 stayed short with the target resting.
 * That trade had no stop. Had it had one, the first piece would have taken it
 * off the book: the first exit fill was treated as the exit, so the stop was
 * cancelled as its "sibling", the trade went to exit_pending, and in
 * exit_pending the desk neither re-protects nor watches the stop. 222 contracts
 * with nothing behind them, and nothing saying so.
 *
 * A part-filled target is still a target. What is left of the position is
 * still a position, and it keeps its stop, sized to what is left.
 */

const CE = 'C-BTC-80000-080926';

async function halfTakenByTarget(stopPrice: number | null = 60) {
  const r = rig({ quotes: [quote(CE, 26, 28, { mark: 27 })] });
  const plan = planFor(ceProduct(), {
    lots: 100, stopPrice, takeProfitPrice: 11,
    entry: { type: 'limit', limitPrice: 26, timeoutMs: 0, marketFallback: false, chase: null },
  });
  await r.engine.open(plan);
  await r.engine.poll(plan.tradeId);

  // somebody offers 40 at the target, and no more
  r.ex.configure({ partialFillSize: 40 });
  r.ex.tick(quote(CE, 9, 11, { mark: 10, ts: r.now() }));
  await r.engine.poll(plan.tradeId);
  // the offer goes away again
  r.ex.tick(quote(CE, 14, 16, { mark: 15, ts: r.now() }));
  const s = await r.engine.poll(plan.tradeId);
  const book = (await r.ex.getOpenOrders(CE)).filter((o) => o.reduceOnly);
  return { r, plan, s: s!, book };
}

test('[critical] a target that fills in part does not take the stop off the rest', async () => {
  const { s, book } = await halfTakenByTarget();
  assert.equal(s.position, -60, '40 bought back, 60 still short');
  const stop = book.find((o) => o.type === 'stop_market');
  assert.ok(stop, 'the stop is still on the book');
  assert.equal(stop.size - stop.filledSize, 60, 'sized to what is still short, not to the 100 it was placed for');
  assert.equal(stop.stopPrice, 60);
  assert.equal(s.alarm, null);
});

test('[critical] the half-filled target keeps resting for the rest, and is not re-sent', async () => {
  const { s, book } = await halfTakenByTarget();
  const targets = book.filter((o) => o.type === 'limit');
  assert.equal(targets.length, 1, 'one target, never a second beside it');
  assert.equal(targets[0]!.limitPrice, 11);
  assert.equal(targets[0]!.filledSize, 40, 'the same order that filled 40');
  assert.equal(targets[0]!.size - targets[0]!.filledSize, 60, 'with 60 still resting');
  assert.equal(s.protection.takeProfit, targets[0]!.clientOrderId);
});

test('[critical] a trade half-closed by its target still stops out when the price runs', async () => {
  const { r, plan } = await halfTakenByTarget();
  r.ex.configure({ partialFillSize: undefined });
  r.ex.tick(quote(CE, 64, 66, { mark: 65, ts: r.now() }));
  const s = await r.engine.poll(plan.tradeId);
  assert.equal(s?.position, 0, 'the desk watched the stop on the 60 that were left');
});

test('a part-filled target is not a finished exit: the trade is still protected, not closing', async () => {
  const { s } = await halfTakenByTarget();
  assert.equal(s.phase, 'protected');
  assert.equal(s.protection.size, 60, 'protection is recorded at the size still held');
  assert.equal(s.exitWinner, null, 'nothing has won until the position is flat');
});

test('without a stop, a part-filled target simply keeps resting', async () => {
  const { s, book } = await halfTakenByTarget(null);
  assert.equal(s.position, -60);
  assert.deepEqual(book.map((o) => [o.type, o.size - o.filledSize, o.limitPrice]), [['limit', 60, 11]]);
  assert.equal(s.phase, 'protected');
});

test('when the rest fills, the target is the exit and the stop goes', async () => {
  const { r, plan } = await halfTakenByTarget();
  r.ex.configure({ partialFillSize: undefined });
  r.ex.tick(quote(CE, 9, 11, { mark: 10, ts: r.now() }));
  const s = await r.engine.poll(plan.tradeId);
  assert.equal(s?.position, 0);
  assert.equal(s?.phase, 'flat');
  assert.equal(s?.exitWinner, 'take_profit');
  assert.equal((await r.ex.getOpenOrders(CE)).length, 0, 'nothing left resting');
});

test('protection that covers more than is held is also the wrong size', async () => {
  const { r, plan } = await halfTakenByTarget();
  const rec = r.store.get(plan.tradeId)!;
  assert.equal(missingProtection(rec), false, 'settled at 60');
  assert.equal(
    missingProtection({ ...rec, state: { ...rec.state, protection: { ...rec.state.protection, size: 100 } } }),
    true,
    'a stop for 100 on a position of 60 is not what the plan asked for',
  );
});

test('[critical] a half-filled target that no longer matches the position is replaced, never edited down to the wrong size', async () => {
  const { r, plan } = await halfTakenByTarget(null);
  // 10 more closed by hand on Delta: 50 short, while the target still rests for 60
  r.ex.forcePosition(CE, -50);
  await r.engine.reconcile(plan.tradeId);
  const book = (await r.ex.getOpenOrders(CE)).filter((o) => o.reduceOnly);
  // an edit to size 50 on an order that has filled 40 would leave 10 resting
  assert.deepEqual(book.map((o) => [o.type, o.size - o.filledSize, o.limitPrice]), [['limit', 50, 11]]);
});

test('[critical] the target still only fills when the ask comes down to it, at its own price', async () => {
  const { r, plan, s } = await halfTakenByTarget();
  // after the first 40, the ask went back up to 16: nothing more was bought
  assert.deepEqual(
    s.fills.filter((f) => f.side === 'buy').map((f) => [f.role, f.size, f.price]),
    [['take_profit', 40, 11]],
    'no market buy, no chase to the offer',
  );
  // the ask comes back down to the target: the rest fills there, and only there
  r.ex.configure({ partialFillSize: undefined });
  r.ex.tick(quote(CE, 10, 11, { mark: 10.5, ts: r.now() }));
  const done = await r.engine.poll(plan.tradeId);
  assert.deepEqual(
    done!.fills.filter((f) => f.side === 'buy').map((f) => [f.role, f.size, f.price]),
    [['take_profit', 40, 11], ['take_profit', 60, 11]],
  );
});
