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
const { exitMomentFor, istDate } = await import('../../src/strategy/schedule.js');
type MethodRead = import('../../src/entry/types.js').MethodRead;
type SignalBoard = import('../../src/strategy/runner.js').SignalBoard;

await initTradingService();
await initStrategyStore();
await (await import('../../src/entry/paper.js')).entrySchema();
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
  trigger: 'signal', signal: { mode: 'single', tf: '5m', methods: ['breakout'], target: 'tp1', maxOpen: 1, enterOn: 'signal' },
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
  // ...and written down as sold: what a strategy is unless it says bought.
  assert.deepEqual(row!.config.signal, { ...config.signal, action: 'sell' }, 'every signal setting kept, not dropped by the cleaner');
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
  assert.deepEqual(t!.plan.underlying, { dir: 1, stop: 84_600, target: 85_500, source: 'BTC perp', entry: null });
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
  assert.match(skip.detail, /already 1 of its trade open \(1 live\) -- at most 1/);
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
  assert.deepEqual(t!.plan.underlying, { dir: -1, stop: 85_400, target: 84_500, source: 'BTC perp', entry: null });
});

// ------------------------------------------------------------ filled, then closed at the end of its window

const until = async <T>(read: () => Promise<T>, ok: (v: T) => boolean, what: string, ms = 15_000): Promise<T> => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await read();
    if (ok(v)) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}: ${JSON.stringify(v).slice(0, 300)}`);
    await new Promise((r) => setTimeout(r, 200));
  }
};

test('[critical] the put fills -- at the bid after 5 s -- and at the end of its window it is bought back, said on its signal', async () => {
  const run = (await runsOf('sig-bo')).find((x) => x.status === 'placed')!;
  const filled = await until(
    () => one<{ position: number; state: any }>('SELECT position, state FROM trades WHERE trade_id = $1', [run.trade_id]),
    (t) => t?.position === -1, 'the entry filled',
  );
  const fill = filled!.state.fills.find((f: any) => f.role === 'entry');
  assert.equal(fill.price, 18, 'crossed to the bid after 5 s');
  // The option's own target and stop reach Delta as well: the backstop, working with the desk down.
  const book = await until(
    async () => (await paper().getOpenOrders(`P-BTC-${PUT}-${EXPIRY}`)).filter((o) => o.reduceOnly),
    (o) => o.length === 2, 'the option target and stop on the book');
  assert.ok(book.some((o) => o.type === 'limit' && o.limitPrice! < 18), 'the option target, a buy-back under the entry');
  assert.ok(book.some((o) => o.type !== 'limit' && o.stopPrice! > 18), 'the option stop, the backstop above it');
  // A second past its 17:00 end, measured from the fill -- which carries the real clock, so a test run after
  // 17:00 IST would otherwise read as filled after the end and roll to tomorrow's.
  clock = exitMomentFor('17:00', fill.ts) + 1_000;
  await (runner as unknown as { considerExit(s: unknown): Promise<void> }).considerExit((await strategyStore().get('sig-bo'))!);
  clock = TEN;
  await until(
    () => one<{ position: number }>('SELECT position FROM trades WHERE trade_id = $1', [run.trade_id]),
    (t) => t?.position === 0, 'the put bought back',
  );
  const after = (await runsOf('sig-bo')).find((x) => x.trade_id === run.trade_id)!;
  assert.match(after.detail, /\| closed at 5:00 PM, the end of its window$/);
  assert.equal((await rows('SELECT 1 FROM strategy_runs WHERE strategy_id = $1', ['sig-bo'])).length, 0, 'no daily run row made up for it');
});

test('the list carries each signal run in the shape the screen reads', async () => {
  const r = await api('GET', '/api/strategies');
  const run = r.body.signalRuns.find((x: any) => x.strategyId === 'sig-bo' && x.status === 'placed');
  assert.ok(run, JSON.stringify(r.body.signalRuns).slice(0, 300));
  for (const k of ['id', 'signalKey', 'method', 'mode', 'tf', 'dir', 'status', 'detail', 'tradeId', 'at']) assert.ok(k in run, k);
  assert.equal(run.dir, 1);
  assert.equal(run.method, 'breakout');
  const m = await api('GET', '/api/entry/methods');
  assert.equal(m.body.methods.length, 81);
  assert.deepEqual(Object.keys(m.body.methods[0]).sort(), ['group', 'id', 'n', 'name', 'orderSide', 'sl', 'summary']);
  assert.deepEqual([m.body.methods[0].orderSide, m.body.methods[9].orderSide], ['BUY', 'SELL'], '#1 Breakout BUY, #10 VWAP reversion SELL');
});

// ------------------------------------------------------------ several timeframes

test('[critical] without the chain on 5m and 1h: both timeframes taken, 15m not -- saved in the desk\'s order', async () => {
  const multi = { ...config, signal: { ...config.signal, tfs: ['1h', '5m', '1h'], maxOpen: 100 }, liveOrders: false };
  const r = await api('POST', '/api/strategies', { name: 'Sig multi', config: multi });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual((await strategyStore().get('sig-multi'))!.config.signal!.tfs, ['5m', '1h']);
  const bad = await api('POST', '/api/strategies', { name: 'Sig multi bad', config: { ...multi, signal: { ...multi.signal, tfs: ['5m', '2h'] } } });
  assert.ok(bad.body.problems.some((p: string) => /Pick a timeframe/.test(p)));
  await api('POST', '/api/strategies/sig-multi/enabled', { enabled: true });
  for (const sym of [`P-BTC-${PUT}-${EXPIRY}`, `C-BTC-${CALL}-${EXPIRY}`]) {
    paper().setQuote({ symbol: sym, bid: 18, ask: 18.5, bidSize: 5_000, askSize: 5_000, mark: 18.2, ts: Date.now() });
  }
  await runner.onSignal(signal({ tf: '5m' }));
  await runner.onSignal(signal({ tf: '1h' }));
  await runner.onSignal(signal({ tf: '15m' }));
  assert.deepEqual((await runsOf('sig-multi')).map((x) => x.signal_key.split('|')[2]), ['5m', '1h']);
  await api('POST', '/api/strategies/sig-multi/enabled', { enabled: false });
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

// ------------------------------------------------------------ renamed

test('[critical] renamed: its open position, its order history and the order detail all say the new name', async () => {
  const open = (await runsOf('sig-bo-sell')).find((x) => x.status === 'placed')!;
  const closed = (await runsOf('sig-bo')).find((x) => x.status === 'placed')!;
  const before = await api('GET', '/api/trade/status');
  assert.equal(before.body.open.find((t: any) => t.tradeId === open.trade_id).plan.strategyName, 'Sig BO sell', 'the name it was placed under');

  const sell = (await strategyStore().get('sig-bo-sell'))!;
  assert.equal((await api('POST', '/api/strategies', { id: 'sig-bo-sell', name: 'Breakout CE', config: sell.config })).status, 200);
  const bo = (await strategyStore().get('sig-bo'))!;
  assert.equal((await api('POST', '/api/strategies', { id: 'sig-bo', name: 'Breakout PE', config: bo.config })).status, 200);

  await new Promise((r) => setTimeout(r, 1_000));     // past the status cache (STATUS_TTL_MS)
  const status = await api('GET', '/api/trade/status');
  const pos = status.body.open.find((t: any) => t.tradeId === open.trade_id);
  assert.equal(pos.plan.strategyName, 'Breakout CE', 'Positions');
  assert.equal(pos.plan.strategyId, 'sig-bo-sell', 'the id does not change');

  const history = await api('GET', '/api/trade/history');
  const names = new Map(history.body.trades.map((t: any) => [t.tradeId, t.plan.strategyName]));
  assert.equal(names.get(open.trade_id), 'Breakout CE', 'Orders, open');
  assert.equal(names.get(closed.trade_id), 'Breakout PE', 'Orders, closed');

  const detail = await api('GET', `/api/trade/${encodeURIComponent(closed.trade_id!)}`);
  assert.equal(detail.body.trade.plan.strategyName, 'Breakout PE', 'the order detail');
  // the journal keeps what was true when it was placed
  const stored = await one<{ plan: any }>('SELECT plan FROM trades WHERE trade_id = $1', [closed.trade_id]);
  assert.equal(stored!.plan.strategyName, 'Sig BO');
  // and the signal it traded, for the labels
  assert.deepEqual(detail.body.trade.plan.signal, { method: 'breakout', n: 1, name: 'Breakout', mode: 'single', tf: '5m', dir: 1, triggerTime: stored!.plan.signal.triggerTime });
  assert.deepEqual(detail.body.trade.plan.underlying, { dir: 1, stop: 84_600, target: 85_500, source: 'BTC perp', entry: null });
});

// ------------------------------------------------------------ at most N open, with live orders off

test('[critical] live orders off: "at most 2 open" counts the would-sells still in play -- the third waits', async () => {
  const cfg2 = { ...config, signal: { ...config.signal, maxOpen: 2 }, liveOrders: false };
  assert.equal((await api('POST', '/api/strategies', { name: 'Sig cap', config: cfg2 })).status, 200);
  await api('POST', '/api/strategies/sig-cap/enabled', { enabled: true });
  await api('POST', '/api/strategies/sig-bo-sell/enabled', { enabled: false });
  const take = async () => {
    const s = signal();
    // the paper log writes every TRADE before the runner sees it (index.ts recordSetups)
    await rows(`INSERT INTO entry_setups (method, mode, tf, dir, trigger_at, first_seen, entry_lo, entry_hi, stop, tp1, rr, graded_to)
                VALUES ($1, $2, $3, 1, $4, $5, 84950, 85000, 84600, 85500, 1.25, 0)`, [s.id, s.mode, s.tf, s.triggerTime, Date.now()]);
    return s;
  };
  for (const sym of [`P-BTC-${PUT}-${EXPIRY}`, `C-BTC-${CALL}-${EXPIRY}`]) {
    paper().setQuote({ symbol: sym, bid: 18, ask: 18.5, bidSize: 5_000, askSize: 5_000, mark: 18.2, ts: Date.now() });
  }
  // seven signals in the same minute, side by side, as the recorder hands them over
  const seven = await Promise.all(Array.from({ length: 7 }, take));
  await Promise.all(seven.map((s) => runner.onSignal(s)));
  const runs = await runsOf('sig-cap');
  assert.equal(runs[0]!.status, 'would-place', runs[0]!.detail);
  assert.deepEqual(runs.map((r) => r.status), ['would-place', 'would-place', 'skipped', 'skipped', 'skipped', 'skipped', 'skipped']);
  assert.match(runs[2]!.detail, /already 2 of its trades open \(2 would-sell\) -- at most 2/);

  // one of the two ends (its paper trade stopped out): the next signal is taken
  await rows(`UPDATE entry_setups SET status = 'stop' WHERE trigger_at = $1`, [seven[0]!.triggerTime]);
  await runner.onSignal(await take());
  assert.equal((await runsOf('sig-cap')).at(-1)!.status, 'would-place');
});

test('a deleted strategy\'s trades keep the name they were placed under', async () => {
  const closed = (await runsOf('sig-bo')).find((x) => x.status === 'placed')!;
  await app.inject({ method: 'DELETE', url: '/api/strategies/sig-bo', headers: cookie });
  const history = await api('GET', '/api/trade/history');
  assert.equal(history.body.trades.find((t: any) => t.tradeId === closed.trade_id).plan.strategyName, 'Sig BO');
});

// ------------------------------------------------------------ the trade history

test('[critical] the trade history: the signal\'s perp levels, the paper log\'s verdict, and a real order\'s option, exit and money', async () => {
  const r = await api('GET', '/api/strategies');
  const trades: any[] = r.body.signalTrades;
  const sold = trades.find((t) => t.strategyId === 'sig-bo-sell' && t.status === 'placed');
  assert.ok(sold, JSON.stringify(trades).slice(0, 400));
  assert.equal(sold.dir, -1);
  assert.equal(sold.option.side, 'CE');
  assert.equal(sold.option.strike, CALL);
  assert.equal(sold.option.perpStop, 85_400);
  assert.equal(sold.option.perpTarget, 84_500);

  const closed = trades.find((t) => t.status === 'placed' && t.option?.exitReason);
  assert.ok(closed, 'the one bought back at the end of its window');
  assert.equal(closed.option.open, false);
  assert.ok(closed.option.exit > 0);
  assert.equal(typeof closed.option.pnlUsd, 'number');
  assert.ok(closed.option.entryAt > 0 && closed.option.exitAt >= closed.option.entryAt, 'when it went in, and when it came out');

  const would = trades.find((t) => t.strategyId === 'sig-cap' && t.status === 'would-place' && t.perp?.status === 'stop');
  assert.ok(would, 'a would-sell, with what the paper log saw on the perp');
  assert.deepEqual(would.levels, { entryLo: 84_950, entryHi: 85_000, stop: 84_600, tp1: 85_500, tp2: null, tp3: null });
  assert.equal(would.option, null, 'nothing was sold');
  const skipped = trades.find((t) => t.strategyId === 'sig-cap' && t.status === 'skipped');
  assert.match(skipped.detail, /already 2 of its trades open/, 'and what was not taken, with why');
  assert.ok(!trades.some((t) => t.status === 'claimed'));
});

// ------------------------------------------------------------ entering "in the trade"

test('[critical] enter at the zone (the default): nothing at the signal; the option sold the moment the paper log grades the fill', async () => {
  const zone = { ...config, signal: { mode: 'single', tf: '15m', methods: ['breakout'], target: 'tp2', maxOpen: 5 }, liveOrders: true };
  assert.equal((await api('POST', '/api/strategies', { name: 'Sig zone', config: zone })).status, 200);
  assert.equal((await strategyStore().get('sig-zone'))!.config.signal!.enterOn, 'zone', 'saved as the default');
  await api('POST', '/api/strategies/sig-zone/enabled', { enabled: true });
  for (const sym of [`P-BTC-${PUT}-${EXPIRY}`, `C-BTC-${CALL}-${EXPIRY}`]) {
    paper().setQuote({ symbol: sym, bid: 18, ask: 18.5, bidSize: 5_000, askSize: 5_000, mark: 18.2, ts: Date.now() });
  }
  const s = signal({ tf: '15m' });
  await runner.onSignal(s);
  assert.equal((await runsOf('sig-zone')).length, 0, 'the signal alone sells nothing');

  // the paper log writes the signal, then the real grader sees the perp trade into the zone
  const { recordSetups, saveGraded, onSetupFilled, workingRows } = await import('../../src/entry/paper.js');
  const off = onSetupFilled((f) => { void runner.onSetupFilled(f); });
  await recordSetups([s], Date.now());
  const row = (await workingRows()).find((x) => x.tf === '15m' && x.triggerAt === s.triggerTime)!;
  // Filled now by the runner's clock (10:00 IST), not the machine's: before 10:00 the machine's own time read as a fill hours old.
  const filledAt = Math.floor(clock / 1000);
  await saveGraded(row.id, { ...row, status: 'filled', filledAt, fillPrice: 84_990 }, 'open');
  const run = await until(async () => (await runsOf('sig-zone')).at(-1), (x) => x?.status === 'placed', 'the zone entry');
  const t = await one<{ plan: any }>('SELECT plan FROM trades WHERE trade_id = $1', [run!.trade_id]);
  assert.equal(t!.plan.optionSide, 'PE');
  assert.deepEqual(t!.plan.underlying, { dir: 1, stop: 84_600, target: 85_900, source: 'BTC perp', entry: 84_990 }, 'TGT2, and the perp entry the fill');
  assert.match(run!.detail, /perp filled 84990 · perp SL 84600 · TGT 85900/);
  off();
});

test('[critical] at the zone: a fill reported late, or already out, is written down and not entered', async () => {
  const fill = (o: Partial<import('../../src/entry/paper.js').SetupFill>) => ({
    method: 'breakout', mode: 'single' as const, tf: '15m' as const, dir: 1 as const, triggerAt: trigger += 300,
    entryLo: 84_950, entryHi: 85_000, stop: 84_600, tp1: 85_500, tp2: 85_900, tp3: null,
    status: 'filled' as const, filledAt: Math.floor(clock / 1000), fillPrice: 84_990, ...o,
  });
  await runner.onSetupFilled(fill({ filledAt: Math.floor(clock / 1000) - 300 }));
  assert.match((await runsOf('sig-zone')).at(-1)!.detail, /filled at 84990 300s ago -- too late to enter/);
  await runner.onSetupFilled(fill({ status: 'stop' }));
  assert.match((await runsOf('sig-zone')).at(-1)!.detail, /was out \(SL\) in the same moment/);
  // a strategy that enters at the signal does not enter again at the fill
  const n = (await runsOf('sig-multi')).length;
  await runner.onSetupFilled(fill({ tf: '5m' }));
  assert.equal((await runsOf('sig-multi')).length, n);
  await api('POST', '/api/strategies/sig-zone/enabled', { enabled: false });
});

test('[critical] the trade history by IST day: today has them, a day before has none, a bad range is refused', async () => {
  const today = istDate(Date.now());
  const r = await api('GET', `/api/strategies/signal-trades?from=${today}&to=${today}`);
  assert.equal(r.status, 200);
  assert.ok(r.body.trades.length > 0 && r.body.trades.every((t: any) => istDate(t.at) === today), 'only today\'s');
  const before = await api('GET', '/api/strategies/signal-trades?from=2020-01-01&to=2020-01-02');
  assert.deepEqual(before.body.trades, []);
  const bad = await api('GET', `/api/strategies/signal-trades?from=${today}&to=2020-01-01`);
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /on or before/);
});

test('[critical] two different signals, the same strike: both sold, each its own trade with its own perp levels', async () => {
  const two = { ...config, signal: { ...config.signal, maxOpen: 5 }, liveOrders: true };
  assert.equal((await api('POST', '/api/strategies', { name: 'Sig same strike', config: two })).status, 200);
  await api('POST', '/api/strategies/sig-same-strike/enabled', { enabled: true });
  for (const sym of [`P-BTC-${PUT}-${EXPIRY}`, `C-BTC-${CALL}-${EXPIRY}`]) {
    paper().setQuote({ symbol: sym, bid: 18, ask: 18.5, bidSize: 5_000, askSize: 5_000, mark: 18.2, ts: Date.now() });
  }
  await runner.onSignal(signal());
  await runner.onSignal(signal({ plan: { entryLo: 84_900, entryHi: 84_950, stop: 84_500, tp1: 85_400, tp2: null, tp3: null, tpWhy: [], rr: 1.4 } }));
  const runs = await runsOf('sig-same-strike');
  assert.deepEqual(runs.map((r) => r.status), ['placed', 'placed'], runs.map((r) => r.detail).join(' / '));
  const plans = await Promise.all(runs.map((r) => one<{ plan: any }>('SELECT plan FROM trades WHERE trade_id = $1', [r.trade_id])));
  assert.deepEqual(plans.map((p) => p!.plan.symbol), [`P-BTC-${PUT}-${EXPIRY}`, `P-BTC-${PUT}-${EXPIRY}`], 'one strike');
  assert.deepEqual(plans.map((p) => p!.plan.underlying.stop), [84_600, 84_500], 'each signal its own SL');
  await api('POST', '/api/strategies/sig-same-strike/enabled', { enabled: false });
});

test('[critical] option TP and SL at 0: nothing is placed on the option, no alarm -- the perp levels are its only exits', async () => {
  const bare = { ...config, signal: { ...config.signal, maxOpen: 5 }, liveOrders: true, takeProfitPct: 0, stopLossPct: 0 };
  // As live: the desk has BTC's price, so a trade with no option stop is priced by where Delta would close it out.
  tradingService().noteSpot(85_000);
  assert.equal((await api('POST', '/api/strategies', { name: 'Sig bare', config: bare })).status, 200);
  await api('POST', '/api/strategies/sig-bare/enabled', { enabled: true });
  const sym = `C-BTC-${CALL}-${EXPIRY}`;
  paper().setQuote({ symbol: sym, bid: 18, ask: 18.5, bidSize: 5_000, askSize: 5_000, mark: 18.2, ts: Date.now() });
  const before = (await paper().getOpenOrders(sym)).filter((o) => o.reduceOnly).length;
  await runner.onSignal(signal({ dir: 'short', plan: { entryLo: 85_000, entryHi: 85_050, stop: 85_400, tp1: 84_500, tp2: null, tp3: null, tpWhy: [], rr: 1.25 } }));
  const run = (await runsOf('sig-bare')).at(-1)!;
  assert.equal(run.status, 'placed', run.detail);
  const t = await until(
    () => one<{ plan: any; state: any; position: number }>('SELECT plan, state, position FROM trades WHERE trade_id = $1', [run.trade_id]),
    (x) => x?.position !== 0, 'the call filled');
  assert.equal(t!.plan.takeProfitPrice, null, 'no option target asked, none planned');
  assert.equal(t!.plan.stopPrice, null, 'no option stop asked, none planned');
  assert.deepEqual(t!.plan.underlying.stop, 85_400, 'the perp SL is its exit');
  await new Promise((r) => setTimeout(r, 1_500));
  assert.equal((await paper().getOpenOrders(sym)).filter((o) => o.reduceOnly).length, before, 'nothing new resting on the option');
  const st = await one<{ state: any }>('SELECT state FROM trades WHERE trade_id = $1', [run.trade_id]);
  assert.equal(st!.state.alarm ?? null, null, 'no "unprotected" alarm: it asked for no option stop');
  await api('POST', '/api/strategies/sig-bare/enabled', { enabled: false });
});

test('[critical] live orders switched ON: the would-sells written down while it was off no longer count toward "at most N"', async () => {
  // sig-cap: at most 2, with 2 would-sells still in play in the paper log from the test above
  const cap = (await strategyStore().get('sig-cap'))!;
  await api('POST', '/api/strategies/sig-cap/enabled', { enabled: true });
  for (const sym of [`P-BTC-${PUT}-${EXPIRY}`, `C-BTC-${CALL}-${EXPIRY}`]) {
    paper().setQuote({ symbol: sym, bid: 18, ask: 18.5, bidSize: 5_000, askSize: 5_000, mark: 18.2, ts: Date.now() });
  }
  await runner.onSignal(signal());
  assert.match((await runsOf('sig-cap')).at(-1)!.detail, /already 2 of its trades open \(2 would-sell\)/, 'off: they count');
  assert.equal((await api('POST', '/api/strategies', { id: 'sig-cap', name: cap.name, config: { ...cap.config, liveOrders: true } })).status, 200);
  await runner.onSignal(signal());
  const last = (await runsOf('sig-cap')).at(-1)!;
  assert.equal(last.status, 'placed', `on: a real order, not blocked by would-sells -- ${last.detail}`);
  await api('POST', '/api/strategies/sig-cap/enabled', { enabled: false });
});

// ------------------------------------------------------------ the strike rule over the window

/*
 * The window cut into blocks, each with its own strike rule (4 Oct 2026): 9:00 AM
 * to 5:00 PM under "at most $20", from 1:00 PM "at most $10", from 3:00 PM the
 * third strike out. A board of its own, with strikes for each rule to find.
 */
const BLOCKS = [
  { at: '13:00', strikeRule: 'premium', strikeStep: 0, premium: { mode: 'atMost', usd: 10, fallbackUsd: null } },
  { at: '15:00', strikeRule: 'strict', strikeStep: 3, premium: { mode: 'atMost', usd: 10, fallbackUsd: null } },
];
const blocked = { ...config, signal: { ...config.signal, maxOpen: 10 }, strikeBlocks: BLOCKS };

test('[critical] strike blocks are saved with the strategy, in the database, as sent -- and a bad one is refused in words', async () => {
  const late = await api('POST', '/api/strategies', { name: 'Sig blocks', config: { ...blocked, strikeBlocks: [{ ...BLOCKS[0], at: '17:30' }] } });
  assert.equal(late.status, 422);
  assert.ok(late.body.problems.some((p: string) => /Block 2 \(5:30 PM\) must start after entry \(9:00 AM\) and before exit \(5:00 PM\)/.test(p)), late.body.problems.join(' '));
  const order = await api('POST', '/api/strategies', { name: 'Sig blocks', config: { ...blocked, strikeBlocks: [BLOCKS[1], BLOCKS[0]] } });
  assert.ok(order.body.problems.some((p: string) => /Block 3 \(1:00 PM\) must start after block 2/.test(p)), 'out of order is said, not sorted');
  const zero = await api('POST', '/api/strategies', { name: 'Sig blocks', config: { ...blocked, strikeBlocks: [{ ...BLOCKS[0], premium: { mode: 'atMost', usd: 0 } }] } });
  assert.ok(zero.body.problems.some((p: string) => /Block 2: the premium must be a positive number/.test(p)));

  const r = await api('POST', '/api/strategies', { name: 'Sig blocks', config: { ...blocked, strikeBlocks: [{ ...BLOCKS[0], stray: 'x' }, BLOCKS[1]] } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const row = await one<{ config: Record<string, any> }>("SELECT config FROM strategies WHERE id = 'sig-blocks'");
  assert.deepEqual(row!.config.strikeBlocks, BLOCKS, 'every block kept, and only its own keys');
  assert.deepEqual((await strategyStore().get('sig-blocks'))!.config.strikeBlocks, BLOCKS, 'and read back');
  const listed = (await api('GET', '/api/strategies')).body.strategies.find((x: any) => x.id === 'sig-blocks');
  assert.deepEqual(listed.config.strikeBlocks, BLOCKS, 'the screen gets them');
});

test('a strategy saved without blocks has none; a clock strategy never carries them', async () => {
  assert.equal((await api('POST', '/api/strategies', { name: 'Sig one rule', config })).status, 200);
  const none = await one<{ config: Record<string, any> }>("SELECT config FROM strategies WHERE id = 'sig-one-rule'");
  assert.deepEqual(none!.config.strikeBlocks, [], 'one rule for the whole window');
  const { trigger: _t, signal: _s, liveOrders: _l, ...clockOnly } = blocked;
  const r = await api('POST', '/api/strategies', { name: 'Clock blocks', config: clockOnly });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const row = await one<{ config: Record<string, any> }>("SELECT config FROM strategies WHERE id = 'clock-blocks'");
  assert.equal('strikeBlocks' in row!.config, false, 'dropped by the cleaner: the clock enters once, under one rule');
});

test('[critical] each signal is sold under the block the clock has reached, and its row says which', async () => {
  const FAR = 83_600, FURTHER = 83_200;
  for (const [strike, pid, bid] of [[FAR, 7003, 9], [FURTHER, 7004, 4]] as const) {
    const symbol = `P-BTC-${strike}-${EXPIRY}`;
    paper().addProduct({ symbol, productId: pid, underlying: 'BTC', optionSide: 'PE', strike, expiryTs: EXPIRY_TS, tickSize: 0.1, lotSize: 1, contractValue: 0.001, state: 'live' });
    paper().setQuote({ symbol, bid, ask: bid + 0.5, bidSize: 5_000, askSize: 5_000, mark: bid + 0.2, ts: Date.now() });
  }
  paper().setQuote({ symbol: `P-BTC-${PUT}-${EXPIRY}`, bid: 18, ask: 18.5, bidSize: 5_000, askSize: 5_000, mark: 18.2, ts: Date.now() });
  const wide: SignalBoard = {
    ...board,
    candidates: [
      ...board.candidates,
      { cp: 'P', strike: FAR, sellPrice: 9, pOtm: 0.9, moneyness: 'OTM', ask: 9.5 },
      { cp: 'P', strike: FURTHER, sellPrice: 4, pOtm: 0.95, moneyness: 'OTM', ask: 4.5 },
    ],
  };
  const byBlock = new StrategyRunner(strategyStore(), () => clock, async () => wide);
  await api('POST', '/api/strategies/sig-blocks/enabled', { enabled: true });
  await tradingService().settings.set('scheduler_enabled', '1');
  const last = async () => (await runsOf('sig-blocks')).at(-1)!;

  clock = TEN;                                         // 10:00 -- before the first block: the strategy's own rule
  await byBlock.onSignal(signal());
  assert.match((await last()).detail, /would sell PE 84000 x1 @ 18 · perp SL 84600 · TGT 85500$/, 'at most $20, and no block named');

  clock = TEN + 3 * 3_600_000;                         // 13:00 -- the minute the second block starts
  await byBlock.onSignal(signal());
  assert.match((await last()).detail, /would sell PE 83600 x1 @ 9 .* · block 2, from 1:00 PM$/, 'at most $10');

  clock = TEN + 5.5 * 3_600_000;                       // 15:30 -- the third: the third strike out, whatever it pays
  await byBlock.onSignal(signal());
  assert.match((await last()).detail, /would sell PE 83200 x1 @ 4 .* · block 3, from 3:00 PM$/);

  // A block whose rule finds nothing refuses the signal, and says which block asked.
  const s = (await strategyStore().get('sig-blocks'))!;
  const none = [{ ...BLOCKS[0], premium: { mode: 'atMost', usd: 2, fallbackUsd: null } }];
  assert.equal((await api('POST', '/api/strategies', { id: s.id, name: s.name, config: { ...s.config, strikeBlocks: none } })).status, 200);
  clock = TEN + 4 * 3_600_000;
  await byBlock.onSignal(signal());
  const refused = await last();
  assert.equal(refused.status, 'refused', refused.detail);
  assert.match(refused.detail, /PE: nothing out of the money at or below \$2 · block 2, from 1:00 PM$/);

  // And a strike the block did find, turned down by a gate: the row still says which block chose it.
  assert.equal((await api('POST', '/api/strategies', { id: s.id, name: s.name, config: { ...s.config, strikeBlocks: BLOCKS, minPremiumUsd: 5 } })).status, 200);
  clock = TEN + 5.5 * 3_600_000;                       // 15:30 -- the third strike out pays 4, under its $5 floor
  await byBlock.onSignal(signal());
  const gated = await last();
  assert.equal(gated.status, 'refused', gated.detail);
  assert.match(gated.detail, /\| refused: PE 83200 @ 4 — .+ · block 3, from 3:00 PM$/, 'the strike the gate turned down, and the block');

  clock = TEN;
  await api('POST', '/api/strategies/sig-blocks/enabled', { enabled: false });
});

test('[critical] "at least OTM n" on a premium rule and on a block: saved only when set, and it decides the strike in real runs', async () => {
  // Puts on the wide board: OTM 1 84,000 @ 18 · OTM 2 83,600 @ 9 · OTM 3 83,200 @ 4.
  const floored = {
    ...config, signal: { ...config.signal, maxOpen: 10 },
    premium: { mode: 'atMost', usd: 20, fallbackUsd: null, minOtm: 2 },               // picks OTM 1 @ 18: nearer than OTM 2
    strikeBlocks: [
      { at: '13:00', strikeRule: 'premium', strikeStep: 0, premium: { mode: 'atMost', usd: 10, fallbackUsd: null, minOtm: 1 } },   // picks OTM 2 @ 9: stands
      { at: '15:00', strikeRule: 'premium', strikeStep: 0, premium: { mode: 'atMost', usd: 20, fallbackUsd: null, minOtm: 3 } },   // picks OTM 1: sold at OTM 3
      { at: '16:00', strikeRule: 'premium', strikeStep: 0, premium: { mode: 'atMost', usd: 20, fallbackUsd: null, minOtm: 3, elseOtm: 2 } },   // picks OTM 1: its else names OTM 2
    ],
  };
  const badElse = await api('POST', '/api/strategies', { name: 'Sig floor', config: { ...floored, premium: { ...floored.premium, elseOtm: 0 } } });
  assert.equal(badElse.status, 422);
  assert.ok(badElse.body.problems.includes('The else strike must be OTM 1 to OTM 20.'), badElse.body.problems.join(' '));
  const bad = await api('POST', '/api/strategies', { name: 'Sig floor', config: { ...floored, premium: { ...floored.premium, minOtm: 0 } } });
  assert.equal(bad.status, 422);
  assert.ok(bad.body.problems.includes('The nearest strike a premium rule may sell must be OTM 1 to OTM 20, or switched off.'), bad.body.problems.join(' '));
  const badBlock = await api('POST', '/api/strategies', { name: 'Sig floor', config: { ...floored, strikeBlocks: [{ ...floored.strikeBlocks[0], premium: { mode: 'atMost', usd: 10, minOtm: 21 } }] } });
  assert.ok(badBlock.body.problems.some((p: string) => /^Block 2: The nearest strike a premium rule may sell/.test(p)));

  assert.equal((await api('POST', '/api/strategies', { name: 'Sig floor', config: floored })).status, 200);
  const row = await one<{ config: Record<string, any> }>("SELECT config FROM strategies WHERE id = 'sig-floor'");
  assert.equal(row!.config.premium.minOtm, 2);
  assert.equal(row!.config.premium.elseOtm, 2, 'the else strike is written beside its rule: the rule\'s own when none was sent');
  assert.deepEqual(row!.config.strikeBlocks.map((b: any) => [b.premium.minOtm, b.premium.elseOtm]), [[1, 1], [3, 3], [3, 2]]);
  const plain = await one<{ config: Record<string, any> }>("SELECT config FROM strategies WHERE id = 'sig-blocks'");
  assert.equal('minOtm' in plain!.config.premium, false, 'off is no key at all: a strategy that never used it is stored as before');
  assert.equal('elseOtm' in plain!.config.premium, false);

  const FAR = 83_600, FURTHER = 83_200;
  for (const [strike, pid, bid] of [[PUT, 7001, 18], [FAR, 7003, 9], [FURTHER, 7004, 4]] as const) {
    const symbol = `P-BTC-${strike}-${EXPIRY}`;
    paper().addProduct({ symbol, productId: pid, underlying: 'BTC', optionSide: 'PE', strike, expiryTs: EXPIRY_TS, tickSize: 0.1, lotSize: 1, contractValue: 0.001, state: 'live' });
    paper().setQuote({ symbol, bid, ask: bid + 0.5, bidSize: 5_000, askSize: 5_000, mark: bid + 0.2, ts: Date.now() });
  }
  const wide: SignalBoard = {
    ...board,
    candidates: [
      ...board.candidates,
      { cp: 'P', strike: FAR, sellPrice: 9, pOtm: 0.9, moneyness: 'OTM', ask: 9.5 },
      { cp: 'P', strike: FURTHER, sellPrice: 4, pOtm: 0.95, moneyness: 'OTM', ask: 4.5 },
    ],
  };
  const r = new StrategyRunner(strategyStore(), () => clock, async () => wide);
  await api('POST', '/api/strategies/sig-floor/enabled', { enabled: true });
  await tradingService().settings.set('scheduler_enabled', '1');
  const last = async () => (await runsOf('sig-floor')).at(-1)!;

  clock = TEN;                                         // the rule itself: at most $20 is OTM 1, the floor is OTM 2
  await r.onSignal(signal());
  assert.match((await last()).detail, /would sell PE 83600 x1 @ 9 \(rule failed: the premium's strike 84000 @ 18 is nearer than OTM 2 — went to the else strike OTM 2\) · perp SL 84600 · TGT 85500$/);

  clock = TEN + 3.5 * 3_600_000;                       // 13:30 -- at most $10 is OTM 2, past its OTM 1 floor: the premium's own strike
  await r.onSignal(signal());
  assert.match((await last()).detail, /would sell PE 83600 x1 @ 9 · perp SL 84600 · TGT 85500 · block 2, from 1:00 PM$/);

  clock = TEN + 5.5 * 3_600_000;                       // 15:30 -- at most $20 is OTM 1, the floor is OTM 3
  await r.onSignal(signal());
  assert.match((await last()).detail, /would sell PE 83200 x1 @ 4 \(rule failed: the premium's strike 84000 @ 18 is nearer than OTM 3 — went to the else strike OTM 3\) · perp SL 84600 · TGT 85500 · block 3, from 3:00 PM$/);

  clock = TEN + 6.5 * 3_600_000;                       // 16:30 -- the same rule, OTM 3, with an else strike of its own: OTM 2
  await r.onSignal(signal());
  assert.match((await last()).detail, /would sell PE 83600 x1 @ 9 \(rule failed: the premium's strike 84000 @ 18 is nearer than OTM 3 — went to the else strike OTM 2\) · perp SL 84600 · TGT 85500 · block 4, from 4:00 PM$/);

  // The rule failed and its else strike is not on the board: the signal is not taken, and its row -- the one the
  // trade history's Skipped tab shows -- says both halves and the block.
  const s = (await strategyStore().get('sig-floor'))!;
  const gone = [{ at: '13:00', strikeRule: 'premium', strikeStep: 0, premium: { mode: 'atMost', usd: 20, fallbackUsd: null, minOtm: 3, elseOtm: 9 } }];
  assert.equal((await api('POST', '/api/strategies', { id: s.id, name: s.name, config: { ...s.config, strikeBlocks: gone } })).status, 200);
  clock = TEN + 4 * 3_600_000;
  await r.onSignal(signal());
  const refused = await last();
  assert.equal(refused.status, 'refused', refused.detail);
  assert.equal(refused.detail.split(' | ')[1], "PE: rule failed — the premium's strike 84000 @ 18 is nearer than OTM 3 — and the else strike OTM 9 is not listed with a price · block 2, from 1:00 PM");
  // The rule failed, its else strike was chosen, and a gate turned that strike down: the row says all three.
  const low = [{ at: '13:00', strikeRule: 'premium', strikeStep: 0, premium: { mode: 'atMost', usd: 20, fallbackUsd: null, minOtm: 2, elseOtm: 3 } }];
  assert.equal((await api('POST', '/api/strategies', { id: s.id, name: s.name, config: { ...s.config, strikeBlocks: low, minPremiumUsd: 5 } })).status, 200);
  await r.onSignal(signal());
  const gatedElse = await last();
  assert.equal(gatedElse.status, 'refused', gatedElse.detail);
  assert.match(gatedElse.detail, /\| refused: PE 83200 @ 4 \(rule failed: the premium's strike 84000 @ 18 is nearer than OTM 2 — went to the else strike OTM 3\) — .+ · block 2, from 1:00 PM$/);
  const listed = (await api('GET', '/api/strategies')).body.signalTrades.find((t: any) => t.strategyId === 'sig-floor' && t.status === 'refused' && /not listed/.test(t.detail));
  assert.match(listed.detail, /rule failed — .* · block 2, from 1:00 PM$/, 'and the history gets the same words');

  clock = TEN;
  await api('POST', '/api/strategies/sig-floor/enabled', { enabled: false });
});

// ------------------------------------------------------------ the SL-distance filter

test('[critical] SL distance per timeframe: a signal whose SL is nearer than its timeframe\'s points is skipped, and the history says why', async () => {
  // The signal: entry zone 84,950-85,000 (its middle 84,975 is the entry when the perp has no fresh print), SL 84,600 -- 375 pts.
  const filtered = {
    ...config, signal: { ...config.signal, tfs: ['5m', '15m'], maxOpen: 10, minSlPts: { '5m': 500, '15m': 375, '1h': 0, '4h': '' } },
  };
  const bad = await api('POST', '/api/strategies', { name: 'Sig sl', config: { ...filtered, signal: { ...filtered.signal, minSlPts: { '5m': -5 } } } });
  assert.equal(bad.status, 422);
  assert.ok(bad.body.problems.includes('The SL distance for 5m must be from 0 to 100,000 points.'), bad.body.problems.join(' '));

  assert.equal((await api('POST', '/api/strategies', { name: 'Sig sl', config: filtered })).status, 200);
  const row = await one<{ config: Record<string, any> }>("SELECT config FROM strategies WHERE id = 'sig-sl'");
  assert.deepEqual(row!.config.signal.minSlPts, { '5m': 500, '15m': 375 }, 'each timeframe\'s number kept; a blank or zero is no entry');
  const plain = await one<{ config: Record<string, any> }>("SELECT config FROM strategies WHERE id = 'sig-blocks'");
  assert.equal('minSlPts' in plain!.config.signal, false, 'a strategy that never used it is stored as before');

  for (const sym of [`P-BTC-${PUT}-${EXPIRY}`, `C-BTC-${CALL}-${EXPIRY}`]) {
    paper().setQuote({ symbol: sym, bid: 18, ask: 18.5, bidSize: 5_000, askSize: 5_000, mark: 18.2, ts: Date.now() });
  }
  await api('POST', '/api/strategies/sig-sl/enabled', { enabled: true });
  await tradingService().settings.set('scheduler_enabled', '1');
  clock = TEN;
  const last = async () => (await runsOf('sig-sl')).at(-1)!;

  await runner.onSignal(signal());                       // 5m: 375 pts against 500 -- not taken
  const skipped = await last();
  assert.equal(skipped.status, 'skipped', skipped.detail);
  assert.equal(skipped.detail, '#1 Breakout BUY | SL too near: the perp entry 84975 to the SL 84600 is 375 pts — this strategy takes 5m signals only at 500 pts or more');
  assert.equal(skipped.trade_id, null);

  await runner.onSignal(signal({ tf: '15m' }));          // 15m: 375 against 375 -- equal is enough
  assert.equal((await last()).status, 'would-place', (await last()).detail);

  // a wider stop on 5m passes its 500
  await runner.onSignal(signal({ plan: { entryLo: 84_950, entryHi: 85_000, stop: 84_400, tp1: 85_500, tp2: null, tp3: null, tpWhy: [], rr: 1 } }));
  assert.match((await last()).detail, /would sell PE 84000 x1 @ 18 · perp SL 84400/);

  // a SELL is measured the same way: the stop above the entry
  await runner.onSignal(signal({ dir: 'short', plan: { entryLo: 85_000, entryHi: 85_050, stop: 85_200, tp1: 84_500, tp2: null, tp3: null, tpWhy: [], rr: 1 } }));
  assert.match((await last()).detail, /SELL \| SL too near: the perp entry 85025 to the SL 85200 is 175 pts — this strategy takes 5m signals only at 500 pts or more$/);

  // the trade history's Skipped tab gets the row, reason and all
  const listed = (await api('GET', '/api/strategies')).body.signalTrades.filter((t: any) => t.strategyId === 'sig-sl' && t.status === 'skipped');
  assert.equal(listed.length, 2);
  assert.match(listed[0].detail, /SL too near: .* is 175 pts/);
  await api('POST', '/api/strategies/sig-sl/enabled', { enabled: false });
});

test('[critical] a maximum too: a signal whose SL or TGT is further than its timeframe\'s most is skipped, 0 is off, and a most under its least is refused', async () => {
  // The signal: entry 84,975, SL 84,600 -- 375 pts; TGT1 85,500 -- 525 pts.
  const ranged = { ...config, signal: { ...config.signal, tfs: ['5m', '15m'], maxOpen: 10, maxSlPts: { '5m': 300, '15m': 0 }, maxTgtPts: { '5m': 400, '1h': '' } } };
  const crossed = await api('POST', '/api/strategies', { name: 'Sig max', config: { ...ranged, signal: { ...ranged.signal, minSlPts: { '5m': 500 } } } });
  assert.equal(crossed.status, 422);
  assert.ok(crossed.body.problems.includes('The SL maximum for 5m (300) is under its minimum (500): no signal could pass both.'), crossed.body.problems.join(' '));
  const over = await api('POST', '/api/strategies', { name: 'Sig max', config: { ...ranged, signal: { ...ranged.signal, maxTgtPts: { '5m': 100_001 } } } });
  assert.ok(over.body.problems.includes('The TGT maximum distance for 5m must be from 0 to 100,000 points.'), over.body.problems.join(' '));

  assert.equal((await api('POST', '/api/strategies', { name: 'Sig max', config: ranged })).status, 200);
  const row = await one<{ config: Record<string, any> }>("SELECT config FROM strategies WHERE id = 'sig-max'");
  assert.deepEqual([row!.config.signal.maxSlPts, row!.config.signal.maxTgtPts], [{ '5m': 300 }, { '5m': 400 }], 'a blank or zero is no entry: off');
  const plain = await one<{ config: Record<string, any> }>("SELECT config FROM strategies WHERE id = 'sig-sl'");
  assert.equal('maxSlPts' in plain!.config.signal || 'maxTgtPts' in plain!.config.signal, false, 'a strategy that never used it is stored as before');

  for (const sym of [`P-BTC-${PUT}-${EXPIRY}`, `C-BTC-${CALL}-${EXPIRY}`]) {
    paper().setQuote({ symbol: sym, bid: 18, ask: 18.5, bidSize: 5_000, askSize: 5_000, mark: 18.2, ts: Date.now() });
  }
  await api('POST', '/api/strategies/sig-max/enabled', { enabled: true });
  await tradingService().settings.set('scheduler_enabled', '1');
  clock = TEN;
  const last = async () => (await runsOf('sig-max')).at(-1)!;

  await runner.onSignal(signal());                       // 5m: SL 375 against at most 300, TGT 525 against at most 400 -- both said
  const skipped = await last();
  assert.equal(skipped.status, 'skipped', skipped.detail);
  assert.equal(skipped.detail, '#1 Breakout BUY | SL too far: the perp entry 84975 to the SL 84600 is 375 pts — this strategy takes 5m signals only at 300 pts or less; '
    + 'TGT too far: the perp entry 84975 to the TGT 85500 is 525 pts — this strategy takes 5m signals only at 400 pts or less');
  assert.equal(skipped.trade_id, null);

  await runner.onSignal(signal({ tf: '15m' }));          // 15m: no maximum set -- taken as before
  assert.equal((await last()).status, 'would-place', (await last()).detail);

  // exactly at the maximum is inside it: SL 300 pts, TGT 400 pts
  await runner.onSignal(signal({ plan: { entryLo: 84_950, entryHi: 85_000, stop: 84_675, tp1: 85_375, tp2: null, tp3: null, tpWhy: [], rr: 1 } }));
  assert.equal((await last()).status, 'would-place', (await last()).detail);

  // a SELL is measured the same way: the stop above the entry, 475 pts against at most 300
  await runner.onSignal(signal({ dir: 'short', plan: { entryLo: 85_000, entryHi: 85_050, stop: 85_500, tp1: 84_700, tp2: null, tp3: null, tpWhy: [], rr: 1 } }));
  assert.match((await last()).detail, /SELL \| SL too far: the perp entry 85025 to the SL 85500 is 475 pts — this strategy takes 5m signals only at 300 pts or less$/);
  await api('POST', '/api/strategies/sig-max/enabled', { enabled: false });
});

// ------------------------------------------------------------ bought or sold

test('[critical] a BUY-side strategy: a BUY signal buys the call, a SELL the put -- written down at the offer, never sent, and never live', async () => {
  const bought = { ...config, signal: { ...config.signal, tfs: ['5m'], maxOpen: 10, action: 'buy' } };
  // Live orders cannot be on for it: there is no buy order the desk can send.
  const live = await api('POST', '/api/strategies', { name: 'Sig buy', config: { ...bought, liveOrders: true } });
  assert.equal(live.status, 422);
  assert.ok(live.body.problems.includes('A BUY strategy is written down only for now: the desk sends sell orders, not buys, so its live orders stay off.'), live.body.problems.join(' '));
  const odd = await api('POST', '/api/strategies', { name: 'Sig buy', config: { ...bought, signal: { ...bought.signal, action: 'hold' } } });
  assert.ok(odd.body.problems.includes('Pick whether the option is bought or sold.'), odd.body.problems.join(' '));

  assert.equal((await api('POST', '/api/strategies', { name: 'Sig buy', config: bought })).status, 200);
  const row = await one<{ config: Record<string, any> }>("SELECT config FROM strategies WHERE id = 'sig-buy'");
  assert.equal(row!.config.signal.action, 'buy');

  for (const sym of [`P-BTC-${PUT}-${EXPIRY}`, `C-BTC-${CALL}-${EXPIRY}`]) {
    paper().setQuote({ symbol: sym, bid: 18, ask: 18.5, bidSize: 5_000, askSize: 5_000, mark: 18.2, ts: Date.now() });
  }
  await api('POST', '/api/strategies/sig-buy/enabled', { enabled: true });
  await tradingService().settings.set('scheduler_enabled', '1');
  clock = TEN;
  const last = async () => (await runsOf('sig-buy')).at(-1)!;
  const tradesBefore = (await rows('SELECT trade_id FROM trades')).length;

  await runner.onSignal(signal());                       // a BUY signal: the call, bought
  const up = await last();
  assert.equal(up.status, 'would-place', up.detail);
  assert.match(up.detail, /^#1 Breakout BUY \| written down only: would buy CE \d+ x1 @ [\d.]+ · perp SL 84600 · TGT 85500$/);
  assert.equal(up.trade_id, null);

  await runner.onSignal(signal({ dir: 'short', plan: { entryLo: 85_000, entryHi: 85_050, stop: 85_400, tp1: 84_500, tp2: null, tp3: null, tpWhy: [], rr: 1 } }));
  assert.match((await last()).detail, /SELL \| written down only: would buy PE \d+ x1 @ [\d.]+ · perp SL 85400 · TGT 84500$/, 'a SELL signal: the put, bought');

  assert.equal((await rows('SELECT trade_id FROM trades')).length, tradesBefore, 'nothing was placed: no trade, no order');
  await api('POST', '/api/strategies/sig-buy/enabled', { enabled: false });
});

test('[critical] at the zone, the distance is measured from the fill -- and with the chain the filter is not read', async () => {
  const zone = { ...config, signal: { mode: 'single', tf: '15m', tfs: ['15m'], methods: ['breakout'], target: 'tp1', maxOpen: 10, enterOn: 'zone', minSlPts: { '15m': 400 } } };
  assert.equal((await api('POST', '/api/strategies', { name: 'Sig sl zone', config: zone })).status, 200);
  const chain = { ...config, signal: { mode: 'mtf', tf: '5m', methods: ['breakout'], target: 'tp1', maxOpen: 10, enterOn: 'signal', minSlPts: { '5m': 5_000 } } };
  assert.equal((await api('POST', '/api/strategies', { name: 'Sig sl chain', config: chain })).status, 200);
  for (const id of ['sig-sl-zone', 'sig-sl-chain']) await api('POST', `/api/strategies/${id}/enabled`, { enabled: true });
  for (const sym of [`P-BTC-${PUT}-${EXPIRY}`, `C-BTC-${CALL}-${EXPIRY}`]) {
    paper().setQuote({ symbol: sym, bid: 18, ask: 18.5, bidSize: 5_000, askSize: 5_000, mark: 18.2, ts: Date.now() });
  }
  clock = TEN;
  const fill = (fillPrice: number, triggerAt: number) => ({
    method: 'breakout', mode: 'single' as const, tf: '15m' as const, dir: 1 as const, triggerAt,
    entryLo: 84_950, entryHi: 85_000, stop: 84_600, tp1: 85_500, tp2: null, tp3: null,
    status: 'filled' as const, filledAt: Math.floor(clock / 1000), fillPrice,
  });
  await runner.onSetupFilled(fill(84_990, 1_790_900_000));     // 390 pts from the fill: under 400
  const near = (await runsOf('sig-sl-zone')).at(-1)!;
  assert.equal(near.status, 'skipped', near.detail);
  assert.match(near.detail, /SL too near: the perp entry 84990 to the SL 84600 is 390 pts — this strategy takes 15m signals only at 400 pts or more$/);
  await runner.onSetupFilled(fill(85_000, 1_790_900_900));     // 400 pts: taken
  assert.equal((await runsOf('sig-sl-zone')).at(-1)!.status, 'would-place');

  await runner.onSignal(signal({ mode: 'mtf', tf: '5m' }));    // with the chain: 375 pts against a 5,000 it does not read
  const taken = (await runsOf('sig-sl-chain')).at(-1)!;
  assert.equal(taken.status, 'would-place', taken.detail);
  for (const id of ['sig-sl-zone', 'sig-sl-chain']) await api('POST', `/api/strategies/${id}/enabled`, { enabled: false });
});

test('[critical] TGT distance per timeframe: a signal whose target is nearer than its points is skipped, said in the history -- measured to the target the trade exits at', async () => {
  // The signal: entry 84,975 (the middle of its zone), SL 84,600 (375 pts), TGT1 85,500 (525 pts), TGT2 85,900 (925 pts).
  const withTgt = (over: Record<string, unknown>) => ({ ...config, signal: { ...config.signal, maxOpen: 10, ...over } });
  const bad = await api('POST', '/api/strategies', { name: 'Sig tgt', config: withTgt({ minTgtPts: { '5m': -5 } }) });
  assert.equal(bad.status, 422);
  assert.ok(bad.body.problems.includes('The TGT distance for 5m must be from 0 to 100,000 points.'), bad.body.problems.join(' '));

  assert.equal((await api('POST', '/api/strategies', { name: 'Sig tgt', config: withTgt({ minTgtPts: { '5m': 600, '15m': 0, '1h': '' } }) })).status, 200);
  const row = await one<{ config: Record<string, any> }>("SELECT config FROM strategies WHERE id = 'sig-tgt'");
  assert.deepEqual(row!.config.signal.minTgtPts, { '5m': 600 }, 'kept; a blank or zero is no entry');
  assert.equal('minSlPts' in row!.config.signal, false, 'the SL filter is its own key, absent when unused');
  const plain = await one<{ config: Record<string, any> }>("SELECT config FROM strategies WHERE id = 'sig-blocks'");
  assert.equal('minTgtPts' in plain!.config.signal, false, 'a strategy that never used it is stored as before');

  for (const sym of [`P-BTC-${PUT}-${EXPIRY}`, `C-BTC-${CALL}-${EXPIRY}`]) {
    paper().setQuote({ symbol: sym, bid: 18, ask: 18.5, bidSize: 5_000, askSize: 5_000, mark: 18.2, ts: Date.now() });
  }
  await api('POST', '/api/strategies/sig-tgt/enabled', { enabled: true });
  await tradingService().settings.set('scheduler_enabled', '1');
  clock = TEN;
  const last = async () => (await runsOf('sig-tgt')).at(-1)!;
  const save = async (over: Record<string, unknown>) => {
    const s = (await strategyStore().get('sig-tgt'))!;
    assert.equal((await api('POST', '/api/strategies', { id: s.id, name: s.name, config: withTgt(over) })).status, 200);
  };

  await runner.onSignal(signal());                       // TGT1 525 pts against 600: not taken
  const skipped = await last();
  assert.equal(skipped.status, 'skipped', skipped.detail);
  assert.equal(skipped.detail, '#1 Breakout BUY | TGT too near: the perp entry 84975 to the TGT 85500 is 525 pts — this strategy takes 5m signals only at 600 pts or more');

  await save({ minTgtPts: { '5m': 525 } });              // equal is enough
  await runner.onSignal(signal());
  assert.equal((await last()).status, 'would-place', (await last()).detail);

  await save({ minTgtPts: { '5m': 600 }, target: 'tp2' });   // exits at TGT2: 925 pts, measured to that one
  await runner.onSignal(signal());
  assert.match((await last()).detail, /would sell PE 84000 x1 @ 18 · perp SL 84600 · TGT 85900$/);

  // TGT2 asked for and the signal has none: TGT1 is the exit, and the distance is to TGT1
  await runner.onSignal(signal({ plan: { entryLo: 84_950, entryHi: 85_000, stop: 84_600, tp1: 85_500, tp2: null, tp3: null, tpWhy: [], rr: 1.25 } }));
  assert.match((await last()).detail, /TGT too near: the perp entry 84975 to the TGT 85500 is 525 pts/);

  // both filters on, both failing: both said in the one row
  await save({ minSlPts: { '5m': 500 }, minTgtPts: { '5m': 600 }, target: 'tp1' });
  await runner.onSignal(signal());
  assert.equal((await last()).detail,
    '#1 Breakout BUY | SL too near: the perp entry 84975 to the SL 84600 is 375 pts — this strategy takes 5m signals only at 500 pts or more; '
    + 'TGT too near: the perp entry 84975 to the TGT 85500 is 525 pts — this strategy takes 5m signals only at 600 pts or more');

  // a SELL is measured the same way: the target under the entry
  await save({ minTgtPts: { '5m': 600 } });
  await runner.onSignal(signal({ dir: 'short', plan: { entryLo: 85_000, entryHi: 85_050, stop: 85_400, tp1: 84_500, tp2: null, tp3: null, tpWhy: [], rr: 1.25 } }));
  assert.match((await last()).detail, /SELL \| TGT too near: the perp entry 85025 to the TGT 84500 is 525 pts — this strategy takes 5m signals only at 600 pts or more$/);

  await api('POST', '/api/strategies/sig-tgt/enabled', { enabled: false });
});

// ------------------------------------------------------------ the desk-wide cap on open trades

test('[critical] at most open at once, across all strategies: one number over every strategy, saved as a setting, and a signal past it is skipped in words', async () => {
  const MSG = 'At most open at once, across all strategies, must be a whole number from 0 (no limit) to 500.';
  for (const bad of [-1, 501, 1.5, 'six', null]) {
    const r = await api('POST', '/api/strategies/max-open', { max: bad });
    assert.equal(r.status, 422, String(bad));
    assert.deepEqual(r.body.problems, [MSG]);
  }
  // Nothing set: no cap, and the list says so beside how many are open now.
  let status = (await api('GET', '/api/strategies')).body;
  assert.equal(status.signalMaxOpen, 0);
  const openBefore = (await tradingService().openTrades()).length;
  assert.equal(status.openNow, openBefore);

  // Two strategies, each allowed ten of its own: twenty between them, were it not for the desk's one number.
  const each = { ...config, signal: { ...config.signal, maxOpen: 10 }, liveOrders: true };
  for (const name of ['Sig cap a', 'Sig cap b']) {
    assert.equal((await api('POST', '/api/strategies', { name, config: each })).status, 200);
    await api('POST', `/api/strategies/${name.toLowerCase().replace(/ /g, '-')}/enabled`, { enabled: true });
  }
  await tradingService().settings.set('scheduler_enabled', '1');
  clock = TEN;
  const quote = () => {
    for (const sym of [`P-BTC-${PUT}-${EXPIRY}`, `C-BTC-${CALL}-${EXPIRY}`]) {
      paper().setQuote({ symbol: sym, bid: 18, ask: 18.5, bidSize: 5_000, askSize: 5_000, mark: 18.2, ts: Date.now() });
    }
  };
  const lastOf = async (id: string) => (await runsOf(id)).at(-1)!;

  // What the strategies switched on allow between them: the sum of their own limits. A cap above it can never bind,
  // so it is refused with that sum -- not stored as a limit that protects nothing.
  const { signalEntriesAllowed } = await import('../../src/strategy/types.js');
  const allowed = signalEntriesAllowed(await strategyStore().all());
  assert.ok(allowed >= 20, `the two just switched on allow ten each: ${allowed}`);
  const over = await api('POST', '/api/strategies/max-open', { max: allowed + 1 });
  assert.equal(over.status, 422);
  assert.deepEqual(over.body.problems, [`The strategies switched on allow ${allowed} entries between them, so a limit above ${allowed} changes nothing. Enter ${allowed} or less.`]);
  assert.equal((await one<{ n: number }>("SELECT count(*)::int AS n FROM settings WHERE key = 'signal_max_open'"))!.n, 0, 'nothing stored');
  assert.equal((await api('POST', '/api/strategies/max-open', { max: allowed })).status, 200, 'the sum itself is accepted');

  // The cap: one more than the desk holds now. Saved in the settings table, as a number the list reads back.
  const cap = openBefore + 1;
  assert.ok(cap <= allowed, `the cap under test (${cap}) is inside what the strategies allow (${allowed})`);
  const saved = await api('POST', '/api/strategies/max-open', { max: cap });
  assert.deepEqual([saved.status, saved.body.signalMaxOpen], [200, cap]);
  const row = await one<{ value: string }>("SELECT value FROM settings WHERE key = 'signal_max_open'");
  assert.equal(row!.value, String(cap));
  assert.equal((await api('GET', '/api/strategies')).body.signalMaxOpen, cap);

  // One signal, taken by both strategies in turn: the first fills the last place, the second is over the desk's cap --
  // though it holds none of its own, and its own limit is ten.
  quote();
  await runner.onSignal(signal());
  const a = await lastOf('sig-cap-a');
  const b = await lastOf('sig-cap-b');
  assert.equal(a.status, 'placed', a.detail);
  assert.equal(b.status, 'skipped', b.detail);
  assert.equal(b.detail.split(' | ')[1], `the desk already has ${cap} open (positions and working orders, all strategies) -- at most ${cap} at once across all`);
  assert.equal(b.trade_id, null, 'nothing sent');
  status = (await api('GET', '/api/strategies')).body;
  assert.equal(status.openNow, cap);
  // Each strategy's card is told what it holds now: one trade of one lot for the first, nothing for the second.
  const openOf = (id: string) => status.strategies.find((x: any) => x.id === id).open;
  assert.deepEqual(openOf('sig-cap-a'), { trades: 1, lots: 1 }, 'a working entry counts at the size it asked for');
  assert.deepEqual(openOf('sig-cap-b'), { trades: 0, lots: 0 });
  // The summary's other figures: the desk's limit on lots short and the lots short now, Delta's wallet (none on
  // paper), and which build this is -- no tag when run by hand, as here.
  assert.equal(status.shortCap, tradingService().maxShortContracts);
  assert.ok(Number.isInteger(status.shortNow) && status.shortNow >= status.openNow, `lots short (${status.shortNow}) cover every open trade (${status.openNow})`);
  assert.equal(status.shortNow, status.strategies.reduce((n: number, x: any) => n + (x.open?.lots ?? 0), 0)
    + (await tradingService().openTrades()).filter((t) => !t.plan.strategyId || !status.strategies.some((x: any) => x.id === t.plan.strategyId && x.open))
      .reduce((n, t) => n + (Math.abs(t.state.position) || t.state.requestedSize || 0), 0), 'each strategy\'s lots, and the rest');
  assert.deepEqual([status.walletUsd, status.marginUsedUsd], [null, null]);
  assert.equal(status.build.tag, null);
  assert.ok(status.build.startedAt <= Date.now() && status.build.startedAt > Date.now() - 3_600_000);
  const skippedRow = status.signalTrades.find((t: any) => t.strategyId === 'sig-cap-b' && t.status === 'skipped');
  assert.match(skippedRow.detail, /at most \d+ at once across all$/, 'and the trade history\'s Skipped tab gets the reason');

  // The strategy's own limit is still its own: with the desk's cap far away, "at most 1" of its own still holds it.
  assert.equal((await api('POST', '/api/strategies/max-open', { max: allowed })).status, 200);
  const one1 = (await strategyStore().get('sig-cap-a'))!;
  await api('POST', '/api/strategies', { id: one1.id, name: one1.name, config: { ...one1.config, signal: { ...one1.config.signal, maxOpen: 1 } } });
  await api('POST', '/api/strategies/sig-cap-b/enabled', { enabled: false });
  quote();
  await runner.onSignal(signal());
  assert.match((await lastOf('sig-cap-a')).detail, /already 1 of its trade open .*-- at most 1$/);

  // 0 takes the cap off: the second strategy takes the next signal.
  await api('POST', '/api/strategies/max-open', { max: 0 });
  assert.equal((await api('GET', '/api/strategies')).body.signalMaxOpen, 0);
  await api('POST', '/api/strategies/sig-cap-b/enabled', { enabled: true });
  quote();
  await runner.onSignal(signal());
  const free = await lastOf('sig-cap-b');
  assert.equal(free.status, 'placed', free.detail);
  for (const id of ['sig-cap-a', 'sig-cap-b']) await api('POST', `/api/strategies/${id}/enabled`, { enabled: false });
});

// ------------------------------------------------------------ the limits, as real money needs them

test('[critical] the limits under load: a ticket trade takes a place, a burst of signals stops exactly at the cap, a fill at the zone is held to it, and a cancelled entry frees its place', async () => {
  const quote = () => {
    for (const sym of [`P-BTC-${PUT}-${EXPIRY}`, `C-BTC-${CALL}-${EXPIRY}`]) {
      paper().setQuote({ symbol: sym, bid: 18, ask: 18.5, bidSize: 5_000, askSize: 5_000, mark: 18.2, ts: Date.now() });
    }
  };
  const open = async () => (await tradingService().openTrades()).length;
  // The cap is set straight into the settings here: the route holds it to what the strategies allow, and these
  // cases need it just above whatever earlier tests left open.
  const setCap = (n: number) => tradingService().settings.set('signal_max_open', String(n));
  const live = { ...config, signal: { ...config.signal, maxOpen: 10 }, liveOrders: true };
  assert.equal((await api('POST', '/api/strategies', { name: 'Sig burst', config: live })).status, 200);
  assert.equal((await api('POST', '/api/strategies', { name: 'Sig burst zone', config: { ...live, signal: { ...live.signal, tf: '15m', enterOn: 'zone' } } })).status, 200);
  await api('POST', '/api/strategies/sig-burst/enabled', { enabled: true });
  await tradingService().settings.set('scheduler_enabled', '1');
  clock = TEN;
  const runs = async (id: string) => (await runsOf(id)).map((r) => r.status);
  const lastOf = async (id: string) => (await runsOf(id)).at(-1)!;

  // A trade placed from the ticket is a trade on the desk: it takes a place under the cap like any other.
  quote();
  const before = await open();
  // On a contract of its own: the ticket will not open a second trade on a contract the desk already holds.
  const TICKET = 82_800;
  paper().addProduct({ symbol: `P-BTC-${TICKET}-${EXPIRY}`, productId: 7010, underlying: 'BTC', optionSide: 'PE', strike: TICKET, expiryTs: EXPIRY_TS, tickSize: 0.1, lotSize: 1, contractValue: 0.001, state: 'live' });
  paper().setQuote({ symbol: `P-BTC-${TICKET}-${EXPIRY}`, bid: 8, ask: 8.5, bidSize: 5_000, askSize: 5_000, mark: 8.2, ts: Date.now() });
  const ticket = await api('POST', '/api/trade/place', { symbol: `P-BTC-${TICKET}-${EXPIRY}`, side: 'PE', strike: TICKET, expiryTs: EXPIRY_TS, lots: 1, limitPrice: 8.5, leverage: 200 });
  assert.equal(ticket.status, 200, JSON.stringify(ticket.body).slice(0, 300));
  assert.equal(await open(), before + 1);
  await setCap(before + 1);
  await runner.onSignal(signal());
  const held = await lastOf('sig-burst');
  assert.equal(held.status, 'skipped', held.detail);
  assert.match(held.detail, new RegExp(`the desk already has ${before + 1} open .* at most ${before + 1} at once across all$`), 'the strategy holds none of its own: the ticket\'s trade filled the last place');
  assert.equal(await open(), before + 1, 'nothing sent');

  // A burst: five signals in the same moment, two places left. Exactly two orders go out -- never three.
  await setCap(before + 3);
  quote();
  const n0 = (await runs('sig-burst')).length;
  await Promise.all([1, 2, 3, 4, 5].map(() => runner.onSignal(signal())));
  const burst = (await runs('sig-burst')).slice(n0);
  assert.deepEqual([burst.filter((s) => s === 'placed').length, burst.filter((s) => s === 'skipped').length], [2, 3], burst.join(','));
  assert.equal(await open(), before + 3, 'the desk holds exactly the cap');
  assert.equal((await api('GET', '/api/strategies')).body.openNow, before + 3);

  // A signal that fills at its zone is held to the same cap.
  await api('POST', '/api/strategies/sig-burst/enabled', { enabled: false });
  await api('POST', '/api/strategies/sig-burst-zone/enabled', { enabled: true });
  quote();
  await runner.onSetupFilled({
    method: 'breakout', mode: 'single', tf: '15m', dir: 1, triggerAt: 1_790_950_000,
    entryLo: 84_950, entryHi: 85_000, stop: 84_600, tp1: 85_500, tp2: null, tp3: null,
    status: 'filled', filledAt: Math.floor(clock / 1000), fillPrice: 84_990,
  });
  const zone = await lastOf('sig-burst-zone');
  assert.equal(zone.status, 'skipped', zone.detail);
  assert.match(zone.detail, /at once across all$/);
  assert.equal(await open(), before + 3);

  // A working entry taken off the book frees its place: the next signal is taken.
  const mine = (await runsOf('sig-burst')).filter((r) => r.status === 'placed').at(-1)!;
  assert.equal((await api('POST', '/api/trade/cancel', { tradeId: mine.trade_id })).status, 200);
  await until(open, (n) => n === before + 2, 'the cancelled entry to leave the open list');
  quote();
  await runner.onSetupFilled({
    method: 'breakout', mode: 'single', tf: '15m', dir: 1, triggerAt: 1_790_950_900,
    entryLo: 84_950, entryHi: 85_000, stop: 84_600, tp1: 85_500, tp2: null, tp3: null,
    status: 'filled', filledAt: Math.floor(clock / 1000), fillPrice: 84_990,
  });
  const freed = await lastOf('sig-burst-zone');
  assert.equal(freed.status, 'placed', freed.detail);
  assert.equal(await open(), before + 3, 'back at the cap, not past it');

  // The strategy's own limit holds inside the desk's: at most 2 of its own, with the desk's cap far away.
  await setCap(0);
  const z = (await strategyStore().get('sig-burst-zone'))!;
  await api('POST', '/api/strategies', { id: z.id, name: z.name, config: { ...z.config, signal: { ...z.config.signal, maxOpen: 2 } } });
  quote();
  const z0 = (await runs('sig-burst-zone')).length;
  for (const at of [1_790_951_800, 1_790_952_700, 1_790_953_600]) {
    await runner.onSetupFilled({
      method: 'breakout', mode: 'single', tf: '15m', dir: 1, triggerAt: at,
      entryLo: 84_950, entryHi: 85_000, stop: 84_600, tp1: 85_500, tp2: null, tp3: null,
      status: 'filled', filledAt: Math.floor(clock / 1000), fillPrice: 84_990,
    });
  }
  // it already held one: one more is taken, then it is at its own limit of two
  assert.deepEqual((await runs('sig-burst-zone')).slice(z0), ['placed', 'skipped', 'skipped']);
  assert.match((await lastOf('sig-burst-zone')).detail, /already 2 of its trades open .*-- at most 2$/);
  const own = (await api('GET', '/api/strategies')).body.strategies.find((x: any) => x.id === 'sig-burst-zone').open;
  assert.deepEqual(own, { trades: 2, lots: 2 }, 'and its card says 2 of 2');

  for (const id of ['sig-burst', 'sig-burst-zone']) await api('POST', `/api/strategies/${id}/enabled`, { enabled: false });
});

test('[critical] a zone-entry signal makes its contract ready and nothing else: no claim, no order, no trade -- and only with live orders on', async () => {
  for (const sym of [`P-BTC-${PUT}-${EXPIRY}`, `C-BTC-${CALL}-${EXPIRY}`]) {
    paper().setQuote({ symbol: sym, bid: 18, ask: 18.5, bidSize: 5_000, askSize: 5_000, mark: 18.2, ts: Date.now() });
  }
  const zone = { ...config, signal: { mode: 'single', tf: '30m', methods: ['breakout'], target: 'tp1', maxOpen: 5 } };
  assert.equal((await api('POST', '/api/strategies', { name: 'Sig warm', config: { ...zone, liveOrders: true } })).status, 200);
  assert.equal((await api('POST', '/api/strategies', { name: 'Sig warm paper', config: { ...zone, liveOrders: false } })).status, 200);
  for (const id of ['sig-warm', 'sig-warm-paper']) await api('POST', `/api/strategies/${id}/enabled`, { enabled: true });
  await tradingService().settings.set('scheduler_enabled', '1');
  clock = TEN;

  const svc = tradingService();
  const warmed: string[] = [];
  const real = svc.warmEntry.bind(svc);
  svc.warmEntry = (symbol: string) => { warmed.push(symbol); return real(symbol); };
  try {
    const tradesBefore = (await svc.openTrades()).length;
    await runner.onSignal(signal({ tf: '30m' }));          // a BUY: this strategy would sell the put when the perp reaches the zone
    await new Promise((r) => setTimeout(r, 50));            // the warm-up is not waited for by the signal
    assert.deepEqual(warmed, [`P-BTC-${PUT}-${EXPIRY}`], 'the contract it would sell now is made ready -- once, for the strategy with live orders on');
    assert.equal((await runsOf('sig-warm')).length, 0, 'the signal is not claimed: the zone has not been reached');
    assert.equal((await runsOf('sig-warm-paper')).length, 0);
    assert.equal((await svc.openTrades()).length, tradesBefore, 'and nothing was placed');
  } finally {
    svc.warmEntry = real;
    for (const id of ['sig-warm', 'sig-warm-paper']) await api('POST', `/api/strategies/${id}/enabled`, { enabled: false });
  }
});
