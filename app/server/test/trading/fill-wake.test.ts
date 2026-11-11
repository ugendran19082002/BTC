import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rig, peProduct, planFor, quote, T0 } from './harness.js';
import { clientId, type TradePlan } from '../../src/trading/engine.js';
import {
  FILL_WAKE_IN_FLIGHT, FILL_WAKE_MAX, FILL_WAKE_PER_LOOK, FILL_WAKE_QUOTA_PCT, FILL_WAKE_RETRY_MS, FILL_WAKE_STALE_MS,
  FillWake, type HeardOrder,
} from '../../src/trading/fill-wake.js';
import { QUOTA_LADDER } from '../../src/observability/desk-metrics.js';
import type { Fill, TradePhase } from '../../src/trading/types.js';

/**
 * A fill heard on Delta's private socket wakes its trade's poll (trading/fill-wake.ts, 11 Nov 2026). First the wake on
 * its own, with a poll the test answers for and a clock it turns; then on the engine, with the paper venue as Delta:
 * an entry filled there has its stop and target put on by the wake alone, and a target filled there has its stop taken
 * off -- no loop pass, no entry watch.
 */

const PE = peProduct().symbol;
/** A trade id as the desk makes them: the contract and the moment (`${symbol}-${ms}`), which its client ids carry. */
const tid = (n: number) => `${PE}-${T0 + n}`;
const heard = (tradeId: string, orderId: string, over: Partial<HeardOrder> = {}): HeardOrder =>
  ({ kind: 'fill', symbol: PE, orderId, clientOrderId: clientId(tradeId, 'entry'), heardAt: T0, ...over });
const fill = (orderId: string): Fill => ({ orderId, role: 'entry', side: 'sell', size: 1, price: 100, ts: T0 });
const turn = () => new Promise((r) => setImmediate(r));

/** The wake over a poll the test answers: `states[tradeId]` is what the trade shows after its poll. */
function wake(o: { quota?: () => number } = {}) {
  let t = T0;
  const states: Record<string, { phase: TradePhase; fills: Fill[] } | null> = {};
  const polls: string[] = [];
  const settled: string[] = [];
  const w = new FillWake({
    poll: async (id) => { polls.push(id); const s = states[id]; if (s === undefined) throw new Error(`no answer for ${id}`); return s; },
    quotaUsedPct: o.quota ?? (() => 0),
    onSettled: (id) => settled.push(id),
    now: () => t,
  });
  return { w, states, polls, settled, advance: (ms: number) => { t += ms; } };
}

// ------------------------------------------------------------------ whose it is

test('[critical] only the desk\'s own orders wake anything: the client id names the trade, on its own contract', () => {
  const { w } = wake();
  assert.equal(w.hear(heard(tid(1), '9001')), true);
  assert.equal(w.size, 1);
  assert.equal(w.hear(heard(tid(2), '9002', { clientOrderId: null })), false, 'placed outside the desk (the Delta app): no client id');
  assert.equal(w.hear(heard(tid(3), '9003', { clientOrderId: 'my-own-order-7' })), false, 'a client id that is not ours');
  assert.equal(w.hear(heard(tid(4), '9004', { symbol: 'P-BTC-77000-090926' })), false, 'our id, but on another expiry: not that trade');
  assert.equal(w.size, 1);
  assert.equal(w.counts.notOurs, 3);
});

test('[critical] an id read onto the wrong contract of the same expiry names a trade that is not there: its poll finds nothing, and it is dropped', async () => {
  const { w, states, settled } = wake();
  // The client id carries the expiry's last five and the moment; on another strike that is another trade id.
  const elsewhere = `C-BTC-81000-080926-${T0 + 4}`;
  states[elsewhere] = null;                          // the desk's store has no such trade
  assert.equal(w.hear(heard(tid(4), '9004', { symbol: 'C-BTC-81000-080926' })), true);
  w.tick(); await turn();
  assert.equal(w.size, 0);
  assert.equal(w.counts.unknown, 1);
  assert.deepEqual(settled, [], 'nothing was done for it');
});

// ------------------------------------------------------------------ the poll

test('[critical] a fill heard is polled on the next look, and settles once the trade shows it', async () => {
  const { w, states, polls, settled } = wake();
  states[tid(1)] = { phase: 'protected', fills: [fill('9001')] };
  w.hear(heard(tid(1), '9001'));
  assert.deepEqual(w.tick(), [tid(1)]);
  await turn();
  assert.deepEqual(polls, [tid(1)]);
  assert.deepEqual(settled, [tid(1)], 'its watches told to read it again');
  assert.equal(w.size, 0);
  assert.equal(w.counts.firstPoll, 1);
  assert.deepEqual(w.tick(), [], 'nothing left');
});

test('[critical] Delta not showing the fill yet: polled again, later each time, until it does', async () => {
  const { w, states, polls, advance } = wake();
  states[tid(1)] = { phase: 'entry_pending', fills: [] };
  w.hear(heard(tid(1), '9001'));
  w.tick(); await turn();
  assert.equal(w.size, 1, 'still waiting: the fill is not on the trade');
  assert.deepEqual(w.tick(), [], 'not before its retry is due');
  advance(FILL_WAKE_RETRY_MS[0] - 1);
  assert.deepEqual(w.tick(), []);
  advance(1);
  states[tid(1)] = { phase: 'protected', fills: [fill('9001')] };
  assert.deepEqual(w.tick(), [tid(1)]);
  await turn();
  assert.equal(w.size, 0);
  assert.equal(polls.length, 2);
  assert.equal(w.counts.retries, 1);
  assert.equal(w.counts.firstPoll, 0, 'it took a retry');
});

test('[critical] a fill never shown after every retry is left to the loop -- polled no more by the wake', async () => {
  const { w, states, polls, advance } = wake();
  states[tid(1)] = { phase: 'entry_pending', fills: [] };
  w.hear(heard(tid(1), '9001'));
  w.tick(); await turn();
  for (const ms of FILL_WAKE_RETRY_MS) { advance(ms); assert.deepEqual(w.tick(), [tid(1)]); await turn(); }
  assert.equal(w.size, 0);
  assert.equal(polls.length, 1 + FILL_WAKE_RETRY_MS.length);
  assert.equal(w.counts.unconfirmed, 1);
});

test('a trade already over settles the wake whatever it shows; a cancel is answered by one poll; no such trade is dropped', async () => {
  const { w, states } = wake();
  states[tid(1)] = { phase: 'flat', fills: [] };
  states[tid(2)] = { phase: 'protected', fills: [] };
  states[tid(3)] = null;
  w.hear(heard(tid(1), '9001'));
  w.hear(heard(tid(2), '9002', { kind: 'cancelled', clientOrderId: clientId(tid(2), 'stop_loss') }));
  w.tick(); await turn();
  w.hear(heard(tid(3), '9003'));
  w.tick(); await turn();
  assert.equal(w.size, 0);
  assert.equal(w.counts.settled, 2);
  assert.equal(w.counts.unknown, 1, 'another account\'s, or gone: the desk\'s store does not have it');
});

test('[critical] two fills on one trade are one wake, settled only when both are on it', async () => {
  const { w, states, polls, advance } = wake();
  w.hear(heard(tid(1), '9001'));
  w.hear(heard(tid(1), '9002', { clientOrderId: clientId(tid(1), 'take_profit') }));
  assert.equal(w.size, 1);
  assert.equal(w.counts.merged, 1);
  states[tid(1)] = { phase: 'protected', fills: [fill('9001')] };
  w.tick(); await turn();
  assert.equal(w.size, 1, 'the target\'s fill is not on it yet');
  advance(FILL_WAKE_RETRY_MS[0]);
  states[tid(1)] = { phase: 'flat', fills: [fill('9001'), fill('9002')] };
  w.tick(); await turn();
  assert.equal(w.size, 0);
  assert.equal(polls.length, 2);
});

test('[critical] a fill heard while its trade\'s poll is running is asked about again at once, not left for the retries', async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  let answer = { phase: 'protected' as TradePhase, fills: [fill('9001')] };
  const polls: string[] = [];
  const w = new FillWake({ poll: async (id) => { polls.push(id); await gate; return answer; }, quotaUsedPct: () => 0, now: () => T0 });
  w.hear(heard(tid(1), '9001'));
  assert.deepEqual(w.tick(), [tid(1)]);
  assert.deepEqual(w.tick(), [], 'never two polls of one trade at once');
  w.hear(heard(tid(1), '9002', { clientOrderId: clientId(tid(1), 'take_profit') }));
  release(); await turn(); await turn();
  assert.equal(w.size, 1, 'the poll answered for 9001 only');
  answer = { phase: 'flat', fills: [fill('9001'), fill('9002')] };
  assert.deepEqual(w.tick(), [tid(1)], 'due now, with no retry wait');
  await turn(); await turn();
  assert.equal(w.size, 0);
  assert.equal(polls.length, 2);
});

// ------------------------------------------------------------------ the limits

test('[critical] the quota: the wakes stand aside at the target\'s line -- after the entry watch, before every stop', async () => {
  assert.equal(FILL_WAKE_QUOTA_PCT, QUOTA_LADDER.target);
  assert.ok(FILL_WAKE_QUOTA_PCT > QUOTA_LADDER.others && FILL_WAKE_QUOTA_PCT < QUOTA_LADDER.stop, 'stops are never kept waiting by a wake');
  let used = FILL_WAKE_QUOTA_PCT;
  const { w, states, polls } = wake({ quota: () => used });
  states[tid(1)] = { phase: 'protected', fills: [fill('9001')] };
  w.hear(heard(tid(1), '9001'));
  assert.deepEqual(w.tick(), []);
  assert.equal(polls.length, 0);
  assert.equal(w.counts.quotaWaits, 1);
  used = FILL_WAKE_QUOTA_PCT - 1;
  assert.deepEqual(w.tick(), [tid(1)], 'below it, polled');
  await turn();
});

test('[critical] at most two started a look and six running at once; the earliest heard goes first', async () => {
  const gates: (() => void)[] = [];
  const w = new FillWake({
    poll: (id) => new Promise((r) => { gates.push(() => r({ phase: 'flat', fills: [] })); void id; }),
    quotaUsedPct: () => 0, now: () => T0,
  });
  for (let i = 1; i <= 10; i++) w.hear(heard(tid(i), String(9000 + i)));
  assert.deepEqual(w.tick(), [tid(1), tid(2)].slice(0, FILL_WAKE_PER_LOOK));
  w.tick(); w.tick(); w.tick();
  assert.equal(gates.length, FILL_WAKE_IN_FLIGHT);
  assert.deepEqual(w.tick(), [], 'six running: no more until one answers');
  for (const g of gates.splice(0)) g();
  await turn(); await turn();
  assert.equal(w.size, 10 - FILL_WAKE_IN_FLIGHT);
  assert.equal(w.tick().length, FILL_WAKE_PER_LOOK);
});

test('a wake not run for a minute is dropped, and past the most waiting the oldest goes -- the loop has them', () => {
  const { w, advance } = wake({ quota: () => 100 });
  w.hear(heard(tid(1), '9001'));
  advance(FILL_WAKE_STALE_MS + 1);
  w.tick();
  assert.equal(w.size, 0);
  assert.equal(w.counts.stale, 1);
  for (let i = 0; i < FILL_WAKE_MAX + 3; i++) w.hear(heard(tid(100 + i), String(i)));
  assert.equal(w.size, FILL_WAKE_MAX);
  assert.equal(w.counts.overflow, 3);
});

test('a poll that throws is tried again; a quota that cannot be read stops nothing', async () => {
  const w = new FillWake({ poll: async () => { throw new Error('exchange down'); }, quotaUsedPct: () => { throw new Error('no gauge'); }, now: () => T0 });
  w.hear(heard(tid(1), '9001'));
  assert.deepEqual(w.tick(), [tid(1)]);
  await turn();
  assert.equal(w.counts.failed, 1);
  assert.equal(w.size, 1, 'kept, for its retry');
});

// ------------------------------------------------------------------ on the engine

const plan = (n: number, over: Partial<TradePlan> = {}): TradePlan => ({
  ...planFor(peProduct(), { lots: 1, stopPrice: 300, takeProfitPrice: 50 }),
  tradeId: tid(n),
  // Resting: a sale at 102 against a 100.5 bid waits for a buyer.
  entry: { type: 'limit', limitPrice: 102, timeoutMs: 600_000, marketFallback: false },
  ...over,
});

function onEngine() {
  const r = rig({ products: [peProduct()], quotes: [quote(PE, 100.5, 101)] });
  const w = new FillWake({ poll: (id) => r.engine.poll(id), quotaUsedPct: () => 0, now: () => r.now() });
  /** Delta's own id for one of the trade's orders, as its socket names it. */
  const orderOf = async (tradeId: string, role: 'entry' | 'take_profit' | 'stop_loss') => (await r.ex.getOrderByClientId(clientId(tradeId, role)))!.orderId;
  const run = async () => { w.tick(); for (let i = 0; i < 20; i++) await turn(); };
  return { r, w, orderOf, run };
}

test('[critical] an entry filled on Delta: the wake alone puts its stop and target on -- no loop pass', async () => {
  const { r, w, orderOf, run } = onEngine();
  assert.equal((await r.engine.open(plan(1))).ok, true);
  assert.equal(r.store.peek(tid(1))!.state.phase, 'entry_pending');
  r.ex.tick(quote(PE, 102, 103, { ts: r.now() }));               // a buyer at 102: filled at Delta, the journal not told
  assert.equal(r.store.peek(tid(1))!.state.phase, 'entry_pending', 'only Delta knows');
  const entryOrder = await orderOf(tid(1), 'entry');
  w.hear({ kind: 'fill', symbol: PE, orderId: entryOrder, clientOrderId: clientId(tid(1), 'entry'), heardAt: r.now() });
  await run();
  const s = r.store.peek(tid(1))!.state;
  assert.equal(s.phase, 'protected');
  assert.equal(s.fills.some((f) => f.orderId === entryOrder), true);
  assert.ok(s.protection.stopLoss && s.protection.takeProfit, 'stop and target both resting');
  const book = await r.ex.getOpenOrders(PE);
  assert.deepEqual(book.map((o) => o.clientOrderId).sort(), [clientId(tid(1), 'stop_loss'), clientId(tid(1), 'take_profit')].sort());
  assert.equal(w.counts.firstPoll, 1);
});

test('[critical] heard a moment before Delta shows it: the retry finds the fill and protects the trade', async () => {
  const { r, w, orderOf, run } = onEngine();
  await r.engine.open(plan(1));
  const entryOrder = await orderOf(tid(1), 'entry');
  w.hear({ kind: 'fill', symbol: PE, orderId: entryOrder, clientOrderId: clientId(tid(1), 'entry'), heardAt: r.now() });
  await run();
  assert.equal(r.store.peek(tid(1))!.state.phase, 'entry_pending', 'the first poll found it still resting');
  assert.equal(w.size, 1);
  r.ex.tick(quote(PE, 102, 103, { ts: r.now() }));
  r.advance(FILL_WAKE_RETRY_MS[0]);
  await run();
  assert.equal(r.store.peek(tid(1))!.state.phase, 'protected');
  assert.equal(w.size, 0);
  assert.equal(w.counts.retries, 1);
});

test('[critical] a target filled on Delta: the wake takes its stop off the book and closes the trade -- no stop left behind', async () => {
  const { r, w, orderOf, run } = onEngine();
  await r.engine.open(plan(1));
  r.ex.tick(quote(PE, 102, 103, { ts: r.now() }));
  await r.engine.poll(tid(1));                                  // protected, as the loop or a wake would
  assert.equal(r.store.peek(tid(1))!.state.phase, 'protected');
  r.ex.tick(quote(PE, 49, 50, { ts: r.now() }));                // the target's buy-back at 50 fills at Delta
  const tp = await orderOf(tid(1), 'take_profit');
  assert.equal((await r.ex.getOrderByClientId(clientId(tid(1), 'take_profit')))!.status, 'filled');
  assert.equal((await r.ex.getOpenOrders(PE)).some((o) => o.clientOrderId === clientId(tid(1), 'stop_loss')), true, 'the stop still rests');
  w.hear({ kind: 'fill', symbol: PE, orderId: tp, clientOrderId: clientId(tid(1), 'take_profit'), heardAt: r.now() });
  await run();
  const s = r.store.peek(tid(1))!.state;
  assert.equal(s.phase, 'flat');
  assert.equal(s.exitWinner, 'take_profit');
  assert.deepEqual(await r.ex.getOpenOrders(PE), [], 'the stop is off the book');
  assert.equal(w.size, 0);
});

test('[critical] a stop Delta cancelled: the wake\'s poll puts a stop back behind the position', async () => {
  const { r, w, orderOf, run } = onEngine();
  await r.engine.open(plan(1));
  r.ex.tick(quote(PE, 102, 103, { ts: r.now() }));
  await r.engine.poll(tid(1));
  const sl = await orderOf(tid(1), 'stop_loss');
  await r.ex.cancelOrder({ orderId: sl });                     // Delta took it off (it does, for a reduce-only it judges over-committed)
  w.hear({ kind: 'cancelled', symbol: PE, orderId: sl, clientOrderId: clientId(tid(1), 'stop_loss'), heardAt: r.now() });
  await run();
  const stops = (await r.ex.getOpenOrders(PE)).filter((o) => o.role === 'stop_loss' || /S\d+$/.test(o.clientOrderId ?? ''));
  assert.equal(stops.length, 1, 'a stop rests again');
  assert.notEqual(stops[0]!.orderId, sl);
  assert.equal(r.store.peek(tid(1))!.state.position, -1);
});
