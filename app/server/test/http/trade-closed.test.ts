import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Every closed trade of a range, for the phone's Trade history (29 Oct 2026, owner: "the history screen's P&L -- the
 * values look wrong"). The phone read `/api/trade/history`, the range's newest 500 trades whatever they were, and kept
 * the closed ones: with waiting and cancelled orders among the newest, a busy day lost most of its closed trades and
 * thirty days read as one. Pinned here: every closed trade of the range comes back, of the account asked for, each with
 * the money the full order row says for it, and nothing but what the list reads.
 */

const dir = mkdtempSync(join(tmpdir(), 'trade-closed-'));
process.env.CHAIN_DB = join(dir, 'chain.db');
process.env.DESK_SESSION_SECRET = 'trade-closed-master';
process.env.DELTA_API_KEY = 'clsKEYclsKEYclsKEY1111';
process.env.DELTA_API_SECRET = 'clsSECRETclsSECRETclsSECRETclsSECRETclsSECRET';
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
const { istDate } = await import('../../src/strategy/schedule.js');

await initTradingService();
await initStrategyStore();
const auth = await AuthStore.open();
await auth.seedUser('desk', hashPassword('correct horse battery'), Date.now());
await auth.createSession({ token: 'closed-session', stage: 'full', now: Date.now(), ttlMs: 3_600_000, ip: null, userAgent: null });

type App = Awaited<ReturnType<typeof buildApp>>;
let app: App;
before(async () => {
  app = await buildApp({ auth: new AuthService({ store: auth, secrets: new Secrets('trade-closed-master'), now: Date.now }) });
});
after(async () => { tradingService().stop(); await app.close(); await closePool(); });

const get = async (url: string) => {
  const r = await app.inject({ method: 'GET', url, headers: { cookie: `${COOKIE}=${encodeURIComponent('closed-session')}` } });
  return { status: r.statusCode, body: r.json() as Record<string, any> };
};

const NOW = Date.now();
const DAY = 86_400_000;
let seq = 0;
/** A trade sold at 40: bought back at `exit` (closed), or never filled and cancelled (`exit` absent). */
async function trade(at: number, o: { exit?: number; account: number; strategy?: string }) {
  const id = `P-BTC-84000-CL-${++seq}`;
  const closed = o.exit !== undefined;
  const fills = closed ? [
    { orderId: `${id}-e`, role: 'entry', side: 'sell', size: 5, price: 40, ts: at - 600_000 },
    { orderId: `${id}-x`, role: 'take_profit', side: 'buy', size: 5, price: o.exit, ts: at },
  ] : [];
  const plan = {
    tradeId: id, symbol: 'P-BTC-84000-291026', origin: 'strategy', strategyId: o.strategy ?? '15m-time', strategyName: o.strategy ?? '15m time',
    accountId: o.account, lots: 5, entry: { type: 'limit', limitPrice: 40, timeoutMs: 5000, marketFallback: false }, takeProfitPrice: 4, stopPrice: 140,
    signal: { method: 'breakout', n: 1, name: 'Breakout', mode: 'single', tf: '15m', dir: -1, triggerTime: 1 },
  };
  const state = {
    tradeId: id, symbol: plan.symbol, productId: 1, phase: closed ? 'flat' : 'aborted', position: 0, optionSide: 'PE', contractValue: 0.001,
    requestedSize: 5, entrySize: closed ? 5 : 0, entryAvgPrice: closed ? 40 : null, exitSize: closed ? 5 : 0, exitAvgPrice: closed ? o.exit : null,
    realisedPnl: closed ? (40 - o.exit!) * 5 * 0.001 : 0, exitWinner: closed ? 'take_profit' : null, exitReason: null, fills, updatedAt: at,
    protection: { takeProfit: null, stopLoss: null }, wantsProtection: true,
  };
  await query('INSERT INTO trades (trade_id, symbol, phase, position, plan, state, updated_at, broker_account_id) VALUES ($1, $2, $3, 0, $4, $5, $6, $7)',
    [id, plan.symbol, state.phase, JSON.stringify(plan), JSON.stringify(state), at, o.account]);
  return id;
}

let one = 0;
let two = 0;
const today = istDate(NOW);
// The minutes of today that have passed, so every trade is today's whatever the hour the test runs at.
const sinceMidnight = NOW - Date.parse(`${today}T00:00:00+05:30`);
const todayAt = (i: number, of: number) => NOW - Math.floor(((i + 1) / (of + 1)) * Math.max(sinceMidnight - 60_000, 60_000));

test('[critical] every closed trade of today, where the order history\'s newest 500 -- cancelled orders first -- lost most of them', async () => {
  one = brokerAccounts().default()!.id;
  two = (await brokerAccounts().create({ name: 'Second', apiKey: 'clsKEYtwoKEYtwo2222', apiSecret: 'clsSECRETtwoSECRETtwoSECRETtwo2222' })).id;
  // 650 closed earlier today on account one, 30 on account two; then 600 orders cancelled unfilled, the newest of all.
  for (let i = 0; i < 650; i++) await trade(todayAt(i + 600, 1_300), { exit: i % 5 === 0 ? 90 : 4, account: one });
  for (let i = 0; i < 30; i++) await trade(todayAt(i + 1_250, 1_300), { exit: 4, account: two, strategy: '5m time' });
  for (let i = 0; i < 600; i++) await trade(todayAt(i, 1_300), { account: one });

  const r = await get(`/api/trade/closed?from=${today}&to=${today}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.trades.length, 680, 'every closed trade, every account');
  assert.equal(r.body.truncated, false);
  const old = await get(`/api/trade/history?from=${today}&to=${today}&status=completed`);
  assert.ok(old.body.trades.length < 680, `the order history keeps ${old.body.trades.length}: the reason for this route`);

  const mine = await get(`/api/trade/closed?from=${today}&to=${today}&account=${one}`);
  assert.equal(mine.body.trades.length, 650);
  assert.ok(mine.body.trades.every((t: any) => t.account.id === one && t.account.name === brokerAccounts().get(one)!.name));
  const theirs = await get(`/api/trade/closed?from=${today}&to=${today}&account=${two}`);
  assert.equal(theirs.body.trades.length, 30);
  assert.equal(theirs.body.trades[0].account.name, 'Second');
});

test('[critical] each trade\'s money is the order row\'s own: the net after charges, how it closed -- and only what the list reads', async () => {
  const lean = (await get(`/api/trade/closed?from=${today}&to=${today}&account=${two}`)).body.trades as any[];
  const full = (await get(`/api/trade/history?from=${today}&to=${today}&account=${two}`)).body.trades as any[];
  assert.equal(full.length, 30);
  for (const t of lean) {
    const f = full.find((x) => x.tradeId === t.tradeId);
    assert.ok(f, t.tradeId);
    assert.equal(t.netRealisedUsd, f.netRealisedUsd);
    assert.ok(t.netRealisedUsd < t.realisedPnl, 'after charges');
    assert.equal(t.exitBy, f.exitBy);
  }
  assert.deepEqual(Object.keys(lean[0]).sort(), ['account', 'entryAvgPrice', 'exitAvgPrice', 'exitBy', 'exitSize', 'fills', 'netRealisedUsd', 'optionSide', 'plan', 'position', 'realisedPnl', 'symbol', 'tradeId', 'updatedAt']);
  assert.deepEqual(Object.keys(lean[0].fills[0]).sort(), ['role', 'side', 'ts']);
  assert.deepEqual(lean[0].plan, { origin: 'strategy', action: 'sell', strategyId: '5m time', strategyName: '5m time', signal: { n: 1, name: 'Breakout', mode: 'single', tf: '15m' } });
});

test('a range of days: a trade closed three days ago is in a range that reaches it, and out of today\'s', async () => {
  const id = await trade(NOW - 3 * DAY, { exit: 4, account: two });
  const from = istDate(NOW - 3 * DAY);
  const wide = (await get(`/api/trade/closed?from=${from}&to=${today}&account=${two}`)).body.trades as any[];
  assert.ok(wide.some((t) => t.tradeId === id));
  assert.equal(wide.length, 31);
  const narrow = (await get(`/api/trade/closed?from=${today}&to=${today}&account=${two}`)).body.trades as any[];
  assert.ok(!narrow.some((t) => t.tradeId === id));
});
