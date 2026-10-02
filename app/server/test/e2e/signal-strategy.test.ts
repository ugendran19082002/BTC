import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * A signal strategy, end to end (2 Oct 2026): the desk's entry signals traded
 * as options -- a BUY sells the put, a SELL the call -- with the signal's SL and
 * TGT on the BTC perpetual as the trade's exits. Through the real HTTP API, the
 * real runner and engine on the service's paper exchange, and the real
 * database. The board is a fixed one handed to the runner; nothing leaves the
 * machine.
 */

const dir = mkdtempSync(join(tmpdir(), 'sig-'));
process.env.CHAIN_DB = join(dir, 'chain.db');
process.env.DELTA_LIVE_TRADING = '0';

const { hashPassword, COOKIE } = await import('../../src/http/session.js');
const { buildApp } = await import('../../src/http/app.js');
const { AuthService } = await import('../../src/auth/service.js');
const { AuthStore } = await import('../../src/auth/store.js');
const { Secrets } = await import('../../src/auth/secrets.js');
const { closePool, one, rows } = await import('../../src/db/pool.js');
const { initTradingService, tradingService } = await import('../../src/trading/service.js');
const { initStrategyStore, strategyStore } = await import('../../src/http/routes/strategy.routes.js');
const { StrategyRunner, signalKeyOf } = await import('../../src/strategy/runner.js');
const { istDate } = await import('../../src/strategy/schedule.js');
type MethodRead = import('../../src/entry/types.js').MethodRead;
type SignalBoard = import('../../src/strategy/runner.js').SignalBoard;

await initTradingService();
await initStrategyStore();
const auth = await AuthStore.open();
await auth.seedUser('desk', hashPassword('correct horse battery'), Date.now());
await auth.createSession({ token: 'sig-session', stage: 'full', now: Date.now(), ttlMs: 3_600_000, ip: null, userAgent: null });

type App = Awaited<ReturnType<typeof buildApp>>;
let app: App;
before(async () => {
  app = await buildApp({ auth: new AuthService({ store: auth, secrets: new Secrets('sig-secret'), now: Date.now }) });
});
after(async () => { tradingService().stop(); await app.close(); await closePool(); });

const cookie = { cookie: `${COOKIE}=${encodeURIComponent('sig-session')}` };
const api = async (method: 'GET' | 'POST', url: string, payload?: unknown) => {
  const r = await app.inject({ method, url, headers: cookie, ...(payload === undefined ? {} : { payload: payload as object }) });
  return { status: r.statusCode, body: r.json() as Record<string, any> };
};

// ------------------------------------------------------------ the board, the clock, the signals

const EXPIRY = '031026';
const EXPIRY_TS = Math.floor(Date.now() / 1000) + 86_400;
const PUT = 84_000, CALL = 86_000;
const paper = () => tradingService().paper()!;
for (const [cp, strike, pid] of [['P', PUT, 7001], ['C', CALL, 7002]] as const) {
  const symbol = `${cp}-BTC-${strike}-${EXPIRY}`;
  paper().addProduct({ symbol, productId: pid, underlying: 'BTC', optionSide: cp === 'P' ? 'PE' : 'CE', strike, expiryTs: EXPIRY_TS, tickSize: 0.1, lotSize: 1, contractValue: 0.001, state: 'live' });
  paper().setQuote({ symbol, bid: 18, ask: 18.5, bidSize: 5_000, askSize: 5_000, mark: 18.2, ts: Date.now() });
}
const board: SignalBoard = {
  live: true, isDaily: true, expiry: EXPIRY, expiryTs: EXPIRY_TS, spot: 85_000,
  candidates: [
    { cp: 'P', strike: PUT, sellPrice: 18, pOtm: 0.8, moneyness: 'OTM', ask: 18.5 },
    { cp: 'C', strike: CALL, sellPrice: 18, pOtm: 0.8, moneyness: 'OTM', ask: 18.5 },
  ],
};

/** 10:00 IST today: inside the strategy's 09:00-17:00 window, whenever the test runs. */
const [y, mo, d] = istDate(Date.now()).split('-').map(Number) as [number, number, number];
const TEN = Date.UTC(y, mo - 1, d) - 330 * 60_000 + 10 * 3_600_000;
let clock = TEN;
const runner = new StrategyRunner(strategyStore(), () => clock, async () => board);

let trigger = 1_790_000_000;
const signal = (o: Partial<MethodRead> = {}): MethodRead => ({
  id: 'breakout', n: 1, code: '1', name: 'Breakout', group: 'breakout', summary: '', mode: 'single', tf: '5m',
  dir: 'long', state: 'TRADE', steps: [], gates: [], score: 70, scoreParts: [], alignment: null, reason: '',
  triggerTime: trigger += 300,
  plan: { entryLo: 84_950, entryHi: 85_000, stop: 84_600, tp1: 85_500, tp2: 85_900, tp3: null, tpWhy: [], rr: 1.25 },
  ...o,
});

const config = {
  trigger: 'signal', signal: { mode: 'single', tf: '5m', methods: ['breakout'], target: 'tp1', maxOpen: 1 },
  liveOrders: false,
  entryTime: '09:00', exitTime: '17:00', lots: 1, legs: 'both',
  strikeRule: 'premium', premium: { mode: 'atMost', usd: 20, fallbackUsd: null },
  entryPrice: 'offer', crossAfterSec: 5, maxCrossSpreadPct: 0.5,
  takeProfitPct: 0.99, stopLossPct: 3, minPremiumUsd: 1,
  weekdays: [0, 1, 2, 3, 4, 5, 6], graceMin: 60,
};
const runsOf = (id: string) => rows<{ status: string; detail: string; trade_id: string | null; signal_key: string }>(
  'SELECT status, detail, trade_id, signal_key FROM strategy_signal_runs WHERE strategy_id = $1 ORDER BY id', [id]);

// ------------------------------------------------------------ saving

test('[critical] a signal strategy saves with its signals, live orders off -- and a bad one is refused in words', async () => {
  const bad = await api('POST', '/api/strategies', { name: 'Sig bad', config: { ...config, signal: { ...config.signal, methods: [] } } });
  assert.equal(bad.status, 422);
  assert.ok(bad.body.problems.some((p: string) => /at least one method/.test(p)));
  const unknown = await api('POST', '/api/strategies', { name: 'Sig bad', config: { ...config, signal: { ...config.signal, methods: ['nope'] } } });
  assert.ok(unknown.body.problems.some((p: string) => /No such method: nope/.test(p)));
  const noTf = await api('POST', '/api/strategies', { name: 'Sig bad', config: { ...config, signal: { ...config.signal, tf: '2m' } } });
  assert.ok(noTf.body.problems.some((p: string) => /Pick a timeframe/.test(p)));

  const r = await api('POST', '/api/strategies', { name: 'Sig BO', config });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const row = await one<{ config: Record<string, any> }>("SELECT config FROM strategies WHERE id = 'sig-bo'");
  assert.equal(row!.config.trigger, 'signal');
  assert.deepEqual(row!.config.signal, config.signal, 'every signal setting kept, not dropped by the cleaner');
  assert.equal(row!.config.liveOrders, false);
  await api('POST', '/api/strategies/sig-bo/enabled', { enabled: true });
  await tradingService().settings.set('scheduler_enabled', '1');
});

test('the list says a signal strategy has no entry time, and whether it is taking signals', async () => {
  const r = await api('GET', '/api/strategies');
  const s = r.body.strategies.find((x: any) => x.id === 'sig-bo');
  assert.equal(s.nextEntryAt, null);
  assert.match(s.status, /taking signals|outside its window/);
  assert.ok(Array.isArray(r.body.signalRuns));
});

// ------------------------------------------------------------ live orders off

test('[critical] live orders off: it writes down what it would sell -- the put for a BUY -- and sends nothing', async () => {
  const before = (await tradingService().openTrades()).length;
  await runner.onSignal(signal());
  const [run] = await runsOf('sig-bo');
  assert.equal(run!.status, 'would-place', run!.detail);
  assert.match(run!.detail, /#1 Breakout BUY \| live orders off: would sell PE 84000 x1 @ 18 · perp SL 84600 · TGT 85500/);
  assert.equal((await tradingService().openTrades()).length, before, 'no order');
});

// ------------------------------------------------------------ live orders on

test('[critical] live orders on: a BUY sells the put, with the signal\'s perp SL and TGT as its exits', async () => {
  await api('POST', '/api/strategies', { id: 'sig-bo', name: 'Sig BO', config: { ...config, liveOrders: true } });
  const s = signal();
  await runner.onSignal(s);
  const run = (await runsOf('sig-bo')).find((x) => x.signal_key === signalKeyOf(s))!;
  assert.equal(run.status, 'placed', run.detail);
  const t = await one<{ plan: any }>('SELECT plan FROM trades WHERE trade_id = $1', [run.trade_id]);
  assert.equal(t!.plan.optionSide, 'PE');
  assert.equal(t!.plan.strategyId, 'sig-bo');
  assert.deepEqual(t!.plan.underlying, { dir: 1, stop: 84_600, target: 85_500, source: 'BTC perp' });
  assert.ok(t!.plan.stopPrice > 18, 'the premium stop, the backstop at Delta, is on the plan as well');
});

test('[critical] the same signal again is not traded twice; a new one while one is open waits its turn (at most 1)', async () => {
  const runsBefore = (await runsOf('sig-bo')).length;
  const last = (await runsOf('sig-bo')).at(-1)!;
  const [, , , , trig] = last.signal_key.split('|');
  await runner.onSignal(signal({ triggerTime: Number(trig) }));
  assert.equal((await runsOf('sig-bo')).length, runsBefore, 'claimed once: the second sighting writes nothing');
  await runner.onSignal(signal());
  const skip = (await runsOf('sig-bo')).at(-1)!;
  assert.equal(skip.status, 'skipped');
  assert.match(skip.detail, /already 1 of its trade open \(at most 1\)/);
});

test('[critical] a SELL sells the call', async () => {
  await api('POST', '/api/strategies', { name: 'Sig BO sell', config: { ...config, liveOrders: true } });
  await api('POST', '/api/strategies/sig-bo-sell/enabled', { enabled: true });
  await api('POST', '/api/strategies/sig-bo/enabled', { enabled: false });
  await runner.onSignal(signal({ dir: 'short', plan: { entryLo: 85_000, entryHi: 85_050, stop: 85_400, tp1: 84_500, tp2: null, tp3: null, tpWhy: [], rr: 1.25 } }));
  const run = (await runsOf('sig-bo-sell')).at(-1)!;
  assert.equal(run.status, 'placed', run.detail);
  const t = await one<{ plan: any }>('SELECT plan FROM trades WHERE trade_id = $1', [run.trade_id]);
  assert.equal(t!.plan.optionSide, 'CE');
  assert.deepEqual(t!.plan.underlying, { dir: -1, stop: 85_400, target: 84_500, source: 'BTC perp' });
});

// ------------------------------------------------------------ what it does not take

test('another method, another timeframe, another way: not its signal -- nothing written', async () => {
  const n = (await runsOf('sig-bo-sell')).length;
  await runner.onSignal(signal({ id: 'momentum' }));
  await runner.onSignal(signal({ tf: '15m' }));
  await runner.onSignal(signal({ mode: 'mtf' }));
  await runner.onSignal(signal({ state: 'WAIT' }));
  assert.equal((await runsOf('sig-bo-sell')).length, n);
});

test('[critical] auto-trading off, or outside its window: nothing taken', async () => {
  const n = (await runsOf('sig-bo-sell')).length;
  await tradingService().settings.set('scheduler_enabled', '0');
  await runner.onSignal(signal({ dir: 'short' }));
  await tradingService().settings.set('scheduler_enabled', '1');
  clock = TEN + 8 * 3_600_000;                       // 18:00 IST, past its 17:00 end
  await runner.onSignal(signal({ dir: 'short' }));
  clock = TEN;
  assert.equal((await runsOf('sig-bo-sell')).length, n);
});
