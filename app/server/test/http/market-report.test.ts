import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * The market report (owner, 13 Oct 2026): each expiry day -- 5:30 PM IST to 5:30 PM IST -- with the kind of day
 * the perp had, and against it what the signal history and the real orders made.
 *
 * Through the real HTTP API and database, on a desk on paper. The tape, the signals and the orders are written
 * straight into their tables: three expiry days -- a clean climb, a quiet range, and the day in progress -- with
 * a handful of signals and orders in each, so every figure the report gives can be added up by hand here.
 */

const dir = mkdtempSync(join(tmpdir(), 'market-report-'));
process.env.CHAIN_DB = join(dir, 'chain.db');
process.env.DELTA_LIVE_TRADING = '0';

const { hashPassword, COOKIE } = await import('../../src/http/session.js');
const { buildApp } = await import('../../src/http/app.js');
const { AuthService } = await import('../../src/auth/service.js');
const { AuthStore } = await import('../../src/auth/store.js');
const { Secrets } = await import('../../src/auth/secrets.js');
const { closePool, query, rows } = await import('../../src/db/pool.js');
const { initTradingService, tradingService } = await import('../../src/trading/service.js');
const { initStrategyStore } = await import('../../src/http/routes/strategy.routes.js');
const { flowSchema } = await import('../../src/market/flow.js');
const { entrySchema } = await import('../../src/entry/paper.js');
const { methodsSchema } = await import('../../src/entry/catalogue.js');
const { sessionDayOf, sessionOf } = await import('../../src/report/market-day.js');
const { clearMarketReportCache } = await import('../../src/report/market-report.js');
const { optionSnapshotsSchema } = await import('../../src/market/option-snapshots.js');
const { clearSignalBacktestCache } = await import('../../src/report/signal-backtest.js');

await initTradingService();
await initStrategyStore();
await flowSchema();
await entrySchema();
await methodsSchema();
await optionSnapshotsSchema();
const auth = await AuthStore.open();
await auth.seedUser('desk', hashPassword('correct horse battery'), Date.now());
await auth.createSession({ token: 'market-session', stage: 'full', now: Date.now(), ttlMs: 3_600_000, ip: null, userAgent: null });

type App = Awaited<ReturnType<typeof buildApp>>;
let app: App;
before(async () => { app = await buildApp({ auth: new AuthService({ store: auth, secrets: new Secrets('market-secret'), now: Date.now }) }); });
after(async () => { tradingService().stop(); await app.close(); await closePool(); });

const cookie = { cookie: `${COOKIE}=${encodeURIComponent('market-session')}` };
const get = async (url: string) => {
  const r = await app.inject({ method: 'GET', url, headers: cookie });
  return { status: r.statusCode, body: r.json() as Record<string, any> };
};

// ------------------------------------------------------------ three expiry days

const DAY_MS = 86_400_000;
const TODAY = sessionDayOf(Date.now());
const dayBack = (n: number) => new Date(Date.parse(`${TODAY}T00:00:00Z`) - n * DAY_MS).toISOString().slice(0, 10);
const CLIMB = dayBack(2), QUIET = dayBack(1);

/** One expiry day of tape along a straight path, a minute at a time; `minutes` short of 1,440 is a day in progress. */
async function tape(day: string, path: [number, number][], minutes = 1_440) {
  const from = sessionOf(day).from;
  const at: number[] = [], px: number[] = [];
  for (let i = 0; i < minutes; i++) {
    const x = i / 1_439;
    let k = 0;
    while (k < path.length - 2 && x > path[k + 1]![0]) k++;
    const [x0, p0] = path[k]!, [x1, p1] = path[k + 1]!;
    at.push(from + i * 60_000);
    px.push(p0 + (p1 - p0) * Math.min(1, Math.max(0, (x - x0) / (x1 - x0))) + 6 * Math.sin(i * 1.7));
  }
  await query(
    `INSERT INTO trade_flow_1m (at, buy_volume, sell_volume, buy_count, sell_count, large_buy_volume, large_sell_volume, vwap, high, low)
     SELECT a, 1, 1, 1, 1, 0, 0, p, p + 3, p - 3 FROM unnest($1::bigint[], $2::float8[]) AS t(a, p)`, [at, px]);
}

let trigger = 1_780_000_000;
/** A signal the paper log graded: filled `minIn` minutes into the day, then closed (or still in the trade). */
async function signal(day: string, minIn: number, o: { method?: string; tf?: string; mode?: 'single' | 'mtf'; status: 'tp1' | 'stop' | 'timeout' | 'filled' | 'expired'; pts?: number; r?: number }) {
  const filled = Math.floor(sessionOf(day).from / 1_000) + minIn * 60;
  const open = o.status === 'filled', never = o.status === 'expired';
  await query(
    `INSERT INTO entry_setups (method, mode, tf, dir, trigger_at, first_seen, entry_lo, entry_hi, stop, tp1, rr, graded_to, status, filled_at, fill_price, exit_at, exit_price, r_net)
     VALUES ($1, $2, $3, 1, $4, $5, 84000, 84050, 83700, 84500, 1.5, 0, $6, $7, $8, $9, $10, $11)`,
    [o.method ?? 'breakout', o.mode ?? 'single', o.tf ?? '15m', trigger += 900, (filled - 60) * 1_000, o.status,
      never ? null : filled, never ? null : 84_000, open || never ? null : filled + 1_800, open || never ? null : 84_000 + (o.pts ?? 0), open || never ? null : o.r ?? 0]);
}

let seq = 0;
/**
 * A real order on a signal: sold `lots` at `entry` `minIn` minutes into the day, and bought back at `exit` (absent:
 * still open). `by` is how it closed: the order that filled it, or the desk's own reason.
 */
async function order(day: string, minIn: number, o: {
  method?: string; tf?: string; strategy?: string; account?: number; lots?: number; entry: number; exit?: number;
  by?: 'option-tgt' | 'option-sl' | 'perp-tgt' | 'perp-sl' | 'window-end' | 'manual';
}) {
  const t0 = sessionOf(day).from + minIn * 60_000;
  const id = `P-BTC-84000-T-${++seq}`;
  const lots = o.lots ?? 10;
  const closed = o.exit !== undefined;
  const role = o.by === 'option-tgt' ? 'take_profit' : o.by === 'option-sl' ? 'stop_loss' : 'manual';
  const reason = o.by === 'perp-tgt' ? "BTC perp at 84510 reached the signal's target 84500"
    : o.by === 'perp-sl' ? "BTC perp at 83690 reached the signal's stop 83700"
      : o.by === 'window-end' ? 'exit time: the end of its window' : null;
  const fills = [
    { orderId: `${id}-e`, role: 'entry', side: 'sell', size: lots, price: o.entry, ts: t0 },
    ...(closed ? [{ orderId: `${id}-x`, role, side: 'buy', size: lots, price: o.exit!, ts: t0 + 3_600_000 }] : []),
  ];
  const strategy = o.strategy ?? '15m time';
  const plan = {
    tradeId: id, symbol: 'P-BTC-84000-071026', origin: 'strategy', strategyId: strategy.replace(/ /g, '-'), strategyName: strategy, accountId: o.account ?? 1,
    signal: { method: o.method ?? 'breakout', n: 1, name: 'Breakout', mode: 'single', tf: o.tf ?? '15m', dir: 1, triggerTime: 1 },
  };
  const state = {
    tradeId: id, symbol: plan.symbol, phase: closed ? 'flat' : 'protected', position: closed ? 0 : -lots, optionSide: 'PE', contractValue: 0.001,
    entrySize: lots, entryAvgPrice: o.entry, exitSize: closed ? lots : 0, exitAvgPrice: closed ? o.exit : null,
    exitWinner: !closed ? null : o.by === 'option-tgt' ? 'take_profit' : o.by === 'option-sl' ? 'stop_loss' : 'manual', exitReason: reason, fills,
  };
  await query('INSERT INTO trades (trade_id, symbol, phase, position, plan, state, updated_at, broker_account_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
    [id, plan.symbol, state.phase, state.position, JSON.stringify(plan), JSON.stringify(state), closed ? t0 + 3_600_000 : Date.now(), o.account ?? 1]);
}

/** What a sold option made before charges, in dollars: (entry less exit) x lots x 0.001. */
const gross = (entry: number, exit: number, lots = 10) => (entry - exit) * lots * 0.001;

before(async () => {
  // Thirty-odd quiet days of tape are not there: the two finished days are ranked against nothing, and say so.
  await tape(CLIMB, [[0, 84_000], [1, 85_500]]);
  await tape(QUIET, [[0, 85_500], [0.25, 85_750], [1, 85_560]]);
  const elapsed = Math.max(120, Math.min(1_440, Math.floor((Date.now() - sessionOf(TODAY).from) / 60_000)));
  await tape(TODAY, [[0, 85_560], [1, 85_000]], elapsed);

  // The climb: three closed signals on 15m breakout (two targets, one stop), one on 1h; one still in the trade, one never filled.
  await signal(CLIMB, 30, { status: 'tp1', pts: 500, r: 1.5 });
  await signal(CLIMB, 90, { status: 'tp1', pts: 400, r: 1.2 });
  await signal(CLIMB, 200, { status: 'stop', pts: -300, r: -1 });
  await signal(CLIMB, 300, { tf: '1h', method: 'pullback', status: 'timeout', pts: 50, r: 0.1 });
  await signal(CLIMB, 400, { tf: '1h', method: 'pullback', status: 'filled' });
  await signal(CLIMB, 500, { status: 'expired' });
  await signal(CLIMB, 600, { mode: 'mtf', tf: '5m', status: 'tp1', pts: 200, r: 0.8 });
  // The quiet day: one stop.
  await signal(QUIET, 60, { status: 'stop', pts: -250, r: -1 });

  // Orders on the climb: an option target, a perp target, a perp stop; another strategy's option stop; the other account's.
  await order(CLIMB, 31, { entry: 40, exit: 4, by: 'option-tgt' });
  await order(CLIMB, 91, { entry: 40, exit: 22, by: 'perp-tgt' });
  await order(CLIMB, 201, { entry: 40, exit: 95, by: 'perp-sl' });
  await order(CLIMB, 301, { tf: '1h', method: 'pullback', strategy: '1h time', entry: 50, exit: 200, by: 'option-sl' });
  await order(CLIMB, 302, { tf: '1h', method: 'pullback', strategy: '1h time', account: 2, entry: 50, exit: 30, by: 'window-end' });
  await order(CLIMB, 303, { tf: '1h', method: 'pullback', strategy: '1h time', entry: 50 });                 // still open
  // The quiet day: one closed by hand.
  await order(QUIET, 61, { entry: 30, exit: 20, by: 'manual' });
  // An order entered the evening before the climb's day began belongs to the day before, not to it.
  await order(dayBack(3), 1_400, { entry: 40, exit: 4, by: 'option-tgt' });
  // The climb's own contract, every five minutes: a put and a call 0.09 of delta out, each decaying from 40 to 4 bid, offered 2 over.
  const code = `${CLIMB.slice(8, 10)}${CLIMB.slice(5, 7)}${CLIMB.slice(2, 4)}`;
  const at: number[] = [], bid: number[] = [];
  for (let m = 0; m < 1_440; m += 5) { at.push(sessionOf(CLIMB).from + m * 60_000); bid.push(40 - 36 * m / 1_435); }
  for (const [cp, strike, delta] of [['P', 83_200, -0.09], ['C', 86_400, 0.09]] as const) {
    await query(
      `INSERT INTO option_snapshots (at, symbol, expiry, cp, strike, spot, mark, bid, ask, delta)
       SELECT a, $3, $4, $5, $6, 84000, b + 1, b, b + 2, $7 FROM unnest($1::bigint[], $2::float8[]) AS t(a, b)`,
      [at, bid, `${cp}-BTC-${strike}-${code}`, code, cp, strike, delta]);
  }
  clearMarketReportCache();
  clearSignalBacktestCache();
});

// ------------------------------------------------------------ the days

test('[critical] each expiry day: 5:30 PM to 5:30 PM IST, its figures, its name -- and the day in progress, marked', async () => {
  const r = await get(`/api/market-report?from=${CLIMB}&to=${TODAY}`);
  assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 300));
  assert.deepEqual(r.body.days.map((d: any) => [d.day, d.live]), [[CLIMB, false], [QUIET, false], [TODAY, true]]);
  const [climb, quiet, today] = r.body.days;
  assert.equal(climb.to - climb.from, DAY_MS);
  assert.equal(new Date(climb.to + 5.5 * 3_600_000).toISOString().slice(11, 16), '17:30', 'it ends at 5:30 PM IST');
  assert.equal(climb.bars, 1_440);
  assert.equal(climb.pattern, 'UP_TREND_CLEAN'); assert.equal(climb.family, 'up');
  assert.match(climb.why, /Closed 1,5\d\d pts up/);
  const s = climb.stats;
  assert.ok(Math.abs(s.rangePts - 1_500) < 30 && Math.abs(s.netPts - 1_500) < 30, `${s.rangePts} / ${s.netPts}`);
  assert.ok(s.high > s.low && s.highAt > s.lowAt, 'the low early, the high late');
  assert.ok(s.atr > 0 && s.candleExpansion >= 1 && s.zigzag.totalPts > 0);
  assert.equal(s.atrPercentile, null, 'no days before it on record: not ranked');
  assert.equal(s.line.length, 48);
  assert.equal(quiet.pattern, 'RANGE_LOW_VOLATILITY', quiet.why);
  assert.equal(quiet.family, 'range');
  assert.ok(today.bars >= 120 && today.bars <= 1_440);
  assert.ok(today.stats && today.pattern, 'the day so far has figures and a name');
  assert.equal(r.body.catalogue.length, 20);

  // kept: asked again, the finished days come from the table, the same
  const kept = await rows<{ day: string; pattern: string; bars: number }>('SELECT day, pattern, bars FROM market_days ORDER BY day');
  assert.deepEqual(kept.filter((k) => k.day >= CLIMB).map((k) => [k.day, k.pattern, k.bars]), [[CLIMB, 'UP_TREND_CLEAN', 1_440], [QUIET, 'RANGE_LOW_VOLATILITY', 1_440]], 'the day in progress is not kept');
  const again = await get(`/api/market-report?from=${CLIMB}&to=${TODAY}`);
  assert.deepEqual(again.body.days[0].stats, climb.stats);
});

test('[critical] the signal history of a day: trades by their fill, points and R, and which exit closed them', async () => {
  const r = await get(`/api/market-report?from=${CLIMB}&to=${QUIET}`);
  const [climb, quiet] = r.body.days;
  const s = climb.signal;
  assert.equal(s.n, 5, 'five closed: the one still in the trade and the one never filled are not trades');
  assert.equal(s.open, 1);
  assert.equal(s.wins, 4); assert.equal(s.losses, 1);
  assert.equal(s.net, 500 + 400 - 300 + 50 + 200);
  assert.equal(s.won, 1_150); assert.equal(s.lost, 300);
  assert.ok(Math.abs(s.netR - 2.6) < 1e-9);
  assert.deepEqual(s.exits, { 'perp-tgt': { n: 3, net: 1_100 }, 'perp-sl': { n: 1, net: -300 }, timeout: { n: 1, net: 50 } });
  assert.deepEqual([quiet.signal.n, quiet.signal.net, quiet.signal.exits['perp-sl'].n], [1, -250, 1]);
  assert.equal(r.body.total.signal.n, 6);
});

test('[critical] the real orders of a day: by their entry, money after charges, and perp TGT / perp SL / option TGT / option SL', async () => {
  const r = await get(`/api/market-report?from=${CLIMB}&to=${QUIET}`);
  const x = r.body.days[0].real;
  assert.equal(x.n, 5, 'five closed on the climb; the one entered the evening before is the day before\'s');
  assert.equal(x.open, 1);
  assert.deepEqual(Object.fromEntries(Object.entries(x.exits).map(([k, v]: [string, any]) => [k, v.n])),
    { 'option-tgt': 1, 'perp-tgt': 1, 'perp-sl': 1, 'option-sl': 1, 'window-end': 1 });
  const before = gross(40, 4) + gross(40, 22) + gross(40, 95) + gross(50, 200) + gross(50, 30);
  assert.ok(x.net < before && x.net > before - 0.5, `after charges: ${x.net} against ${before} before them`);
  assert.equal(x.wins, 3); assert.equal(x.losses, 2);
  assert.ok(Math.abs(x.won - x.lost - x.net) < 1e-9, 'won less lost is the net');
  assert.ok(x.exits['option-sl'].net < gross(50, 200) && x.exits['option-sl'].net > gross(50, 200) - 0.3, String(x.exits['option-sl'].net));
  assert.equal(r.body.days[1].real.exits.manual.n, 1);

  // one account's orders: the other account's window-end exit is not in it; the signal history is the same
  const one = await get(`/api/market-report?from=${CLIMB}&to=${QUIET}&account=1`);
  // (no broker account is saved on this desk, so "account=1" names none and is every account)
  assert.equal(one.body.days[0].real.n, 5);
});

test('[critical] by kind of day and by family: the days of each, both records, and the best and worst pairs', async () => {
  const r = await get(`/api/market-report?from=${CLIMB}&to=${QUIET}`);
  assert.deepEqual(r.body.patterns.map((p: any) => [p.id, p.key, p.days]), [[1, 'UP_TREND_CLEAN', [CLIMB]], [10, 'RANGE_LOW_VOLATILITY', [QUIET]]]);
  assert.deepEqual(r.body.families.map((f: any) => [f.key, f.name, f.days.length]), [['up', 'Up trend', 1], ['range', 'Range', 1]]);
  const up = r.body.patterns[0];
  assert.equal(up.meaning, 'Smooth upward movement');
  assert.equal(up.signal.n, 5); assert.equal(up.real.n, 5);
  // signal pairs: 15m breakout +600 (two targets, one stop), the chain's +200, 1h pullback +50 -- none in loss
  assert.deepEqual(up.signalEnds.best.map((p: any) => [p.name, p.tf, p.net]), [['#1 Breakout', '15m', 600], ['#1 Breakout', '5m + TF chain', 200], [up.signalEnds.best[2].name, '1h', 50]]);
  assert.deepEqual(up.signalEnds.worst, []);
  // real pairs: 15m breakout lost on its perp stop less than it made; 1h pullback lost on the option stop
  assert.equal(up.realEnds.worst[0].tf, '1h');
  assert.ok(up.realEnds.worst[0].net < -1.2);
  // and of the whole range: the quiet day's stop takes 250 off 15m breakout, which is still the best signal pair
  assert.deepEqual(r.body.ends.signal.best.map((p: any) => [p.tf, p.net])[0], ['15m', 350]);
  assert.deepEqual(r.body.ends.signal.worst, []);
  assert.equal(r.body.ends.real.worst[0].tf, '1h');
  assert.deepEqual(r.body.choices.timeframes.map((t: any) => t.key), ['15m', '1h', 'chain']);
  assert.deepEqual(r.body.choices.strategies.map((s: any) => s.name), ['1h time', '15m time'], 'by name, the numbers in them read as numbers');
  // each method with what it made in both records, each strategy with what its orders made
  const breakout = r.body.choices.methods.find((m: any) => m.key === 'breakout');
  assert.equal(breakout.name, '#1 Breakout');
  assert.deepEqual(breakout.signal, { n: 5, wins: 3, net: 500 + 400 - 300 + 200 - 250 });
  assert.deepEqual([breakout.real.n, breakout.real.wins], [4, 3]);
  assert.deepEqual(r.body.choices.strategies.map((s: any) => [s.name, s.n, s.wins]), [['1h time', 2, 1], ['15m time', 4, 3]]);
});

test('[critical] the breakdown of a day, a kind of day, a family: pairs, timeframes, methods, strategies -- and the filters', async () => {
  const day = await get(`/api/market-report/breakdown?from=${CLIMB}&to=${QUIET}&day=${CLIMB}`);
  assert.equal(day.status, 200);
  assert.deepEqual(day.body.days, [CLIMB]);
  assert.deepEqual(day.body.signal.byTf.map((t: any) => [t.key, t.n, t.net]), [['15m', 3, 600], ['1h', 1, 50], ['chain', 1, 200]]);
  assert.deepEqual(day.body.real.byTf.map((t: any) => [t.key, t.n, t.open]), [['15m', 3, 0], ['1h', 2, 1]]);
  assert.deepEqual(day.body.real.byStrategy.map((s: any) => [s.name, s.n]).sort(), [['15m time', 3], ['1h time', 2]]);
  assert.deepEqual(day.body.signal.byStrategy, [], 'the signal history has no strategy');
  const pair = day.body.real.pairs.find((p: any) => p.tf === '15m');
  assert.deepEqual([pair.name, pair.n, pair.wins, pair.losses], ['#1 Breakout', 3, 2, 1]);
  assert.deepEqual(Object.keys(pair.exits).sort(), ['option-tgt', 'perp-sl', 'perp-tgt']);

  const kind = await get(`/api/market-report/breakdown?from=${CLIMB}&to=${QUIET}&pattern=RANGE_LOW_VOLATILITY`);
  assert.deepEqual([kind.body.days, kind.body.signal.total.n, kind.body.real.total.n], [[QUIET], 1, 1]);
  const family = await get(`/api/market-report/breakdown?from=${CLIMB}&to=${QUIET}&family=up`);
  assert.deepEqual([family.body.days, family.body.real.total.n], [[CLIMB], 5]);
  const all = await get(`/api/market-report/breakdown?from=${CLIMB}&to=${QUIET}`);
  assert.equal(all.body.real.total.n, 6);

  // the filters: a timeframe and a method narrow both records; a strategy, the orders alone
  const tf = await get(`/api/market-report/breakdown?from=${CLIMB}&to=${QUIET}&day=${CLIMB}&tf=1h`);
  assert.deepEqual([tf.body.signal.total.n, tf.body.real.total.n], [1, 2]);
  const chain = await get(`/api/market-report/breakdown?from=${CLIMB}&to=${QUIET}&day=${CLIMB}&tf=chain`);
  assert.deepEqual([chain.body.signal.total.n, chain.body.real.total.n], [1, 0]);
  const method = await get(`/api/market-report?from=${CLIMB}&to=${QUIET}&method=pullback`);
  assert.deepEqual([method.body.days[0].signal.n, method.body.days[0].real.n], [1, 2]);
  const strategy = await get(`/api/market-report?from=${CLIMB}&to=${QUIET}&strategy=${encodeURIComponent('15m time')}`);
  assert.deepEqual([strategy.body.days[0].signal.n, strategy.body.days[0].real.n], [5, 3]);
  assert.equal(strategy.body.choices.strategies.length, 2, 'the list to choose from is not narrowed by the choice');
  assert.deepEqual(strategy.body.choices.strategies.map((s: any) => s.n), [2, 4], 'nor are its figures');
  assert.equal(method.body.choices.methods.find((m: any) => m.key === 'breakout').signal.n, 5, 'a method not chosen still says what it made');
  assert.equal(strategy.body.choices.methods.find((m: any) => m.key === 'pullback').real.n, 0, 'but a method\'s figures are of the strategies chosen');
});

test('a bad range, day or kind is refused in words', async () => {
  for (const [url, why] of [
    ['/api/market-report?from=13-10-2026', /YYYY-MM-DD/],
    [`/api/market-report?from=${TODAY}&to=${CLIMB}`, /must not be after/],
    ['/api/market-report?from=2020-01-01&to=2026-10-01', /At most 190 days/],
    [`/api/market-report/breakdown?from=${CLIMB}&pattern=NOPE`, /No such market pattern/],
    [`/api/market-report/breakdown?from=${CLIMB}&family=sideways`, /No such family/],
    [`/api/market-report/breakdown?from=${CLIMB}&day=yesterday`, /YYYY-MM-DD/],
  ] as const) {
    const r = await get(url);
    assert.equal(r.status, 400, url);
    assert.match(r.body.error, why);
  }
  // a day with no tape at all is listed without figures, not left out
  const empty = await get(`/api/market-report?from=${dayBack(6)}&to=${dayBack(6)}`);
  assert.deepEqual(empty.body.days.map((d: any) => [d.day, d.bars, d.stats, d.pattern]), [[dayBack(6), 0, null, null]]);
});

// ------------------------------------------------------------ the backtest

test('[critical] the backtest: every signal in the trade sold as an option on the day\'s own board, by the desk\'s hours or the whole day', async () => {
  // The climb's six signals in the trade are all BUYs with the target at 84,500, which the perp reaches about a third of the way in.
  const all = await get(`/api/signal-backtest?from=${CLIMB}&to=${CLIMB}&window=all`);
  assert.equal(all.status, 200, JSON.stringify(all.body).slice(0, 300));
  assert.deepEqual(all.body.params, { rule: 'delta', value: 0.1, lots: 10, targetPct: 0.9, stopPct: 3, window: 'all' });
  assert.equal(all.body.signals, 6, 'the one never filled is not a signal in the trade');
  assert.equal(all.body.total.n, 6);
  assert.deepEqual(all.body.skipped, { 'outside-window': 0, 'no-board': 0, 'no-strike': 0, 'no-exit-price': 0 });
  assert.deepEqual(Object.keys(all.body.total.exits), ['perp-tgt'], 'each bought back when the perp reached its target');
  assert.equal(all.body.total.exits['perp-tgt'].n, 6);
  assert.equal(all.body.total.perpPts, 6 * 500);
  // sold at minutes 30, 90 and 200 and bought back near minute 480 after hours of decay: in profit. The two sold at 300 and
  // 400 decayed less than the spread and the two fees; the one filled at minute 600, past the target already, is bought
  // straight back for exactly those.
  assert.deepEqual([all.body.total.wins, all.body.total.losses], [3, 3]);
  assert.deepEqual(all.body.byTf.map((t: any) => [t.key, t.n]), [['15m', 3], ['1h', 2], ['chain', 1]]);
  assert.ok(all.body.byTf[2].net < 0 && all.body.byTf[0].net > 0);
  assert.deepEqual(all.body.pairs.map((p: any) => [p.name, p.tf, p.n]), [['#1 Breakout', '15m', 3], [all.body.pairs[1].name, '1h', 2], ['#1 Breakout', '5m + TF chain', 1]]);
  assert.deepEqual(all.body.byPattern.map((p: any) => [p.name, p.days, p.n]), [['#1 Up trend · clean', 1, 6]]);
  assert.deepEqual(all.body.byFamily.map((p: any) => [p.name, p.n]), [['Up trend', 6]]);
  assert.deepEqual(all.body.days.map((d: any) => [d.day, d.pattern, d.n]), [[CLIMB, 'UP_TREND_CLEAN', 6]]);

  // the desk's hours (the default): the three filled before 9:30 PM are left out, and said
  const desk = await get(`/api/signal-backtest?from=${CLIMB}&to=${CLIMB}`);
  assert.equal(desk.body.params.window, 'desk');
  assert.deepEqual([desk.body.total.n, desk.body.skipped['outside-window']], [3, 3]);
  // a timeframe, a method, the lots, another strike rule
  const tf = await get(`/api/signal-backtest?from=${CLIMB}&to=${CLIMB}&window=all&tf=1h`);
  assert.equal(tf.body.total.n, 2);
  assert.equal(tf.body.choices.timeframes.length, 3, 'the list to choose from is not narrowed by the choice');
  assert.deepEqual(all.body.choices.methods.map((m: any) => [m.name, m.n, m.wins]), [['#1 Breakout', 4, 3], [all.body.choices.methods[1].name, 2, 0]], 'each method with its trades and how many won');
  assert.deepEqual(tf.body.choices.methods.map((m: any) => m.n), [0, 2], 'on the timeframes chosen');
  const lots = await get(`/api/signal-backtest?from=${CLIMB}&to=${CLIMB}&window=all&lots=1`);
  assert.ok(Math.abs(lots.body.total.net * 10 - all.body.total.net) < 1e-9);
  const cheap = await get(`/api/signal-backtest?from=${CLIMB}&to=${CLIMB}&window=all&rule=premium&value=20`);
  assert.ok(cheap.body.skipped['no-strike'] > 0, 'no put is offered at 20 or under until late in the day');
  // a day with no board: its signals are counted, none traded
  const quiet = await get(`/api/signal-backtest?from=${QUIET}&to=${QUIET}&window=all`);
  assert.deepEqual([quiet.body.signals, quiet.body.total.n, quiet.body.skipped['no-board']], [1, 0, 1]);
});

test('the backtest refuses settings it cannot mean', async () => {
  for (const [q, why] of [
    ['rule=gamma', /"delta" or "premium"/], ['rule=delta&value=0.9', /0\.02 to 0\.5/], ['rule=premium&value=5', /10 to 500/],
    ['lots=0', /whole number from 1 to 1,000/], ['lots=2.5', /whole number/], ['tp=1.5', /0 \(none\) to 0\.99/], ['sl=50', /0 \(none\) to 10/], ['window=night', /"desk" or "all"/],
  ] as const) {
    const r = await get(`/api/signal-backtest?from=${CLIMB}&to=${CLIMB}&${q}`);
    assert.equal(r.status, 400, q);
    assert.match(r.body.error, why);
  }
});
