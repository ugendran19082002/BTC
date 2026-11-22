import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fillReport, worstFirst, worstIndex } from '../../src/trading/worst-first.js';

/**
 * The session square-off closes the trade losing most first (owner, 22 Nov 2026: "option 2 build panu"). On 21 Nov four
 * accounts were squared off, 257 to 308 trades each, five to six minutes one at a time, and the loss ended ₹60–300 past
 * the limit. Only the order changes: every trade is still closed, the same way, one at a time.
 */

type T = { id: string; loss: number | null };
const lossOf = (t: T) => t.loss;

test('[critical] the trade losing most goes first, then the next; winners last', () => {
  // The owner's example: A ₹85, B ₹1,020, C a ₹85 gain, D ₹595, E ₹42 (in USD here, the same order).
  const trades: T[] = [{ id: 'A', loss: 1 }, { id: 'B', loss: 12 }, { id: 'C', loss: -1 }, { id: 'D', loss: 7 }, { id: 'E', loss: 0.5 }];
  assert.deepEqual(worstFirst(trades, lossOf).map((t) => t.id), ['B', 'D', 'A', 'E', 'C']);
});

test('a trade with no quote in memory ranks as nothing lost: after the losers, before the winners', () => {
  const trades: T[] = [{ id: 'win', loss: -3 }, { id: 'unpriced', loss: null }, { id: 'lose', loss: 2 }];
  assert.deepEqual(worstFirst(trades, lossOf).map((t) => t.id), ['lose', 'unpriced', 'win']);
});

test('equals keep the order they came in; nothing is dropped or doubled', () => {
  const trades: T[] = Array.from({ length: 50 }, (_, i) => ({ id: `t${i}`, loss: i % 3 }));
  const out = worstFirst(trades, lossOf);
  assert.equal(out.length, 50);
  assert.equal(new Set(out.map((t) => t.id)).size, 50);
  assert.deepEqual(out.slice(0, 3).map((t) => t.id), ['t2', 't5', 't8'], 'the first of the worst, in their own order');
  assert.equal(worstIndex([], lossOf), -1);
});

/** The desk with its trades and closes faked: what `closeAll` closes, in what order, and with what words. */
async function desk(trades: { id: string; symbol: string; entry: number; position: number }[], quotes: Record<string, { bid: number; ask: number }>, o: { quotaPct?: number; closeMs?: number } = {}) {
  const { TradingService } = await import('../../src/trading/service.js');
  const { MemoryTradeStore } = await import('../../src/trading/engine.js');
  const { SettingsCache } = await import('../../src/db/settings.js');
  const svc = new TradingService({ settings: await new SettingsCache().load(), store: new MemoryTradeStore() as never, notifier: null });
  const closed: { id: string; why: string }[] = [];
  const recs = trades.map((t) => ({ state: { tradeId: t.id, symbol: t.symbol, position: t.position, entryAvgPrice: t.entry, contractValue: 0.001 } }));
  const inside = svc as unknown as { openTrades: () => Promise<unknown[]>; engine: { closeNow: (id: string, why: string) => Promise<{ position: number; fills: unknown[] }>; cancelEntry: (id: string) => Promise<void> } };
  inside.openTrades = async () => recs;
  const symbolOf = new Map(trades.map((t) => [t.id, t.symbol]));
  const live = { now: 0, most: 0, sameContract: 0, steppingWhileOpen: [] as boolean[] };
  const onContract = new Map<string, number>();
  inside.engine = {
    closeNow: async (id, why) => {
      const sym = symbolOf.get(id)!;
      live.now++; live.most = Math.max(live.most, live.now);
      onContract.set(sym, (onContract.get(sym) ?? 0) + 1);
      if (onContract.get(sym)! > 1) live.sameContract++;
      live.steppingWhileOpen.push(svc.isSquaringOff());
      if (o.closeMs) await new Promise((r) => setTimeout(r, o.closeMs));
      onContract.set(sym, onContract.get(sym)! - 1);
      live.now--;
      closed.push({ id, why });
      // Filled at the ask it was closed on, 2% over it for the 58,200 PE (a book walked); then the contract moves.
      const ask = quotes[sym]?.ask ?? 0;
      const price = sym === 'P-BTC-58200-221126' ? ask * 1.02 : ask;
      // A contract moves while the square-off runs: after the first close, the 60,000 CE runs up.
      if (closed.length === 1) quotes['C-BTC-60000-221126'] = { bid: 30, ask: 31 };
      return { position: 0, fills: ask > 0 ? [{ orderId: `x-${id}`, role: 'exit', side: 'buy', size: 2, price, ts: Date.now() }] : [] };
    },
    cancelEntry: async () => {},
  };
  svc.squareOffQuote = (s) => (quotes[s] ? { ...quotes[s]!, mark: null } : null);
  svc.quotaUsedPct = () => o.quotaPct ?? 0;
  return { svc, closed, live };
}

const BOOK = [
  { id: 'A', symbol: 'P-BTC-58000-221126', entry: 10, position: -2 },
  { id: 'B', symbol: 'P-BTC-58200-221126', entry: 8, position: -2 },
  { id: 'C', symbol: 'C-BTC-60000-221126', entry: 6, position: -2 },
  { id: 'D', symbol: 'P-BTC-58400-221126', entry: 9, position: -2 },
  { id: 'E', symbol: 'C-BTC-59000-221126', entry: 7, position: -2 },
];
const QUOTES = () => ({
  'P-BTC-58000-221126': { bid: 10.5, ask: 11 },
  'P-BTC-58200-221126': { bid: 19.5, ask: 20 },
  'C-BTC-60000-221126': { bid: 4.5, ask: 5 },
  'P-BTC-58400-221126': { bid: 15.5, ask: 16 },
  'C-BTC-59000-221126': { bid: 7, ask: 7.5 },
});

test('[critical] the session square-off closes the worst first, ranked again before each close as the market moves', async () => {
  const { closePool } = await import('../../src/db/pool.js');
  try {
    // One hand (the login over the line for extra hands): the ranking after each close is plain to see.
    const { svc, closed } = await desk(BOOK, QUOTES(), { quotaPct: 70 });
    const out = await svc.closeAll(undefined, 'session limit square off', 'worst-first');
    // B first (ask 20 on 8). Then the 60,000 CE ran to 31 on 6 -- now the worst -- before D (16 on 9), A, E.
    assert.deepEqual(closed.map((c) => c.id), ['B', 'C', 'D', 'A', 'E']);
    assert.ok(closed.every((c) => c.why === 'session limit square off'), 'each keeps the session\'s own words');
    assert.deepEqual([...out.closed].sort(), ['A', 'B', 'C', 'D', 'E'], 'every trade closed');
    assert.equal(out.failed.length, 0);
  } finally { await closePool(); }
});

test('[critical] Close all by hand keeps the trades\' own order, as before', async () => {
  const { closePool } = await import('../../src/db/pool.js');
  try {
    const { svc, closed } = await desk(BOOK, QUOTES());
    await svc.closeAll();
    assert.deepEqual(closed.map((c) => c.id), ['A', 'B', 'C', 'D', 'E']);
    assert.ok(closed.every((c) => c.why === 'square off'));
  } finally { await closePool(); }
});

test('[critical] the session guard asks for the worst first', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../../src/trading/service.ts', import.meta.url), 'utf8');
  assert.match(src, /squareOff: \(only\) => this\.closeAll\(only, 'session limit square off', 'worst-first'\)/);
});


/*
 * A few hands at once (22 Nov 2026, owner: "A + B + C build panu"): each on a different contract, never two on one --
 * a trade's share of a contract is Delta's net less its siblings', and a sibling's close in flight would make it wrong.
 */
const MANY = Array.from({ length: 12 }, (_, i) => ({ id: `t${i}`, symbol: `P-BTC-${58_000 + (i % 4) * 200}-221126`, entry: 8, position: -2 }));
const MANY_QUOTES = () => Object.fromEntries([0, 1, 2, 3].map((k) => [`P-BTC-${58_000 + k * 200}-221126`, { bid: 9 + k, ask: 10 + k }]));

test('[critical] the session square-off: up to three at once, never two on one contract, every trade closed', async () => {
  const { closePool } = await import('../../src/db/pool.js');
  const { SQUARE_OFF_HANDS } = await import('../../src/trading/service.js');
  try {
    const { svc, closed, live } = await desk(MANY, MANY_QUOTES(), { closeMs: 20 });
    const out = await svc.closeAll(undefined, 'session limit square off', 'worst-first');
    assert.equal(out.closed.length, 12);
    assert.equal(new Set(closed.map((c) => c.id)).size, 12, 'each once');
    assert.equal(live.sameContract, 0, 'never two closes on one contract at once');
    assert.equal(live.most, SQUARE_OFF_HANDS, 'three hands at work');
    assert.equal(closed[0]!.id.length > 0, true);
  } finally { await closePool(); }
});

test('[critical] the login over its line for extra hands: one at a time, as before', async () => {
  const { closePool } = await import('../../src/db/pool.js');
  const { SQUARE_OFF_PARALLEL_QUOTA_PCT } = await import('../../src/trading/service.js');
  try {
    const { svc, live } = await desk(MANY, MANY_QUOTES(), { closeMs: 5, quotaPct: SQUARE_OFF_PARALLEL_QUOTA_PCT });
    const out = await svc.closeAll(undefined, 'session limit square off', 'worst-first');
    assert.equal(out.closed.length, 12);
    assert.equal(live.most, 1);
  } finally { await closePool(); }
});

test('[critical] inside a wait Delta named (429): nothing sent, nothing failed -- the closes go on when it ends', async () => {
  const { closePool } = await import('../../src/db/pool.js');
  try {
    const { svc, closed } = await desk(MANY.slice(0, 4), MANY_QUOTES());
    let waitLeft = 2;
    (svc as unknown as { rateLimitWaitMs: () => number }).rateLimitWaitMs = () => (waitLeft-- > 0 ? 30 : 0);
    const out = await svc.closeAll(undefined, 'session limit square off', 'worst-first');
    assert.equal(out.failed.length, 0, 'not one trade failed for the wait');
    assert.equal(closed.length, 4);
  } finally { await closePool(); }
});

test('[critical] the account\'s time steps stand aside while a session square-off runs, and only then', async () => {
  const { closePool } = await import('../../src/db/pool.js');
  try {
    const { svc, live } = await desk(MANY.slice(0, 4), MANY_QUOTES());
    assert.equal(svc.isSquaringOff(), false);
    await svc.closeAll(undefined, 'session limit square off', 'worst-first');
    assert.ok(live.steppingWhileOpen.every(Boolean), 'squaring off during every close');
    assert.equal(svc.isSquaringOff(), false, 'and not after');
    const byHand = await desk(MANY.slice(0, 2), MANY_QUOTES());
    await byHand.svc.closeAll();
    assert.ok(byHand.live.steppingWhileOpen.every((x) => !x), 'Close all by hand leaves the steps alone, as before');
    assert.equal(byHand.live.most, 1, 'and goes one at a time');
  } finally { await closePool(); }
});


/*
 * Each close of a session square-off against the ask the board held as it began (22 Nov 2026, owner: "slippage
 * measure"): whether the closes walked a contract's book up. Words on the square-off's record, numbers in the log.
 */
test('[critical] the fill report: average, 90% and worst over the ask, how long it took, closes not priced counted', () => {
  const rows = [
    { tradeId: 'a', symbol: 'P-1', askAt: 10, fillAvg: 10, size: 2, ms: 900 },
    { tradeId: 'b', symbol: 'P-2', askAt: 20, fillAvg: 20.4, size: 2, ms: 900 },
    { tradeId: 'c', symbol: 'P-3', askAt: 5, fillAvg: 5.5, size: 2, ms: 900 },
    { tradeId: 'd', symbol: 'P-4', askAt: null, fillAvg: 3, size: 2, ms: 900 },
  ];
  const r = fillReport(rows, 112_000);
  assert.equal(r.stats.priced, 3);
  assert.equal(r.stats.avgOverPct, 4);
  assert.deepEqual(r.stats.worst, { symbol: 'P-3', overPct: 10 });
  assert.equal(r.words, 'Square-off 1m 52s, 4 closes · fills vs the ask at each close: avg +4%, 90% within +10%, worst +10% (P-3) · 1 not priced');
  assert.equal(fillReport([{ tradeId: 'x', symbol: 'P', askAt: null, fillAvg: null, size: 0, ms: 1 }], 4_000).words, 'Square-off 4s, 1 close · no fill read against an ask · 1 not priced');
});

test('[critical] a session square-off returns its report; Close all by hand does not', async () => {
  const { closePool } = await import('../../src/db/pool.js');
  try {
    const { svc } = await desk(BOOK, QUOTES(), { quotaPct: 70 });
    const out = await svc.closeAll(undefined, 'session limit square off', 'worst-first');
    assert.match(out.report!, /^Square-off \d+s, 5 closes · fills vs the ask at each close: avg \+0\.4%, 90% within \+2%, worst \+2% \(P-BTC-58200-221126\)$/);
    const byHand = await desk(BOOK, QUOTES());
    assert.equal((await byHand.svc.closeAll()).report, undefined);
  } finally { await closePool(); }
});

/* The early square-off's closes (22 Nov 2026): the worst share only, no working entry pulled, never two on one contract. */
test('[critical] the early square-off closes only the worst share, pulls no entry, and says it as the session limit\'s', async () => {
  const { closePool } = await import('../../src/db/pool.js');
  const { exitByOf } = await import('../../src/strategy/store.js');
  try {
    const { svc, closed } = await desk(MANY, MANY_QUOTES());
    let cancels = 0;
    (svc as unknown as { engine: { cancelEntry: () => Promise<void> } }).engine.cancelEntry = async () => { cancels++; };
    const out = await svc.trimWorst(20);
    assert.equal(out.held, 12);
    assert.equal(out.closed.length, 3, 'the worst 20% of 12, rounded up');
    assert.equal(cancels, 0);
    // The worst: the dearest contract (P-BTC-58600, ask 13 on 8) first.
    assert.ok(closed.slice(0, 1).every((c) => c.id === 't3' || c.id === 't7' || c.id === 't11'));
    assert.equal(closed[0]!.why, 'session limit square off (early: the worst 20%)');
    assert.equal(exitByOf(closed[0]!.why, null), 'session', 'History shows it as Session limit');
  } finally { await closePool(); }
});

test('[critical] the early square-off and the whole one at once: never two closes on one contract', async () => {
  const { closePool } = await import('../../src/db/pool.js');
  try {
    const { svc, live } = await desk(MANY, MANY_QUOTES(), { closeMs: 15 });
    await Promise.all([svc.trimWorst(50), svc.closeAll(undefined, 'session limit square off', 'worst-first')]);
    assert.equal(live.sameContract, 0);
  } finally { await closePool(); }
});
