import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BOARD_QUOTE_FRESH_MS, newestQuote } from '../../src/trading/engine.js';
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

/**
 * An entry judged on the newer of the two readings (25 Oct 2026, decision 0007). At the busy candle closes Delta's REST
 * ticker was 3 to 6 s old by its own time and 68 orders were refused as a stale quote, while the socket's board was
 * about a second behind. The REST answer alone, the board missing; the older of the two never.
 */
test('[critical] an entry: REST 6 s old, the board 1 s -- judged on the board and sent; both old, still refused as stale', async () => {
  const p = ceProduct();
  let boardAge: number | null = 1_000;
  const r = rig({ products: [p], quotes: [quote(p.symbol, 100.5, 101)],
    boardQuote: () => (boardAge === null ? null : { symbol: p.symbol, bid: 100.5, ask: 101, bidSize: 5, askSize: 5, mark: 100.8, ts: r.now() - boardAge }) });
  r.ex.tick(quote(p.symbol, 100.5, 101, { ts: r.now() - 6_000 }));
  const fresh = await r.engine.previewOpen(planFor(p, { tradeId: 'x', lots: 1 }));
  assert.ok(fresh.ok, JSON.stringify(fresh));
  boardAge = 7_000;
  const stale = await r.engine.previewOpen(planFor(p, { tradeId: 'y', lots: 1 }));
  assert.ok(!stale.ok && stale.failures.some((f) => f.code === 'STALE_QUOTE' && f.message === 'Last quote is 6.0s old.'), JSON.stringify(stale));
  boardAge = null;
  const alone = await r.engine.previewOpen(planFor(p, { tradeId: 'z', lots: 1 }));
  assert.ok(!alone.ok && alone.failures.some((f) => f.code === 'STALE_QUOTE'), 'no board: the REST answer, as before');
});

test('the newer reading, either alone, the REST answer on a tie', () => {
  const q = (ts: number, bid = 1) => ({ symbol: 's', bid, ask: 2, bidSize: 1, askSize: 1, mark: 1.5, ts });
  assert.equal(newestQuote(null, null), null);
  assert.equal(newestQuote(q(5), null)!.ts, 5);
  assert.equal(newestQuote(null, q(7))!.ts, 7);
  assert.equal(newestQuote(q(5), q(7))!.ts, 7);
  assert.equal(newestQuote(q(9), q(7))!.ts, 9);
  assert.equal(newestQuote(q(7, 1), q(7, 3))!.bid, 1);
});

/**
 * A quote just past its limit asked once more (owner, 27 Nov 2026: "stale quote fix"): Delta stamps an option's ticker
 * every 2-3 s, and when one refresh ran late the freshest answer was 5.2-6.5 s old -- 108 sales refused on 27 Nov by
 * 12:30 that every other rule had passed. After Delta's next refresh it is asked again and the newer reading judged.
 */
test('[critical] an entry: the quote 5.5 s old, Delta asked again a second later and fresh -- judged on that one and sent', async () => {
  const p = ceProduct();
  const r = rig({ products: [p], quotes: [quote(p.symbol, 100.5, 101)] });
  let asked = 0;
  r.ex.getQuote = async (s: string) => {
    asked++;
    return asked === 1 ? quote(s, 100.5, 101, { ts: r.now() - 5_500 }) : quote(s, 100.5, 101, { ts: r.now() - 800 });
  };
  const ok = await r.engine.previewOpen(planFor(p, { tradeId: 'x', lots: 1 }));
  assert.ok(ok.ok, JSON.stringify(ok));
  assert.equal(asked, 2, 'asked once more, only because the first was past its age');
});

test('[critical] still old when asked again: refused as stale, as before; long past it: refused at once, not asked again', async () => {
  const p = ceProduct();
  const r = rig({ products: [p], quotes: [quote(p.symbol, 100.5, 101)] });
  let asked = 0;
  let age = 5_500;
  r.ex.getQuote = async (s: string) => { asked++; return quote(s, 100.5, 101, { ts: r.now() - age }); };
  const still = await r.engine.previewOpen(planFor(p, { tradeId: 'y', lots: 1 }));
  assert.ok(!still.ok && still.failures.some((f) => f.code === 'STALE_QUOTE' && f.message === 'Last quote is 5.5s old.'), JSON.stringify(still));
  assert.equal(asked, 2);
  asked = 0; age = 20_000;
  const dead = await r.engine.previewOpen(planFor(p, { tradeId: 'z', lots: 1 }));
  assert.ok(!dead.ok && dead.failures.some((f) => f.code === 'STALE_QUOTE'), JSON.stringify(dead));
  assert.equal(asked, 1, 'twenty seconds old: the feed is in trouble, no second ask');
});

test('a fresh quote: asked once, no wait, no second read', async () => {
  const p = ceProduct();
  const r = rig({ products: [p], quotes: [quote(p.symbol, 100.5, 101)] });
  let asked = 0;
  r.ex.getQuote = async (s: string) => { asked++; return quote(s, 100.5, 101, { ts: r.now() - 1_200 }); };
  assert.ok((await r.engine.previewOpen(planFor(p, { tradeId: 'f', lots: 1 }))).ok);
  assert.equal(asked, 1);
});
