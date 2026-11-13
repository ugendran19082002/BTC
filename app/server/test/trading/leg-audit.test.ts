import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LEG_AUDIT_MAX_WAKES, LEG_AUDIT_MIN_AGE_MS, LEG_AUDIT_QUOTA_PCT, LEG_AUDIT_REWAKE_MS, LegAudit, missingLegOf } from '../../src/trading/leg-audit.js';
import { clientId, type TradeRecord } from '../../src/trading/engine.js';
import type { ExchangeOrder } from '../../src/trading/types.js';

/*
 * Every open short's stop and target against the book Delta last listed (13 Nov 2026): 22 trades on C-BTC-72200 sat
 * with no target on Delta for twenty minutes while sellers traded through the level. A trade whose order is not on the
 * book is woken now; one just changed, or whose target is held off on purpose, is left alone.
 */

const SYM = 'C-BTC-72200-131126';
let n = 0;
const T0 = 1_794_535_000_000;

function trade(over: { position?: number; phase?: string; updatedAt?: number; sl?: string | null; tp?: string | null; stopPrice?: number | null; takeProfitPrice?: number | null; events?: unknown[] } = {}): TradeRecord {
  const id = `${SYM}-${T0 + ++n}`;
  const sl = over.sl === undefined ? clientId(id, 'stop_loss') : over.sl;
  const tp = over.tp === undefined ? clientId(id, 'take_profit') : over.tp;
  return {
    plan: { symbol: SYM, stopPrice: over.stopPrice === undefined ? 30 : over.stopPrice, takeProfitPrice: over.takeProfitPrice === undefined ? 6.3 : over.takeProfitPrice } as never,
    state: { tradeId: id, symbol: SYM, phase: over.phase ?? 'protected', position: over.position ?? -1, updatedAt: over.updatedAt ?? T0, protection: { size: 1, stopLoss: sl, takeProfit: tp }, requestedSize: 1, entrySize: 1, fills: [] } as never,
    events: (over.events ?? []) as never,
  };
}
const order = (cid: string): ExchangeOrder => ({ clientOrderId: cid, orderId: cid, symbol: SYM, status: 'open', side: 'buy', type: 'limit', size: 1, filledSize: 0, limitPrice: 6.3, stopPrice: null, reduceOnly: true } as never);
const bookOf = (...cids: (string | null)[]) => new Map(cids.flatMap((c) => (c ? [[c, order(c)] as const] : [])));
const legsOf = (t: TradeRecord) => [t.state.protection.stopLoss!, t.state.protection.takeProfit!] as const;

test('[critical] a target not on the book is missing; one on it is not; a stop the same', () => {
  const t = trade();
  const [sl, tp] = legsOf(t);
  const now = T0 + LEG_AUDIT_MIN_AGE_MS + 1;
  assert.equal(missingLegOf(t, bookOf(sl, tp), now), null);
  assert.equal(missingLegOf(t, bookOf(sl), now), 'take_profit');
  assert.equal(missingLegOf(t, bookOf(tp), now), 'stop_loss', 'the stop first: it is the leg that protects');
  assert.equal(missingLegOf(t, bookOf(), now), 'stop_loss');
});

test('[critical] left alone: a trade changed in the last 30 s, one still entering or closing, a bought one, a flat one, a target held off on purpose', () => {
  const now = T0 + LEG_AUDIT_MIN_AGE_MS + 1;
  const empty = bookOf();
  assert.equal(missingLegOf(trade({ updatedAt: now - 1_000 }), empty, now), null, 'its new order may be newer than the book read');
  assert.equal(missingLegOf(trade({ phase: 'entry_pending' }), empty, now), null);
  assert.equal(missingLegOf(trade({ phase: 'exit_pending' }), empty, now), null);
  assert.equal(missingLegOf(trade({ position: 1 }), empty, now), null, 'a bought position has no exits of the desk\'s');
  assert.equal(missingLegOf(trade({ position: 0, phase: 'flat' }), empty, now), null);
  const held = trade({ events: [{ t: 'exit_step', kind: 'held', at: T0, until: now + 60_000, title: 'Target kept off Delta for 15 minutes' }] });
  assert.equal(missingLegOf(held, bookOf(held.state.protection.stopLoss), now), null, 'held off the book: meant to be away');
  const over = trade({ events: [{ t: 'exit_step', kind: 'held', at: T0, until: now - 1, title: 'Target kept off Delta for 15 minutes' }] });
  assert.equal(missingLegOf(over, bookOf(over.state.protection.stopLoss), now), 'take_profit', 'the hold over: missing again');
  assert.equal(missingLegOf(trade({ takeProfitPrice: null, tp: null }), bookOf(), now), 'stop_loss', 'no target wanted: only the stop counts');
});

function audit(o: { open: TradeRecord[]; book: () => ReadonlyMap<string, ExchangeOrder> | null; quota?: number; now?: () => number }) {
  const woke: string[] = [];
  const a = new LegAudit({
    book: async () => o.book(), open: async () => o.open, wake: (id) => { woke.push(id); },
    quotaUsedPct: () => o.quota ?? 10, now: o.now ?? (() => T0 + LEG_AUDIT_MIN_AGE_MS + 1),
  });
  return { a, woke };
}

test('[critical] the 13 Nov morning: 22 trades whose targets are not on the book are woken on one look, at most 20 a look, and not again for 20 s', async () => {
  const open = Array.from({ length: 22 }, () => trade());
  // Every stop on the book, no target.
  const book = () => bookOf(...open.map((t) => t.state.protection.stopLoss));
  let now = T0 + LEG_AUDIT_MIN_AGE_MS + 1;
  const { a, woke } = audit({ open, book, now: () => now });
  assert.deepEqual(await a.look(), open.slice(0, LEG_AUDIT_MAX_WAKES).map((t) => t.state.tradeId));
  assert.equal(a.counts.missingTarget, 22);
  assert.deepEqual(a.last, { at: now, checked: 22, missing: 22, woken: 20 });
  now += 5_000;
  assert.deepEqual(await a.look(), open.slice(20).map((t) => t.state.tradeId), 'the two left over, not the twenty again');
  now += 5_000;
  assert.deepEqual(await a.look(), [], 'none due again yet');
  now += LEG_AUDIT_REWAKE_MS;
  assert.equal((await a.look()).length, 20, 'still missing after 20 s: woken again');
  assert.equal(woke.length, 42);
});

test('[critical] a target back on the book is forgotten; a trade closed is forgotten; nothing is woken for a book that could not be read, or past the quota line', async () => {
  const t = trade();
  const [sl, tp] = legsOf(t);
  let book: ReadonlyMap<string, ExchangeOrder> | null = bookOf(sl);
  let quota = 10;
  const { a, woke } = audit({ open: [t], book: () => book, quota: 0 });
  (a as unknown as { d: { quotaUsedPct: () => number } }).d.quotaUsedPct = () => quota;
  assert.deepEqual(await a.look(), [t.state.tradeId]);
  book = bookOf(sl, tp);
  assert.deepEqual(await a.look(), []);
  assert.equal(a.metrics().waiting, 0, 'back on the book: forgotten');
  book = null;
  assert.deepEqual(await a.look(), []);
  assert.equal(a.counts.noBook, 1);
  book = bookOf(sl);
  quota = LEG_AUDIT_QUOTA_PCT;
  assert.deepEqual(await a.look(), [], 'the quota kept for the stops and targets themselves');
  assert.equal(a.counts.quotaWaits, 1);
  quota = 10;
  assert.equal(woke.length, 1);
});

test('a look that throws is counted and never thrown; two looks at once are one', async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => { release = r; });
  const t = trade();
  const a = new LegAudit({
    book: async () => { await gate; return bookOf(); }, open: async () => [t], wake: () => {},
    quotaUsedPct: () => 0, now: () => T0 + LEG_AUDIT_MIN_AGE_MS + 1,
  });
  const first = a.look();
  assert.deepEqual(await a.look(), [], 'one at a time');
  release();
  assert.deepEqual(await first, [t.state.tradeId]);
  const broken = new LegAudit({ book: async () => { throw new Error('boom'); }, open: async () => [t], wake: () => {}, quotaUsedPct: () => 0 });
  assert.deepEqual(await broken.look(), []);
  assert.equal(broken.counts.failed, 1);
});
