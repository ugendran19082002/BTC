import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { tradeView } from '../../src/http/routes/trade.routes.js';
import { closePool } from '../../src/db/pool.js';
import { rig, ceProduct, planFor, quote } from '../trading/harness.js';

after(closePool);

/**
 * What the position card is told, for one trade.
 *
 * 30 Sep 2026, two fixes. "If closed now" was priced at the mark, a price no
 * close prints: buying a short back pays the offer, which is what the close
 * sheet has always used. And the P&L was sized from Delta's row for the
 * contract, which with two strategies on one strike (decision 0011) is both
 * trades' contracts, not this one's.
 */

const CE = ceProduct().symbol;

async function shortAt(entry: number) {
  const r = rig({ quotes: [quote(CE, entry, entry + 0.5)] });
  const plan = planFor(ceProduct(), {
    lots: 100, stopPrice: null, takeProfitPrice: null,
    entry: { type: 'limit', limitPrice: entry, timeoutMs: 0, marketFallback: false, chase: null },
  });
  await r.engine.open(plan);
  await r.engine.poll(plan.tradeId);
  return r.store.peek(plan.tradeId)!;
}

test('[critical] "If closed now" buys back at the offer, not the mark', async () => {
  const rec = await shortAt(20);
  const q = quote(CE, 9, 11, { mark: 10 });
  const v = tradeView(rec, [], 0.001, q, 80_000);
  const atAsk = tradeView(rec, [], 0.001, { ...q, mark: 11 }, 80_000);
  assert.equal(v.live.netIfClosedUsd, atAsk.live.netIfClosedUsd, 'the same whatever the mark says: it is the ask');
  assert.ok(v.live.netIfClosedUsd! < v.live.unrealisedPnl!, 'paying the offer is worse than the mark says');
});

test('with no offer on the book it falls back to the mark, rather than a blank', async () => {
  const rec = await shortAt(20);
  const v = tradeView(rec, [], 0.001, quote(CE, 9, 0, { mark: 10, ask: null as unknown as number }), 80_000);
  assert.notEqual(v.live.netIfClosedUsd, null);
});

test('[critical] the P&L is this trade\'s own contracts, not Delta\'s row for the whole contract', async () => {
  const rec = await shortAt(20);
  const alone = tradeView(rec, [{ symbol: CE, size: -100, entryPrice: 20 } as never], 0.001, quote(CE, 9, 11, { mark: 10 }), 80_000);
  const shared = tradeView(rec, [{ symbol: CE, size: -200, entryPrice: 20 } as never], 0.001, quote(CE, 9, 11, { mark: 10 }), 80_000);
  assert.equal(shared.live.unrealisedPnl, alone.live.unrealisedPnl, 'another strategy\'s 100 on the same strike is not this card\'s');
  assert.equal(alone.live.unrealisedPnl, (20 - 10) * 100 * 0.001);
});

test('[critical] two trades on one contract: each card shows its own target and stop -- a trade with no stop shows none', async () => {
  // 2 Oct 2026: three signal trades on the 86,000 PE; one stop of 183.40 on the book, and every card said "Stop 183.40".
  const withStop = await shortAt(38.1);
  const noStop = { ...withStop, state: { ...withStop.state, tradeId: 'b', protection: { takeProfit: 'b-tp', stopLoss: null } } };
  const a = { ...withStop, state: { ...withStop.state, protection: { takeProfit: 'a-tp', stopLoss: 'a-sl' } } };
  const order = (id: string, type: 'limit' | 'stop_limit', at: number) => ({
    orderId: id, clientOrderId: id, symbol: CE, productId: 1, side: 'buy' as const, type, size: 2, filledSize: 0, averageFillPrice: null,
    limitPrice: type === 'limit' ? at : at + 20, stopPrice: type === 'limit' ? null : at, status: 'open' as const, reduceOnly: true, createdAt: 0, updatedAt: 0,
  });
  const book = [order('a-sl', 'stop_limit', 183.4), order('a-tp', 'limit', 1.9), order('b-tp', 'limit', 2.5)];
  const va = tradeView(a, [], 0.001, quote(CE, 20, 30), 86_000, book);
  const vb = tradeView(noStop, [], 0.001, quote(CE, 20, 30), 86_000, book);
  assert.deepEqual(va.onBook, { target: 1.9, stop: 183.4 });
  assert.deepEqual(vb.onBook, { target: 2.5, stop: null }, "B's own target, and no stop -- not A's 183.40");
  assert.equal(vb.ifExits!.stop, null);
  // an order nobody owns (placed by hand) is still read as the trade's, as the engine reads it
  const hand = { ...order('x', 'stop_limit', 150), clientOrderId: null };
  assert.equal(tradeView(noStop, [], 0.001, quote(CE, 20, 30), 86_000, [hand]).onBook!.stop, 150);
});

test('[critical] a perp SL close is named as one -- not "manual", though the desk closes at market -- from the state or the journal', async () => {
  const rec = await shortAt(38.1);
  const closed = (state: object, events: unknown[] = []) => ({
    ...rec,
    state: { ...rec.state, position: 0, exitSize: rec.state.entrySize, exitWinner: 'manual', ...state },
    events: [...rec.events, ...events],
  }) as typeof rec;
  const why = "BTC perp at 86,010.00 reached the signal's stop 86,019.00";
  assert.equal(tradeView(closed({ exitReason: why })).exitBy, 'perp-sl', 'from the state');
  // a trade closed before the state kept the reason: the journal still has it
  const old = tradeView(closed({ exitReason: undefined }, [{ t: 'exit_submitted', clientOrderId: 'x', reason: why, at: 1 }]));
  assert.equal(old.exitBy, 'perp-sl');
  assert.equal(old.exitReason, why);
  assert.equal(tradeView(closed({ exitReason: 'manual exit' })).exitBy, 'manual', 'a close by hand is still one');
  assert.equal(tradeView(closed({ exitReason: null, exitWinner: 'take_profit' })).exitBy, 'option-tgt');
  assert.equal(tradeView(rec).exitBy, null, 'open: no exit yet');
});

test('[critical] a target Delta would not take is said, with why -- until one is placed', async () => {
  const rec = await shortAt(38.1);
  const failed = { ...rec, events: [...rec.events, { t: 'protection_failed', reason: 'take_profit: reduce only order would exceed position', at: 2 }] } as typeof rec;
  assert.equal(tradeView(failed).protectionProblem, 'take_profit: reduce only order would exceed position');
  const placedSince = { ...failed, events: [...failed.events, { t: 'protection_placed', takeProfit: 'x', stopLoss: null, size: 2, at: 3 }] } as typeof rec;
  assert.equal(tradeView(placedSince).protectionProblem, null, 'placed since: no problem now');
});

test('[critical] a bought position\'s card is told its own exits and its account, and is priced at the bid', async () => {
  const r = rig({ quotes: [quote(CE, 39.5, 40)] });
  const plan = planFor(ceProduct(), {
    lots: 1, action: 'buy', accountId: 2, stopPrice: null, takeProfitPrice: null,
    entry: { type: 'limit', limitPrice: 40, timeoutMs: 0, marketFallback: false, chase: null },
    longExits: { target: { mode: 'pct', value: 3.5 }, stop: { mode: 'pct', value: 0.5 } },
  });
  await r.engine.open(plan);
  await r.engine.poll(plan.tradeId);
  const rec = r.store.peek(plan.tradeId)!;
  assert.equal(rec.state.position, 1, 'long 1');
  const resting = await r.ex.getOpenOrders(CE);
  const q = quote(CE, 44, 46, { mark: 45 });
  const v = tradeView(rec, resting, 0.001, q, 80_000);
  // Without these the Edit exits form opened with the target unticked, and saving it took the target off.
  assert.deepEqual(v.plan.longExits, { target: { mode: 'pct', value: 3.5 }, stop: { mode: 'pct', value: 0.5 } });
  assert.equal(v.plan.accountId, 2);
  assert.equal(v.plan.action, 'buy');
  assert.equal(v.onBook?.target, 180, 'the sale resting at 350% over the 40 paid');
  // A bought position is sold at the bid: the same whatever the offer or the mark says.
  const other = tradeView(rec, resting, 0.001, { ...q, ask: 60, mark: 50 }, 80_000);
  assert.equal(v.live.netIfClosedUsd, other.live.netIfClosedUsd);
  // A short's card says neither.
  const short = tradeView(await shortAt(20), [], 0.001, quote(CE, 9, 11, { mark: 10 }), 80_000);
  assert.deepEqual([short.plan.longExits, short.plan.accountId], [null, null]);
});
