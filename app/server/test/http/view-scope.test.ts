import { after, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RouteOptions } from 'fastify';

/**
 * The phone's view-only sign-in (6 Oct 2026).
 *
 * A session signed in with `view: true` reads the desk -- positions, orders, P&L, accounts, its health -- and
 * changes nothing. The screen that holds it has no buttons, but a lost phone is not trusted to keep to its
 * screen: the gate refuses every write but sign-in, sign-out and the browser's own error reports. These pin
 * that, route by route, so a route added later is closed to a view session until somebody decides otherwise.
 */

const dir = mkdtempSync(join(tmpdir(), 'view-scope-'));
process.env.CHAIN_DB = join(dir, 'chain.db');
process.env.DELTA_LIVE_TRADING = '0';
const { buildApp, viewRefuses } = await import('../../src/http/app.js');
const { AuthService } = await import('../../src/auth/service.js');
const { AuthStore } = await import('../../src/auth/store.js');
const { Secrets } = await import('../../src/auth/secrets.js');
const { hashPassword, COOKIE } = await import('../../src/http/session.js');
const { totp } = await import('../../src/auth/totp.js');
const { closePool, query } = await import('../../src/db/pool.js');
const { initTradingService } = await import('../../src/trading/service.js');
const { initStrategyStore } = await import('../../src/http/routes/strategy.routes.js');
await initTradingService();
await initStrategyStore();

const PASSWORD = 'a long private passphrase';
const T0 = Date.UTC(2026, 9, 6, 6, 0, 0);
const OWN = { origin: 'https://delta.thannigo.in', host: 'delta.thannigo.in' };

type App = Awaited<ReturnType<typeof buildApp>>;
let app: App;
let clock: number;
let store: InstanceType<typeof AuthStore>;
let routes: RouteOptions[];

async function fresh() {
  clock = T0;
  routes = [];
  if (app) await app.close();
  store = await AuthStore.open();
  await query('TRUNCATE auth_user, auth_sessions, auth_recovery_codes, auth_limits, auth_events');
  await store.seedUser('ugendran', hashPassword(PASSWORD), clock);
  const auth = new AuthService({ store, secrets: new Secrets('test-master-secret'), now: () => clock });
  app = await buildApp({ auth, now: () => clock, onRoute: (r) => { routes.push(r); } });
}
beforeEach(fresh);
after(async () => { await app?.close(); await closePool(); });

const tokenFrom = (r: { headers: Record<string, unknown> }) => {
  const raw = r.headers['set-cookie'];
  const line = Array.isArray(raw) ? raw[0] : raw;
  const m = new RegExp(`${COOKIE.replace(/[-]/g, '\\-')}=([^;]*)`).exec(typeof line === 'string' ? line : '');
  return m ? decodeURIComponent(m[1]!) : '';
};
const jar = (token: string) => ({ cookie: `${COOKIE}=${encodeURIComponent(token)}`, ...OWN });

/** Two-step turned on with a full sign-in, as the desk's first sign-in does; returns the authenticator secret. */
async function setUpTwoStep(): Promise<string> {
  const r1 = await app.inject({ method: 'POST', url: '/api/login', payload: { username: 'ugendran', password: PASSWORD }, headers: OWN });
  const setupToken = tokenFrom(r1);
  const { secret } = (await app.inject({ method: 'GET', url: '/api/security/setup', headers: jar(setupToken) })).json() as { secret: string };
  await app.inject({ method: 'POST', url: '/api/security/enable', payload: { code: totp(secret, clock) }, headers: jar(setupToken) });
  return secret;
}

/** A sign-in through the routes, password then code; `view` as the phone sends it. */
async function signIn(secret: string, view: boolean): Promise<string> {
  clock += 31_000;
  const r1 = await app.inject({ method: 'POST', url: '/api/login', payload: { username: 'ugendran', password: PASSWORD, view }, headers: OWN });
  assert.equal(r1.statusCode, 200);
  const r2 = await app.inject({ method: 'POST', url: '/api/login/code', payload: { code: totp(secret, clock) }, headers: jar(tokenFrom(r1)) });
  assert.equal(r2.statusCode, 200, r2.body);
  return tokenFrom(r2);
}

/** A path for a route pattern: every parameter filled with something harmless. */
const pathOf = (url: string) => url.replace(/:[A-Za-z]+/g, '1');

test('[critical] a view sign-in reads the desk the phone shows', async () => {
  const token = await signIn(await setUpTwoStep(), true);
  const me = (await app.inject({ method: 'GET', url: '/api/me', headers: jar(token) })).json();
  assert.equal(me.signedIn, true);
  assert.equal(me.scope, 'view');
  for (const url of [
    '/api/trade/status', '/api/desk/glance', '/api/report/mtm', '/api/report/days', '/api/report/stats', '/api/trade/history',
    '/api/accounts', '/api/strategies', '/api/telegram/log', '/api/entry/methods',
  ]) {
    const r = await app.inject({ method: 'GET', url, headers: jar(token) });
    assert.equal(r.statusCode, 200, `${url}: ${r.body.slice(0, 120)}`);
  }
  // The phone's strategy filter is a read like the rest: the statistics say which strategies there are to choose
  // from, and a strategy asked for that has no trade in the range is still listed, so it can be taken off.
  const stats = await app.inject({ method: 'GET', url: '/api/report/stats?strategy=no-such,manual', headers: jar(token) });
  assert.equal(stats.statusCode, 200, stats.body.slice(0, 120));
  assert.deepEqual(stats.json().strategies.filter((x: { key: string }) => x.key === 'no-such' || x.key === 'manual').map((x: { key: string; name: string; trades: number }) => [x.key, x.name, x.trades]).sort(),
    [['manual', 'By hand', 0], ['no-such', 'no-such', 0]]);
  assert.equal((await app.inject({ method: 'GET', url: '/api/report/days?strategy=no-such', headers: jar(token) })).statusCode, 200);
  // The method filter the same way: its own list, and a method asked for with no trade is still in it.
  const byMethod = await app.inject({ method: 'GET', url: '/api/report/stats?method=breakout&strategy=manual', headers: jar(token) });
  assert.equal(byMethod.statusCode, 200, byMethod.body.slice(0, 120));
  assert.deepEqual(byMethod.json().methods.filter((x: { key: string }) => x.key === 'breakout').map((x: { key: string; trades: number }) => [x.key, x.trades]), [['breakout', 0]]);
  assert.equal((await app.inject({ method: 'GET', url: '/api/report/days?method=breakout', headers: jar(token) })).statusCode, 200);
  // And the timeframe filter, the timeframe chain being one of its choices, named for the screen.
  const byTf = await app.inject({ method: 'GET', url: '/api/report/stats?tf=chain,15m', headers: jar(token) });
  assert.equal(byTf.statusCode, 200, byTf.body.slice(0, 120));
  assert.deepEqual(byTf.json().timeframes.map((x: { key: string; name: string; trades: number }) => [x.key, x.name, x.trades]), [['15m', '15m', 0], ['chain', 'With timeframe chain', 0]]);
  assert.equal((await app.inject({ method: 'GET', url: '/api/report/days?tf=chain', headers: jar(token) })).statusCode, 200);
});

test('[critical] a view session is refused every write but sign-in, sign-out and error reports -- every route the app has', async () => {
  const token = await signIn(await setUpTwoStep(), true);
  const writes = routes.flatMap((r) => (Array.isArray(r.method) ? r.method : [r.method]).map((m) => ({
    method: m, url: r.url, stage: (r.config as { auth?: string } | undefined)?.auth ?? 'full',
  }))).filter((r) => ['POST', 'PUT', 'PATCH', 'DELETE'].includes(r.method));
  assert.ok(writes.length > 30, `the sweep found the app's write routes (${writes.length})`);
  for (const w of writes) {
    if (['/api/login', '/api/login/code', '/api/logout', '/api/errors'].includes(w.url)) continue;
    const r = await app.inject({ method: w.method as 'POST', url: pathOf(w.url), payload: {}, headers: jar(token) });
    if (w.stage === 'setup' || w.stage === 'totp') {
      // A step of signing in (two-step setup): a signed-in session is the wrong stage for it, view or not.
      assert.equal(r.statusCode, 401, `${w.method} ${w.url} answered ${r.statusCode}`);
      continue;
    }
    assert.equal(r.statusCode, 403, `${w.method} ${w.url} answered ${r.statusCode}: ${r.body.slice(0, 120)}`);
    assert.equal(r.json().viewOnly, true, `${w.method} ${w.url} was refused by the view rule, not by something else`);
  }
});

test('[critical] a view session cannot read the security page, and is still signed in after trying', async () => {
  const token = await signIn(await setUpTwoStep(), true);
  const r = await app.inject({ method: 'GET', url: '/api/security', headers: jar(token) });
  assert.equal(r.statusCode, 403);
  assert.equal((await app.inject({ method: 'GET', url: '/api/trade/status', headers: jar(token) })).statusCode, 200);
});

test('a view session may report its own errors and sign itself out', async () => {
  const token = await signIn(await setUpTwoStep(), true);
  const report = await app.inject({ method: 'POST', url: '/api/errors', payload: { message: 'phone: test', where: 'glance' }, headers: jar(token) });
  assert.notEqual(report.statusCode, 403, report.body);
  const out = await app.inject({ method: 'POST', url: '/api/logout', headers: jar(token) });
  assert.equal(out.statusCode, 200);
  assert.equal((await app.inject({ method: 'GET', url: '/api/trade/status', headers: jar(token) })).statusCode, 401);
});

test('[critical] a full sign-in is untouched: writes reach their route, and its scope says full', async () => {
  const token = await signIn(await setUpTwoStep(), false);
  assert.equal((await app.inject({ method: 'GET', url: '/api/me', headers: jar(token) })).json().scope, 'full');
  // A bad body, answered by the route itself (400), not refused at the gate (403).
  const r = await app.inject({ method: 'POST', url: '/api/trade/mode', payload: { mode: 'neither' }, headers: jar(token) });
  assert.equal(r.statusCode, 400, r.body);
});

test('the account page marks the phone\'s session as view only', async () => {
  const secret = await setUpTwoStep();
  await signIn(secret, true);
  const full = await signIn(secret, false);
  const a = (await app.inject({ method: 'GET', url: '/api/security', headers: jar(full) })).json() as { sessions: { current: boolean; viewOnly: boolean }[] };
  assert.equal(a.sessions.filter((s) => s.viewOnly).length, 1);
  assert.equal(a.sessions.find((s) => s.current)!.viewOnly, false);
});

test('a session from before the scope existed reads as full', async () => {
  await store.createSession({ token: 'older', stage: 'full', now: clock, ttlMs: 3_600_000, ip: null, userAgent: null });
  assert.equal((await store.session('older', clock))!.scope, 'full');
});

test('the rule itself: writes refused but the four, the security page hidden, every other read allowed', () => {
  assert.equal(viewRefuses('POST', '/api/trade/place'), true);
  assert.equal(viewRefuses('DELETE', '/api/strategies/:id'), true);
  assert.equal(viewRefuses('POST', '/api/logout'), false);
  assert.equal(viewRefuses('GET', '/api/security'), true);
  assert.equal(viewRefuses('GET', '/api/trade/status'), false);
});
