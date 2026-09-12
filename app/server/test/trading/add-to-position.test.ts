import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rig, peProduct, planFor, quote, type Rig } from './harness.js';
import { TradeEngine, type AddRequest } from '../../src/trading/engine.js';

/**
 * Appending to an open position: more of the same contract, under the same trade.
 *
 * The strategy's add to the other leg ends here. What has to hold, whatever the
 * market does while the add is working:
 *
 *   - it is one trade: one position, one average, one target and one stop, the
 *     last two resized to cover every contract;
 *   - it sells at its minimum or better, never below;
 *   - it ends: filled, or cancelled when its window closes -- and a close of
 *     the position takes it off first, so nothing sells after the close;
 *   - the target is still the leg's own resting buy, filling when the ask comes
 *     down to it, at its own price.
 */

const PE = 'P-BTC-77000-080926';
const SOURCE = { tradeId: 'CE-1', optionSide: 'CE' as const, boughtBack: 425 };

/** 425 PE sold at 15, target 0.70, stop 45, and the book now 7 bid / 7.50 offered. */
async function shortPE(opts: { limits?: Parameters<typeof rig>[0] extends infer O ? O extends { limits?: infer L } ? L : never : never } = {}) {
  const r = rig({
    products: [peProduct()],
    quotes: [quote(PE, 15, 15.5)],
    limits: { maxShortContracts: 5_000, ...opts.limits },
  });
  const plan = planFor(peProduct(), {
    tradeId: 'PE-1', strategyId: 's', lots: 425, leverage: 200,
    stopPrice: 45, takeProfitPrice: 0.7,
    entry: { type: 'limit', limitPrice: 15, timeoutMs: 0, marketFallback: false, chase: null },
  });
  await r.engine.open(plan);
  await r.engine.poll(plan.tradeId);
  r.advance(60_000);
  r.ex.tick(quote(PE, 7, 7.5, { mark: 7.2, ts: r.now() }));
  return { r, plan };
}

const addOf = (over: Partial<AddRequest> = {}): AddRequest => ({
  size: 425, limitPrice: 7.5, chaseSeconds: 5, maxCrossSpreadPct: 0.15, floorPrice: 3,
  timeoutMs: 5 * 60_000, source: SOURCE, ...over,
});

/** Let the walk run, keeping the quote fresh, polling as the service does. */
async function walk(r: Rig, ms: number, bid = 7, ask = 7.5, engine: TradeEngine = r.engine) {
  for (let t = 0; t < ms; t += 1_250) {
    r.advance(1_250);
    r.ex.tick(quote(PE, bid, ask, { mark: (bid + ask) / 2, ts: r.now() }));
    await engine.poll('PE-1');
  }
  return r.store.get('PE-1')!.state;
}

const book = async (r: Rig) => (await r.ex.getOpenOrders(PE)).map((o) => ({
  type: o.type, side: o.side, left: o.size - o.filledSize, limit: o.limitPrice, stop: o.stopPrice, reduceOnly: Boolean(o.reduceOnly),
}));

test('[critical] an add appends to the same trade: one position, one average, one target and stop covering all of it', async () => {
  const { r } = await shortPE();
  const res = await r.engine.addToPosition('PE-1', addOf());
  assert.equal(res.ok, true, res.ok ? '' : res.reason);
  const s = await walk(r, 6_000);

  assert.equal(s.position, -850, '425 + 425');
  assert.equal(s.addedSize, 425);
  assert.equal(s.entryAvgPrice, 11, '(15 x 425 + 7 x 425) / 850');
  assert.equal(s.adding, null, 'the add is over');
  assert.equal(r.store.all().length, 1, 'still one trade on the contract');
  assert.deepEqual((await book(r)).sort((a, b) => a.type.localeCompare(b.type)), [
    { type: 'limit', side: 'buy', left: 850, limit: 0.7, stop: null, reduceOnly: true },
    // a stop limit: the trigger at 45, priced through it at 67.50 so it fills
    { type: 'stop_limit', side: 'buy', left: 850, limit: 67.5, stop: 45, reduceOnly: true },
  ], "the leg's own target and stop, resized to 850 -- at the same prices");
  assert.equal((await r.ex.getPositions()).find((p) => p.symbol === PE)?.size, -850, 'and the exchange agrees');
});

test('[critical] the target is still a resting buy at its own price: when the ask reaches 0.70 all 850 are bought back there', async () => {
  const { r } = await shortPE();
  await r.engine.addToPosition('PE-1', addOf());
  await walk(r, 6_000);
  r.ex.tick(quote(PE, 0.6, 0.7, { mark: 0.65, ts: r.now() }));
  const s = (await r.engine.poll('PE-1'))!;
  assert.equal(s.position, 0);
  assert.deepEqual(s.fills.filter((f) => f.side === 'buy').map((f) => [f.role, f.size, f.price]), [['take_profit', 850, 0.7]]);
  assert.ok(Math.abs(s.realisedPnl - (11 - 0.7) * 850 * 0.001) < 1e-9);
});

test('[critical] the add is never sold below its minimum, however far the bid falls', async () => {
  const { r } = await shortPE();
  await r.engine.addToPosition('PE-1', addOf());
  const s = await walk(r, 20_000, 2, 2.6);
  const [sell] = (await book(r)).filter((o) => o.side === 'sell');
  assert.equal(sell?.limit, 3, 'the walk stopped at the $3 minimum');
  assert.equal(s.position, -425, 'and nothing sold at 2');
  assert.equal(s.fills.filter((f) => f.role === 'entry' && f.price < 3).length, 0);
});

test('[critical] an add that does not fill in its window is cancelled, and the position is left as it was', async () => {
  const { r } = await shortPE();
  await r.engine.addToPosition('PE-1', addOf({ timeoutMs: 10_000 }));
  const s = await walk(r, 12_500, 2, 2.6);
  assert.equal(s.adding, null);
  assert.equal(s.position, -425);
  assert.deepEqual((await book(r)).filter((o) => o.side === 'sell'), [], 'no sell left on the book');
  assert.match(s.note ?? '', /add not filled: its window closed/);
});

test('an add that half fills keeps what filled, and the target and stop cover exactly that', async () => {
  const { r } = await shortPE();
  r.ex.configure({ partialFillSize: 100 });
  await r.engine.addToPosition('PE-1', addOf({ timeoutMs: 10_000 }));
  const s = await walk(r, 12_500);
  assert.equal(s.position, -525);
  assert.equal(s.addedSize, 100);
  assert.deepEqual((await book(r)).map((o) => o.left).sort(), [525, 525]);
});

test('[critical] Close now while an add is working takes the add off first: nothing sells after the close', async () => {
  const { r } = await shortPE();
  await r.engine.addToPosition('PE-1', addOf());      // resting at 7.50
  const closed = await r.engine.closeNow('PE-1');
  assert.equal(closed?.position, 0);
  assert.equal(closed?.adding, null);
  // a buyer arrives at 8: had the add been left on the book it would sell now
  r.ex.tick(quote(PE, 8, 8.5, { mark: 8.2, ts: r.now() }));
  await r.engine.poll('PE-1');
  assert.equal((await r.ex.getPositions()).find((p) => p.symbol === PE)?.size ?? 0, 0);
});

test('[critical] the desk\'s stop watch covers the added contracts too', async () => {
  const { r } = await shortPE();
  await r.engine.addToPosition('PE-1', addOf());
  await walk(r, 6_000);
  r.ex.tick(quote(PE, 46, 47, { mark: 46.5, ts: r.now() }));
  const s = (await r.engine.poll('PE-1'))!;
  assert.equal(s.position, 0, 'all 850 closed');
});

test('[critical] one add at a time: a second while the first works is refused', async () => {
  const { r } = await shortPE();
  assert.equal((await r.engine.addToPosition('PE-1', addOf())).ok, true);
  const second = await r.engine.addToPosition('PE-1', addOf({ size: 3 }));
  assert.equal(second.ok, false);
  if (!second.ok) assert.match(second.reason, /already working/);
});

test('[critical] not while the entry is still working', async () => {
  const r = rig({ products: [peProduct()], quotes: [quote(PE, 15, 15.5)], limits: { maxShortContracts: 5_000 } });
  r.ex.configure({ partialFillSize: 200 });
  await r.engine.open(planFor(peProduct(), {
    tradeId: 'PE-1', lots: 425, stopPrice: null, takeProfitPrice: 0.7,
    entry: { type: 'limit', limitPrice: 15, timeoutMs: 0, marketFallback: false, chase: null },
  }));
  await r.engine.poll('PE-1');
  const res = await r.engine.addToPosition('PE-1', addOf({ limitPrice: 15 }));
  assert.equal(res.ok, false);
  if (!res.ok) assert.match(res.reason, /entry is still working/);
});

test('[critical] the gates still apply: an add past the short limit is refused, and nothing is sent', async () => {
  const { r } = await shortPE({ limits: { maxShortContracts: 500 } });
  const res = await r.engine.addToPosition('PE-1', addOf());
  assert.equal(res.ok, false);
  if (!res.ok) assert.match(res.reason, /limit is 500/);
  assert.deepEqual((await book(r)).filter((o) => o.side === 'sell'), []);
  assert.equal(r.store.get('PE-1')!.state.position, -425);
});

test('the add\'s own minimum stands in for the desk\'s $5 premium floor -- and only for the add', async () => {
  const { r } = await shortPE();
  r.ex.tick(quote(PE, 3.8, 4, { mark: 3.9, ts: r.now() }));
  const res = await r.engine.addToPosition('PE-1', addOf({ limitPrice: 4 }));
  assert.equal(res.ok, true, res.ok ? '' : res.reason);
  // an ordinary entry at 4 on another trade is still refused by the desk floor
  const other = await r.engine.open(planFor(peProduct(), {
    tradeId: 'PE-2', lots: 1, stopPrice: null, takeProfitPrice: null,
    entry: { type: 'limit', limitPrice: 4, timeoutMs: 0, marketFallback: false, chase: null },
  }));
  assert.equal(other.ok, false);
});

test('[critical] Delta refusing the add does not end the trade that was already open', async () => {
  const { r } = await shortPE();
  r.ex.configure({ nextFault: { kind: 'reject', reason: 'insufficient_margin' } });
  const res = await r.engine.addToPosition('PE-1', addOf());
  assert.equal(res.ok, false);
  const s = r.store.get('PE-1')!.state;
  assert.equal(s.phase, 'protected', 'not aborted, not rejected');
  assert.equal(s.position, -425);
  assert.equal(s.adding, null);
});

test('[critical] an add with no answer is looked for, never sent twice -- and its fills still count', async () => {
  const { r } = await shortPE();
  r.ex.configure({ nextFault: { kind: 'submit_timeout', landed: true } });
  const res = await r.engine.addToPosition('PE-1', addOf());
  assert.equal(res.ok, true);
  assert.equal(r.store.get('PE-1')!.state.adding?.unknown, true);
  const s = await walk(r, 6_000);
  assert.equal(s.position, -850);
  assert.equal((await r.ex.getOpenOrders(PE)).filter((o) => o.side === 'sell').length, 0, 'one add order, filled');
});

test('an add with no answer that never landed is given up at the end of its window', async () => {
  const { r } = await shortPE();
  r.ex.configure({ nextFault: { kind: 'submit_timeout', landed: false } });
  await r.engine.addToPosition('PE-1', addOf({ timeoutMs: 5_000 }));
  const s = await walk(r, 6_250);
  assert.equal(s.adding, null);
  assert.equal(s.position, -425);
  assert.match(s.note ?? '', /never reached the exchange/);
});

test('[critical] a restart in the middle of an add picks it up from the journal and finishes it', async () => {
  const { r } = await shortPE();
  await r.engine.addToPosition('PE-1', addOf());
  // a new engine on the same journal and the same exchange: the process restarted
  const fresh = new TradeEngine({
    exchange: r.ex, store: r.store, now: r.now, feedHealthy: () => true, spot: () => 80_000,
  });
  const s = await walk(r, 6_000, 7, 7.5, fresh);
  assert.equal(s.position, -850);
  assert.equal(s.adding, null);
});

test('nothing to add to once the position is flat', async () => {
  const { r } = await shortPE();
  await r.engine.closeNow('PE-1');
  const res = await r.engine.addToPosition('PE-1', addOf());
  assert.equal(res.ok, false);
});
