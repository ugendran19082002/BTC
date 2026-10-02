import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * The Account card's day (2 Oct 2026, owner: "the calculation is not right"):
 * Booked today + Open P&L - Charges today must be Net today, on the screen's
 * own figures. Two bugs made it not: the day's open P&L counted Delta's whole
 * position on a contract for each trade holding it, and "Booked today" summed
 * every trade touched today, whole -- yesterday's included.
 */

const dir = mkdtempSync(join(tmpdir(), 'acct-'));
process.env.CHAIN_DB = join(dir, 'chain.db');
process.env.DELTA_LIVE_TRADING = '0';

const { hashPassword, COOKIE } = await import('../../src/http/session.js');
const { buildApp } = await import('../../src/http/app.js');
const { AuthService } = await import('../../src/auth/service.js');
const { AuthStore } = await import('../../src/auth/store.js');
const { Secrets } = await import('../../src/auth/secrets.js');
const { closePool } = await import('../../src/db/pool.js');
const { initTradingService, tradingService } = await import('../../src/trading/service.js');
const { initStrategyStore } = await import('../../src/http/routes/strategy.routes.js');
const { realisedSinceOf } = await import('../../src/trading/machine.js');
type TradeState = import('../../src/trading/types.js').TradeState;

await initTradingService();
await initStrategyStore();
const auth = await AuthStore.open();
await auth.seedUser('desk', hashPassword('correct horse battery'), Date.now());
await auth.createSession({ token: 'acct-session', stage: 'full', now: Date.now(), ttlMs: 3_600_000, ip: null, userAgent: null });
let app: Awaited<ReturnType<typeof buildApp>>;
before(async () => { app = await buildApp({ auth: new AuthService({ store: auth, secrets: new Secrets('acct-secret'), now: Date.now }) }); });
after(async () => { tradingService().stop(); await app.close(); await closePool(); });
const get = async (url: string) => (await app.inject({ method: 'GET', url, headers: { cookie: `${COOKIE}=${encodeURIComponent('acct-session')}` } })).json() as Record<string, any>;

test('[critical] booked since a moment: only the buy-backs since then, against the entry average', () => {
  const day = 1_000_000;
  const s = {
    contractValue: 0.001,
    fills: [
      { orderId: 'e', role: 'entry', side: 'sell', size: 10, price: 20, ts: day - 50_000 },
      { orderId: 'x1', role: 'exit', side: 'buy', size: 4, price: 15, ts: day - 10_000 },     // yesterday: +0.02
      { orderId: 'x2', role: 'stop_loss', side: 'buy', size: 6, price: 30, ts: day + 5_000 }, // today: -0.06
    ],
  } as unknown as TradeState;
  assert.ok(Math.abs(realisedSinceOf(s, day) - -0.06) < 1e-12, 'today books only today\'s buy-back');
  assert.ok(Math.abs(realisedSinceOf(s, 0) - (0.02 - 0.06)) < 1e-12, 'the whole trade, from the start');
  assert.equal(realisedSinceOf({ ...s, fills: [s.fills[0]!] } as TradeState, day), 0, 'nothing bought back, nothing booked');
});

test('[critical] two trades on one contract: the day\'s open P&L is the Open P&L, and the card adds up', async () => {
  const svc = tradingService();
  const paper = svc.paper()!;
  const symbol = 'P-BTC-84000-031026';
  // Once: computed twice, a second could tick between the product and the order, and the desk rightly
  // refused it ("expiry does not match") -- the flake this test had.
  const expiryTs = Math.floor(Date.now() / 1000) + 86_400;
  paper.addProduct({ symbol, productId: 9101, underlying: 'BTC', optionSide: 'PE', strike: 84_000, expiryTs, tickSize: 0.1, lotSize: 1, contractValue: 0.001, state: 'live' });
  paper.setQuote({ symbol, bid: 20, ask: 20.5, bidSize: 5_000, askSize: 5_000, mark: 20.2, ts: Date.now() });
  // two strategies on one strike, as decision 0011 allows
  const place = (strategyId: string) => svc.place({ symbol, optionSide: 'PE', strike: 84_000, expiryTs, lots: 2, minPremiumUsd: 1, stopLossPct: 3, limitPrice: 20, strategyId, origin: 'strategy' });
  for (const r of [await place('acct-a'), await place('acct-b')]) assert.ok(r.ok, JSON.stringify((r as any).precheck ?? (r as any).state?.note ?? r).slice(0, 600));
  for (let i = 0; i < 40 && (await svc.openTrades()).filter((t) => t.state.position !== 0).length < 2; i++) await new Promise((r) => setTimeout(r, 150));
  // the price moves against the short: each trade is down
  paper.setQuote({ symbol, bid: 25, ask: 25.5, bidSize: 5_000, askSize: 5_000, mark: 25.2, ts: Date.now() });
  // Delta's positions report: ONE row per contract, the sum of both trades (the paper exchange has no such row)
  const realPositions = svc.positionsForDisplay.bind(svc);
  svc.positionsForDisplay = async () => [{ symbol, productId: 9101, size: -4, entryPrice: 20, markPrice: 25.2, unrealisedPnl: null, liquidationPrice: null } as any];
  after(() => { svc.positionsForDisplay = realPositions; });
  await new Promise((r) => setTimeout(r, 1_000));      // past the status cache (0.9 s)
  const st = await get('/api/trade/status');
  const t = st.today;
  assert.ok(st.open.length >= 2);

  assert.ok(Math.abs(t.unrealisedUsd - st.unrealisedPnlUsd) < 1e-9, `day open ${t.unrealisedUsd} = Open P&L ${st.unrealisedPnlUsd} -- not each trade counting both`);
  assert.ok(Math.abs(t.netUsd - (t.realisedUsd + st.unrealisedPnlUsd - t.chargesUsd)) < 1e-9, 'Net today = Booked + Open P&L - Charges, on the card\'s own figures');
  assert.equal(st.realisedTodayUsd, t.realisedUsd, 'one "booked today", whichever field the screen reads');
});

test('[critical] the desk has BTC\'s price from its own live feed -- no screen has to be opened after a restart', async () => {
  // 2 Oct 2026: eight minutes after a deploy a no-stop signal trade was refused, "no BTC price", feed live all along.
  const { useFlowSocket } = await import('../../src/market/flow.js');
  const { FlowSocket } = await import('../../src/market/flow-socket.js');
  const now = Date.now();
  const s = new FlowSocket({ now: () => now });
  s.receive(JSON.stringify({ type: 'all_trades', symbol: 'BTCUSD', price: '86123.5', size: 1, timestamp: now * 1000, buyer_role: 'taker', seller_role: 'maker' }));
  useFlowSocket(s);
  try {
    assert.equal(tradingService().spot, 86_123.5, 'the perp\'s last trade, fresh');
  } finally {
    useFlowSocket(null);
  }
});
