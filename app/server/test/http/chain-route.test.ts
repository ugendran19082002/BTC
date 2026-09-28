import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * The chain route answers, or says why.
 *
 * 24 September 2026: a recorder was added to the handler and its call was
 * written above the `const` it reads, so every request died on "Cannot access
 * 'structure' before initialization" -- a temporal dead zone the compiler
 * cannot see through a closure, and which no unit test of the pieces would
 * ever catch. The route was only ever exercised through the browser.
 *
 * This is the cheap guard that would have caught it: drive the handler and
 * assert it never fails *that* way. The upstream exchange is not reachable
 * from a test, so a 502 with a message is a pass -- what is being pinned is
 * that the handler's own body runs, in an order that works.
 */

const dir = mkdtempSync(join(tmpdir(), 'chain-route-'));
process.env.CHAIN_DB = join(dir, 'chain.db');
process.env.DELTA_LIVE_TRADING = '0';
const { hashPassword, COOKIE } = await import('../../src/http/session.js');
const { buildApp } = await import('../../src/http/app.js');
const { AuthService } = await import('../../src/auth/service.js');
const { AuthStore } = await import('../../src/auth/store.js');
const { Secrets } = await import('../../src/auth/secrets.js');
const { closePool } = await import('../../src/db/pool.js');
const { initTradingService } = await import('../../src/trading/service.js');
const { initStrategyStore } = await import('../../src/http/routes/strategy.routes.js');
await initTradingService();
await initStrategyStore();

type App = Awaited<ReturnType<typeof buildApp>>;
let app: App;
const store = await AuthStore.open();
await store.seedUser('desk', hashPassword('correct horse battery'), Date.now());
await store.createSession({ token: 'chain-route-token', stage: 'full', now: Date.now(), ttlMs: 3_600_000, ip: null, userAgent: null });
before(async () => { app = await buildApp({ auth: new AuthService({ store, secrets: new Secrets('test-secret'), now: Date.now }) }); });
after(async () => { await app.close(); await closePool(); });

const session = () => `${COOKIE}=${encodeURIComponent('chain-route-token')}`;

test('[critical] the chain handler runs through, whatever the exchange says', async () => {
  const r = await app.inject({
    method: 'GET',
    url: '/api/chain?at=now&lots=100&mode=safety&width=500&hedgeGap=0&safetyBar=0.988&minPremium=10',
    headers: { cookie: session() },
  });
  assert.ok(r.body.length > 0);
  assert.ok(
    !/before initialization|is not defined|is not a function/.test(r.body),
    `the handler's own body failed: ${r.body.slice(0, 300)}`,
  );
  assert.notEqual(r.statusCode, 500, r.body.slice(0, 300));
});

test('[critical] the routes removed on 28 Sep 2026 stay removed', async () => {
  // Signal history, the warning journal, the term structure, movement, big move
  // risk, the market state and the momentum read, and the backtest / sizing /
  // presets / calibration endpoints nothing called.
  for (const [method, url] of [
    ['GET', '/api/market-state/history?tf=15m&limit=5'], ['GET', '/api/warning/history?window=5&limit=5'],
    ['GET', '/api/market-state?tf=5m'], ['GET', '/api/live'],
    ['GET', '/api/term'], ['GET', '/api/movement'], ['GET', '/api/break-risk'],
    ['GET', '/api/sizing'], ['GET', '/api/presets'], ['GET', '/api/calibration'],
    ['POST', '/api/backtest'], ['POST', '/api/backtest/byyear'],
  ] as const) {
    const r = await app.inject({ method, url, headers: { cookie: session() } });
    assert.equal(r.statusCode, 404, `${method} ${url} → ${r.statusCode}`);
  }
});
