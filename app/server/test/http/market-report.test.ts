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
const post = async (url: string, payload: object) => {
  const r = await app.inject({ method: 'POST', url, headers: cookie, payload });
  return { status: r.statusCode, body: r.json() as Record<string, any> };
};
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

test('[critical] the report is the days and nothing else: no groups, no pairs of the range, no lists to filter by', async () => {
  const r = await get(`/api/market-report?from=${CLIMB}&to=${QUIET}`);
  assert.deepEqual(Object.keys(r.body).sort(), ['catalogue', 'days', 'from', 'to', 'total']);
  assert.equal(r.body.total.signal.n, 6);
  assert.equal(r.body.total.real.n, 6);
  // the filters went with the panels they served: asked for, they change nothing
  const asked = await get(`/api/market-report?from=${CLIMB}&to=${QUIET}&tf=1h&method=pullback&strategy=${encodeURIComponent('15m time')}`);
  assert.deepEqual(asked.body.days.map((d: any) => [d.signal.n, d.real.n]), r.body.days.map((d: any) => [d.signal.n, d.real.n]));
});

test('[critical] a day opened: both records by pair, timeframe, method and strategy', async () => {
  const day = await get(`/api/market-report/breakdown?day=${CLIMB}`);
  assert.equal(day.status, 200);
  assert.equal(day.body.day, CLIMB);
  assert.deepEqual(day.body.signal.byTf.map((t: any) => [t.key, t.n, t.net]), [['15m', 3, 600], ['1h', 1, 50], ['chain', 1, 200]]);
  assert.deepEqual(day.body.real.byTf.map((t: any) => [t.key, t.n, t.open]), [['15m', 3, 0], ['1h', 2, 1]]);
  assert.deepEqual(day.body.real.byStrategy.map((s: any) => [s.name, s.n]).sort(), [['15m time', 3], ['1h time', 2]]);
  assert.deepEqual(day.body.signal.byStrategy, [], 'the signal history has no strategy');
  const pair = day.body.real.pairs.find((p: any) => p.tf === '15m');
  assert.deepEqual([pair.name, pair.n, pair.wins, pair.losses], ['#1 Breakout', 3, 2, 1]);
  assert.deepEqual(Object.keys(pair.exits).sort(), ['option-tgt', 'perp-sl', 'perp-tgt']);
  assert.deepEqual(day.body.signal.pairs.map((p: any) => [p.name, p.tf, p.net]).slice(0, 2), [['#1 Breakout', '15m', 600], ['#1 Breakout', '5m + TF chain', 200]]);
  assert.equal(day.body.signal.total.n, 5); assert.equal(day.body.real.total.n, 5);
  const quiet = await get(`/api/market-report/breakdown?day=${QUIET}`);
  assert.deepEqual([quiet.body.signal.total.n, quiet.body.real.total.n], [1, 1]);
});

test('a bad range or day is refused in words', async () => {
  for (const [url, why] of [
    ['/api/market-report?from=13-10-2026', /YYYY-MM-DD/],
    [`/api/market-report?from=${TODAY}&to=${CLIMB}`, /must not be after/],
    ['/api/market-report?from=2020-01-01&to=2026-10-01', /At most 190 days/],
    ['/api/market-report/breakdown', /Day must be YYYY-MM-DD/],
    ['/api/market-report/breakdown?day=yesterday', /YYYY-MM-DD/],
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
  assert.deepEqual(all.body.params, { rule: 'delta', value: 0.1, lots: 10, targetPct: 0.9, stopPct: 3, window: 'all', deskMax: 0, cePct: 100, pePct: 100, slMin: 0, slMax: 0, tgtMin: 0, tgtMax: 0, vol: 'off' });
  assert.deepEqual(all.body.deskLimits, [], 'no broker account on this desk: no limits to offer');
  assert.equal(all.body.signals, 6, 'the one never filled is not a signal in the trade');
  assert.equal(all.body.total.n, 6);
  assert.deepEqual(all.body.skipped, { 'outside-window': 0, 'no-entry-window': 0, distance: 0, volatility: 0, 'at-limit': 0, 'desk-limit': 0, 'side-limit': 0, 'no-board': 0, 'no-strike': 0, 'no-exit-price': 0 });
  // at most two open at once: the first two are open when the others fill
  const capped = await get(`/api/signal-backtest?from=${CLIMB}&to=${CLIMB}&window=all&max=2&ce=80&pe=80`);
  assert.deepEqual([capped.body.params.deskMax, capped.body.total.n], [2, capped.body.total.n]);
  assert.ok(capped.body.skipped['desk-limit'] + capped.body.skipped['side-limit'] > 0, JSON.stringify(capped.body.skipped));
  assert.ok(capped.body.total.n < all.body.total.n);
  assert.equal(capped.body.choices.methods.find((m: any) => m.key === 'breakout').n, all.body.choices.methods.find((m: any) => m.key === 'breakout').n, 'the method list says what each makes without a limit');
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
  // custom hours: 6 PM to 8 PM IST -- the fills at minutes 30 and 90 of the day (6:00 and 7:00 PM)
  const evening = await get(`/api/signal-backtest?from=${CLIMB}&to=${CLIMB}&window=custom&hfrom=18:00&hto=20:00`);
  assert.deepEqual([evening.body.params.hoursFrom, evening.body.params.hoursTo, evening.body.total.n], ['18:00', '20:00', 2]);
  // a target by the clock is taken and said back, as shares
  const timed = await get(`/api/signal-backtest?from=${CLIMB}&to=${CLIMB}&window=all&tp=0.7&tsteps=23:30:73,01:30:76`);
  assert.deepEqual(timed.body.params.targetSteps, [{ at: '23:30', pct: 0.73 }, { at: '01:30', pct: 0.76 }]);
  assert.equal(timed.body.params.targetPct, 0.7);
  // the volatility filter: this desk has no days before the climb to compare with, so no signal has a level -- none is "low"
  const lowVol = await get(`/api/signal-backtest?from=${CLIMB}&to=${CLIMB}&window=all&vol=low`);
  assert.deepEqual([lowVol.body.params.vol, lowVol.body.total.n, lowVol.body.skipped.volatility], ['low', 0, 6]);
  assert.deepEqual(all.body.byVol, [], 'and with the filter off, no trade has a level to be listed under');
  // the quiet day has the climb before it: its one signal has a level, though no board to be traded on
  const desk = await get(`/api/signal-backtest?from=${CLIMB}&to=${CLIMB}`);
  assert.equal(desk.body.params.window, 'desk');
  assert.deepEqual([desk.body.total.n, desk.body.skipped['outside-window']], [3, 3]);
  // a timeframe, a method, the lots, another strike rule
  const tf = await get(`/api/signal-backtest?from=${CLIMB}&to=${CLIMB}&window=all&tf=1h`);
  assert.equal(tf.body.total.n, 2);
  // the counts are of what is shown: the two 1h signals, both traded -- and of the desk's hours, the 1h ones left out
  assert.deepEqual([tf.body.signals, Object.values(tf.body.skipped).reduce((a: any, b: any) => a + b, 0)], [2, 0]);
  const deskTf = await get(`/api/signal-backtest?from=${CLIMB}&to=${CLIMB}&tf=15m`);
  assert.equal(deskTf.body.signals, deskTf.body.total.n + deskTf.body.skipped['outside-window'], 'signals = traded + not traded, under a filter too');
  assert.equal(deskTf.body.signals, 3, 'the three 15m signals, not the day\'s six');
  const oneMethod = await get(`/api/signal-backtest?from=${CLIMB}&to=${CLIMB}&window=all&method=breakout`);
  assert.deepEqual([oneMethod.body.signals, oneMethod.body.total.n], [4, 4]);
  assert.equal(tf.body.choices.timeframes.length, 3, 'the list to choose from is not narrowed by the choice');
  assert.deepEqual(all.body.choices.methods.map((m: any) => [m.name, m.n, m.wins]), [['#1 Breakout', 4, 3], [all.body.choices.methods[1].name, 2, 0]], 'each method with its trades and how many won');
  assert.deepEqual(tf.body.choices.methods.map((m: any) => m.n), [0, 2], 'on the timeframes chosen');
  const lots = await get(`/api/signal-backtest?from=${CLIMB}&to=${CLIMB}&window=all&lots=1`);
  assert.ok(Math.abs(lots.body.total.net * 10 - all.body.total.net) < 1e-9);
  assert.ok(all.body.total.charges > 0, 'charges are counted and sent');
  // the margin: all six were open together at the target's minute -- the peak is all of theirs
  const m = all.body.margin;
  assert.ok(m.peakUsd > 0 && m.peakDay === CLIMB && m.peakAt > 0, JSON.stringify(m));
  assert.ok(m.peakOpen >= 1 && m.peakOpen <= 6);
  assert.ok(Math.abs(m.avgDailyPeakUsd - m.peakUsd) < 1e-9, 'one day: its peak is the average day\'s');
  assert.ok(m.avgTradeUsd > 0 && m.avgTradeUsd * m.peakOpen <= m.peakUsd * 1.5);
  const one = await get(`/api/signal-backtest?from=${CLIMB}&to=${CLIMB}&window=all&tf=1h`);
  assert.ok(one.body.margin.peakUsd < m.peakUsd, 'the margin of the trades shown: the filters narrow it');
  assert.ok(Math.abs(all.body.byTf.reduce((n: number, t: any) => n + t.charges, 0) - all.body.total.charges) < 1e-9, 'and add up across the time frames');
  const cheap = await get(`/api/signal-backtest?from=${CLIMB}&to=${CLIMB}&window=all&rule=premium&value=20`);
  assert.ok(cheap.body.skipped['no-strike'] > 0, 'no put is offered at 20 or under until late in the day');
  // a day with no board: its signals are counted, none traded
  const quiet = await get(`/api/signal-backtest?from=${QUIET}&to=${QUIET}&window=all`);
  assert.deepEqual([quiet.body.signals, quiet.body.total.n, quiet.body.skipped['no-board']], [1, 0, 1]);
});

test('the backtest refuses settings it cannot mean', async () => {
  for (const [q, why] of [
    ['rule=gamma', /"delta" or "premium"/], ['rule=delta&value=0.9', /0\.02 to 0\.5/], ['rule=premium&value=5', /10 to 500/],
    ['lots=0', /whole number from 1 to 1,000/], ['max=600', /0 \(no limit\) to 500/], ['max=10&ce=0', /1% to 100%/], ['lots=2.5', /whole number/], ['tp=1.5', /0 \(none\) to 0\.99/], ['sl=50', /0 \(none\) to 10/], ['window=night', /"desk", "all" or "custom"/], ['window=custom&hfrom=22:00', /From and a To time/], ['window=custom&hfrom=22:00&hto=22:00', /must differ/], ['window=custom&hfrom=25:00&hto=02:00', /HH:MM/], ['slmin=-1', /0 \(off\) to 20,000/], ['vol=wild', /"off", "low", "medium" or "high"/], ['tsteps=2330:73', /HH:MM:NN/], ['tsteps=23:30:0', /1% to 99%/], ['tsteps=23:30:150', /HH:MM:NN/], ['tsteps=23:30:73,23:30:80', /same time/], ['tp=0&tsteps=23:30:73', /needs a target to start from/], ['slmin=500&slmax=200', /SL maximum must not be under/], ['tgtmin=500&tgtmax=200', /TGT maximum/],
  ] as const) {
    const r = await get(`/api/signal-backtest?from=${CLIMB}&to=${CLIMB}&${q}`);
    assert.equal(r.status, 400, q);
    assert.match(r.body.error, why);
  }
});

test('[critical] the backtest by a saved strategy: its methods and timeframe, its strike rule, its lots, its "at most N open"', async () => {
  const config = {
    trigger: 'signal', signal: { mode: 'single', tf: '15m', tfs: ['15m'], methods: ['breakout'], target: 'tp1', maxOpen: 1, enterOn: 'zone', action: 'sell' },
    liveOrders: false, entryTime: '17:35', exitTime: '17:29', lots: 3, legs: 'both',
    strikeRule: 'delta', delta: { max: 0.1 }, premium: { mode: 'atMost', usd: 50, fallbackUsd: null },
    entryPrice: 'offer', crossAfterSec: 5, maxCrossSpreadPct: 0.5, takeProfitPct: 0.9, stopLossPct: 3, minPremiumUsd: 1,
    weekdays: [0, 1, 2, 3, 4, 5, 6], graceMin: 60,
  };
  const made = await post('/api/strategies', { name: 'BT fifteen', config });
  assert.equal(made.status, 200, JSON.stringify(made.body));
  const id = made.body.strategy.id;

  const r = await get(`/api/signal-backtest?from=${CLIMB}&to=${CLIMB}&strategy=${id}`);
  assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 300));
  assert.deepEqual(r.body.strategies.find((s: any) => s.id === id), { id, name: 'BT fifteen', enabled: false, account: null, methods: ['breakout'], tfs: ['15m'], target: { pct: 0.9, steps: [] } }, 'the list to choose from, with its methods and timeframes');
  assert.equal(r.body.strategy.name, 'BT fifteen');
  assert.deepEqual(r.body.strategy.caveats, []);
  // only its own signals: 15m breakout, three on the climb -- the 1h pullbacks and the chain's are not its
  assert.equal(r.body.signals, 3);
  // at most one open: the first is sold, and it is still open (the perp reaches the target hours later) when the other two fill
  assert.equal(r.body.total.n, 1);
  assert.equal(r.body.skipped['at-limit'], 2);
  assert.equal(r.body.byTf[0].key, '15m');
  assert.deepEqual([r.body.params.rule, r.body.params.value, r.body.params.lots], ['delta', 0.1, 3]);
  // what its real orders made in the range: none were placed under this name
  assert.equal(r.body.strategy.real.n, 0);

  // a strategy that does not exist, or no longer does, is said so
  const gone = await get(`/api/signal-backtest?from=${CLIMB}&to=${CLIMB}&strategy=nope`);
  assert.equal(gone.status, 404);
  assert.match(gone.body.error, /No such signal strategy/);
});

test('[critical] the backtest says what each day\'s options were priced on, and works a day again when Delta\'s minutes for it arrive', async () => {
  const { storeMarks } = await import('../../src/market/option-marks.js');
  const before = await get(`/api/signal-backtest?from=${CLIMB}&to=${QUIET}&window=all`);
  assert.deepEqual(before.body.priced, { 'own-1m': 0, 'mark-1m': 0, '5m': 2 }, 'nothing but the five-minute record yet');
  assert.deepEqual(before.body.days.map((d: any) => d.grain), ['5m', '5m']);

  // Delta's minutes for one of the climb's two contracts only: half a board is not used
  const code = `${CLIMB.slice(8, 10)}${CLIMB.slice(5, 7)}${CLIMB.slice(2, 4)}`;
  const { from } = sessionOf(CLIMB);
  const minutes = Array.from({ length: 1_440 }, (_, m) => { const mark = 41 - 36 * m / 1_435; return { time: from / 1_000 + m * 60, open: mark, high: mark, low: mark, close: mark, volume: 0 }; });
  await storeMarks(`P-BTC-83200-${code}`, code, minutes, Date.now());
  const half = await get(`/api/signal-backtest?from=${CLIMB}&to=${QUIET}&window=all`);
  assert.deepEqual([half.body.priced['mark-1m'], half.body.total.net], [0, before.body.total.net]);

  // both: the day is priced a minute at a time, and said so
  await storeMarks(`C-BTC-86400-${code}`, code, minutes, Date.now());
  const after = await get(`/api/signal-backtest?from=${CLIMB}&to=${QUIET}&window=all`);
  assert.deepEqual(after.body.priced, { 'own-1m': 0, 'mark-1m': 1, '5m': 1 });
  assert.deepEqual(after.body.days.map((d: any) => [d.day, d.grain]), [[CLIMB, 'mark-1m'], [QUIET, '5m']]);
  assert.equal(after.body.total.n, 6, 'the same six trades');
  // each was bought back when the perp reached its target, about minute 480: on the five-minute record at the next
  // reading, a minute at a time at that minute -- sooner, when the decaying put still cost a little more
  assert.ok(after.body.total.net < before.body.total.net && before.body.total.net - after.body.total.net < 0.05, `${after.body.total.net} against ${before.body.total.net}`);

  // the desk's own minute record over the whole day comes first
  await query(
    `INSERT INTO option_snapshots_1m (at, symbol, expiry, cp, strike, spot, mark, bid, ask, delta)
     SELECT $1::bigint + g * 60000, s.symbol, $2, s.cp, s.strike, 84000, 41 - 36 * g / 1435.0, 40 - 36 * g / 1435.0, 42 - 36 * g / 1435.0, s.delta
       FROM generate_series(0, 1439) g, (VALUES ($3, 'P', 83200, -0.09), ($4, 'C', 86400, 0.09)) AS s(symbol, cp, strike, delta)`,
    [from, code, `P-BTC-83200-${code}`, `C-BTC-86400-${code}`]);
  clearSignalBacktestCache();
  const own = await get(`/api/signal-backtest?from=${CLIMB}&to=${QUIET}&window=all`);
  assert.deepEqual(own.body.priced, { 'own-1m': 1, 'mark-1m': 0, '5m': 1 });
  assert.ok(Math.abs(own.body.total.net - after.body.total.net) < 1e-6, 'the same prices a minute at a time, whoever recorded them');
});
