import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * One strategy, start to finish, step by step -- through the real HTTP API, the
 * real trading engine on the service's paper exchange, and the real database.
 *
 *   1  a strategy the rules refuse is refused, and nothing is written
 *   2  a good one is saved: its exits as typed, the retired settings dropped
 *   3  it is listed, off, with its next entry
 *   4  it is switched on
 *   5  the day is claimed before any order -- the rule that stops a second entry
 *   6  the entry is placed the way the runner places it
 *   7  it fills; the target and the stop reach the book; every step is journalled
 *   8  the API shows the trade with how each exit was asked for
 *   9  a time step moves the target on the book; the fixed stop stays
 *  10  editing the strategy's entry time does not close the open position (22 Sep)
 *  11  a stop moved by hand to a price is pinned; one on the wrong side is refused
 *  12  at the position's own exit time it is closed, and the day's record says so
 *  13  an order with a stop under its entry never reaches the book
 *  14  deleting the strategy keeps its history
 *
 * Each step depends on the one before, as the day does. Nothing leaves the
 * machine: the exchange is the service's own paper exchange, seeded here.
 */

const dir = mkdtempSync(join(tmpdir(), 'e2e-'));
process.env.CHAIN_DB = join(dir, 'chain.db');
process.env.DELTA_LIVE_TRADING = '0';
const { hashPassword, COOKIE } = await import('../../src/http/session.js');
const { buildApp } = await import('../../src/http/app.js');
const { AuthService } = await import('../../src/auth/service.js');
const { AuthStore } = await import('../../src/auth/store.js');
const { Secrets } = await import('../../src/auth/secrets.js');
const { closePool, one, rows, query } = await import('../../src/db/pool.js');
const { initTradingService, tradingService } = await import('../../src/trading/service.js');
const { initStrategyStore, strategyStore } = await import('../../src/http/routes/strategy.routes.js');
const { StrategyRunner, exitsNow } = await import('../../src/strategy/runner.js');
const { StrategyExitStepper } = await import('../../src/strategy/exit-steps.js');
const { entrySlotDate, exitMomentFor, istDate } = await import('../../src/strategy/schedule.js');

await initTradingService();
await initStrategyStore();
const auth = await AuthStore.open();
await auth.seedUser('desk', hashPassword('correct horse battery'), Date.now());
await auth.createSession({ token: 'e2e-session', stage: 'full', now: Date.now(), ttlMs: 3_600_000, ip: null, userAgent: null });

type App = Awaited<ReturnType<typeof buildApp>>;
let app: App;
before(async () => {
  app = await buildApp({ auth: new AuthService({ store: auth, secrets: new Secrets('e2e-secret'), now: Date.now }) });
});
after(async () => { tradingService().stop(); await app.close(); await closePool(); });

const cookie = { cookie: `${COOKIE}=${encodeURIComponent('e2e-session')}` };
const api = async (method: 'GET' | 'POST' | 'DELETE', url: string, payload?: unknown) => {
  const r = await app.inject({ method, url, headers: cookie, ...(payload === undefined ? {} : { payload: payload as object }) });
  return { status: r.statusCode, body: r.json() as Record<string, any> };
};
const until = async <T>(read: () => Promise<T>, ok: (v: T) => boolean, what: string, ms = 8_000): Promise<T> => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await read();
    if (ok(v)) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}: ${JSON.stringify(v).slice(0, 300)}`);
    await new Promise((r) => setTimeout(r, 150));
  }
};

/* The contract the day trades: a put, listed on the paper exchange, expiring tomorrow. */
const EXPIRY_TS = Math.floor(Date.now() / 1000) + 86_400;
const SYMBOL = 'P-BTC-83800-230926';
const paper = () => tradingService().paper()!;
const quote = (bid: number, ask: number) => paper().setQuote({ symbol: SYMBOL, bid, ask, bidSize: 5_000, askSize: 5_000, mark: (bid + ask) / 2, ts: Date.now() });

/*
 * The strategy's day is fixed -- 10:00 entry, 10:05 step, 10:30 exit -- so the
 * test passes at any hour it runs (a window built from the clock crossed the
 * 17:30 settlement when run at five past five). The strategy's own logic is
 * handed these times; the engine and the exchange run on the real clock.
 */
const ENTRY = '10:00';
const STEP = '10:05';
const EXIT = '10:30';
const [y, mo, d] = istDate(Date.now()).split('-').map(Number) as [number, number, number];
const ist = (hhmm: string, sec = 0) => Date.UTC(y, mo - 1, d) - 330 * 60_000
  + (Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3))) * 60_000 + sec * 1000;
const config = {
  entryTime: ENTRY, exitTime: EXIT, legs: 'PE', lots: 100,
  strikeRule: 'premium', premium: { mode: 'atMost', usd: 20, fallbackUsd: 50 },
  entryPrice: 'offer', crossAfterSec: 5, maxCrossSpreadPct: 0.15,
  takeProfitPct: 0.8, targetSteps: [{ at: STEP, value: 0.85 }],
  stopMode: 'price', stopLossAt: 70, stopLossPct: 0,
  weekdays: [0, 1, 2, 3, 4, 5, 6], graceMin: 60,
};

let tradeId = '';
let filledAt = 0;

test('1 [critical] a strategy the rules refuse is refused in words, and nothing is written', async () => {
  const bad = await api('POST', '/api/strategies', { name: 'E2E bad', config: { ...config, takeProfitPct: 1, targetSteps: [{ at: '11:00', value: 0.9 }] } });
  assert.equal(bad.status, 422);
  assert.ok(bad.body.problems.some((p: string) => /Take profit must be between 0 and 99%/.test(p)));
  assert.ok(bad.body.problems.some((p: string) => /before exit/.test(p)), 'the step after the exit time');
  assert.equal(await one("SELECT id FROM strategies WHERE id = 'e2e-bad'"), null);
});

test('2 [critical] a good strategy is saved as typed; a retired setting sent by an old screen is dropped', async () => {
  const r = await api('POST', '/api/strategies', { name: 'E2E PE', config: { ...config, probGate: 0.95, doubleWhenOneSided: true } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const row = await one<{ config: Record<string, unknown>; enabled: boolean }>("SELECT config, enabled FROM strategies WHERE id = 'e2e-pe'");
  assert.ok(row);
  assert.equal(row.enabled, false, 'a new strategy is never born armed');
  assert.equal(row.config.stopMode, 'price');
  assert.equal(row.config.stopLossAt, 70);
  assert.deepEqual(row.config.targetSteps, [{ at: STEP, value: 0.85 }]);
  assert.equal('probGate' in row.config, false);
  assert.equal('doubleWhenOneSided' in row.config, false);
  assert.equal(row.config.entryLimit, null, 'no stale "my price" on an offer entry');
});

test('3 it is listed, off, with its next entry', async () => {
  const r = await api('GET', '/api/strategies');
  const s = r.body.strategies.find((x: any) => x.id === 'e2e-pe');
  assert.ok(s);
  assert.equal(s.enabled, false);
  assert.equal(typeof s.status, 'string');
});

test('4 it is switched on, and the database says so', async () => {
  const r = await api('POST', '/api/strategies/e2e-pe/enabled', { enabled: true });
  assert.equal(r.status, 200);
  assert.equal((await one<{ enabled: boolean }>("SELECT enabled FROM strategies WHERE id = 'e2e-pe'"))!.enabled, true);
});

test('5 [critical] the day is claimed before any order, and only once', async () => {
  const s = (await strategyStore().get('e2e-pe'))!;
  const day = entrySlotDate(s, ist(ENTRY, 30));
  assert.equal(await strategyStore().claim(s.id, day, Date.now()), true);
  assert.equal(await strategyStore().claim(s.id, day, Date.now()), false, 'a second claim of the same day loses');
});

test('6 [critical] the entry is placed the way the runner places it: the exits in force now, in their own mode', async () => {
  paper().addProduct({
    symbol: SYMBOL, productId: 9001, underlying: 'BTC', optionSide: 'PE', strike: 83_800, expiryTs: EXPIRY_TS,
    tickSize: 0.1, lotSize: 1, contractValue: 0.001, state: 'live',
  });
  quote(20, 20.5);
  const s = (await strategyStore().get('e2e-pe'))!;
  const res = await tradingService().place({
    symbol: SYMBOL, optionSide: 'PE', strike: 83_800, expiryTs: EXPIRY_TS, lots: 100, leverage: 200,
    strategyId: s.id, origin: 'strategy', limitPrice: 20, ...exitsNow(s, ist(ENTRY, 30)),
  });
  assert.equal(res.ok, true, JSON.stringify(res));
  tradeId = res.state.tradeId;
  const row = await one<{ plan: any }>('SELECT plan FROM trades WHERE trade_id = $1', [tradeId]);
  assert.equal(row!.plan.origin, 'strategy');
  assert.equal(row!.plan.strategyId, 'e2e-pe');
  assert.equal(row!.plan.stopPrice, 70, 'the stop at the price typed');
  assert.equal(row!.plan.takeProfitPrice, 4, '80% of 20');
  assert.deepEqual(row!.plan.exitAsk, { takeProfitPct: 0.8 }, 'the target follows the fill; the fixed stop does not');
});

test('7 [critical] it fills, the target and the stop reach the book, and every step is journalled in order', async () => {
  const book = await until(
    async () => (await paper().getOpenOrders(SYMBOL)).filter((o) => o.reduceOnly),
    (o) => o.length === 2, 'the target and the stop on the book',
  );
  assert.deepEqual(book.filter((o) => o.type === 'limit').map((o) => o.limitPrice), [4]);
  assert.deepEqual(book.filter((o) => o.type !== 'limit').map((o) => o.stopPrice), [70]);
  const events = await rows<{ kind: string }>('SELECT kind FROM trade_events WHERE trade_id = $1 ORDER BY seq', [tradeId]);
  const kinds = events.map((e) => e.kind);
  assert.deepEqual(kinds.slice(0, 3), ['entry_submitted', 'fill', 'protection_placed'], kinds.join(','));
  const st = await one<{ state: any; position: number }>('SELECT state, position FROM trades WHERE trade_id = $1', [tradeId]);
  assert.equal(st!.position, -100);
  filledAt = st!.state.fills.find((f: any) => f.role === 'entry').ts;
});

test('8 the API shows the trade with how each exit was asked for, and what is on the book', async () => {
  const r = await api('GET', `/api/trade/${tradeId}`);
  assert.equal(r.status, 200);
  const t = r.body.trade ?? r.body;
  assert.deepEqual(t.plan.exitAsk, { takeProfitPct: 0.8 });
  assert.equal(t.plan.stopPrice, 70);
});

test('9 [critical] at the step time the target moves on the book; the fixed stop stays at 70', async () => {
  const s = (await strategyStore().get('e2e-pe'))!;
  const stepAt = ist('10:06');                             // past the step, before the exit
  const stepper = new StrategyExitStepper({
    openTrades: async (id) => (await tradingService().openTrades()).filter((t) => t.plan.strategyId === id),
    move: (id, ask) => tradingService().updateExits(id, ask),
    now: () => stepAt,
  });
  assert.deepEqual(await stepper.consider(s), [tradeId]);
  const book = (await paper().getOpenOrders(SYMBOL)).filter((o) => o.reduceOnly);
  assert.deepEqual(book.filter((o) => o.type === 'limit').map((o) => o.limitPrice), [3], '85% of 20');
  assert.deepEqual(book.filter((o) => o.type !== 'limit').map((o) => o.stopPrice), [70]);
  assert.equal((await one<{ plan: any }>('SELECT plan FROM trades WHERE trade_id = $1', [tradeId]))!.plan.takeProfitPrice, 3);
});

test('10 [critical] 22 Sep: editing the entry time while the position is open does not close it', async () => {
  const later = '10:02';
  const r = await api('POST', '/api/strategies', { id: 'e2e-pe', name: 'E2E PE', config: { ...config, entryTime: later } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const runner = new StrategyRunner(strategyStore(), () => Date.now());
  await (runner as unknown as { considerExit(s: unknown): Promise<void> }).considerExit((await strategyStore().get('e2e-pe'))!);
  assert.equal((await one<{ position: number }>('SELECT position FROM trades WHERE trade_id = $1', [tradeId]))!.position, -100, 'still open');
});

test('11 [critical] a stop moved by hand to a price is pinned there; one on the wrong side is refused and nothing moves', async () => {
  const ok = await api('POST', '/api/trade/protection', { tradeId, stopPrice: 60 });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  let book = (await paper().getOpenOrders(SYMBOL)).filter((o) => o.reduceOnly && o.type !== 'limit');
  assert.deepEqual(book.map((o) => o.stopPrice), [60]);
  const bad = await api('POST', '/api/trade/protection', { tradeId, stopPrice: 10 });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /A stop of 10 must be over the 20 entry/);
  book = (await paper().getOpenOrders(SYMBOL)).filter((o) => o.reduceOnly && o.type !== 'limit');
  assert.deepEqual(book.map((o) => o.stopPrice), [60], 'the refused edit changed nothing');
});

test('12 [critical] at the position\'s own exit time it is closed at the market, and the day\'s record says so', async () => {
  quote(19, 19.5);
  const afterExit = exitMomentFor(EXIT, filledAt) + 1_000;
  const runner = new StrategyRunner(strategyStore(), () => afterExit);
  await (runner as unknown as { considerExit(s: unknown): Promise<void> }).considerExit((await strategyStore().get('e2e-pe'))!);
  const t = await until(
    async () => one<{ position: number; phase: string }>('SELECT position, phase FROM trades WHERE trade_id = $1', [tradeId]),
    (r) => r?.position === 0, 'the position closed',
  );
  assert.equal(t!.position, 0);
  const kinds = (await rows<{ kind: string }>('SELECT kind FROM trade_events WHERE trade_id = $1 ORDER BY seq', [tradeId])).map((e) => e.kind);
  assert.ok(kinds.includes('exit_submitted'), kinds.join(','));
  const run = await one<{ detail: string }>("SELECT detail FROM strategy_runs WHERE strategy_id = 'e2e-pe' ORDER BY at DESC LIMIT 1");
  assert.match(run!.detail, /closed 1 leg/);
  assert.deepEqual((await paper().getOpenOrders(SYMBOL)).filter((o) => o.reduceOnly), [], 'nothing left resting');
});

test('13 [critical] an order with its stop under the entry is refused before anything reaches the book', async () => {
  quote(20, 20.5);
  const r = await api('POST', '/api/trade/place', {
    symbol: SYMBOL, side: 'PE', strike: 83_800, expiryTs: EXPIRY_TS, lots: 1, limitPrice: 20, stopPrice: 15, leverage: 200,
  });
  assert.equal(r.status, 422, JSON.stringify(r.body));
  assert.ok(r.body.failures.some((f: any) => f.code === 'EXIT_WRONG_SIDE_OF_ENTRY'));
  assert.deepEqual((await paper().getOpenOrders(SYMBOL)).filter((o) => o.role === 'entry' && o.status === 'open'), []);
});

test('14 deleting the strategy keeps its history', async () => {
  const r = await api('DELETE', '/api/strategies/e2e-pe');
  assert.ok(r.status === 200 || r.status === 204);
  assert.equal(await one("SELECT id FROM strategies WHERE id = 'e2e-pe'"), null);
  assert.ok(await one("SELECT id FROM strategy_runs WHERE strategy_id = 'e2e-pe'"), 'the run journal outlives the strategy');
  assert.ok(await one('SELECT trade_id FROM trades WHERE trade_id = $1', [tradeId]), 'and so does the trade');
  void query;
});
