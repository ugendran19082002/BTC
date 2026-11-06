import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { BOOK_SHARE_BUSY_MS, BOOK_SHARE_FULL_MS, BOOK_SHARE_MS, DeltaExchange, bookShareMs } from '../../src/trading/exchange/delta.js';
import { ExchangeUnavailable } from '../../src/trading/exchange/port.js';
import { passPaceMs } from '../../src/trading/service.js';
import { clearRateLimitWaits } from '../../src/delta/signed.js';
import { costOf } from '../../src/observability/desk-metrics.js';
import { ceProduct, planFor, quote, rig } from './harness.js';

/**
 * Every trade's target and stop off one read of the account's book, and a lookup only for an order that changed (6 Nov
 * 2026: the quota at 75-86% all day, ~254,000 refusals). Fetch is stood in for: what matters is what reaches Delta.
 */

const CREDS = { key: 'reads-login', secret: 's' };
const real = globalThis.fetch;
const realNow = Date.now;
afterEach(() => { globalThis.fetch = real; Date.now = realNow; clearRateLimitWaits(); });

type Row = { id: number; client_order_id: string; product_id: number; product_symbol: string; side: 'buy'; order_type: string; size: number; unfilled_size: number; limit_price: string; state: string; stop_price?: string; stop_order_type?: string; reduce_only?: boolean };
const rowOf = (i: number, over: Partial<Row> = {}): Row => ({ id: 1000 + i, client_order_id: `c${i}`, product_id: 7, product_symbol: 'C-BTC-80000-080926', side: 'buy', order_type: 'limit_order', size: 1, unfilled_size: 1, limit_price: '5', state: 'open', ...over });
const okJson = (result: unknown, after: string | null = null) => new Response(JSON.stringify({ success: true, result, meta: { after } }), { status: 200 });

/** Delta, with a book of `rows` a hundred to the page; what was asked is in `sent`. */
function delta(rows: () => Row[], single: (cid: string) => Response = () => new Response(JSON.stringify({ success: false, error: { code: 'not_found' } }), { status: 404 })) {
  const sent: string[] = [];
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    const u = new URL(String(url));
    sent.push(`${init?.method ?? 'GET'} ${u.pathname}`);
    if (u.pathname === '/v2/orders' && (init?.method ?? 'GET') === 'GET') {
      const from = Number(u.searchParams.get('after') ?? 0);
      const all = rows();
      return okJson(all.slice(from, from + 100), from + 100 < all.length ? String(from + 100) : null);
    }
    const one = /^\/v2\/orders\/client_order_id\/(.+)$/.exec(u.pathname);
    if (one) return single(decodeURIComponent(one[1]!));
    if (u.pathname === '/v2/orders') return okJson({ id: 1, state: 'cancelled', client_order_id: 'x', product_id: 7, product_symbol: 'C-BTC-80000-080926', side: 'buy', order_type: 'limit_order', size: 1 });
    if (u.pathname.startsWith('/v2/products/')) return okJson({ id: 7, symbol: 'C-BTC-80000-080926', contract_type: 'call_options', strike_price: '80000', settlement_time: '2026-09-08T12:00:00Z', tick_size: '0.1', contract_unit_currency: 'BTC', contract_value: '0.001', initial_margin: '10', maintenance_margin: '5', state: 'live', trading_status: 'operational', underlying_asset: { symbol: 'BTC' } });
    if (u.pathname === '/v2/positions/margined') return okJson([{ product_id: 7, product_symbol: 'C-BTC-80000-080926', size: -rows().reduce((n, x) => n + (x.stop_price ? x.size : 0), 0), entry_price: '20' }]);
    return okJson([]);
  }) as typeof fetch;
  return sent;
}
const count = (sent: string[], what: RegExp) => sent.filter((s) => what.test(s)).length;

test('[critical] 500 resting orders: one read of the book answers all of them -- 5 pages, not 500 lookups', async () => {
  const rows = Array.from({ length: 500 }, (_, i) => rowOf(i));
  const sent = delta(() => rows);
  const ex = new DeltaExchange(CREDS);
  const got = await Promise.all(rows.map((r) => ex.getRestingOrder(r.client_order_id)));
  assert.deepEqual(got.map((o) => o?.clientOrderId), rows.map((r) => r.client_order_id));
  assert.equal(count(sent, /GET \/v2\/orders$/), 5);
  assert.equal(count(sent, /client_order_id/), 0);
  // The same again inside the window: nothing more is asked.
  await ex.getRestingOrder('c7');
  assert.equal(sent.length, 5);
});

test('[critical] an order no longer on the book is looked up on its own, and read as it is: a filled target is seen as filled', async () => {
  const filled = { ...rowOf(1), state: 'closed', unfilled_size: 0, average_fill_price: '5' };
  const sent = delta(() => [rowOf(0)], (cid) => okJson(cid === 'c1' ? filled : null));
  const ex = new DeltaExchange(CREDS);
  const o = await ex.getRestingOrder('c1', 'C-BTC-80000-080926');
  assert.equal(o?.status, 'filled');
  assert.equal(o?.filledSize, 1);
  assert.equal(count(sent, /client_order_id/), 1);
});

test('[critical] an order the desk has just edited or cancelled is read fresh, never off the book read before it', async () => {
  const fresh = rowOf(0, { limit_price: '3' });
  const sent = delta(() => [rowOf(0)], () => okJson(fresh));
  const ex = new DeltaExchange(CREDS);
  assert.equal((await ex.getRestingOrder('c0'))?.limitPrice, 5);
  await ex.cancelOrder({ orderId: '1000', productId: 7 });
  assert.equal((await ex.getRestingOrder('c0'))?.limitPrice, 3);
  assert.equal(count(sent, /client_order_id/), 1);
});

test('[critical] the book is read again when its moment is over, and a fill between reads is seen on the next', async () => {
  let now = 1_000_000;
  Date.now = () => now;
  let rows = [rowOf(0)];
  const filled = { ...rowOf(0), state: 'closed', unfilled_size: 0, average_fill_price: '5' };
  const sent = delta(() => rows, () => okJson(filled));
  const ex = new DeltaExchange(CREDS);
  assert.equal((await ex.getRestingOrder('c0'))?.status, 'open');
  rows = [];
  now += BOOK_SHARE_MS - 1;
  assert.equal((await ex.getRestingOrder('c0'))?.status, 'open', 'inside the moment, the read already made');
  assert.equal(count(sent, /GET \/v2\/orders$/), 1);
  now += 1;
  assert.equal((await ex.getRestingOrder('c0'))?.status, 'filled');
  assert.equal(count(sent, /GET \/v2\/orders$/), 2);
});

test('reads step back as the login\'s quota fills, before the stops and targets do', () => {
  assert.equal(bookShareMs(0), BOOK_SHARE_MS);
  assert.equal(bookShareMs(49.9), BOOK_SHARE_MS);
  assert.equal(bookShareMs(50), BOOK_SHARE_BUSY_MS);
  assert.equal(bookShareMs(70), BOOK_SHARE_FULL_MS);
});

test('[critical] a book that cannot be read is no answer: each order is asked on its own, as before', async () => {
  const single = rowOf(3);
  const sent: string[] = [];
  globalThis.fetch = (async (url: string | URL) => {
    const u = new URL(String(url));
    sent.push(u.pathname);
    if (u.pathname === '/v2/orders') return new Response(JSON.stringify({ success: false, error: { code: 'internal_server_error' } }), { status: 500 });
    return okJson(single);
  }) as typeof fetch;
  const o = await new DeltaExchange(CREDS).getRestingOrder('c3');
  assert.equal(o?.clientOrderId, 'c3');
  assert.ok(sent.some((p) => p.includes('client_order_id')));
});

test('[critical] Delta says wait: the second search is not tried, nothing more is sent, and the answer is "could not ask", not "no such order"', async () => {
  const sent: string[] = [];
  globalThis.fetch = (async (url: string | URL) => {
    sent.push(new URL(String(url)).pathname);
    return new Response('{}', { status: 429, headers: { 'X-RATE-LIMIT-RESET': '3000' } });
  }) as typeof fetch;
  const ex = new DeltaExchange(CREDS);
  await assert.rejects(ex.getOrderByClientId('c0', 'C-BTC-80000-080926'), (e) => e instanceof ExchangeUnavailable);
  assert.equal(sent.length, 1);
  await assert.rejects(ex.getOrderByClientId('c0', 'C-BTC-80000-080926'), (e) => e instanceof ExchangeUnavailable);
  await assert.rejects(ex.getRestingOrder('c0', 'C-BTC-80000-080926'), (e) => e instanceof ExchangeUnavailable);
  assert.equal(sent.length, 1);
});

/** A protected short, on a rig whose exchange counts what a poll asks. */
async function protectedShort(boardQuote?: Parameters<typeof rig>[0] extends infer O ? (O extends { boardQuote?: infer B } ? B : never) : never) {
  const symbol = ceProduct().symbol;
  const r = rig({ quotes: [quote(symbol, 20, 20.5)], boardQuote });
  const plan = planFor(ceProduct(), { lots: 1, stopPrice: 70, takeProfitPrice: 2, entry: { type: 'limit', limitPrice: 20, timeoutMs: 0, marketFallback: false, chase: null } });
  await r.engine.open(plan);
  await r.engine.poll(plan.tradeId);
  await r.engine.poll(plan.tradeId);
  const rec = r.store.peek(plan.tradeId)!;
  assert.ok(rec.state.protection.stopLoss && rec.state.protection.takeProfit, 'protected');
  return { r, plan, rec };
}

test('[critical] a poll reads a protected trade\'s target and stop through the shared read, and a working entry on its own', async () => {
  const { r, plan, rec } = await protectedShort();
  const shared: string[] = [], single: string[] = [];
  const ex = r.ex as unknown as { getRestingOrder?: (c: string, s?: string) => Promise<unknown>; getOrderByClientId: (c: string, s?: string) => Promise<unknown> };
  const realSingle = ex.getOrderByClientId.bind(r.ex);
  ex.getRestingOrder = (c, s) => { shared.push(c); return realSingle(c, s); };
  ex.getOrderByClientId = (c, s) => { single.push(c); return realSingle(c, s); };
  await r.engine.poll(plan.tradeId);
  assert.deepEqual([...shared].sort(), [rec.state.protection.stopLoss, rec.state.protection.takeProfit].sort());
  assert.deepEqual(single, []);
});

test('[critical] the loop\'s stop check is on the board while it is fresh; a stale board asks Delta', async () => {
  const symbol = ceProduct().symbol;
  let board: ReturnType<typeof quote> | null = null;
  const { r, plan } = await protectedShort((() => board) as never);
  let asked = 0;
  const ex = r.ex as unknown as { getQuote: (s: string) => Promise<unknown> };
  const realQuote = ex.getQuote.bind(r.ex);
  ex.getQuote = (s) => { asked++; return realQuote(s); };
  board = { ...quote(symbol, 20, 20.5), ts: r.now() };
  await r.engine.poll(plan.tradeId);
  assert.equal(asked, 0, 'fresh board: Delta is not asked');
  board = { ...quote(symbol, 20, 20.5), ts: r.now() - 60_000 };
  await r.engine.poll(plan.tradeId);
  assert.ok(asked > 0, 'stale board: Delta is asked');
});

test('[critical] a stop reached on the fresh board closes the trade from the loop, as the watch would', async () => {
  const symbol = ceProduct().symbol;
  let board: ReturnType<typeof quote> | null = null;
  const { r, plan } = await protectedShort((() => board) as never);
  r.ex.setQuote(quote(symbol, 90, 91));
  board = { ...quote(symbol, 90, 91), ts: r.now() };
  await r.engine.poll(plan.tradeId);
  r.advance(4_000);
  board = { ...quote(symbol, 90, 91), ts: r.now() };
  await r.engine.poll(plan.tradeId);
  const after = r.store.peek(plan.tradeId)!;
  assert.ok(after.state.phase === 'exit_pending' || after.state.position === 0, `closing, phase ${after.state.phase}`);
});

/** The real engine and the real client over 250 protected trades, against a Delta stood in for: what one pass spends. */
async function passOf250(oldWay: boolean) {
  const symbol = ceProduct().symbol;
  const r = rig({ quotes: [quote(symbol, 20, 20.5)], boardQuote: (() => ({ ...quote(symbol, 20, 20.5), ts: r.now() })) as never });
  const plan = planFor(ceProduct(), { lots: 1, stopPrice: 70, takeProfitPrice: 2, entry: { type: 'limit', limitPrice: 20, timeoutMs: 0, marketFallback: false, chase: null } });
  await r.engine.open(plan);
  await r.engine.poll(plan.tradeId);
  await r.engine.poll(plan.tradeId);
  // One protected trade, as the store holds it, 250 times over: each its own id and its own two orders.
  const one = r.store.peek(plan.tradeId)!;
  assert.ok(one.state.protection.stopLoss && one.state.protection.takeProfit);
  const ids: string[] = [];
  for (let i = 0; i < 250; i++) {
    const tradeId = `t${i}`;
    const copy = structuredClone(one);
    copy.state.tradeId = tradeId; copy.plan.tradeId = tradeId;
    copy.state.protection = { takeProfit: `${tradeId}-tp`, stopLoss: `${tradeId}-sl` };
    await r.store.save(copy);
    ids.push(tradeId);
  }
  const rows = new Map<string, Row>();
  assert.equal(new Set(ids).size, 250);
  // The two orders as the engine really placed them, so nothing in a pass finds them out of place.
  const placed = await r.ex.getOpenOrders();
  const tpo = placed.find((o) => o.clientOrderId === one.state.protection.takeProfit)!;
  const slo = placed.find((o) => o.clientOrderId === one.state.protection.stopLoss)!;
  ids.forEach((id, i) => {
    const p = r.store.peek(id)!.state.protection;
    rows.set(p.takeProfit!, rowOf(2 * i, { client_order_id: p.takeProfit!, size: tpo.size, unfilled_size: tpo.size, limit_price: String(tpo.limitPrice), reduce_only: true }));
    rows.set(p.stopLoss!, rowOf(2 * i + 1, { client_order_id: p.stopLoss!, size: slo.size, unfilled_size: slo.size, limit_price: String(slo.limitPrice), stop_price: String(slo.stopPrice), stop_order_type: 'stop_loss_order', state: 'pending', reduce_only: true }));
  });
  const sent = delta(() => [...rows.values()], (cid) => okJson(rows.get(cid) ?? null));
  const ex = new DeltaExchange({ key: `pass-${oldWay}`, secret: 's' });
  if (oldWay) Object.defineProperty(ex, 'getRestingOrder', { value: undefined });
  (r.engine as unknown as { d: { exchange: unknown } }).d.exchange = ex;
  // The first pass settles copied trades (`anchored`); a running pass is the second, with the book's moment over.
  for (const id of ids) await r.engine.poll(id);
  sent.length = 0;
  const later = Date.now() + BOOK_SHARE_FULL_MS + 1;
  Date.now = () => later;
  for (const id of ids) await r.engine.poll(id);
  Date.now = realNow;
  const units = sent.reduce((n, s) => { const [m, path] = s.split(' ') as [string, string]; return n + costOf(m, path).units; }, 0);
  return { sent, units };
}

test('[critical] one pass over 250 trades, the whole engine: 15 units in place of 1,500, and nothing else grows', { timeout: 120_000 }, async () => {
  const before = await passOf250(true);
  const after = await passOf250(false);
  assert.equal(count(before.sent, /client_order_id/), 500);
  assert.equal(before.units, 1_500);
  assert.equal(count(after.sent, /client_order_id/), 0);
  // The book: 5 pages. Everything asked is that read: a faster pass has spent nothing elsewhere.
  assert.equal(after.sent.length, 5, after.sent.join(', '));
  assert.equal(after.units, 15);
});

test('[critical] a pass is paced only past what fits its second: ~5 s round at 250 trades, nothing added at 50', () => {
  assert.equal(passPaceMs(0), 0);
  assert.equal(passPaceMs(50), 0);
  assert.equal(passPaceMs(51), 20);
  assert.equal(passPaceMs(250) * 250, 5_000);
});

test('[critical] a board that throws does not cost the trade its stop check: Delta is asked, and the poll goes on', async () => {
  const { r, plan } = await protectedShort((() => { throw new Error('board broken'); }) as never);
  let asked = 0;
  const ex = r.ex as unknown as { getQuote: (s: string) => Promise<unknown> };
  const realQuote = ex.getQuote.bind(r.ex);
  ex.getQuote = (s) => { asked++; return realQuote(s); };
  await r.engine.poll(plan.tradeId);
  assert.ok(asked > 0);
});
