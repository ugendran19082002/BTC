import { test } from 'node:test';
import assert from 'node:assert/strict';
import { worstFirst, worstIndex } from '../../src/trading/worst-first.js';

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
async function desk(trades: { id: string; symbol: string; entry: number; position: number }[], quotes: Record<string, { bid: number; ask: number }>) {
  const { TradingService } = await import('../../src/trading/service.js');
  const { MemoryTradeStore } = await import('../../src/trading/engine.js');
  const { SettingsCache } = await import('../../src/db/settings.js');
  const svc = new TradingService({ settings: await new SettingsCache().load(), store: new MemoryTradeStore() as never, notifier: null });
  const closed: { id: string; why: string }[] = [];
  const recs = trades.map((t) => ({ state: { tradeId: t.id, symbol: t.symbol, position: t.position, entryAvgPrice: t.entry, contractValue: 0.001 } }));
  const inside = svc as unknown as { openTrades: () => Promise<unknown[]>; engine: { closeNow: (id: string, why: string) => Promise<{ position: number }>; cancelEntry: (id: string) => Promise<void> } };
  inside.openTrades = async () => recs;
  inside.engine = {
    closeNow: async (id, why) => {
      closed.push({ id, why });
      // A contract moves while the square-off runs: after the first close, the 60,000 CE runs up.
      if (closed.length === 1) quotes['C-BTC-60000-221126'] = { bid: 30, ask: 31 };
      return { position: 0 };
    },
    cancelEntry: async () => {},
  };
  svc.squareOffQuote = (s) => (quotes[s] ? { ...quotes[s]!, mark: null } : null);
  return { svc, closed };
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
    const { svc, closed } = await desk(BOOK, QUOTES());
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
