import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * The day's signals, one account's and counted whole (29 Oct 2026, owner: "on the phone, Strategies, the Not taken
 * count is wrong -- cross every value"). The route read the newest 2,000 signals of every account and then kept the
 * account asked for, so once the three accounts together passed 2,000 an account's day lost its morning: at 16:40 IST
 * High read Taken 28 for 286 taken, Not taken 648 for 1,404. Pinned here: the account is asked of the database before
 * the page is cut, and `counts` are over every signal of the range however long the list.
 */

const dir = mkdtempSync(join(tmpdir(), 'signal-trades-counts-'));
process.env.CHAIN_DB = join(dir, 'chain.db');
process.env.DESK_SESSION_SECRET = 'signal-trades-counts-master';
process.env.DELTA_API_KEY = 'cntKEYcntKEYcntKEY1111';
process.env.DELTA_API_SECRET = 'cntSECRETcntSECRETcntSECRETcntSECRETcntSECRET';
process.env.DELTA_LIVE_TRADING = '0';
const { hashPassword, COOKIE } = await import('../../src/http/session.js');
const { buildApp } = await import('../../src/http/app.js');
const { AuthService } = await import('../../src/auth/service.js');
const { AuthStore } = await import('../../src/auth/store.js');
const { Secrets } = await import('../../src/auth/secrets.js');
const { closePool, query } = await import('../../src/db/pool.js');
const { initTradingService, tradingService } = await import('../../src/trading/service.js');
const { initStrategyStore } = await import('../../src/http/routes/strategy.routes.js');
const { brokerAccounts } = await import('../../src/delta/accounts.js');

await initTradingService();
await initStrategyStore();
// The list joins the paper log's setups; the desk migrates them at boot.
await (await import('../../src/entry/paper.js')).entrySchema();
const auth = await AuthStore.open();
await auth.seedUser('desk', hashPassword('correct horse battery'), Date.now());
await auth.createSession({ token: 'counts-session', stage: 'full', now: Date.now(), ttlMs: 3_600_000, ip: null, userAgent: null });

type App = Awaited<ReturnType<typeof buildApp>>;
let app: App;
before(async () => {
  app = await buildApp({ auth: new AuthService({ store: auth, secrets: new Secrets('signal-trades-counts-master'), now: Date.now }) });
});
after(async () => { tradingService().stop(); await app.close(); await closePool(); });

const get = async (url: string) => {
  const r = await app.inject({ method: 'GET', url, headers: { cookie: `${COOKIE}=${encodeURIComponent('counts-session')}` } });
  return { status: r.statusCode, body: r.json() as Record<string, any> };
};

// 20 Oct 2026 IST, from 00:00.
const DAY = '2026-10-20';
const DAY_START = Date.UTC(2026, 9, 19, 18, 30);
const config = JSON.stringify({ trigger: 'signal', signal: { mode: 'single', tf: '5m', methods: ['breakout'], target: 'tp1', maxOpen: 1 } });
let one = 0;
let two = 0;

test('[critical] one account\'s morning is not lost behind another account\'s newer 2,000; the counts are the whole day\'s', async () => {
  one = brokerAccounts().default()!.id;
  two = (await brokerAccounts().create({ name: 'Second', apiKey: 'cntKEYtwoKEYtwo2222', apiSecret: 'cntSECRETtwoSECRETtwoSECRETtwo2222' })).id;
  await query(`INSERT INTO strategies (id, name, enabled, config, created_at, updated_at, broker_account_id) VALUES
    ('cnt-one', 'One 5m', true, $1, 1, 1, $2), ('cnt-two', 'Two 5m', true, $1, 1, 1, $3)`, [config, one, two]);
  // Account one: 30 signals at 07:30 IST, every third taken, the rest with their SL too near.
  await query(`INSERT INTO strategy_signal_runs (strategy_id, signal_key, method, mode, tf, dir, status, detail, at)
    SELECT 'cnt-one', 'breakout|single|5m|1|' || i, 'breakout', 'single', '5m', 1,
           CASE WHEN i % 3 = 0 THEN 'placed' ELSE 'skipped' END,
           CASE WHEN i % 3 = 0 THEN 'sell PE 81400 x1 @ 13' ELSE 'SL too near: the perp entry 81645 to the SL 81705 is 61 pts' END,
           $1::bigint + i * 60000
      FROM generate_series(1, 30) i`, [DAY_START + 7.5 * 3_600_000]);
  // Account two: 2,100 newer signals from 13:30 IST, every one skipped at the desk's cap.
  await query(`INSERT INTO strategy_signal_runs (strategy_id, signal_key, method, mode, tf, dir, status, detail, at)
    SELECT 'cnt-two', 'breakout|single|5m|-1|' || i, 'breakout', 'single', '5m', -1, 'skipped',
           'the desk already has 200 open (positions and working orders, all strategies) -- at most 200 at once across all',
           $1::bigint + i * 1000
      FROM generate_series(1, 2100) i`, [DAY_START + 13.5 * 3_600_000]);

  const mine = await get(`/api/strategies/signal-trades?from=${DAY}&to=${DAY}&account=${one}`);
  assert.equal(mine.status, 200, JSON.stringify(mine.body));
  assert.equal(mine.body.trades.length, 30, 'the account\'s own 30, not none of the newest 2,000');
  assert.ok(mine.body.trades.every((t: any) => t.strategyId === 'cnt-one'));
  assert.deepEqual(mine.body.counts, { all: 30, taken: 10, placed: 10, notTaken: 20, byReason: { 'sl-min': 20 } });

  const theirs = await get(`/api/strategies/signal-trades?from=${DAY}&to=${DAY}&account=${two}`);
  assert.equal(theirs.body.trades.length, 2_000, 'a page of the newest');
  assert.deepEqual(theirs.body.counts, { all: 2_100, taken: 0, placed: 0, notTaken: 2_100, byReason: { 'desk-max': 2_100 } }, 'counted whole');

  const every = await get(`/api/strategies/signal-trades?from=${DAY}&to=${DAY}`);
  assert.equal(every.body.trades.length, 2_000);
  assert.deepEqual(every.body.counts, { all: 2_130, taken: 10, placed: 10, notTaken: 2_120, byReason: { 'sl-min': 20, 'desk-max': 2_100 } });
});

test('no range is the latest page, with no counts: "the latest" has no whole to count', async () => {
  const r = await get('/api/strategies/signal-trades');
  assert.equal(r.status, 200);
  assert.equal(r.body.counts, null);
  assert.ok(r.body.trades.length > 0);
});
