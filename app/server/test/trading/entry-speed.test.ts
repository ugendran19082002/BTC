import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rig, peProduct, ceProduct, planFor, quote } from './harness.js';
import { LEVERAGE_HELD_MS, type TradePlan } from '../../src/trading/engine.js';
import { ENTRY_WATCH_PER_LOOK, ENTRY_WATCH_QUOTA_PCT, EntryWatch, isUrgent } from '../../src/trading/entry-watch.js';
import { FlowSocket } from '../../src/market/flow-socket.js';

/**
 * Speed on the entry path (4 Oct 2026): the leverage is not asked for again
 * when the desk set it a moment ago, a contract can be made ready before its
 * order is due, a working entry is polled on its own, and the perp's own
 * prints are what the watchers act on. None of it changes what is traded.
 */

const PE = peProduct().symbol;
const CE = ceProduct().symbol;

/** The rig, with every leverage call to the exchange counted. */
function counted() {
  const r = rig({ products: [peProduct(), ceProduct()], quotes: [quote(PE, 100.5, 101), quote(CE, 100.5, 101)] });
  const calls: [number, number][] = [];
  const real = r.ex.setLeverage.bind(r.ex);
  r.ex.setLeverage = async (productId: number, leverage: number) => { calls.push([productId, leverage]); return real(productId, leverage); };
  return { r, calls };
}
const signal = (i: number): TradePlan['signal'] => ({ method: 'bos', n: 6, name: 'BOS', mode: 'single', tf: '5m', dir: 1, triggerTime: 1_700_000_000 + i * 300 });
const put = (i: number, over: Partial<TradePlan> = {}): TradePlan =>
  ({ ...planFor(peProduct(), { lots: 2, stopPrice: 300, takeProfitPrice: 1 }), tradeId: `put-${i}`, signal: signal(i), ...over });

// ------------------------------------------------------------- the leverage

test('[critical] the leverage is set once for a product, not before every entry -- and every entry still goes at it', async () => {
  const { r, calls } = counted();
  for (const i of [1, 2, 3]) assert.equal((await r.engine.open(put(i))).ok, true);
  assert.equal(calls.length, 1, 'three entries on one contract: one leverage call');
  assert.equal(calls[0]![1], 10, 'at the plan\'s leverage');
  for (const i of [1, 2, 3]) {
    const sent = r.store.peek(`put-${i}`)!.events.some((e) => e.t === 'entry_submitted');
    assert.equal(sent, true, 'each order went');
  }
});

test('[critical] another product, another leverage, or ten minutes on: asked again', async () => {
  const { r, calls } = counted();
  await r.engine.open(put(1));
  await r.engine.open({ ...planFor(ceProduct(), { lots: 2, stopPrice: 300, takeProfitPrice: 1 }), tradeId: 'call-1' });
  assert.equal(calls.length, 2, 'the call is another product');
  await r.engine.open(put(2, { leverage: 20 }));
  assert.equal(calls.length, 3, 'a different leverage is set');
  assert.equal(calls[2]![1], 20);
  await r.engine.open(put(3, { leverage: 20 }));
  assert.equal(calls.length, 3, 'the same again is not');
  r.advance(LEVERAGE_HELD_MS + 1);
  r.ex.tick(quote(PE, 100.5, 101, { ts: r.now() }));   // a fresh book: the gates read it before the leverage is asked for
  assert.equal((await r.engine.open(put(4, { leverage: 20 }))).ok, true);
  assert.equal(calls.length, 4, 'after ten minutes it is not taken on trust');
});

test('[critical] a leverage call that fails is not remembered: the entry is refused, and the next one asks again', async () => {
  const { r, calls } = counted();
  let fail = true;
  const counting = r.ex.setLeverage.bind(r.ex);
  r.ex.setLeverage = async (productId: number, leverage: number) => { if (fail) { calls.push([productId, leverage]); throw new Error('leverage refused'); } return counting(productId, leverage); };
  const refused = await r.engine.open(put(1));
  assert.equal(refused.ok, false);
  assert.match(r.store.peek('put-1')!.state.note ?? '', /could not set 10x leverage/);
  fail = false;
  assert.equal((await r.engine.open(put(2))).ok, true);
  assert.equal(calls.length, 2, 'asked again, not assumed');
});

test('[critical] warming a contract sets its leverage and sends no order; the entry that follows goes straight to the order', async () => {
  const { r, calls } = counted();
  assert.equal(await r.engine.warm(PE, 10), true);
  assert.equal(calls.length, 1);
  assert.equal((await r.ex.getOpenOrders(PE)).length, 0, 'nothing on the book');
  assert.equal((await r.store.all()).length, 0, 'and no trade');
  assert.equal((await r.engine.open(put(1))).ok, true);
  assert.equal(calls.length, 1, 'the entry did not ask again');
  assert.equal(await r.engine.warm('P-BTC-1-000000', 10), false, 'a contract that is not listed is only not warmed');
});

// ---------------------------------------------------------- the urgent trades

const rec = (tradeId: string, phase: string) => ({ state: { tradeId, phase } }) as never;

test('[critical] urgent is a working entry or a position without its target; a protected trade is the loop\'s', () => {
  assert.deepEqual(['entry_pending', 'position_open', 'unprotected', 'protected', 'exit_pending', 'flat', 'entry_unknown'].map((p) => isUrgent(rec('t', p))),
    [true, true, true, false, false, false, false]);
});

function urgent(phases: Record<string, string>, quota = 0) {
  const polls: string[] = [];
  const settled: string[] = [];
  const w = new EntryWatch({
    poll: async (id) => { polls.push(id); return { phase: phases[id] ?? 'flat' }; },
    quotaUsedPct: () => quota,
    onSettled: (id) => settled.push(id),
  });
  return { w, polls, settled };
}
const turn = () => new Promise((r) => setImmediate(r));

test('[critical] a working entry is polled on every look until it is filled and protected, then left to the loop', async () => {
  const phases: Record<string, string> = { a: 'entry_pending' };
  const { w, polls, settled } = urgent(phases);
  w.add('a');
  for (let i = 0; i < 3; i++) { assert.deepEqual(w.tick(), ['a']); await turn(); }
  assert.equal(polls.length, 3);
  phases.a = 'position_open';                     // filled: still urgent until its target rests
  w.tick(); await turn();
  assert.equal(w.size, 1);
  phases.a = 'protected';
  w.tick(); await turn();
  assert.equal(w.size, 0, 'protected: off the list');
  assert.deepEqual(settled, ['a'], 'and whoever watches its exits is told, once');
  assert.deepEqual(w.tick(), [], 'nothing left to look at');
});

test('[critical] at most two a look, in turn, never the same trade twice at once -- and none at all past half of Delta\'s quota', async () => {
  const phases = { a: 'entry_pending', b: 'entry_pending', c: 'entry_pending' };
  const { w, polls } = urgent(phases);
  w.note([rec('a', 'entry_pending'), rec('b', 'entry_pending'), rec('c', 'entry_pending'), rec('d', 'protected')]);
  assert.equal(w.size, 3, 'the protected one is not on the list');
  assert.equal(w.tick().length, ENTRY_WATCH_PER_LOOK);
  await turn();
  w.tick(); await turn();
  assert.deepEqual([...new Set(polls)].sort(), ['a', 'b', 'c'], 'all three had their turn inside two looks');

  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const slow = new EntryWatch({ poll: async () => { await gate; return { phase: 'entry_pending' }; }, quotaUsedPct: () => 0 });
  slow.add('x');
  assert.deepEqual(slow.tick(), ['x']);
  assert.deepEqual(slow.tick(), [], 'still being polled: not asked for again');
  release();

  const { w: held, polls: none } = urgent(phases, ENTRY_WATCH_QUOTA_PCT);
  held.add('a');
  assert.deepEqual(held.tick(), []);
  assert.equal(none.length, 0, 'the quota comes first; the loop still polls it');
});

test('a poll that throws, or a quota that cannot be read, stops nothing', async () => {
  const w = new EntryWatch({ poll: async () => { throw new Error('exchange down'); }, quotaUsedPct: () => { throw new Error('no gauge'); } });
  w.add('a');
  assert.deepEqual(w.tick(), ['a']);
  await turn();
  assert.deepEqual(w.tick(), ['a'], 'tried again on the next look');
});

// ------------------------------------------------------- the perp, as it prints

test('[critical] every print of the perp tells the listener as it arrives; an option\'s print and a repeat do not', () => {
  let told = 0;
  const T0 = Date.UTC(2026, 9, 4, 6, 0, 0);
  const s = new FlowSocket({ now: () => T0, onPerp: () => { told++; } });
  const print = (symbol: string, at: number, price = 85_000) => s.receive(JSON.stringify({ type: 'all_trades', symbol, price: String(price), size: 5, timestamp: at * 1000, buyer_role: 'taker', seller_role: 'maker' }));
  print('BTCUSD', T0 - 2_000);
  print('BTCUSD', T0 - 1_000, 85_010);
  assert.equal(told, 2);
  print('BTCUSD', T0 - 1_000, 85_010);
  assert.equal(told, 2, 'the same print again is not news');
  const before = told;
  print('C-BTC-86000-051026', T0 - 500);
  assert.equal(told, before, 'an option trading is not the perp moving');
  // A listener that throws must not stop the tape taking prints.
  const bad = new FlowSocket({ now: () => T0, onPerp: () => { throw new Error('listener'); } });
  bad.receive(JSON.stringify({ type: 'all_trades', symbol: 'BTCUSD', price: '85000', size: 1, timestamp: (T0 - 100) * 1000, buyer_role: 'taker', seller_role: 'maker' }));
  assert.equal(bad.lastPerpPrint()?.price, 85_000);
});
