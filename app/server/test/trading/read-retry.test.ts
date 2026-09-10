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
type DeltaExchange = InstanceType<typeof DeltaExchange>;

/**
 * A read that Delta's own server fails is asked once more, quietly.
 *
 * Observed on the live account, 10 September 2026, 21:35 IST: GET
 * /v2/orders/history answered `internal_server_error`, once, and the next poll a
 * second later was fine. It still became a red row in the error log. A read
 * changes nothing on the account, so asking again is safe -- the same reasoning
 * that already covered reads that time out.
 *
 * Writes are the opposite: resending an order Delta may already have acted on
 * could open a second position. Those are never retried.
 */

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

const creds = { key: 'k', secret: 's' };

/** A transport that answers with the given statuses in turn, and counts. */
function answers(...replies: Array<{ status: number; body: unknown }>) {
  const seen: string[] = [];
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    seen.push(`${init?.method ?? 'GET'} ${String(url)}`);
    const r = replies[Math.min(seen.length - 1, replies.length - 1)]!;
    return new Response(JSON.stringify(r.body), { status: r.status });
  }) as typeof fetch;
  return seen;
}

const serverError = { status: 500, body: { success: false, error: { code: 'internal_server_error' } } };
const okOrders = { status: 200, body: { success: true, result: [] } };

const call = (ex: DeltaExchange, req: { method: string; path: string; body?: unknown }) =>
  (ex as unknown as { call: (r: typeof req) => Promise<unknown> }).call(req);

test('[critical] a read that Delta fails once is asked again, and the answer comes back', async () => {
  const seen = answers(serverError, okOrders);
  const result = await call(new DeltaExchange(creds), { method: 'GET', path: '/v2/orders/history' });
  assert.deepEqual(result, []);
  assert.equal(seen.length, 2, 'one failure, one retry');
});

test('a read Delta fails twice still fails, so a real outage is not hidden', async () => {
  const seen = answers(serverError, serverError);
  await assert.rejects(
    call(new DeltaExchange(creds), { method: 'GET', path: '/v2/orders/history' }),
    (e: unknown) => e instanceof DeltaRefused && e.code === 'internal_server_error',
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
    DeltaRefused,
  );
  assert.equal(seen.length, 1, 'a resend could act twice on the account');
});
