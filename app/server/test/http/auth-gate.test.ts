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
process.env.TRADE_DB = join(dir, 'trades.db');
process.env.ERROR_DB = join(dir, 'errors.db');
process.env.CHAIN_DB = join(dir, 'chain.db');
process.env.DELTA_LIVE_TRADING = '0';
const { hashPassword, COOKIE } = await import('../../src/http/session.js');
const { buildApp } = await import('../../src/http/app.js');
const { AuthService } = await import('../../src/auth/service.js');
const { AuthStore } = await import('../../src/auth/store.js');
const { Secrets } = await import('../../src/auth/secrets.js');

type App = Awaited<ReturnType<typeof buildApp>>;
let app: App;
const store = new AuthStore(join(dir, 'auth.db'));
store.seedUser('desk', hashPassword('correct horse battery'), Date.now());
// a fully signed-in session, written as sign-in would write it
store.createSession({ token: 'full-session-token', stage: 'full', now: Date.now(), ttlMs: 3_600_000, ip: null, userAgent: null });
before(async () => { app = await buildApp({ auth: new AuthService({ store, secrets: new Secrets('test-secret'), now: Date.now }) }); });
after(async () => { await app.close(); });

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
