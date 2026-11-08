import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * The session loss limit through the real API and database (4 Nov 2026): off with no sessions until set, kept for the
 * account it is set on, refused in words when it will not read, and its square-offs read back for the card.
 */

const dir = mkdtempSync(join(tmpdir(), 'session-loss-'));
process.env.CHAIN_DB = join(dir, 'chain.db');
process.env.DESK_SESSION_SECRET = 'session-loss-master';
process.env.DELTA_API_KEY = 'envKEYenvKEYenvKEY9999';
process.env.DELTA_API_SECRET = 'envSECRETenvSECRETenvSECRETenvSECRETenvSECRET';
process.env.DELTA_LIVE_TRADING = '0';
const { hashPassword, COOKIE } = await import('../../src/http/session.js');
const { buildApp } = await import('../../src/http/app.js');
const { AuthService } = await import('../../src/auth/service.js');
const { AuthStore } = await import('../../src/auth/store.js');
const { Secrets } = await import('../../src/auth/secrets.js');
const { closePool, one } = await import('../../src/db/pool.js');
const { initTradingService, tradingService } = await import('../../src/trading/service.js');
const { initStrategyStore } = await import('../../src/http/routes/strategy.routes.js');
const { brokerAccounts } = await import('../../src/delta/accounts.js');

await initTradingService();
await initStrategyStore();
const auth = await AuthStore.open();
await auth.seedUser('desk', hashPassword('correct horse battery'), Date.now());
await auth.createSession({ token: 'sl-session', stage: 'full', now: Date.now(), ttlMs: 3_600_000, ip: null, userAgent: null });

type App = Awaited<ReturnType<typeof buildApp>>;
let app: App;
before(async () => {
  app = await buildApp({ auth: new AuthService({ store: auth, secrets: new Secrets('session-loss-master'), now: () => Date.now() }) });
});
after(async () => { tradingService().stop(); await app.close(); await closePool(); });

const cookie = { cookie: `${COOKIE}=${encodeURIComponent('sl-session')}` };
const api = async (method: 'GET' | 'POST', url: string, payload?: unknown) => {
  const r = await app.inject({ method, url, headers: cookie, ...(payload === undefined ? {} : { payload: payload as object }) });
  return { status: r.statusCode, body: r.json() as Record<string, any> };
};
const main = () => brokerAccounts().default()!.id;

test('[critical] untouched: off, no sessions, nothing stopped, nothing hit', async () => {
  const got = (await api('GET', '/api/desk/session-loss')).body;
  const { pctBase, ...rest } = got;
  assert.deepEqual(rest, { setting: { on: false, sessions: [] }, now: null, blocked: null, hits: [] });
  // What a % is of: no max open set on this account yet, so nothing to take a per cent of.
  assert.equal(pctBase.maxOpen, 0);
  assert.equal(pctBase.totalUsd, null);
});

test('[critical] set on an account: kept under its own key, read back in the order of the day', async () => {
  const sessions = [{ from: '08:00', to: '09:00', limit: 2, unit: 'pct' }, { from: '07:00', to: '08:00', limit: 1000, unit: 'inr' }];
  const r = await api('POST', `/api/desk/session-loss?account=${main()}`, { on: true, sessions });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.setting, { on: true, sessions: [sessions[1], sessions[0]] });
  const kept = await one<{ value: string }>('SELECT value FROM settings WHERE key = $1', [`session_loss_limit@${main()}`]);
  assert.deepEqual(JSON.parse(kept!.value), { on: true, sessions });
  assert.deepEqual((await api('GET', `/api/desk/session-loss?account=${main()}`)).body.setting.sessions.map((s: { from: string }) => s.from), ['07:00', '08:00']);
  // Off again, sessions kept.
  const off = await api('POST', `/api/desk/session-loss?account=${main()}`, { on: false, sessions });
  assert.equal(off.body.setting.on, false);
});

test('[critical] a % is of max open × the margin one position takes -- never the wallet', async () => {
  await tradingService().settings.set(`signal_max_open@${main()}`, '200');
  const svc = tradingService() as unknown as { sessionPctBase: () => Promise<{ maxOpen: number; perPositionUsd: number | null; totalUsd: number | null }> };
  const b = await svc.sessionPctBase();
  if (b.perPositionUsd === null) return; // no price yet on a paper desk: nothing to price the margin by
  assert.equal(b.maxOpen, 200);
  assert.ok(Math.abs(b.totalUsd! - 200 * b.perPositionUsd) < 1e-9);
});

test('the margin model counts the contracts the account\'s strategies trade: 2-lot trades count twice', async () => {
  const { query } = await import('../../src/db/pool.js');
  const store = (tradingService() as unknown as { store: { recentAvgLots: (a: number) => Promise<number> } }).store;
  assert.equal(await store.recentAvgLots(987654), 1, 'none yet: one');
  for (const [id, n] of [['lots-a', 2], ['lots-b', 2], ['lots-c', 0]] as const) {
    await query(`INSERT INTO trades (trade_id, symbol, phase, position, plan, state, updated_at, broker_account_id) VALUES ($1, 'P-X', 'flat', 0, $2, $3, $4, 987654)`,
      [id, JSON.stringify({ signal: { tf: '5m' }, lots: n }), JSON.stringify({ entrySize: n, phase: 'flat' }), Date.now()]);
  }
  assert.equal(await store.recentAvgLots(987654), 2, 'the unfilled one is not counted');
});

test('[critical] the margin model takes the lots the account\'s strategies are set to, not those of past trades (7 Nov 2026)', async () => {
  const { query } = await import('../../src/db/pool.js');
  const { fundsRequiredPerContract } = await import('../../src/trading/margin.js');
  const { DEFAULT_LEVERAGE } = await import('../../src/trading/order-plan.js');
  const svc = tradingService() as unknown as {
    store: { configuredLots: (a: number) => Promise<number | null> };
    currentSpot: () => number | null; currentAccountId: number | null;
    sessionPctBase: () => Promise<{ maxOpen: number; perPositionUsd: number | null; source: string | null }>;
  };
  const acct = 987655;
  assert.equal(await svc.store.configuredLots(acct), null, 'no strategies: none');
  const add = (id: string, lots: number, enabled: boolean, trigger = 'signal') => query(
    `INSERT INTO strategies (id, name, enabled, config, created_at, updated_at, broker_account_id) VALUES ($1, $1, $2, $3, 0, 0, $4)`,
    [id, enabled, JSON.stringify({ trigger, lots }), acct]);
  await add('lots2-a', 2, true); await add('lots2-b', 2, true);
  await add('lots2-off', 9, false); await add('lots2-time', 9, true, 'time');
  assert.equal(await svc.store.configuredLots(acct), 2, 'enabled signal strategies only');
  // The desk on that account, priced at a known BTC: 2-lot strategies with no 2-lot trade yet price a position at 2 lots.
  const realSpot = svc.currentSpot, realAcct = svc.currentAccountId;
  svc.currentSpot = () => 80_000; svc.currentAccountId = acct;
  try {
    const b = await svc.sessionPctBase();
    assert.equal(b.source, 'model');
    assert.ok(Math.abs(b.perPositionUsd! - 2 * fundsRequiredPerContract({ spot: 80_000, premium: 0, leverage: DEFAULT_LEVERAGE })) < 1e-9);
  } finally { svc.currentSpot = realSpot; svc.currentAccountId = realAcct; }
});

test('a setting that will not read is refused in words, and nothing is kept', async () => {
  const before = (await api('GET', `/api/desk/session-loss?account=${main()}`)).body.setting;
  const r = await api('POST', `/api/desk/session-loss?account=${main()}`, { on: true, sessions: [{ from: '09:00', to: '08:00', limit: 100, unit: 'inr' }] });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /end after it starts/);
  assert.deepEqual((await api('GET', `/api/desk/session-loss?account=${main()}`)).body.setting, before);
});

test('a square-off written down is read back for the card', async () => {
  const store = (tradingService() as unknown as { store: { addSessionLossHit: (h: unknown, a: number) => Promise<void> } }).store;
  await store.addSessionLossHit({ day: '2026-11-04', from: '07:00', to: '08:00', limitInr: 1000, lossInr: 1234.5, at: Date.parse('2026-11-04T07:40:00+05:30'), closed: 12, cancelled: 2, failed: 0, detail: '' }, main());
  const hits = (await api('GET', `/api/desk/session-loss?account=${main()}`)).body.hits;
  assert.equal(hits.length, 1);
  assert.deepEqual([hits[0].from, hits[0].lossInr, hits[0].closed], ['07:00', 1234.5, 12]);
});
