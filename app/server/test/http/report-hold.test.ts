import { after, before, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * The P&L days and the trade statistics, each answer held ten seconds and worked once for the same question asked at
 * the same time (4 Nov 2026): under a heavy mix each phone and tab worked the thirty days' trades again for itself, on
 * the desk's own thread. Pinned: a trade saved meanwhile shows within the ten seconds' end, not on the next poll after
 * the poll after; the same question at the same moment is one answer; another account's question is its own.
 */
const dir = mkdtempSync(join(tmpdir(), 'report-hold-'));
process.env.CHAIN_DB = join(dir, 'chain.db');
process.env.DESK_SESSION_SECRET = 'report-hold-master';
process.env.DELTA_LIVE_TRADING = '0';
const { hashPassword, COOKIE } = await import('../../src/http/session.js');
const { buildApp } = await import('../../src/http/app.js');
const { AuthService } = await import('../../src/auth/service.js');
const { AuthStore } = await import('../../src/auth/store.js');
const { Secrets } = await import('../../src/auth/secrets.js');
const { closePool, query } = await import('../../src/db/pool.js');
const { initTradingService, tradingService } = await import('../../src/trading/service.js');
const { initStrategyStore } = await import('../../src/http/routes/strategy.routes.js');
const { REPORT_HOLD_MS } = await import('../../src/http/routes/report.routes.js');
const { clearTradesRange } = await import('../../src/report/trades-range.js');
const { istDate } = await import('../../src/strategy/schedule.js');

await initTradingService();
await initStrategyStore();
const auth = await AuthStore.open();
await auth.seedUser('desk', hashPassword('correct horse battery'), Date.now());
await auth.createSession({ token: 'hold-session', stage: 'full', now: Date.now(), ttlMs: 3_600_000, ip: null, userAgent: null });
type App = Awaited<ReturnType<typeof buildApp>>;
let app: App;
before(async () => {
  app = await buildApp({ auth: new AuthService({ store: auth, secrets: new Secrets('report-hold-master'), now: Date.now }) });
  await query('DELETE FROM trades');
  clearTradesRange();
});
after(async () => { await query('DELETE FROM trades'); tradingService().stop(); await app.close(); await closePool(); });

const get = async (url: string) => (await app.inject({ method: 'GET', url, headers: { cookie: `${COOKIE}=${encodeURIComponent('hold-session')}` } })).json() as Record<string, any>;
let seq = 0;
/** A trade sold at 40 and bought back at 4, a second ago -- today at any hour, midnight included. */
async function closed(): Promise<void> {
  const id = `HOLD-${++seq}`, at = Date.now() - 1_000;
  const state = {
    tradeId: id, symbol: 'P-BTC-84000-291026', phase: 'flat', position: 0, optionSide: 'PE', contractValue: 0.001, requestedSize: 1, entrySize: 1,
    entryAvgPrice: 40, exitSize: 1, exitAvgPrice: 4, realisedPnl: 0.036, exitWinner: 'take_profit', updatedAt: at,
    fills: [{ role: 'entry', side: 'sell', size: 1, price: 40, ts: at - 500 }, { role: 'take_profit', side: 'buy', size: 1, price: 4, ts: at }],
  };
  await query('INSERT INTO trades (trade_id, symbol, phase, position, plan, state, updated_at, broker_account_id) VALUES ($1, $2, $3, 0, $4, $5, $6, NULL)',
    [id, state.symbol, 'flat', JSON.stringify({ tradeId: id, symbol: state.symbol, origin: 'manual' }), JSON.stringify(state), at]);
}
const trades = (r: Record<string, any>) => (r.days as { trades: number }[]).reduce((n, d) => n + d.trades, 0);

test('[critical] the same question within ten seconds is the answer held; after them, the journal as it is now', async () => {
  const today = istDate(Date.now());
  const url = `/api/report/days?from=${today}&to=${today}`;
  await closed();
  mock.timers.enable({ apis: ['Date'], now: Date.now() });
  try {
    assert.equal(trades(await get(url)), 1);
    await closed();
    mock.timers.tick(REPORT_HOLD_MS - 1);
    assert.equal(trades(await get(url)), 1, 'held: worked once for every poll inside the ten seconds');
    // Another question -- the stats, another account named -- is its own answer.
    assert.equal((await get(`/api/report/stats?from=${today}&to=${today}`)).overall.trades, 2);
    mock.timers.tick(2);
    assert.equal(trades(await get(url)), 2, 'past ten seconds: read again');
  } finally {
    mock.timers.reset();
  }
});

test('[critical] the same question at the same moment is one answer, worked once', async () => {
  const today = istDate(Date.now());
  const url = `/api/report/stats?from=${today}&to=${today}&tf=15m`;
  const [a, b, c] = await Promise.all([get(url), get(url), get(url)]);
  assert.deepEqual([a.overall.trades, b.overall.trades, c.overall.trades], [a.overall.trades, a.overall.trades, a.overall.trades]);
});
