import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { RATE_LIMIT_WAIT_MAX_MS, RATE_LIMIT_WAIT_MIN_MS, RateLimited, clearRateLimitWaits, rateLimitWaitMs, signed } from '../../src/delta/signed.js';

/**
 * A 429 holds that login's calls until the time Delta named (4 Nov 2026: ~78,000 refused calls in twenty minutes, the
 * desk asking again every second for every open trade, so Delta's window never emptied). Fetch is stood in for: what
 * matters is what reaches it.
 */

const A = { key: 'login-a', secret: 's' };
const B = { key: 'login-b', secret: 's' };
const realFetch = globalThis.fetch;
const realNow = Date.now;
let sent: string[] = [];
let answer: () => Response = () => new Response(JSON.stringify({ success: true, result: { ok: 1 } }), { status: 200 });
globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
  sent.push(`${(init?.headers as Record<string, string>)['api-key']} ${String(url).replace(/^https:\/\/[^/]+/, '')}`);
  return answer();
}) as typeof fetch;
const limited = (resetMs: string | null) => () => new Response('{}', { status: 429, headers: resetMs === null ? {} : { 'X-RATE-LIMIT-RESET': resetMs } });
const ok = () => new Response(JSON.stringify({ success: true, result: { ok: 1 } }), { status: 200 });

afterEach(() => { clearRateLimitWaits(); sent = []; answer = ok; Date.now = realNow; });
process.on('exit', () => { globalThis.fetch = realFetch; });

test('[critical] a 429 holds that login: the next calls are refused here, not sent, until the time Delta named', async () => {
  let now = 1_000_000;
  Date.now = () => now;
  answer = limited('3000');
  await assert.rejects(signed(A, { method: 'GET', path: '/v2/positions' }), (e) => e instanceof RateLimited && e.retryAfterMs === 3_000);
  assert.equal(sent.length, 1);
  answer = ok;
  // Inside the wait: refused at once, with what is left of it -- nothing reaches Delta.
  now += 1_000;
  await assert.rejects(signed(A, { method: 'GET', path: '/v2/orders' }), (e) => e instanceof RateLimited && e.retryAfterMs === 2_000);
  assert.equal(sent.length, 1);
  assert.equal(rateLimitWaitMs(A, now), 2_000);
  // Another login is its own: not held.
  assert.deepEqual(await signed(B, { method: 'GET', path: '/v2/positions' }), { ok: 1 });
  assert.equal(sent.length, 2);
  // The wait over: asked again, and answered.
  now += 2_000;
  assert.equal(rateLimitWaitMs(A, now), 0);
  assert.deepEqual(await signed(A, { method: 'GET', path: '/v2/positions' }), { ok: 1 });
  assert.deepEqual(sent, ['login-a /v2/positions', 'login-b /v2/positions', 'login-a /v2/positions']);
});

test('the wait is Delta\'s, kept within a second and a minute; none named is five seconds', async () => {
  const now = 2_000_000;
  Date.now = () => now;
  for (const [header, want] of [['10', RATE_LIMIT_WAIT_MIN_MS], ['9999999', RATE_LIMIT_WAIT_MAX_MS], [null, 5_000], ['nonsense', 5_000]] as const) {
    clearRateLimitWaits();
    answer = limited(header);
    await assert.rejects(signed(A, { method: 'GET', path: '/v2/positions' }), (e) => e instanceof RateLimited && e.retryAfterMs === want);
    assert.equal(rateLimitWaitMs(A, now), want);
  }
});
