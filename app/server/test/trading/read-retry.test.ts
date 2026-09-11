import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// These failures are logged, and the log's file is fixed when paths.ts is first
// imported -- so point it somewhere disposable before anything imports it, or
// the fake outages below land in the desk's own errors.db.
process.env.ERROR_DB = join(mkdtempSync(join(tmpdir(), 'read-retry-')), 'errors.db');
const { DeltaExchange } = await import('../../src/trading/exchange/delta.js');
const { DeltaRefused } = await import('../../src/delta/signed.js');
const { ExchangeUnavailable } = await import('../../src/trading/exchange/port.js');
type DeltaExchange = InstanceType<typeof DeltaExchange>;

/**
 * What the desk makes of Delta failing, as opposed to Delta saying no.
 *
 * Three rows from the live log on 10 September 2026:
 *
 *   21:35  GET /v2/orders/history   internal_server_error, once; the next poll
 *          a second later was fine.
 *   22:30  GET /v2/products/        "refused (http_200)": Delta's whole 3.7 MB
 *          product list, asked for by mistake, arriving unreadable.
 *
 * A read changes nothing on the account, so asking again is safe. Beyond that,
 * Delta's trouble must never be read as an answer: a lookup that fails is not
 * "no such order", and a cancel that fails is not "already gone".
 *
 * Writes are never resent: an order Delta may already have acted on could open
 * a second position.
 */

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

const creds = { key: 'k', secret: 's' };

type Reply = { status: number; body: unknown };

/** A transport that answers with the given replies in turn, and counts. */
function answers(...replies: Reply[]) {
  const seen: string[] = [];
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    seen.push(`${init?.method ?? 'GET'} ${String(url)}`);
    const r = replies[Math.min(seen.length - 1, replies.length - 1)]!;
    // a string goes out as it is, so a reply can arrive broken
    return new Response(typeof r.body === 'string' ? r.body : JSON.stringify(r.body), { status: r.status });
  }) as typeof fetch;
  return seen;
}

const serverError: Reply = { status: 500, body: { success: false, error: { code: 'internal_server_error' } } };
const okOrders: Reply = { status: 200, body: { success: true, result: [] } };
const cutOff: Reply = { status: 200, body: '{"success":true,"result":[{"symbol":"C-BTC-' };

const call = (ex: DeltaExchange, req: { method: string; path: string; body?: unknown }) =>
  (ex as unknown as { call: (r: typeof req) => Promise<unknown> }).call(req);

test('[critical] a read that Delta fails once is asked again, and the answer comes back', async () => {
  const seen = answers(serverError, okOrders);
  const result = await call(new DeltaExchange(creds), { method: 'GET', path: '/v2/orders/history' });
  assert.deepEqual(result, []);
  assert.equal(seen.length, 2, 'one failure, one retry');
});

test('[critical] a read Delta fails twice is an outage, and throws rather than reading as an answer', async () => {
  const seen = answers(serverError, serverError);
  await assert.rejects(
    call(new DeltaExchange(creds), { method: 'GET', path: '/v2/orders/history' }),
    (e: unknown) => e instanceof ExchangeUnavailable && /internal_server_error/.test((e as Error).message),
  );
  assert.equal(seen.length, 2, 'asked twice, not forever');
});

test('a 4xx is Delta saying no on purpose, and is not asked again', async () => {
  const seen = answers({ status: 400, body: { success: false, error: { code: 'bad_schema' } } }, okOrders);
  await assert.rejects(call(new DeltaExchange(creds), { method: 'GET', path: '/v2/orders' }), DeltaRefused);
  assert.equal(seen.length, 1);
});

test('[critical] a write that Delta fails is never sent twice', async () => {
  const seen = answers(serverError, okOrders);
  await assert.rejects(
    call(new DeltaExchange(creds), { method: 'DELETE', path: '/v2/orders', body: { id: 1, product_id: 1 } }),
    ExchangeUnavailable,
  );
  assert.equal(seen.length, 1, 'a resend could act twice on the account');
});

test('[critical] a success reply that arrives cut off is asked again, not called a refusal', async () => {
  const seen = answers(cutOff, okOrders);
  const result = await call(new DeltaExchange(creds), { method: 'GET', path: '/v2/orders' });
  assert.deepEqual(result, []);
  assert.equal(seen.length, 2);
});

test('cut off twice is an outage, and says the reply could not be read', async () => {
  answers(cutOff, cutOff);
  await assert.rejects(
    call(new DeltaExchange(creds), { method: 'GET', path: '/v2/orders' }),
    (e: unknown) => e instanceof ExchangeUnavailable && /could not be read/.test((e as Error).message),
  );
});

test('[critical] a cancel that Delta\'s server fails is not taken as "already gone"', async () => {
  const seen = answers(serverError);
  await assert.rejects(new DeltaExchange(creds).cancelOrder({ orderId: '1', productId: 1 }), ExchangeUnavailable);
  assert.equal(seen.length, 1, 'and it is not sent twice');
});

test('a cancel Delta refuses on purpose -- the order is already gone -- still counts as done', async () => {
  answers({ status: 400, body: { success: false, error: { code: 'open_order_not_found' } } });
  await new DeltaExchange(creds).cancelOrder({ orderId: '1', productId: 1 });
});

test('[critical] an order lookup that Delta\'s server fails throws, rather than saying the order never existed', async () => {
  answers(serverError);
  await assert.rejects(new DeltaExchange(creds).getOrderByClientId('009261789000000000E0'), ExchangeUnavailable);
});

test('[critical] no symbol is not a product lookup: nothing is fetched', async () => {
  const seen = answers(okOrders);
  assert.equal(await new DeltaExchange(creds).getProduct(''), null);
  assert.equal(seen.length, 0, 'the 3.7 MB product list is never downloaded');
});

test('[critical] an order Delta\'s server fails on is "unknown", never "rejected" -- and is not resent', async () => {
  const { SubmitTimeout, OrderRejected } = await import('../../src/trading/exchange/port.js');
  const seen = answers(serverError);
  await assert.rejects(
    new DeltaExchange(creds).placeOrder({
      clientOrderId: '009261789000000000E0', symbol: 'C-BTC-79800-110926', productId: 1,
      side: 'sell', type: 'limit', size: 1, limitPrice: 19, role: 'entry',
    }),
    // rejected means "certainly not on the book"; a 500 cannot promise that
    (e: unknown) => e instanceof SubmitTimeout && !(e instanceof OrderRejected),
  );
  assert.equal(seen.length, 1);
});

test('an order Delta refuses on purpose is still rejected', async () => {
  const { OrderRejected } = await import('../../src/trading/exchange/port.js');
  answers({ status: 400, body: { success: false, error: { code: 'insufficient_margin' } } });
  await assert.rejects(
    new DeltaExchange(creds).placeOrder({
      clientOrderId: '009261789000000000E1', symbol: 'C-BTC-79800-110926', productId: 1,
      side: 'sell', type: 'limit', size: 1, limitPrice: 19, role: 'entry',
    }),
    OrderRejected,
  );
});

test('a reply that is a list of products is not cached as one product', async () => {
  answers({ status: 200, body: { success: true, result: [{ symbol: 'C-BTC-79800-110926' }] } });
  assert.equal(await new DeltaExchange(creds).getProduct('C-BTC-79800-110926'), null);
});
