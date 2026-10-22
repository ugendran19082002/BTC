import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { DeltaExchange } from '../../src/trading/exchange/delta.js';
import { venueAt } from '../../src/market/venue-time.js';
import { cachedAsks, liveTickers } from '../../src/market/delta.js';
import { ceProduct, planFor, quote, rig } from './harness.js';

/**
 * A stop's quote, by Delta's own time and past its CDN (22 Oct 2026): `/v2/tickers` answers were cached five seconds
 * and stamped by the desk as they arrived, so a quote 2.4 to 6 s old was judged as if it were new.
 */

const real = globalThis.fetch;
afterEach(() => { globalThis.fetch = real; });
type Seen = { url: string; headers: Record<string, string> };
const answering = (result: unknown, seen: Seen[]) => {
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    seen.push({ url: String(url), headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>)) });
    return new Response(JSON.stringify({ success: true, result }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
};
const ticker = (o: { timestamp?: number | null } = {}) => ({ symbol: 'P-BTC-81800-221026', mark_price: '123.9', quotes: { best_bid: '122', best_ask: '124.4', bid_size: '50', ask_size: '50' }, ...o });

test('[critical] the reading\'s own time: Delta\'s timestamp when older than its arrival; the arrival when absent, or when Delta\'s clock runs ahead', () => {
  assert.equal(venueAt(1_792_658_588_223_583, 1_792_658_590_000), 1_792_658_588_223);
  assert.equal(venueAt(null, 1_000), 1_000);
  assert.equal(venueAt(undefined, 1_000), 1_000);
  assert.equal(venueAt('nope', 1_000), 1_000);
  assert.equal(venueAt(5_000_000, 1_000), 1_000, 'stamped after it arrived: the desk\'s clock');
});

test('[critical] a stop\'s quote is asked past the CDN -- a query no request made before, signed with it -- and dated by Delta', async () => {
  const seen: Seen[] = [];
  const at = Date.now() - 2_400;
  answering(ticker({ timestamp: at * 1_000 }), seen);
  const ex = new DeltaExchange({ key: 'k', secret: 's' });
  const q = await ex.getQuote('P-BTC-81800-221026');
  assert.ok(q);
  assert.equal(q!.ask, 124.4);
  assert.ok(Math.abs(q!.ts - at) <= 1, `dated ${Date.now() - q!.ts} ms ago, as Delta took it`);
  await ex.getQuote('P-BTC-81800-221026');
  assert.equal(seen.length, 2);
  const [a, b] = seen.map((s) => new URL(s.url));
  assert.equal(a!.pathname, '/v2/tickers/P-BTC-81800-221026');
  assert.match(a!.search, /^\?_=\d+$/);
  assert.notEqual(a!.search, b!.search, 'never the same query twice: nothing for the cache to answer from');
  // The query is part of what is signed, or Delta refuses it.
  const h = seen[0]!.headers;
  const want = createHmac('sha256', 's').update(`GET${h.timestamp}${a!.pathname}${a!.search}`).digest('hex');
  assert.equal(h.signature, want);
});

test('[critical] no timestamp on the answer: dated as it arrived, as before', async () => {
  answering(ticker({ timestamp: null }), []);
  const before = Date.now();
  const q = await new DeltaExchange({ key: 'k', secret: 's' }).getQuote('P-BTC-81800-221026');
  assert.ok(q!.ts >= before && q!.ts <= Date.now());
});

test('[critical] the board polled while the socket is quiet: past the CDN, and as old as Delta\'s snapshot -- what the stop watch judges freshness by', async () => {
  const seen: Seen[] = [];
  const snap = Date.now() - 4_100;
  answering([
    { ...ticker({ timestamp: snap * 1_000 }), contract_type: 'put_options', underlying_asset_symbol: 'BTC', strike_price: '81800', close: null },
  ], seen);
  await liveTickers();
  assert.match(new URL(seen[0]!.url).search, /contract_types=call_options,put_options&_=\d+$/);
  const board = cachedAsks(['P-BTC-81800-221026']);
  assert.equal(board!.asks.get('P-BTC-81800-221026'), 124.4);
  assert.ok(Math.abs(board!.at - snap) <= 1, `the board dated ${Date.now() - board!.at} ms ago`);
});

test('[critical] each stop\'s close says how old the quote it was judged on was', async () => {
  const p = ceProduct();
  const r = rig({ products: [p], quotes: [quote(p.symbol, 100.5, 101)] });
  await r.engine.open(planFor(p, { tradeId: 'a', stopPrice: 110, lots: 1 }));
  await r.engine.poll('a');
  r.ex.tick(quote(p.symbol, 111, 112, { ts: r.now() - 1_800, mark: 111.5 }));
  assert.deepEqual(await r.engine.checkStops(p.symbol, ['a']), ['a']);
  const ev = (await r.store.get('a'))!.events.find((e) => e.t === 'exit_submitted') as { quoteAgeMs?: number };
  assert.equal(ev.quoteAgeMs, 1_800);
});
