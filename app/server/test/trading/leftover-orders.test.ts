import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rig, ceProduct, planFor, quote, type Rig } from './harness.js';
import {
  NO_REDUCE_ONLY_ROOM, ORPHAN_MIN_AGE_MS, ORPHAN_SWEEP_MS, TARGET_HOLD_MS, TradeEngine, clientId, targetHoldOf, tradeIdOfClientId,
} from '../../src/trading/engine.js';
import { DEFAULT_LIMITS } from '../../src/trading/precheck.js';
import type { ExchangeOrder } from '../../src/trading/types.js';

/**
 * 14 Oct 2026. Delta mailed: a BUY stop of the 84,200 CE "triggered at 09:03:39 ... immediately cancelled because it
 * was marked as reduce-only" -- on a contract whose twenty trades the desk had closed by 06:10. The desk read one page
 * of a hundred open orders while 77 trades were open; a trade whose stop was past the page read as having none, and a
 * second went on beside it (S0, then S1). S1 was cancelled at the close; S0 was never seen again. Orders like it held
 * the contracts' reduce-only room, and Delta cancelled the targets that were wanted.
 *
 * So the account's whole book is swept once a minute for the desk's own exits that no open trade wants -- and only
 * those: an order the desk did not place is never touched.
 */

const CE = ceProduct().symbol;
/** A trade id of the desk's own shape (`${symbol}-${ms}`), so its client ids can be read back to it. */
const tradeIdAt = (ms: number) => `${CE}-${ms}`;

type PaperOrder = ExchangeOrder & { reason?: string };
const ordersOf = (r: Rig) => (r.ex as unknown as { orders: Map<string, PaperOrder> }).orders;
/** The paper venue stamps orders with the wall clock; the rig's clock is its own. Make every order old enough. */
const age = (r: Rig) => { for (const o of ordersOf(r).values()) o.createdAt = r.now() - ORPHAN_MIN_AGE_MS - 1_000; };

async function shortAt(ms: number, r = rig({ quotes: [quote(CE, 100.5, 101)] })) {
  const plan = planFor(ceProduct(), { tradeId: tradeIdAt(ms), lots: 10, stopPrice: 300, takeProfitPrice: 20 });
  await r.engine.open(plan);
  await r.engine.poll(plan.tradeId);
  const rec = r.store.peek(plan.tradeId)!;
  assert.equal(rec.state.position, -10);
  assert.ok(rec.state.protection.takeProfit && rec.state.protection.stopLoss, 'both exits on the book');
  return { r, id: plan.tradeId };
}

const stopFor = (r: Rig, id: string, n: number) => r.ex.placeOrder({
  clientOrderId: clientId(id, 'stop_loss', n), symbol: CE, productId: ceProduct().productId,
  side: 'buy', type: 'stop_limit', size: 10, stopPrice: 300, limitPrice: 330, reduceOnly: true, role: 'stop_loss',
});

test('a client id is read back to the trade it was made for -- and only one of the desk\'s own shape', () => {
  const id = tradeIdAt(1791933603779);
  assert.equal(tradeIdOfClientId(CE, clientId(id, 'stop_loss', 0)), id);
  assert.equal(tradeIdOfClientId(CE, clientId(id, 'take_profit', 164)), id);
  assert.equal(tradeIdOfClientId('P-BTC-77000-090926', clientId(id, 'stop_loss', 0)), null, 'not on another expiry');
  // The same expiry shares the id's first five: only a candidate, which the sweep then has to find in the journal.
  assert.equal(tradeIdOfClientId('P-BTC-77000-080926', clientId(id, 'stop_loss', 0)), 'P-BTC-77000-080926-1791933603779');
  assert.equal(tradeIdOfClientId(CE, 'my-own-order'), null, 'an order placed by hand');
  assert.equal(tradeIdOfClientId(CE, clientId('t-CE-1', 'stop_loss', 0)), null, 'an id of another shape is left alone');
});

test('[critical] a second stop beside the one in use is taken off -- the one in use, the target and the position stay', async () => {
  const { r, id } = await shortAt(1_700_000_000_001);
  const before = r.store.peek(id)!.state.protection;
  // The scene of 06:03: S0 still resting, S7 placed beside it and the one the record now carries.
  await stopFor(r, id, 7);
  age(r);
  const swept = await r.engine.sweepOrphans();
  assert.deepEqual(swept, [clientId(id, 'stop_loss', 7)]);
  const book = (await r.ex.getOpenOrders(CE)).map((o) => o.clientOrderId).sort();
  assert.deepEqual(book, [before.stopLoss, before.takeProfit].sort(), 'the trade\'s own exits are what is left');
  const after = r.store.peek(id)!;
  assert.deepEqual(after.state.protection, before, 'the record\'s exits untouched');
  assert.equal(after.state.position, -10);
  const note = after.events.at(-1)!;
  assert.ok(note.t === 'exit_step' && note.kind === 'swept', 'journaled as a note, not as the trade\'s own exit going');
});

test('[critical] a finished trade\'s exits still resting are all taken off; a hand-placed order and a fresh one are not', async () => {
  const r = rig({ quotes: [quote(CE, 100.5, 101)] });
  const { id } = await shortAt(1_700_000_000_002, r);
  // An order of the person's own, and an exit of an open trade placed this moment.
  await r.ex.placeOrder({
    clientOrderId: 'by-hand', symbol: CE, productId: ceProduct().productId,
    side: 'buy', type: 'limit', size: 1, limitPrice: 5, reduceOnly: true, role: 'take_profit',
  });
  age(r);
  await stopFor(r, id, 9);                                        // younger than ORPHAN_MIN_AGE_MS
  // The trade is over on the record -- its close done, its exits not confirmed off the book.
  const rec = r.store.peek(id)!;
  await r.store.save({ ...rec, state: { ...rec.state, phase: 'flat' } });
  const swept = await r.engine.sweepOrphans();
  assert.deepEqual(swept.sort(), [rec.state.protection.stopLoss, rec.state.protection.takeProfit].sort());
  const left = (await r.ex.getOpenOrders(CE)).map((o) => o.clientOrderId).sort();
  assert.deepEqual(left, ['by-hand', clientId(id, 'stop_loss', 9)].sort(), 'the person\'s order and the fresh one stay');
  // once a minute, not every pass
  assert.deepEqual(await r.engine.sweepOrphans(), []);
  r.advance(ORPHAN_SWEEP_MS);
  age(r);
  assert.deepEqual(await r.engine.sweepOrphans(), [clientId(id, 'stop_loss', 9)], 'old enough now, and its trade is done');
});

test('a book that cannot be read is not swept on', async () => {
  const { r, id } = await shortAt(1_700_000_000_003);
  await stopFor(r, id, 7);
  age(r);
  r.ex.getOpenOrders = async () => { throw new Error('more than 1000 open orders: the book was not read whole'); };
  assert.deepEqual(await r.engine.sweepOrphans(), []);
});

test('[critical] a held target stays held across a restart: the hold is in the journal, not in memory', async () => {
  const { r, id } = await shortAt(1_700_000_000_004);
  const tp = r.store.peek(id)!.state.protection.takeProfit;
  const o = [...ordersOf(r).values()].find((x) => x.clientOrderId === tp)!;
  await r.ex.cancelOrder(o);
  o.reason = NO_REDUCE_ONLY_ROOM;
  r.advance(30_000);
  await r.engine.poll(id);
  assert.equal(r.store.peek(id)!.state.protection.takeProfit, null, 'held');
  assert.equal(targetHoldOf(r.store.peek(id)!).until, r.now() + TARGET_HOLD_MS);

  // The process restarts (10:30 that morning): a new engine over the same journal and the same venue.
  const alarms: string[] = [];
  const fresh = new TradeEngine({
    exchange: r.ex, store: r.store, now: () => r.now(), limits: DEFAULT_LIMITS, tradingEnabled: true,
    feedHealthy: () => true, dayPnlUsd: () => 0, spot: () => 80_000, wait: async () => {},
    onAlarm: (_t, m) => alarms.push(m),
  });
  r.advance(60_000);
  await fresh.poll(id);
  assert.equal(r.store.peek(id)!.state.protection.takeProfit, null, 'not put straight back');
  assert.equal((await r.ex.getOpenOrders(CE)).filter((x) => x.type === 'limit').length, 0);
  // and once the hold is over, back it goes
  r.advance(TARGET_HOLD_MS);
  await fresh.poll(id);
  assert.ok(r.store.peek(id)!.state.protection.takeProfit, 'back after the hold');
  assert.deepEqual(alarms, []);
});

test('[critical] while the target is held the desk does not read Delta\'s book for it every pass; a filled entry is not looked up again', async () => {
  const { r, id } = await shortAt(1_700_000_000_005);
  const entryId = clientId(id, 'entry');
  let bookReads = 0;
  let entryLookups = 0;
  const getOpenOrders = r.ex.getOpenOrders.bind(r.ex);
  const getOrderByClientId = r.ex.getOrderByClientId.bind(r.ex);
  r.ex.getOpenOrders = async (s?: string) => { bookReads++; return getOpenOrders(s); };
  r.ex.getOrderByClientId = async (cid: string, s?: string) => { if (cid === entryId) entryLookups++; return getOrderByClientId(cid, s); };

  for (let i = 0; i < 5; i++) { r.advance(1_000); await r.engine.poll(id); }
  assert.equal(entryLookups, 0, 'all of the entry filled: nothing more to ask it');

  const tp = r.store.peek(id)!.state.protection.takeProfit;
  const o = [...ordersOf(r).values()].find((x) => x.clientOrderId === tp)!;
  await r.ex.cancelOrder(o);
  o.reason = NO_REDUCE_ONLY_ROOM;
  r.advance(1_000);
  await r.engine.poll(id);
  bookReads = 0;
  for (let i = 0; i < 30; i++) { r.advance(1_000); await r.engine.poll(id); }
  assert.equal(bookReads, 0, 'held is not missing: no book read a second');
  assert.ok(r.store.peek(id)!.state.protection.stopLoss, 'the stop stays');
});
