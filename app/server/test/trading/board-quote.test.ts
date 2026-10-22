import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BOARD_QUOTE_FRESH_MS } from '../../src/trading/engine.js';
import { tickerOf } from '../../src/market/delta-socket.js';
import type { Quote } from '../../src/trading/types.js';
import { ceProduct, planFor, quote, rig } from './harness.js';

/**
 * A stop's look judged on the board in memory when it is fresh (22 Oct 2026): the socket's quote is about a second old
 * by Delta's own time, Delta's REST answer 0.8-2.7 s and a request besides. One request fewer before the buy-back.
 */

async function oneShort(board: () => Quote | null) {
  const p = ceProduct();
  const r = rig({ products: [p], quotes: [quote(p.symbol, 100.5, 101)], boardQuote: () => board() });
  await r.engine.open(planFor(p, { tradeId: 'a', stopPrice: 110, lots: 1 }));
  await r.engine.poll('a');
  let asked = 0;
  const get = r.ex.getQuote.bind(r.ex);
  r.ex.getQuote = async (s: string) => { asked++; return get(s); };
  return { r, p, asked: () => asked, exit: async () => (await r.store.get('a'))!.events.find((e) => e.t === 'exit_submitted') as { quoteFrom?: string; quoteAgeMs?: number } | undefined };
}

test('[critical] the board fresh and through the stop: closed on it, Delta not asked again, and the journal says so', async () => {
  let at = 0;
  const x = await oneShort(() => ({ symbol: ceProduct().symbol, bid: 111, ask: 112, bidSize: 5, askSize: 5, mark: 111.5, ts: at }));
  at = x.r.now() - 900;
  assert.deepEqual(await x.r.engine.checkStops(x.p.symbol, ['a']), ['a']);
  assert.equal(x.asked(), 0, 'no request to Delta for the quote');
  const ev = await x.exit();
  assert.deepEqual([ev?.quoteFrom, ev?.quoteAgeMs], ['board', 900]);
});

test('[critical] the board older than its freshness: the quote is asked of Delta, as before', async () => {
  let at = 0;
  const x = await oneShort(() => ({ symbol: ceProduct().symbol, bid: 111, ask: 112, bidSize: 5, askSize: 5, mark: 111.5, ts: at }));
  at = x.r.now() - BOARD_QUOTE_FRESH_MS - 1;
  x.r.ex.tick(quote(x.p.symbol, 111, 112, { ts: x.r.now() - 300, mark: 111.5 }));
  assert.deepEqual(await x.r.engine.checkStops(x.p.symbol, ['a']), ['a']);
  assert.equal(x.asked(), 1);
  const ev = await x.exit();
  assert.deepEqual([ev?.quoteFrom, ev?.quoteAgeMs], ['rest', 300]);
});

test('[critical] no board, or the board fresh and under the stop: nothing closed, and the board is believed -- it is what the watch saw', async () => {
  const none = await oneShort(() => null);
  none.r.ex.tick(quote(none.p.symbol, 100.5, 101, { ts: none.r.now() }));
  assert.deepEqual(await none.r.engine.checkStops(none.p.symbol, ['a']), []);
  assert.equal(none.asked(), 1, 'asked of Delta with no board');
  const under = await oneShort(() => ({ symbol: ceProduct().symbol, bid: 100, ask: 101, bidSize: 5, askSize: 5, mark: 100.5, ts: under.r.now() - 200 }));
  assert.deepEqual(await under.r.engine.checkStops(under.p.symbol, ['a']), []);
  assert.equal(under.asked(), 0);
});

test('the socket\'s ticker keeps Delta\'s timestamp', () => {
  const t = tickerOf({
    type: 'v2/ticker', symbol: 'P-BTC-81800-221026', contract_type: 'put_options', underlying_asset_symbol: 'BTC',
    strike_price: '81800', mark_price: '123.9', spot_price: '84000', timestamp: 1_792_658_588_223_583,
    quotes: { best_bid: '122', best_ask: '124.4', bid_size: '50', ask_size: '50' },
  });
  assert.equal(t?.timestamp, 1_792_658_588_223_583);
});
