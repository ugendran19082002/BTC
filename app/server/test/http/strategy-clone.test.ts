import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Copying a strategy.
 *
 * The desk's strategies differ from each other by a field or two -- another
 * strike distance, an hour later, a different stop -- and building the second
 * one by hand from the first is how a field gets missed.
 *
 * Its own file, with its own strategies. The lifecycle test arms and runs a
 * strategy on a paper exchange over a shared database, and a second test
 * arming something in the middle of that is how two suites that both pass
 * alone fail together.
 */

const dir = mkdtempSync(join(tmpdir(), 'strategy-clone-'));
process.env.CHAIN_DB = join(dir, 'chain.db');
process.env.DELTA_LIVE_TRADING = '0';
const { hashPassword, COOKIE } = await import('../../src/http/session.js');
const { buildApp } = await import('../../src/http/app.js');
const { AuthService } = await import('../../src/auth/service.js');
const { AuthStore } = await import('../../src/auth/store.js');
const { Secrets } = await import('../../src/auth/secrets.js');
const { closePool, one, query } = await import('../../src/db/pool.js');
const { initTradingService, tradingService } = await import('../../src/trading/service.js');
const { initStrategyStore } = await import('../../src/http/routes/strategy.routes.js');
const { DEFAULT_CONFIG } = await import('../../src/strategy/types.js');

await initTradingService();
await initStrategyStore();
const auth = await AuthStore.open();
await auth.seedUser('desk', hashPassword('correct horse battery'), Date.now());
await auth.createSession({ token: 'clone-session', stage: 'full', now: Date.now(), ttlMs: 3_600_000, ip: null, userAgent: null });

type App = Awaited<ReturnType<typeof buildApp>>;
let app: App;
before(async () => {
  app = await buildApp({ auth: new AuthService({ store: auth, secrets: new Secrets('clone-secret'), now: Date.now }) });
});
after(async () => {
  await query("DELETE FROM strategies WHERE id LIKE 'clone-src%'");
  tradingService().stop();
  await app.close();
  await closePool();
});

const cookie = { cookie: `${COOKIE}=${encodeURIComponent('clone-session')}` };
const api = async (method: 'GET' | 'POST' | 'DELETE', url: string, payload?: unknown) => {
  const r = await app.inject({ method, url, headers: cookie, ...(payload === undefined ? {} : { payload: payload as object }) });
  return { status: r.statusCode, body: r.json() as Record<string, any> };
};

test('[critical] a clone carries every setting, and is never born armed', async () => {
  /*
   * A copy that stayed armed would double the scheduler's position at the
   * moment the operator is least expecting it: they asked for a draft, not a
   * second live rule.
   */
  const made = await api('POST', '/api/strategies', {
    name: 'Clone src', config: { ...DEFAULT_CONFIG, stopMode: 'price', stopLossAt: 70, stopLossPct: 0 },
  });
  assert.equal(made.status, 200, JSON.stringify(made.body));
  await api('POST', '/api/strategies/clone-src/enabled', { enabled: true });

  const r = await api('POST', '/api/strategies/clone-src/clone', { name: 'Clone src later' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.strategy.id, 'clone-src-later');
  assert.equal(r.body.strategy.enabled, false, 'a copy of an armed rule is still a draft');
  assert.equal(r.body.strategy.config.stopLossAt, 70, 'every setting came with it');

  const row = await one<{ enabled: boolean; config: Record<string, unknown> }>(
    "SELECT enabled, config FROM strategies WHERE id = 'clone-src-later'",
  );
  assert.equal(row?.enabled, false);
  assert.equal(row?.config.stopLossAt, 70);

  // The source is untouched, and still armed.
  assert.equal((await one<{ enabled: boolean }>("SELECT enabled FROM strategies WHERE id = 'clone-src'"))?.enabled, true);
  await api('POST', '/api/strategies/clone-src/enabled', { enabled: false });
});

test('a second copy of the same name gets a number, rather than eating the first', async () => {
  const again = await api('POST', '/api/strategies/clone-src/clone', { name: 'Clone src later' });
  assert.equal(again.body.strategy.id, 'clone-src-later-2');
  // and the first copy is still there, with its own settings
  assert.ok(await one("SELECT id FROM strategies WHERE id = 'clone-src-later'"));
});

test('cloning something that is not there says so', async () => {
  assert.equal((await api('POST', '/api/strategies/no-such-rule/clone', {})).status, 404);
});
