import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Pick now (owner, 25 Oct 2026: "a Pick now button: the strategies pick now and update"): the methods' daily update
 * asked for from the Method updates screen. Pinned here: refused in words when no strategy has the update on; started
 * and answered at once (202), done by `GET`, with a row in the log for each strategy it took; a second ask while one
 * runs is 409.
 */

const dir = mkdtempSync(join(tmpdir(), 'auto-methods-run-'));
process.env.CHAIN_DB = join(dir, 'chain.db');
process.env.DESK_SESSION_SECRET = 'auto-methods-run-master';
process.env.DELTA_LIVE_TRADING = '0';
const { hashPassword, COOKIE } = await import('../../src/http/session.js');
const { buildApp } = await import('../../src/http/app.js');
const { AuthService } = await import('../../src/auth/service.js');
const { AuthStore } = await import('../../src/auth/store.js');
const { Secrets } = await import('../../src/auth/secrets.js');
const { closePool } = await import('../../src/db/pool.js');
const { initTradingService, tradingService } = await import('../../src/trading/service.js');
const { initStrategyStore, strategyStore } = await import('../../src/http/routes/strategy.routes.js');
const { DEFAULT_AUTO_METHODS } = await import('../../src/strategy/types.js');

await initTradingService();
await initStrategyStore();
const auth = await AuthStore.open();
await auth.seedUser('desk', hashPassword('correct horse battery'), Date.now());
await auth.createSession({ token: 'pick-now-session', stage: 'full', now: Date.now(), ttlMs: 3_600_000, ip: null, userAgent: null });

type App = Awaited<ReturnType<typeof buildApp>>;
let app: App;
before(async () => {
  app = await buildApp({ auth: new AuthService({ store: auth, secrets: new Secrets('auto-methods-run-master'), now: Date.now }) });
});
after(async () => { tradingService().stop(); await app.close(); await closePool(); });

const cookie = { cookie: `${COOKIE}=${encodeURIComponent('pick-now-session')}` };
const api = async (method: 'GET' | 'POST', url: string, payload?: unknown) => {
  const r = await app.inject({ method, url, headers: cookie, ...(payload === undefined ? {} : { payload: payload as object }) });
  return { status: r.statusCode, body: r.json() as Record<string, any> };
};
const config = (on: boolean) => ({
  trigger: 'signal', signal: { mode: 'single', tf: '5m', methods: ['breakout'], target: 'tp1', maxOpen: 1, autoMethods: { ...DEFAULT_AUTO_METHODS, on } },
  liveOrders: false, entryTime: '09:00', exitTime: '17:00', lots: 1, legs: 'both', strikeRule: 'premium', premium: { mode: 'atMost', usd: 20 },
  entryPrice: 'offer', crossAfterSec: 5, takeProfitPct: 0.9, stopLossPct: 2, weekdays: [0, 1, 2, 3, 4, 5, 6], graceMin: 60,
});
const doneOf = async () => {
  for (let i = 0; i < 200; i++) {
    const r = await api('GET', '/api/strategies/auto-methods/run');
    if (r.body.last && !r.body.last.running) return r.body;
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.fail('the pick never finished');
};

test('[critical] Pick now: refused with none on; started at once, done by GET, a row a strategy; one at a time', async () => {
  const off = await api('POST', '/api/strategies', { name: 'update off', config: config(false) });
  assert.equal(off.status, 200, JSON.stringify(off.body).slice(0, 300));
  const none = await api('POST', '/api/strategies/auto-methods/run', {});
  assert.deepEqual([none.status, none.body.error], [422, 'No signal strategy has its daily update on.']);
  assert.equal((await api('POST', '/api/strategies/auto-methods/run', { strategyId: off.body.strategy.id })).status, 422);
  assert.deepEqual((await api('GET', '/api/strategies/auto-methods/run')).body, { last: null, strategies: 0 });

  const on = await api('POST', '/api/strategies', { name: 'update on', config: config(true) });
  assert.equal(on.status, 200, JSON.stringify(on.body).slice(0, 300));
  const started = await api('POST', '/api/strategies/auto-methods/run', {});
  assert.equal(started.status, 202, JSON.stringify(started.body));
  assert.deepEqual([started.body.running, started.body.strategies], [true, 1]);
  const busy = await api('POST', '/api/strategies/auto-methods/run', {});
  assert.deepEqual([busy.status, busy.body.error], [409, 'A pick is already running: its changes come into the log when it is done.']);

  const done = await doneOf();
  assert.equal(done.strategies, 1);
  assert.equal(done.last.error, null);
  assert.equal(done.last.at, started.body.at);
  const rows = await strategyStore().methodUpdates({ strategyId: on.body.strategy.id });
  assert.equal(rows.length, 1, 'its run kept in the log, changed or not');
  assert.deepEqual([rows[0]!.source, rows[0]!.at], ['daily', started.body.at]);
  assert.equal((await strategyStore().methodUpdates({ strategyId: off.body.strategy.id })).length, 0, 'the update off is not touched');
  assert.equal((await strategyStore().get(on.body.strategy.id))!.config.signal!.autoMethods!.last!.at, started.body.at);
});
