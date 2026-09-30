import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * The gate in front of the API.
 *
 * 11 September 2026, found in the security audit: the gate tested the text of
 * the URL, the router decoded it, and `/%61pi/strategies` answered in full with
 * no session. These pin every way a path can be written against the route it
 * reaches, and the two other things a browser request is checked for.
 */

const dir = mkdtempSync(join(tmpdir(), 'gate-'));
process.env.CHAIN_DB = join(dir, 'chain.db');
process.env.DELTA_LIVE_TRADING = '0';
const { hashPassword, COOKIE } = await import('../../src/http/session.js');
const { buildApp } = await import('../../src/http/app.js');
const { AuthService } = await import('../../src/auth/service.js');
const { AuthStore } = await import('../../src/auth/store.js');
const { Secrets } = await import('../../src/auth/secrets.js');
const { closePool } = await import('../../src/db/pool.js');
// The desk is built before the app, as index.ts does: the routes ask for it as they register.
const { initTradingService } = await import('../../src/trading/service.js');
const { initStrategyStore } = await import('../../src/http/routes/strategy.routes.js');
await initTradingService();
await initStrategyStore();

type App = Awaited<ReturnType<typeof buildApp>>;
let app: App;
const store = await AuthStore.open();
await store.seedUser('desk', hashPassword('correct horse battery'), Date.now());
// a fully signed-in session, written as sign-in would write it
await store.createSession({ token: 'full-session-token', stage: 'full', now: Date.now(), ttlMs: 3_600_000, ip: null, userAgent: null });
before(async () => { app = await buildApp({ auth: new AuthService({ store, secrets: new Secrets('test-secret'), now: Date.now }) }); });
after(async () => { await app.close(); await closePool(); });

const session = () => `${COOKIE}=${encodeURIComponent('full-session-token')}`;

test('[critical] a protected route refuses without a session', async () => {
  const r = await app.inject({ method: 'GET', url: '/api/strategies' });
  assert.equal(r.statusCode, 401);
});

test('[critical] no spelling of a protected path gets past the gate', async () => {
  for (const url of [
    '/%61pi/strategies', '/%61%70%69/strategies', '/api/%73trategies', '/%61pi/errors',
    '/%61pi/trade/status', '/api/strategies?x=/api/health', '/api/strategies/',
  ]) {
    const r = await app.inject({ method: 'GET', url });
    assert.ok(r.statusCode === 401 || r.statusCode === 404, `${url} answered ${r.statusCode}: ${r.body.slice(0, 80)}`);
    assert.doesNotMatch(r.body, /schedulerOn|"errors":\[/, `${url} leaked data`);
  }
});

test('[critical] an encoded path to an order-placing route is refused too', async () => {
  const r = await app.inject({ method: 'POST', url: '/%61pi/trade/close-all', payload: {} });
  assert.equal(r.statusCode, 401);
});

test('the public routes stay public', async () => {
  assert.equal((await app.inject({ method: 'GET', url: '/api/health' })).statusCode, 200);
  assert.equal((await app.inject({ method: 'GET', url: '/api/me' })).statusCode, 200);
});

test('[critical] /api/health tells an outsider only that the desk is up', async () => {
  const r = await app.inject({ method: 'GET', url: '/api/health', remoteAddress: '203.0.113.9' });
  assert.equal(r.statusCode, 200);
  assert.deepEqual(Object.keys(r.json()).sort(), ['db', 'now', 'ok'], 'no migration list, counts or feed state');
  assert.deepEqual(r.json().db, { ok: true });
});

test('[critical] a request passed on by a proxy is an outsider, even from loopback', async () => {
  const r = await app.inject({ method: 'GET', url: '/api/health', headers: { 'x-forwarded-for': '203.0.113.9' } });
  assert.equal(r.json().schema, undefined);
});

test('/api/health gives the detail to a signed-in session, and from inside the container', async () => {
  const signedIn = await app.inject({ method: 'GET', url: '/api/health', remoteAddress: '203.0.113.9', headers: { cookie: session() } });
  assert.ok(Array.isArray(signedIn.json().schema), 'the migration ledger, to someone signed in');
  const inside = await app.inject({ method: 'GET', url: '/api/health' });
  assert.ok(Array.isArray(inside.json().schema), 'and to the container itself: the Docker healthcheck, docker compose exec');
});

test('[critical] /api/reload is refused to an outsider, and answers the container itself (refresh.sh)', async () => {
  const outside = await app.inject({ method: 'POST', url: '/api/reload', remoteAddress: '203.0.113.9' });
  assert.equal(outside.statusCode, 401);
  const inside = await app.inject({ method: 'POST', url: '/api/reload' });
  assert.equal(inside.statusCode, 200, inside.body);
  assert.equal(typeof inside.json().days, 'number');
});

test('[critical] the entry section is behind the session; its record answers with one', async () => {
  assert.equal((await app.inject({ method: 'GET', url: '/api/entry/board', remoteAddress: '203.0.113.9' })).statusCode, 401);
  assert.equal((await app.inject({ method: 'GET', url: '/api/entry/record', remoteAddress: '203.0.113.9' })).statusCode, 401);
  const r = await app.inject({ method: 'GET', url: '/api/entry/record', headers: { cookie: session() } });
  assert.equal(r.statusCode, 200, r.body);
  assert.ok(Array.isArray(r.json().records));
});

test('[critical] the gate switches: behind the session, same-origin to change, Data fresh locked on', async () => {
  assert.equal((await app.inject({ method: 'GET', url: '/api/entry/gates', remoteAddress: '203.0.113.9' })).statusCode, 401);
  const own = { cookie: session(), origin: 'https://delta.thannigo.in', host: 'delta.thannigo.in' };
  const list = await app.inject({ method: 'GET', url: '/api/entry/gates', headers: { cookie: session() } });
  assert.equal(list.statusCode, 200, list.body);
  assert.ok(list.json().gates.every((g: { enabled: boolean }) => g.enabled), 'every gate starts on');
  const off = await app.inject({ method: 'POST', url: '/api/entry/gates/rr', payload: { enabled: false }, headers: own });
  assert.equal(off.statusCode, 200, off.body);
  assert.equal(off.json().gates.find((g: { key: string }) => g.key === 'rr').enabled, false);
  const locked = await app.inject({ method: 'POST', url: '/api/entry/gates/data', payload: { enabled: false }, headers: own });
  assert.equal(locked.statusCode, 422);
  assert.equal((await app.inject({ method: 'POST', url: '/api/entry/gates/nope', payload: { enabled: false }, headers: own })).statusCode, 404);
  assert.equal((await app.inject({ method: 'POST', url: '/api/entry/gates/rr', payload: { enabled: 'no' }, headers: own })).statusCode, 400);
  assert.equal((await app.inject({ method: 'POST', url: '/api/entry/gates/rr', payload: { enabled: true }, headers: own })).statusCode, 200);
});

test('[critical] entry alerts: behind the session, same-origin to change, off until switched on; a test with no Telegram says so', async () => {
  assert.equal((await app.inject({ method: 'GET', url: '/api/entry/alerts', remoteAddress: '203.0.113.9' })).statusCode, 401);
  const own = { cookie: session(), origin: 'https://delta.thannigo.in', host: 'delta.thannigo.in' };
  const list = await app.inject({ method: 'GET', url: '/api/entry/alerts', headers: { cookie: session() } });
  assert.equal(list.statusCode, 200, list.body);
  assert.ok(list.json().alerts.every((a: { enabled: boolean }) => !a.enabled), 'off by default');
  const on = await app.inject({ method: 'POST', url: '/api/entry/alerts/single', payload: { enabled: true }, headers: own });
  assert.equal(on.statusCode, 200, on.body);
  assert.equal(on.json().alerts.find((a: { mode: string }) => a.mode === 'single').enabled, true);
  assert.equal((await app.inject({ method: 'POST', url: '/api/entry/alerts/nope', payload: { enabled: true }, headers: own })).statusCode, 404);
  assert.equal((await app.inject({ method: 'POST', url: '/api/entry/alerts/mtf', payload: {}, headers: own })).statusCode, 400);
  const test = await app.inject({ method: 'POST', url: '/api/entry/alerts/test', payload: {}, headers: own });
  assert.ok([200, 409, 502].includes(test.statusCode), test.body);
  await app.inject({ method: 'POST', url: '/api/entry/alerts/single', payload: { enabled: false }, headers: own });
});

test('a session opens the protected routes', async () => {
  const r = await app.inject({ method: 'GET', url: '/api/strategies', headers: { cookie: session() } });
  assert.equal(r.statusCode, 200);
});

test('[critical] no cross-origin reads: no CORS header for a foreign origin', async () => {
  const r = await app.inject({ method: 'GET', url: '/api/me', headers: { origin: 'https://evil.example' } });
  assert.equal(r.headers['access-control-allow-origin'], undefined);
  assert.equal(r.headers['access-control-allow-credentials'], undefined);
});

test('[critical] a change sent from another origin is refused, even with the cookie', async () => {
  for (const origin of ['https://evil.example', 'https://other.thannigo.in']) {
    const r = await app.inject({
      method: 'POST', url: '/api/trade/close-all', payload: {},
      headers: { cookie: session(), origin, host: 'delta.thannigo.in' },
    });
    assert.equal(r.statusCode, 403, origin);
  }
});

test('a change from the desk\'s own origin goes through the gate', async () => {
  const r = await app.inject({
    method: 'POST', url: '/api/strategies/scheduler', payload: { on: false },
    headers: { cookie: session(), origin: 'https://delta.thannigo.in', host: 'delta.thannigo.in' },
  });
  assert.notEqual(r.statusCode, 403);
  assert.notEqual(r.statusCode, 401);
});

test('a Referer from another site counts as that site when there is no Origin', async () => {
  const r = await app.inject({
    method: 'POST', url: '/api/logout',
    headers: { referer: 'https://evil.example/page', host: 'delta.thannigo.in' },
  });
  assert.equal(r.statusCode, 403);
});
