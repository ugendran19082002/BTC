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

/** The rig, with every leverage call and every order written down in the order they reached the exchange. */
function counted() {
  const r = rig({ products: [peProduct(), ceProduct()], quotes: [quote(PE, 100.5, 101), quote(CE, 100.5, 101)] });
  const log: string[] = [];
  const realLev = r.ex.setLeverage.bind(r.ex);
  const realOrder = r.ex.placeOrder.bind(r.ex);
  let failLeverage = false;
  r.ex.setLeverage = async (productId: number, leverage: number) => {
    log.push(`lev ${productId}@${leverage}`);
    if (failLeverage) throw new Error('leverage refused');
    return realLev(productId, leverage);
  };
  r.ex.placeOrder = async (req: Parameters<typeof realOrder>[0]) => { if (req.role === 'entry') log.push('order'); return realOrder(req); };
  return { r, log, failLeverage: (on: boolean) => { failLeverage = on; } };
}
const settle = () => new Promise((r) => setImmediate(r));
const signal = (i: number): TradePlan['signal'] => ({ method: 'bos', n: 6, name: 'BOS', mode: 'single', tf: '5m', dir: 1, triggerTime: 1_700_000_000 + i * 300 });
const put = (i: number, over: Partial<TradePlan> = {}): TradePlan =>
  ({ ...planFor(peProduct(), { lots: 2, stopPrice: 300, takeProfitPrice: 1 }), tradeId: `put-${i}`, signal: signal(i), ...over });
const PID = peProduct().productId;
const lev = (n: number, id = PID) => `lev ${id}@${n}`;

// ------------------------------------------------------------- the leverage

test('[critical] the first entry on a product sets the leverage in front of its order; the ones after it go straight to the order', async () => {
  const { r, log } = counted();
  for (const i of [1, 2, 3]) { assert.equal((await r.engine.open(put(i))).ok, true); await settle(); }
  assert.deepEqual(log.slice(0, 3), [lev(10), 'order', 'order'], 'the second order did not wait for a leverage call');
  for (const i of [1, 2, 3]) assert.equal(r.store.peek(`put-${i}`)!.events.some((e) => e.t === 'entry_submitted'), true, 'each order went');
});

test('[critical] the fallback: an entry that went on a remembered leverage has it set again behind the order -- never in front', async () => {
  const { r, log } = counted();
  for (const i of [1, 2, 3]) { await r.engine.open(put(i)); await settle(); }
  // 1: set, then the order. 2 and 3: the order first, then the leverage set again behind it.
  assert.deepEqual(log, [lev(10), 'order', 'order', lev(10), 'order', lev(10)]);
});

test('[critical] another product, another leverage, or ten minutes on: set in front of the order again', async () => {
  const { r, log } = counted();
  await r.engine.open(put(1)); await settle();
  const call = ceProduct();
  await r.engine.open({ ...planFor(call, { lots: 2, stopPrice: 300, takeProfitPrice: 1 }), tradeId: 'call-1' }); await settle();
  assert.deepEqual(log.slice(-2), [lev(10, call.productId), 'order'], 'the call is another product');
  await r.engine.open(put(2, { leverage: 20 })); await settle();
  assert.deepEqual(log.slice(-2), [lev(20), 'order'], 'a different leverage is set first');
  r.advance(LEVERAGE_HELD_MS + 1);
  r.ex.tick(quote(PE, 100.5, 101, { ts: r.now() }));   // a fresh book: the gates read it before the leverage is asked for
  assert.equal((await r.engine.open(put(3, { leverage: 20 }))).ok, true); await settle();
  assert.deepEqual(log.slice(-2), [lev(20), 'order'], 'after ten minutes it is not taken on trust');
});

test('[critical] Delta refusing the leverage: in front of the order the entry is refused; behind it the memory is dropped and the next entry asks first', async () => {
  const { r, log, failLeverage } = counted();
  failLeverage(true);
  const refused = await r.engine.open(put(1));
  assert.equal(refused.ok, false, 'no leverage, no order');
  assert.match(r.store.peek('put-1')!.state.note ?? '', /could not set 10x leverage/);
  assert.equal(log.includes('order'), false);

  failLeverage(false);
  assert.equal((await r.engine.open(put(2))).ok, true); await settle();     // sets it, and remembers
  failLeverage(true);
  assert.equal((await r.engine.open(put(3))).ok, true, 'went on the remembered leverage'); await settle();
  assert.deepEqual(log.slice(-2), ['order', lev(10)], 'and the set behind it was refused');
  assert.ok(r.swallowed.some((x) => x.what === 'leverage' && /leverage refused/.test(x.message)), 'which is written down, not lost');
  const n = log.length;
  const next = await r.engine.open(put(4));
  assert.equal(next.ok, false, 'so the next entry asks first, and is refused in the open');
  assert.deepEqual(log.slice(n), [lev(10)], 'in front of the order, which is never sent');
});

test('[critical] warming a contract sets its leverage and sends no order; the entry that follows goes straight to the order', async () => {
  const { r, log } = counted();
  assert.equal(await r.engine.warm(PE, 10), true);
  assert.deepEqual(log, [lev(10)]);
  assert.equal((await r.ex.getOpenOrders(PE)).length, 0, 'nothing on the book');
  assert.equal((await r.store.all()).length, 0, 'and no trade');
  assert.equal((await r.engine.open(put(1))).ok, true); await settle();
  assert.deepEqual(log.slice(1, 2), ['order'], 'the entry did not ask first');
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
