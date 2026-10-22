import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';

/**
 * The screen's own choices, kept by the desk (22 Oct 2026, owner: "what I choose in the backtest and the portfolio --
 * keep it on the database side"; "collapse and expand the same"): one row a choice, the newer set wins.
 */
process.env.DESK_SESSION_SECRET = 'ui-settings-master';
process.env.DELTA_LIVE_TRADING = '0';
const { hashPassword, COOKIE } = await import('../../src/http/session.js');
const { buildApp } = await import('../../src/http/app.js');
const { AuthService } = await import('../../src/auth/service.js');
const { AuthStore } = await import('../../src/auth/store.js');
const { Secrets } = await import('../../src/auth/secrets.js');
const { closePool } = await import('../../src/db/pool.js');
const { initTradingService, tradingService } = await import('../../src/trading/service.js');
const { initStrategyStore } = await import('../../src/http/routes/strategy.routes.js');
const { MAX_VALUE_BYTES } = await import('../../src/ui/settings.js');

await initTradingService();
await initStrategyStore();
const auth = await AuthStore.open();
await auth.seedUser('desk', hashPassword('correct horse battery'), Date.now());
await auth.createSession({ token: 'ui-session', stage: 'full', now: Date.now(), ttlMs: 3_600_000, ip: null, userAgent: null });
type App = Awaited<ReturnType<typeof buildApp>>;
let app: App;
before(async () => { app = await buildApp({ auth: new AuthService({ store: auth, secrets: new Secrets('ui-settings-master'), now: Date.now }) }); });
after(async () => { tradingService().stop(); await app.close(); await closePool(); });
const cookie = { cookie: `${COOKIE}=${encodeURIComponent('ui-session')}` };
const api = async (method: 'GET' | 'PUT' | 'DELETE', url: string, payload?: unknown, signedIn = true) => {
  const r = await app.inject({ method, url, headers: signedIn ? cookie : {}, ...(payload === undefined ? {} : { payload: payload as object }) });
  return { status: r.statusCode, body: r.json() as Record<string, any> };
};

test('[critical] a choice set is read back by every screen: the value as JSON, with when it was set', async () => {
  const params = { rule: 'delta', value: 0.1, deskMax: 111, strikePct: 20, strikeFull: 'next' };
  const put = await api('PUT', '/api/ui-settings', { key: 'signalBacktest.params', value: params, at: Date.now() - 1_000 });
  assert.equal(put.status, 200, JSON.stringify(put.body));
  await api('PUT', '/api/ui-settings', { key: 'signalBacktest.sectionsShut', value: ['Filters', 'Exits'] });
  const all = (await api('GET', '/api/ui-settings')).body.settings;
  assert.deepEqual(all['signalBacktest.params'].value, params);
  assert.deepEqual(all['signalBacktest.sectionsShut'].value, ['Filters', 'Exits'], 'collapsed and expanded, kept the same');
  assert.ok(typeof all['signalBacktest.params'].updatedAt === 'number');
});

test('[critical] the newer set wins: a tab left open with an old choice does not undo one made since', async () => {
  const now = Date.now();
  await api('PUT', '/api/ui-settings', { key: 'signalBacktest.mode', value: 'portfolio', at: now - 100 });
  const stale = await api('PUT', '/api/ui-settings', { key: 'signalBacktest.mode', value: 'single', at: now - 60_000 });
  assert.equal(stale.status, 200);
  assert.deepEqual([stale.body.value, stale.body.updatedAt], ['portfolio', now - 100], 'the one kept is said back');
  assert.equal((await api('GET', '/api/ui-settings')).body.settings['signalBacktest.mode'].value, 'portfolio');
  // A clock ahead is held to now: it cannot freeze the choice against every later set.
  const ahead = await api('PUT', '/api/ui-settings', { key: 'signalBacktest.mode', value: 'single', at: Date.now() + 86_400_000 });
  assert.ok(ahead.body.updatedAt <= Date.now());
  assert.equal((await api('PUT', '/api/ui-settings', { key: 'signalBacktest.mode', value: 'portfolio' })).body.value, 'portfolio');
});

test('[critical] refused: a bad key, no value, too large; and only for the signed-in', async () => {
  for (const key of ['', '1abc', 'has space', 'x'.repeat(101), 'a/b']) assert.equal((await api('PUT', '/api/ui-settings', { key, value: 1 })).status, 400, key);
  assert.equal((await api('PUT', '/api/ui-settings', { key: 'a.b' })).status, 400);
  assert.equal((await api('PUT', '/api/ui-settings', { key: 'a.big', value: 'x'.repeat(MAX_VALUE_BYTES + 10) })).status, 413);
  assert.equal((await api('GET', '/api/ui-settings', undefined, false)).status, 401);
  assert.equal((await api('PUT', '/api/ui-settings', { key: 'a.b', value: 1 }, false)).status, 401);
});

test('back to the default: the row removed', async () => {
  await api('PUT', '/api/ui-settings', { key: 'report:from', value: '2026-07-01' });
  assert.equal((await api('DELETE', '/api/ui-settings/report:from')).status, 200);
  assert.equal((await api('GET', '/api/ui-settings')).body.settings['report:from'], undefined);
});
