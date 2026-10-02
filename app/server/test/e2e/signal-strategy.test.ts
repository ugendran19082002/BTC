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
  clock = TEN + 7 * 3_600_000 + 60_000;              // 17:01 IST, past its 17:00 end
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
  assert.deepEqual(Object.keys(m.body.methods[0]).sort(), ['group', 'id', 'n', 'name', 'sl', 'summary']);
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
  assert.match(runs[2]!.detail, /already 2 of its trades open \(at most 2\)/);

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
  const filledAt = Math.floor(Date.now() / 1000);
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
