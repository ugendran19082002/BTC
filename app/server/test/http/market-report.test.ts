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
  /*
   * And a ladder of the same contract further out -- each 200 further, priced and weighted alike (14 Oct 2026). One
   * trade per contract: a signal while another is open sells the next strike out, so the day's overlapping signals
   * each need one. Priced alike, every trade makes what it made on the one strike before.
   */
  const ladder = (cp: 'P' | 'C', strike: number, delta: number) => Array.from({ length: 12 }, (_, i) => [cp, cp === 'P' ? strike - 200 * i : strike + 200 * i, delta] as const);
  for (const [cp, strike, delta] of [...ladder('P', 83_200, -0.09), ...ladder('C', 86_400, 0.09)]) {
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
  assert.deepEqual(all.body.params, { rule: 'delta', value: 0.1, lots: 10, targetPct: 0.9, stopPct: 3, window: 'all', deskMax: 0, cePct: 100, pePct: 100, slMin: 0, slMax: 0, tgtMin: 0, tgtMax: 0, vol: 'off', minPremium: 10 });
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
  assert.equal(m.peakLots, m.peakOpen * 10, 'ten lots a trade: the lots open at the peak');
  assert.ok(Math.abs(m.avgDailyPeakUsd - m.peakUsd) < 1e-9, 'one day: its peak is the average day\'s');
  assert.ok(m.avgTradeUsd > 0 && m.avgTradeUsd * m.peakOpen <= m.peakUsd * 1.5);
  const one = await get(`/api/signal-backtest?from=${CLIMB}&to=${CLIMB}&window=all&tf=1h`);
  assert.ok(one.body.margin.peakUsd < m.peakUsd, 'the margin of the trades shown: the filters narrow it');
  assert.ok(Math.abs(all.body.byTf.reduce((n: number, t: any) => n + t.charges, 0) - all.body.total.charges) < 1e-9, 'and add up across the time frames');
  const cheap = await get(`/api/signal-backtest?from=${CLIMB}&to=${CLIMB}&window=all&rule=premium&value=20`);
  assert.ok(cheap.body.skipped['no-strike'] > 0, 'no put is offered at 20 or under until late in the day');
  // the least premium an option is sold for: 10 unless said; the put is bid at about 15 by minute 1,000 and 5 at the end
  const floor30 = await get(`/api/signal-backtest?from=${CLIMB}&to=${CLIMB}&window=all&minprem=30`);
  assert.deepEqual([floor30.body.params.minPremium, floor30.body.total.n, floor30.body.skipped['no-strike']], [30, 4, 2], 'sold at 39, 38, 35 and 32.5; not at 29.97 and 25 -- under the floor by the time of the fill');
  const noFloor = await get(`/api/signal-backtest?from=${CLIMB}&to=${CLIMB}&window=all&minprem=0`);
  assert.deepEqual([noFloor.body.params.minPremium, noFloor.body.total.n], [0, 6]);
  assert.equal((await get(`/api/signal-backtest?from=${CLIMB}&to=${CLIMB}&minprem=-1`)).status, 400);
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

test('[critical] no-entry windows in the backtest\'s settings: read, held to the hours, and taking the signals inside out (15 Oct 2026)', async () => {
  const q = `from=${CLIMB}&to=${QUIET}&window=all`;
  const whole = await get(`/api/signal-backtest?${q}`);
  assert.equal(whole.status, 200);
  // the whole expiry day's hours, one window over all of it but the last five minutes: nothing traded in it
  const most = await get(`/api/signal-backtest?${q}&noentry=17:30-17:20`);
  assert.equal(most.status, 200, JSON.stringify(most.body).slice(0, 200));
  assert.equal(most.body.total.n, 0, 'every signal is inside it');
  assert.ok(whole.body.total.n > 0 && most.body.skipped['no-entry-window'] >= whole.body.total.n, 'each of them skipped as inside the window');
  // the strategy form's own rules, on these hours
  for (const [bad, said] of [['00:30-00:30', /empty/], ['21:00-22:00,21:30-23:00', /overlap/], ['17:30-17:25', /covers all/], ['nonsense', /from and an until time/]] as const) {
    const r = await get(`/api/signal-backtest?${q}&noentry=${bad}`);
    assert.equal(r.status, 400, bad);
    assert.match(r.body.error, said);
  }
  // the desk's hours: a window outside 9:30 PM - 3:59 PM is refused, in the hours' words
  const outside = await get(`/api/signal-backtest?from=${CLIMB}&to=${QUIET}&window=desk&noentry=18:00-19:00`);
  assert.equal(outside.status, 400);
  assert.match(outside.body.error, /inside the hours' 9:30 PM – 3:59 PM/);
  // saved with a backtest, and back as it was
  const del = async (url: string) => { const r = await app.inject({ method: 'DELETE', url, headers: cookie }); return { status: r.statusCode }; };
  const params = { rule: 'delta', value: 0.1, lots: 10, targetPct: 0.9, stopPct: 3, window: 'all', deskMax: 0, cePct: 100, pePct: 100, noEntry: { on: true, windows: [{ from: '00:30', to: '01:30' }] } };
  const saved = await post('/api/backtest-saves', { name: 'With a quiet hour', query: { params, tfs: [], methods: [], strategy: null } });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.deepEqual(saved.body.save.query.params.noEntry, { on: true, windows: [{ from: '00:30', to: '01:30' }] });
  await del(`/api/backtest-saves/${saved.body.save.id}`);
});

test('[critical] one expiry day of the backtest, trade by trade: the same trades as its day row, each with its entry, exit, levels and money (14 Oct 2026)', async () => {
  const q = `from=${CLIMB}&to=${QUIET}&window=all`;
  const whole = await get(`/api/signal-backtest?${q}`);
  assert.equal(whole.status, 200);
  const row = whole.body.days.find((x: any) => x.day === CLIMB);
  assert.ok(row && row.n > 0, 'the day traded');
  const d = await get(`/api/signal-backtest/trades?${q}&day=${CLIMB}`);
  assert.equal(d.status, 200, JSON.stringify(d.body).slice(0, 200));
  assert.deepEqual([d.body.day, d.body.total, d.body.trades.length], [CLIMB, row.n, row.n]);
  const sum = (k: string) => d.body.trades.reduce((n: number, t: any) => n + t[k], 0);
  assert.ok(Math.abs(sum('netUsd') - row.net) < 1e-9, `the same money: ${sum('netUsd')} against ${row.net}`);
  assert.ok(Math.abs(sum('chargesUsd') - row.charges) < 1e-9, 'and the same charges');
  assert.equal(d.body.trades.filter((t: any) => t.netUsd > 0).length, row.wins);
  const t = d.body.trades[0];
  for (const k of ['at', 'method', 'name', 'tf', 'dir', 'perpEntry', 'perpSl', 'perpTgt', 'cp', 'strike', 'lots', 'entryAt', 'entry', 'exitAt', 'exit', 'by', 'perpPts', 'netUsd', 'chargesUsd']) {
    assert.ok(t[k] !== undefined && t[k] !== null, `a trade says its ${k}`);
  }
  assert.ok('optTgt' in t && 'optStop' in t, 'and its option levels, or none');
  assert.ok(d.body.trades.every((x: any, i: number, xs: any[]) => i === 0 || xs[i - 1].at <= x.at), 'by time');
  // narrowed as the backtest is: only the time frame and method asked for
  const narrow = await get(`/api/signal-backtest/trades?${q}&tf=15m&method=breakout&day=${CLIMB}`);
  assert.ok(narrow.body.trades.every((x: any) => x.tf === '15m' && x.method === 'breakout'));
  assert.equal((await get(`/api/signal-backtest/trades?${q}&day=2020-01-01`)).status, 400, 'a day outside the range');
  assert.equal((await get(`/api/signal-backtest/trades?${q}&day=today`)).status, 400);

  // by session of the day (15 Oct 2026): each method in each fifteen-minute slot, adding up to the whole
  const rowsS = whole.body.bySession as { slot: number; method: string; name: string; n: number; wins: number; net: number; charges: number }[];
  assert.ok(rowsS.length > 0 && rowsS.every((x) => Number.isInteger(x.slot) && x.slot >= 0 && x.slot <= 95 && x.name));
  assert.equal(rowsS.reduce((n, x) => n + x.n, 0), whole.body.total.n, 'every trade in one slot');
  assert.ok(Math.abs(rowsS.reduce((n, x) => n + x.net, 0) - whole.body.total.net) < 1e-9);
  // a session's trades, over every day: as many as its rows, and that money -- and one method of it alone
  const first = rowsS[0]!, lo = first.slot - (first.slot % 4), hi = lo + 3;
  const inSession = rowsS.filter((x) => x.slot >= lo && x.slot <= hi);
  const s = await get(`/api/signal-backtest/trades?${q}&sfrom=${lo}&sto=${hi}`);
  assert.equal(s.status, 200, JSON.stringify(s.body).slice(0, 200));
  assert.equal(s.body.total, inSession.reduce((n, x) => n + x.n, 0), 'the hour\'s trades, every day');
  assert.ok(Math.abs(s.body.trades.reduce((n: number, t: any) => n + t.netUsd, 0) - inSession.reduce((n, x) => n + x.net, 0)) < 1e-9);
  const one = await get(`/api/signal-backtest/trades?${q}&sfrom=${lo}&sto=${hi}&smethod=${first.method}`);
  assert.equal(one.body.total, inSession.filter((x) => x.method === first.method).reduce((n, x) => n + x.n, 0));
  assert.ok(one.body.trades.every((t: any) => t.method === first.method));
  assert.equal((await get(`/api/signal-backtest/trades?${q}&sfrom=96`)).status, 400, 'no slot past the day');
});

test('[critical] the live check: by a strategy, its backtest beside the desk\'s own decisions; by settings, beside the live rules run with them', async () => {
  const config = {
    trigger: 'signal', signal: { mode: 'single', tf: '15m', tfs: ['15m'], methods: ['breakout'], target: 'tp1', maxOpen: 5, enterOn: 'zone', action: 'sell' },
    liveOrders: false, entryTime: '17:35', exitTime: '17:29', lots: 1, legs: 'both',
    strikeRule: 'delta', delta: { max: 0.1 }, premium: { mode: 'atMost', usd: 50, fallbackUsd: null },
    entryPrice: 'offer', crossAfterSec: 5, maxCrossSpreadPct: 0.5, takeProfitPct: 0.9, stopLossPct: 3, minPremiumUsd: 1,
    weekdays: [0, 1, 2, 3, 4, 5, 6], graceMin: 60,
  };
  const made = await post('/api/strategies', { name: 'BT live', config });
  assert.equal(made.status, 200, JSON.stringify(made.body));
  const id = made.body.strategy.id;
  const check = (extra: string) => get(`/api/signal-backtest/live-check?from=${CLIMB}&to=${CLIMB}${extra}`);

  // nothing on the desk's record yet: the backtest's three trades are not compared -- set apart, counted, and why
  const none = await check(`&strategy=${id}`);
  assert.equal(none.status, 200, JSON.stringify(none.body).slice(0, 300));
  assert.deepEqual([none.body.total.backtest, none.body.total.same, none.body.notCompared], [0, 0, { backtest: 3, desk: 0 }]);
  assert.deepEqual(none.body.notComparedWhy.backtest.map((g: any) => [g.why, g.n]), [['the desk has no record of the signal: the strategy was off, not yet made, or its rules were different then', 3]]);
  assert.deepEqual([none.body.liveFrom, none.body.liveTo, none.body.money.real], [null, null, null], 'never the desk\'s finished orders');

  // the desk's record, keyed as a setup is: the first placed, the second refused by the day's loss limit, the third skipped
  const { from } = sessionOf(CLIMB);
  const setups = await rows<{ method: string; mode: string; tf: string; dir: number; trigger_at: string; filled_at: string }>(
    'SELECT method, mode, tf, dir, trigger_at, filled_at FROM entry_setups WHERE filled_at >= $1 AND filled_at < $2 ORDER BY filled_at', [from / 1_000, from / 1_000 + 86_400]);
  const keyOf = (x: (typeof setups)[number]) => `${x.method}|${x.mode}|${x.tf}|${x.dir}|${x.trigger_at}`;
  const mine = setups.filter((x) => x.method === 'breakout' && x.mode === 'single' && x.tf === '15m');
  const other = setups.find((x) => x.method !== 'breakout')!;
  assert.equal(mine.length, 3);
  const wrote = (x: (typeof setups)[number], status: string, detail: string) => query(
    'INSERT INTO strategy_signal_runs (strategy_id, signal_key, method, mode, tf, dir, status, detail, at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)',
    [id, keyOf(x), x.method, x.mode, x.tf, x.dir, status, detail, Number(x.filled_at) * 1_000 + 4_000]);
  await wrote(mine[0]!, 'placed', '#1 Breakout BUY | sell PE 81800 x1 @ 54 (delta 0.09) · perp filled 84000 · perp SL 83700 · TGT 84500');
  await wrote(mine[1]!, 'refused', '#1 Breakout BUY | sell PE 81800 x1 @ 54 (delta 0.09) · perp filled 84000 · perp SL 83700 · TGT 84500 -- refused: Worst case $0 exceeds the $-82 left in today\'s loss budget.');
  await wrote(mine[2]!, 'skipped', '#1 Breakout BUY | SL too near: the perp entry 84000 to the SL 83700 is 300 pts — this strategy takes 15m signals only at 400 pts or more');
  // and an order on a signal outside the strategy's rules as they stand: set apart, not counted against it
  await wrote(other, 'placed', '#2 Pullback BUY | sell PE 81800 x1 @ 54 (delta 0.09) · perp filled 84000 · perp SL 83700 · TGT 84500');

  const r = await check(`&strategy=${id}`);
  const row = r.body.strategies[0];
  assert.deepEqual(r.body.strategies.map((x: any) => x.name), ['BT live'], 'the strategy asked for alone');
  assert.deepEqual([row.live, row.backtest, row.same], [{ placed: 1, refused: 1, skipped: 1 }, 3, 1]);
  assert.deepEqual(row.backtestOnly.map((g: any) => [g.why, g.n]), [['the desk refused: the daily loss limit', 1], ['the desk skipped: its SL / TGT distance', 1]], 'each in the desk\'s own reason');
  assert.deepEqual(row.backtestOnly[0].first, [{ at: Number(mine[1]!.filled_at) * 1_000, method: 'breakout', tf: '15m', dir: 1 }]);
  assert.deepEqual(row.liveOnly, []);
  assert.deepEqual(r.body.notCompared, { backtest: 0, desk: 1 });
  assert.deepEqual(r.body.notComparedWhy.desk.map((g: any) => [g.why, g.n]), [['outside the strategy\'s rules as they stand now', 1]]);
  assert.deepEqual(row.liveWhy, { refused: [{ why: 'the daily loss limit', n: 1 }], skipped: [{ why: 'its SL / TGT distance', n: 1 }] });
  assert.deepEqual(row.backtestSkipped, [], 'the backtest traded all three');
  assert.deepEqual(r.body.days.map((d: any) => [d.day, d.placed, d.backtest, d.same, d.real]), [[CLIMB, 1, 3, 1, null]]);
  assert.equal(r.body.days[0].bt.n, 3);
  assert.ok(r.body.liveFrom >= Number(setups[0]!.filled_at) * 1_000 && r.body.liveTo >= r.body.liveFrom);

  // what became of each signal, on each side: the desk's taken and its kinds of not taken; the backtest's taken and not
  assert.deepEqual(row.fate.live, { taken: 2, waiting: 0, notTaken: 2, skipped: 1, refused: 1, rejected: 0, expired: 0, cancelled: 0 }, 'the order outside its rules counts as taken: it is the desk\'s record');
  assert.deepEqual(row.fate.backtest, { taken: 3, waiting: 0, notTaken: 0, skipped: 0, refused: 0, rejected: 0, expired: 0, cancelled: 0 });
  assert.deepEqual(r.body.days[0].fate, row.fate);
  assert.deepEqual(r.body.fate, row.fate);
  // an order the desk placed whose wait ran out unfilled: not taken in the end, and not the same as the backtest's trade
  await query(`INSERT INTO trades (trade_id, symbol, phase, position, plan, state, updated_at) VALUES ('lc-expired', 'C-BTC-84000-x', 'aborted', 0, '{}', '{"entrySize": 0}', $1)`, [Date.now()]);
  await query(`INSERT INTO trade_events (trade_id, seq, at, kind, event) VALUES ('lc-expired', 0, $1, 'entry_timeout', '{"t": "entry_timeout"}')`, [Date.now()]);
  await query('UPDATE strategy_signal_runs SET trade_id = $1 WHERE strategy_id = $2 AND signal_key = $3', ['lc-expired', id, keyOf(mine[0]!)]);
  const expired = (await check(`&strategy=${id}`)).body;
  assert.deepEqual([expired.strategies[0].same, expired.strategies[0].fate.live.taken, expired.strategies[0].fate.live.expired, expired.strategies[0].fate.live.notTaken], [0, 1, 1, 3]);
  assert.deepEqual(expired.strategies[0].backtestOnly.map((g: any) => [g.why, g.n]), [
    ['the desk placed it and the order expired unfilled', 1], ['the desk refused: the daily loss limit', 1], ['the desk skipped: its SL / TGT distance', 1]]);
  await query("DELETE FROM trade_events WHERE trade_id = 'lc-expired'");
  await query("DELETE FROM trades WHERE trade_id = 'lc-expired'");
  await query('UPDATE strategy_signal_runs SET trade_id = NULL WHERE strategy_id = $1', [id]);

  // the settings the desk's order was sold with, where not the strategy's now (14 Oct 2026 audit): said, so the money is not misread
  assert.equal(expired.strategies[0].rulesThen ?? null, null, 'an order with no lots of its own says nothing');
  await query(`INSERT INTO trades (trade_id, symbol, phase, position, plan, state, updated_at) VALUES ('lc-then', 'C-BTC-84000-x', 'flat', 0, $1, '{"entrySize": 16}', $2)`,
    [JSON.stringify({ lots: 16, exitAsk: { stopLossPct: 3, takeProfitPct: 0.9 } }), Date.now()]);
  await query('UPDATE strategy_signal_runs SET trade_id = $1 WHERE strategy_id = $2 AND signal_key = $3', ['lc-then', id, keyOf(mine[0]!)]);
  const then = (await check(`&strategy=${id}`)).body.strategies[0];
  assert.deepEqual(then.rulesThen, { lots: [16], stopPct: [3], orders: 1, now: { lots: 1, stopPct: 3 } }, 'sold with 16 lots then; 1 now');
  await query("UPDATE trades SET plan = $1 WHERE trade_id = 'lc-then'", [JSON.stringify({ lots: 1, exitAsk: { stopLossPct: 3 } })]);
  assert.equal((await check(`&strategy=${id}`)).body.strategies[0].rulesThen, null, 'the same settings: nothing to say');
  await query("DELETE FROM trades WHERE trade_id = 'lc-then'");
  await query('UPDATE strategy_signal_runs SET trade_id = NULL WHERE strategy_id = $1', [id]);

  // every strategy: the totals are their sum, and one held to one open counts what it did not trade by why
  const all = await check('&all=1');
  assert.ok(all.body.strategies.length >= 2);
  assert.equal(all.body.total.backtest, all.body.strategies.reduce((n: number, x: any) => n + x.backtest, 0));
  assert.deepEqual(all.body.against, { kind: 'strategies' });

  // by the screen's settings: the live rules run with those settings, on the same signals -- the same decisions, the same money
  const screen = await check('&window=all&tf=15m&method=breakout');
  assert.equal(screen.status, 200, JSON.stringify(screen.body).slice(0, 300));
  assert.deepEqual(screen.body.against, { kind: 'portfolio', name: 'these settings' });
  const alone = await get(`/api/signal-backtest?from=${CLIMB}&to=${CLIMB}&window=all&tf=15m&method=breakout`);
  assert.deepEqual([screen.body.total.backtest, screen.body.total.placed, screen.body.total.same, screen.body.total.backtestOnly, screen.body.total.liveOnly], [alone.body.total.n, alone.body.total.n, alone.body.total.n, 0, 0]);
  // the live rules' fate is the backtest's: taken and skipped alike, and none of the desk's own kinds of not taken
  assert.deepEqual(screen.body.fate.live, screen.body.fate.backtest);
  assert.equal(screen.body.fate.live.taken, alone.body.total.n);
  assert.ok(Math.abs(screen.body.money.backtest.net - alone.body.total.net) < 1e-9 && Math.abs(screen.body.money.real.net - alone.body.total.net) < 1e-9, 'and the same money on both sides');
  // a premium rule and a range too: still the same
  const other2 = await check('&window=desk&rule=premium&value=50&slmin=100&tgtmin=100&lots=3');
  assert.deepEqual([other2.body.total.backtestOnly, other2.body.total.liveOnly, other2.body.total.same === other2.body.total.backtest], [0, 0, true]);
  // refused: a range or settings that cannot be meant, a strategy that is not there
  assert.equal((await get('/api/signal-backtest/live-check?from=2026-13-40')).status, 400);
  assert.equal((await check('&lots=0')).status, 400);
  assert.equal((await check('&strategy=nope')).status, 404);
  await query('DELETE FROM strategy_signal_runs WHERE strategy_id = $1', [id]);
  assert.equal((await app.inject({ method: 'DELETE', url: `/api/strategies/${id}`, headers: cookie })).statusCode, 200);
});

test('[critical] a form\'s draft: every method\'s record as options under its rules -- the ticked and the unticked, each on all its signals', async () => {
  const draft = (over: Record<string, unknown> = {}, signal: Record<string, unknown> = {}) => ({
    trigger: 'signal', signal: { mode: 'single', tf: '15m', tfs: ['15m', '1h'], methods: ['breakout'], target: 'tp1', maxOpen: 1, enterOn: 'zone', action: 'sell', ...signal },
    liveOrders: false, entryTime: '17:35', exitTime: '17:29', lots: 3, legs: 'both',
    strikeRule: 'delta', delta: { max: 0.1 }, premium: { mode: 'atMost', usd: 50, fallbackUsd: null },
    entryPrice: 'offer', crossAfterSec: 5, maxCrossSpreadPct: 0.5, takeProfitPct: 0.9, stopLossPct: 3, minPremiumUsd: 1,
    weekdays: [0, 1, 2, 3, 4, 5, 6], graceMin: 60, ...over,
  });
  const r = await post('/api/signal-backtest/methods', { config: draft() });
  assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 300));
  // the climb's 15m and 1h signals: three of the breakout on 15m, two of the pullback on 1h -- the pullback is not ticked, and is there
  const of = (m: string) => r.body.methods.find((x: any) => x.method === m);
  assert.deepEqual([of('breakout').trades, of('breakout').byTf.map((x: any) => [x.tf, x.trades])], [3, [['15m', 3]]]);
  assert.deepEqual([of('pullback').trades, of('pullback').byTf.map((x: any) => [x.tf, x.trades])], [2, [['1h', 2]]]);
  assert.equal(r.body.trades, 5, '"at most 1 open" on the form does not keep one method\'s signals from another\'s record');
  // the money is the option's, after charges, at the form's own lots: the same trades as the backtest by settings at 3 lots
  const same = await get(`/api/signal-backtest?from=${CLIMB}&to=${QUIET}&window=all&lots=3&tf=15m,1h`);
  const net = (m: string) => same.body.byMethod.find((x: any) => x.key === m).net;
  assert.ok(Math.abs(of('breakout').net - net('breakout')) < 1e-9 && Math.abs(of('pullback').net - net('pullback')) < 1e-9, `${of('breakout').net} ${net('breakout')}`);
  assert.deepEqual([of('breakout').wins, of('pullback').wins], [same.body.byMethod.find((x: any) => x.key === 'breakout').wins, same.body.byMethod.find((x: any) => x.key === 'pullback').wins]);
  assert.deepEqual(r.body.methods.map((x: any) => x.net), [...r.body.methods.map((x: any) => x.net)].sort((a: number, b: number) => b - a), 'the most made first');
  assert.ok(r.body.priced && r.body.from <= CLIMB && r.body.to >= QUIET);

  // its own exits change the record: no option target at all, and each trade is held to the perp's own exit
  const noTarget = await post('/api/signal-backtest/methods', { config: draft({ takeProfitPct: 0 }) });
  assert.equal(noTarget.status, 200);
  // with the chain: the one chain signal, under its own key
  const chain = await post('/api/signal-backtest/methods', { config: draft({}, { mode: 'mtf' }) });
  assert.deepEqual(chain.body.methods.map((x: any) => [x.method, x.trades, x.byTf.map((t: any) => t.tf)]), [['breakout', 1, ['chain']]]);

  // a range of its own: the quiet day alone has no board, so no method has a trade
  const quietOnly = await post('/api/signal-backtest/methods', { config: draft(), from: QUIET, to: QUIET });
  assert.deepEqual([quietOnly.status, quietOnly.body.from, quietOnly.body.to, quietOnly.body.trades], [200, QUIET, QUIET, 0]);
  assert.equal((await post('/api/signal-backtest/methods', { config: draft(), from: 'yesterday' })).status, 400);
  // nothing is saved by asking
  assert.equal((await get('/api/strategies')).body.strategies.some((s: any) => s.name === 'draft'), false);
  // a draft that cannot be meant says why; one that buys has no record as options; no settings at all is refused
  const bad = await post('/api/signal-backtest/methods', { config: draft({ entryTime: 'soon' }) });
  assert.equal(bad.status, 422);
  assert.match(bad.body.error, /Entry time/);
  const buys = await post('/api/signal-backtest/methods', { config: draft({ takeProfitPct: 0, stopLossPct: 0 }, { action: 'buy' }) });
  assert.equal(buys.status, 422);
  assert.match(buys.body.error, /strategies that sell/);
  assert.equal((await post('/api/signal-backtest/methods', {})).status, 400);
  // a draft with no method ticked yet is still answered: the record is what the ticking is done against
  const none = await post('/api/signal-backtest/methods', { config: draft({}, { methods: [] }) });
  assert.deepEqual([none.status, none.body.trades], [200, 5]);

  // The methods' daily update, now (16 Oct 2026): the same record, the draft's own win rate -- picked, not saved.
  const auto = { on: true, at: '21:00', winPct: 50, minTrades: 1, days: 7 };
  const pick = await post('/api/strategies/auto-methods/pick', { config: draft({}, { methods: [], autoMethods: auto }) });
  assert.equal(pick.status, 200, JSON.stringify(pick.body).slice(0, 300));
  const won = r.body.methods.filter((m: any) => m.trades >= 1 && m.wins / m.trades >= 0.5).map((m: any) => m.method);
  assert.ok(won.length > 0);
  assert.deepEqual(pick.body.picked, won, 'the Win rule on the form\'s own record, best net first');
  assert.deepEqual(pick.body.before, []);
  assert.equal(pick.body.note, undefined);
  // nothing passes: the list is kept, and why
  const strict = await post('/api/strategies/auto-methods/pick', { config: draft({}, { methods: ['trap'], autoMethods: { ...auto, winPct: 100, minTrades: 50 } }) });
  assert.deepEqual([strict.status, strict.body.picked], [200, ['trap']]);
  assert.match(strict.body.note, /the list was kept/);
  // Exclude (18 Oct 2026): the excluded are not picked, and are said; on with none ticked is refused
  const [top] = won;
  const ex = await post('/api/strategies/auto-methods/pick', { config: draft({}, { methods: [], autoMethods: { ...auto, exclude: { on: true, methods: [top] } } }) });
  assert.equal(ex.status, 200, JSON.stringify(ex.body).slice(0, 300));
  assert.deepEqual([ex.body.picked, ex.body.excluded], [won.slice(1).length ? won.slice(1) : [], [top]]);
  const exNone = await post('/api/strategies/auto-methods/pick', { config: draft({}, { autoMethods: { ...auto, exclude: { on: true, methods: [] } } }) });
  assert.deepEqual([exNone.status, exNone.body.problems], [422, ['Pick at least one method to exclude, or switch Exclude off.']]);
  // Walked forward (18 Oct 2026): the day after picked from the day before alone; the same record, day by day
  const walkAuto = { ...auto, days: 1 };
  const walk = await post('/api/strategies/auto-methods/walk-forward', { config: draft({}, { methods: [], autoMethods: walkAuto }), from: QUIET, to: QUIET, holdout: 0 });
  assert.equal(walk.status, 200, JSON.stringify(walk.body).slice(0, 300));
  assert.deepEqual([walk.body.from, walk.body.to, walk.body.holdoutFrom, walk.body.days.length], [QUIET, QUIET, null, 1]);
  const quietRec = await post('/api/signal-backtest/methods', { config: draft(), from: QUIET, to: QUIET });
  assert.equal(walk.body.walk.all.trades, quietRec.body.trades, 'every method on the test day: that day\'s own record');
  const climbRec = await post('/api/signal-backtest/methods', { config: draft(), from: CLIMB, to: CLIMB });
  const climbWon = climbRec.body.methods.filter((m: any) => m.trades >= 1 && m.wins / m.trades >= 0.5).map((m: any) => m.method);
  assert.deepEqual(walk.body.days[0].picked, climbWon.length ? climbWon : [], 'picked from the day before it, by the rule');
  // refused in words: a day not finished, a holdout with nothing left to walk, a strategy that buys
  for (const [body, said] of [[{ to: '2099-01-01' }, /not finished/], [{ from: QUIET, to: QUIET, holdout: 1 }, /Only 1 finished day has the rule's whole 1-day look-back .* so at most 0 can be held out -- none/], [{ holdout: 11 }, /0 to 10/]] as const) {
    const r = await post('/api/strategies/auto-methods/walk-forward', { config: draft({}, { autoMethods: walkAuto }), ...body });
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.match(r.body.error, said);
  }
  assert.equal((await post('/api/strategies/auto-methods/walk-forward', { config: draft({ takeProfitPct: 0, stopLossPct: 0 }, { action: 'buy', autoMethods: walkAuto }) })).status, 422);
  const tooMany = await post('/api/strategies/auto-methods/walk-forward', { config: draft({}, { autoMethods: walkAuto }), from: QUIET, to: QUIET, holdout: 1 });
  assert.deepEqual([tooMany.body.testDays, tooMany.body.holdoutMax], [1, 0], 'what fits, for the screen to offer');
  // its settings are needed and checked; one that buys has no record as options
  assert.equal((await post('/api/strategies/auto-methods/pick', { config: draft() })).status, 422);
  assert.equal((await post('/api/strategies/auto-methods/pick', { config: draft({}, { autoMethods: { ...auto, days: 0 } }) })).status, 422);
  assert.equal((await post('/api/strategies/auto-methods/pick', { config: draft({ takeProfitPct: 0, stopLossPct: 0 }, { action: 'buy', autoMethods: auto }) })).status, 422);
  // saved with a strategy, with its last run, and read back as saved
  const last = { at: 1, from: QUIET, to: QUIET, picked: ['breakout'], before: ['bos'] };
  const saved = await post('/api/strategies', { name: 'auto pick', config: draft({}, { autoMethods: { ...auto, last } }) });
  assert.equal(saved.status, 200, JSON.stringify(saved.body).slice(0, 300));
  assert.deepEqual(saved.body.strategy.config.signal.autoMethods, { ...auto, last });
  assert.equal((await post('/api/strategies', { name: 'auto pick', config: draft({}, { autoMethods: { ...auto, at: 'late' } }) })).status, 422);
  // Exclude saved, and read back: each method once; off keeps its ticks; on with none is refused
  const withEx = await post('/api/strategies', { name: 'auto exclude', config: draft({}, { autoMethods: { ...auto, exclude: { on: false, methods: ['bos', 'bos', 'trap'] } } }) });
  assert.equal(withEx.status, 200, JSON.stringify(withEx.body).slice(0, 300));
  assert.deepEqual(withEx.body.strategy.config.signal.autoMethods.exclude, { on: false, methods: ['bos', 'trap'] });
  const exRefused = await post('/api/strategies', { name: 'auto exclude', config: draft({}, { autoMethods: { ...auto, exclude: { on: true, methods: [] } } }) });
  assert.equal(exRefused.status, 422);
  assert.match(JSON.stringify(exRefused.body), /Pick at least one method to exclude/);

  // Every methods change kept (16 Oct 2026): a save that changes the list is a 'manual' row; one that does not, none.
  const id = saved.body.strategy.id;
  const log = async (q = '') => (await get(`/api/strategies/method-updates?strategy=${id}${q}`)).body.updates;
  assert.deepEqual(await log(), [], 'made, not changed');
  await post('/api/strategies', { id, name: 'auto pick', config: draft({}, { methods: ['breakout'], autoMethods: { ...auto, last } }) });
  assert.deepEqual(await log(), [], 'saved again, the same list');
  await post('/api/strategies', { id, name: 'auto pick', config: draft({}, { methods: ['breakout', 'pullback'], autoMethods: { ...auto, last } }) });
  const [manual] = await log();
  assert.deepEqual([manual.source, manual.before, manual.after, manual.added, manual.dropped, manual.rule, manual.note], ['manual', ['breakout'], ['breakout', 'pullback'], ['pullback'], [], null, null]);
  assert.equal(manual.tf, '15m+1h', 'the time frames it read signals on, kept with the change');
  // "Pick now", "Use this list", saved: said so, with the rule it picked by
  const taken = { at: 2, from: QUIET, to: QUIET, picked: ['pullback'], before: ['breakout', 'pullback'] };
  await post('/api/strategies', { id, name: 'auto pick', config: draft({}, { methods: ['pullback'], autoMethods: { ...auto, last: taken } }) });
  const [picked] = await log();
  assert.deepEqual([picked.dropped, picked.rule, picked.from, picked.note], [['breakout'], { winPct: 50, minTrades: 1, days: 7 }, QUIET, 'Picked now on the form and saved.']);
  // the desk's own daily row, beside them; one way at a time; the newest first
  const { strategyStore } = await import('../../src/http/routes/strategy.routes.js');
  await strategyStore().logMethodUpdate({
    at: Date.now() + 1_000, strategyId: id, strategyName: 'auto pick', accountId: null, source: 'daily', tf: 'chain', rule: { winPct: 75, minTrades: 3, days: 7 },
    from: CLIMB, to: QUIET, before: ['pullback'], after: ['pullback', 'breakout'], records: [{ method: 'breakout', trades: 4, wins: 3, net: 0.2 }], note: null,
  });
  assert.deepEqual((await log()).map((u: any) => u.source), ['daily', 'manual', 'manual']);
  assert.deepEqual((await log('&source=daily')).map((u: any) => [u.added, u.records[0].wins]), [[['breakout'], 3]]);
  assert.equal((await log('&limit=1')).length, 1);
  // by the IST dates the changes were made on, both included
  const istToday = new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);
  const istTomorrow = new Date(Date.now() + 5.5 * 3_600_000 + 86_400_000).toISOString().slice(0, 10);
  assert.equal((await log(`&from=${istToday}&to=${istTomorrow}`)).length, 3);
  assert.equal((await log('&from=2026-01-01&to=2026-01-02')).length, 0);
  assert.equal((await get(`/api/strategies/method-updates?from=today`)).status, 400);
  assert.equal((await get(`/api/strategies/method-updates?from=2026-10-16&to=2026-10-15`)).status, 400);
  assert.equal((await app.inject({ method: 'DELETE', url: `/api/strategies/${saved.body.strategy.id}`, headers: cookie })).statusCode, 200);
  // the log outlives the strategy: it still reads by the name it had
  assert.equal((await log()).length, 3);
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
  // (the puts of the ladder: the calls not yet)
  for (let i = 0; i < 12; i++) await storeMarks(`P-BTC-${83_200 - 200 * i}-${code}`, code, minutes, Date.now());
  const half = await get(`/api/signal-backtest?from=${CLIMB}&to=${QUIET}&window=all`);
  assert.deepEqual([half.body.priced['mark-1m'], half.body.total.net], [0, before.body.total.net]);

  // both: the day is priced a minute at a time, and said so
  for (let i = 0; i < 12; i++) await storeMarks(`C-BTC-${86_400 + 200 * i}-${code}`, code, minutes, Date.now());
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

// ------------------------------------------------------------ saved backtests, and portfolios of them

test('[critical] a backtest saved by name, run again, and several run together as a portfolio: each as it is alone, and the total of them all', async () => {
  const del = async (url: string) => { const r = await app.inject({ method: 'DELETE', url, headers: cookie }); return { status: r.statusCode, body: r.json() as Record<string, any> }; };
  const WHOLE = { rule: 'delta', value: 0.1, lots: 10, targetPct: 0.9, stopPct: 3, window: 'all', deskMax: 0, cePct: 100, pePct: 100 };
  assert.deepEqual((await get('/api/backtest-saves')).body, { saves: [], portfolios: [] });

  // saved: its settings checked as the screen's are, its filters kept
  const a = await post('/api/backtest-saves', { name: '  Whole day,  10 lots ', query: { params: WHOLE, tfs: [], methods: [], strategy: null } });
  assert.equal(a.status, 200, JSON.stringify(a.body));
  assert.equal(a.body.save.name, 'Whole day, 10 lots', 'spaces tidied');
  assert.deepEqual([a.body.save.query.params.window, a.body.save.query.params.vol, a.body.save.query.tfs], ['all', 'off', []]);
  const b = await post('/api/backtest-saves', { name: '15m, 3 lots, dynamic', query: { params: { ...WHOLE, lots: 3, targetPct: 0.7, targetSteps: [{ at: '23:30', pct: 0.75 }] }, tfs: ['15m'], methods: ['breakout'], strategy: null } });
  assert.deepEqual([b.status, b.body.save.query.params.targetSteps, b.body.save.query.tfs, b.body.save.query.methods], [200, [{ at: '23:30', pct: 0.75 }], ['15m'], ['breakout']]);
  // refused in words: the same name again, no name, settings that cannot be meant
  const same = await post('/api/backtest-saves', { name: 'whole day, 10 LOTS', query: { params: WHOLE } });
  assert.equal(same.status, 409);
  assert.match(same.body.error, /called "whole day, 10 LOTS" already/);
  assert.equal((await post('/api/backtest-saves', { name: ' ', query: { params: WHOLE } })).status, 422);
  const badLots = await post('/api/backtest-saves', { name: 'bad', query: { params: { ...WHOLE, lots: 0 } } });
  assert.equal(badLots.status, 422);
  assert.match(badLots.body.error, /Lots are a whole number/);
  // the same one again under its id: other settings, the name kept
  const again = await post('/api/backtest-saves', { id: b.body.save.id, name: '15m, 3 lots, dynamic', query: { params: { ...WHOLE, lots: 3 }, tfs: ['15m'], methods: [], strategy: null } });
  assert.deepEqual([again.status, again.body.save.id, again.body.save.query.params.lots, again.body.save.query.params.targetSteps], [200, b.body.save.id, 3, undefined]);
  assert.deepEqual((await get('/api/backtest-saves')).body.saves.map((s: any) => s.name), ['15m, 3 lots, dynamic', 'Whole day, 10 lots'], 'by name');

  // run together: each is what it is alone, and the total is their sum
  const aloneA = await get(`/api/signal-backtest?from=${CLIMB}&to=${QUIET}&window=all`);
  const aloneB = await get(`/api/signal-backtest?from=${CLIMB}&to=${QUIET}&window=all&lots=3&tf=15m`);
  const run = await get(`/api/backtest-portfolio?ids=${a.body.save.id},${b.body.save.id}&from=${CLIMB}&to=${QUIET}`);
  assert.equal(run.status, 200, JSON.stringify(run.body).slice(0, 300));
  assert.deepEqual(run.body.members.map((m: any) => [m.name, m.problem, m.total.n]), [['Whole day, 10 lots', null, aloneA.body.total.n], ['15m, 3 lots, dynamic', null, aloneB.body.total.n]]);
  const close = (x: number, y: number) => Math.abs(x - y) < 1e-9;
  assert.ok(close(run.body.members[0].total.net, aloneA.body.total.net) && close(run.body.members[1].total.net, aloneB.body.total.net));
  assert.equal(run.body.total.n, aloneA.body.total.n + aloneB.body.total.n);
  assert.ok(close(run.body.total.net, aloneA.body.total.net + aloneB.body.total.net) && close(run.body.total.charges, aloneA.body.total.charges + aloneB.body.total.charges));
  assert.equal(run.body.total.exits['perp-tgt'].n, aloneA.body.total.exits['perp-tgt'].n + aloneB.body.total.exits['perp-tgt'].n);
  // day by day, with each one's own share
  assert.deepEqual(run.body.days.map((d: any) => [d.day, d.n]), [[CLIMB, aloneA.body.total.n + aloneB.body.total.n], [QUIET, 0]]);
  assert.ok(close(run.body.days[0].byMember[0], aloneA.body.days[0].net) && close(run.body.days[0].byMember[1], aloneB.body.days[0].net));
  // the margin: the most held at once across both -- the two were open together, so it is both peaks, and never more than their sum
  const m = run.body.margin;
  assert.ok(close(m.sumOfPeaksUsd, aloneA.body.margin.peakUsd + aloneB.body.margin.peakUsd));
  assert.ok(m.peakUsd > aloneA.body.margin.peakUsd && m.peakUsd <= m.sumOfPeaksUsd + 1e-9, JSON.stringify(m));
  assert.equal(m.peakDay, CLIMB);
  assert.ok(m.peakLots > 0 && m.peakLots <= 6 * 10 + 3 * 3, `the lots open at that moment, across both: ${m.peakLots}`);

  assert.equal(run.body.shared, null, 'neither has a limit of the desk\'s: there is none to share, and they are added up');
  // as one account: at most 2 open across both. The same signals are asked for by both; the places are the account's
  const one = await get(`/api/backtest-portfolio?ids=${a.body.save.id},${b.body.save.id}&from=${CLIMB}&to=${QUIET}&max=2&ce=100&pe=100`);
  assert.equal(one.status, 200, JSON.stringify(one.body).slice(0, 300));
  assert.deepEqual([one.body.shared.max, one.body.shared.ce, one.body.shared.pe], [2, 2, 2]);
  assert.ok(one.body.total.n < run.body.total.n, `${one.body.total.n} of ${run.body.total.n}: not every one of them finds a place`);
  assert.equal(one.body.total.n + one.body.shared.turnedAway, run.body.total.n, 'each signal either traded or turned away by the account being full');
  assert.equal(one.body.total.n, one.body.members.reduce((n: number, x: any) => n + x.total.n, 0));
  assert.ok(one.body.margin.peakOpen <= 2 && one.body.margin.peakUsd < run.body.margin.peakUsd, JSON.stringify(one.body.margin));
  assert.ok(close(one.body.days[0].net, one.body.days[0].byMember[0] + one.body.days[0].byMember[1]) && close(one.body.total.net, one.body.days[0].net));
  // each its own, said: as before
  const own = await get(`/api/backtest-portfolio?ids=${a.body.save.id},${b.body.save.id}&from=${CLIMB}&to=${QUIET}&limit=own&max=2`);
  assert.deepEqual([own.body.shared, own.body.total.n], [null, run.body.total.n]);
  // one expiry day, trade by trade (14 Oct 2026, "tap the count"): the trades add up to the day's row, each with whose it is
  for (const [label, q, r] of [['one account', '&max=2&ce=100&pe=100', one], ['each its own', '&limit=own&max=2', own], ['added up', '', run]] as const) {
    const d = await get(`/api/backtest-portfolio/trades?ids=${a.body.save.id},${b.body.save.id}&from=${CLIMB}&to=${QUIET}${q}&day=${CLIMB}`);
    assert.equal(d.status, 200, JSON.stringify(d.body).slice(0, 200));
    const row = r.body.days.find((x: any) => x.day === CLIMB);
    assert.equal(d.body.total, row.n, `${label}: as many trades as the day row`);
    assert.ok(close(d.body.trades.reduce((n: number, t: any) => n + t.netUsd, 0), row.net), `${label}: the same money`);
    assert.ok(d.body.trades.length > 0 && d.body.trades.every((t: any) => typeof t.member === 'string' && t.member.length > 0), `${label}: each says whose it is`);
  }
  assert.equal((await get(`/api/backtest-portfolio/trades?ids=${a.body.save.id},${b.body.save.id}&from=${CLIMB}&to=${QUIET}&day=2020-01-01`)).status, 400, 'a day outside the run');
  // by session, all of them together: the rows add up to the run, and a session's trades to its rows
  for (const r of [run, one, own]) assert.equal(r.body.bySession.reduce((n: number, x: any) => n + x.n, 0), r.body.total.n);
  const sess = one.body.bySession[0], from4 = sess.slot - (sess.slot % 4);
  const want = one.body.bySession.filter((x: any) => x.slot >= from4 && x.slot <= from4 + 3).reduce((n: number, x: any) => n + x.n, 0);
  const got = await get(`/api/backtest-portfolio/trades?ids=${a.body.save.id},${b.body.save.id}&from=${CLIMB}&to=${QUIET}&max=2&ce=100&pe=100&sfrom=${from4}&sto=${from4 + 3}`);
  assert.equal(got.body.total, want, 'one account: the session\'s trades, as its rows count them');

  // saved backtests that carry the account's limit themselves: the largest is the one shared
  const l2 = await post('/api/backtest-saves', { name: 'Limited two', query: { params: { ...WHOLE, deskMax: 2, cePct: 100, pePct: 100 }, tfs: [], methods: [], strategy: null } });
  const l1 = await post('/api/backtest-saves', { name: 'Limited one', query: { params: { ...WHOLE, lots: 3, deskMax: 1, cePct: 100, pePct: 100 }, tfs: ['15m'], methods: [], strategy: null } });
  const carried = await get(`/api/backtest-portfolio?ids=${l2.body.save.id},${l1.body.save.id}&from=${CLIMB}&to=${QUIET}`);
  assert.deepEqual([carried.body.shared.max, carried.body.total.n], [2, one.body.total.n], 'the same two places as asked for by hand');
  assert.equal((await get(`/api/backtest-portfolio?ids=${a.body.save.id}&from=${CLIMB}&to=${QUIET}&limit=some`)).status, 400);
  for (const x of [l1, l2]) await del(`/api/backtest-saves/${x.body.save.id}`);

  // kept as a portfolio; two or more, each a saved one
  const p = await post('/api/backtest-portfolios', { name: 'Both', saveIds: [a.body.save.id, b.body.save.id] });
  assert.deepEqual([p.status, p.body.portfolio.saveIds], [200, [a.body.save.id, b.body.save.id]]);
  assert.equal((await post('/api/backtest-portfolios', { name: 'One', saveIds: [a.body.save.id] })).status, 422);
  assert.equal((await post('/api/backtest-portfolios', { name: 'Ghost', saveIds: [a.body.save.id, 'no-such'] })).status, 422);
  assert.equal((await post('/api/backtest-portfolios', { name: 'both', saveIds: [a.body.save.id, b.body.save.id] })).status, 409);

  // edited: a portfolio's name and what is in it, under its id; a saved backtest's name
  const third = await post('/api/backtest-saves', { name: 'Premium rule', query: { params: { ...WHOLE, rule: 'premium', value: 50 }, tfs: [], methods: [], strategy: null } });
  const edited = await post('/api/backtest-portfolios', { id: p.body.portfolio.id, name: 'Whole and premium', saveIds: [a.body.save.id, third.body.save.id] });
  assert.deepEqual([edited.status, edited.body.portfolio.id, edited.body.portfolio.name, edited.body.portfolio.saveIds], [200, p.body.portfolio.id, 'Whole and premium', [a.body.save.id, third.body.save.id]]);
  assert.equal((await get('/api/backtest-saves')).body.portfolios.length, 1, 'the same portfolio, not another');
  assert.equal((await post('/api/backtest-portfolios', { id: p.body.portfolio.id, name: 'Whole and premium', saveIds: [a.body.save.id] })).status, 422, 'still two or more');
  assert.equal((await post('/api/backtest-portfolios', { id: 'no-such', name: 'Ghost', saveIds: [a.body.save.id, third.body.save.id] })).status, 404);
  const renamed = await post('/api/backtest-saves', { id: third.body.save.id, name: 'Premium at most 50', query: third.body.save.query });
  assert.deepEqual([renamed.status, renamed.body.save.name, renamed.body.save.query.params.rule], [200, 'Premium at most 50', 'premium']);
  assert.equal((await post('/api/backtest-saves', { id: third.body.save.id, name: 'Whole day, 10 lots', query: third.body.save.query })).status, 409, 'not to a name another has');
  assert.equal((await post('/api/backtest-saves', { id: 'no-such', name: 'Nobody', query: third.body.save.query })).status, 404);
  // back to the two it began with, for what follows
  await post('/api/backtest-portfolios', { id: p.body.portfolio.id, name: 'Both', saveIds: [a.body.save.id, b.body.save.id] });
  const { status: thirdGone } = await del(`/api/backtest-saves/${third.body.save.id}`);
  assert.equal(thirdGone, 200);

  // a saved backtest worked by a strategy since deleted is listed with why, and counts as nothing
  const made = await post('/api/strategies', { name: 'BT gone', config: {
    trigger: 'signal', signal: { mode: 'single', tf: '15m', tfs: ['15m'], methods: ['breakout'], target: 'tp1', maxOpen: 5, enterOn: 'zone', action: 'sell' },
    liveOrders: false, entryTime: '17:35', exitTime: '17:29', lots: 1, legs: 'both', strikeRule: 'delta', delta: { max: 0.1 }, premium: { mode: 'atMost', usd: 50, fallbackUsd: null },
    entryPrice: 'offer', crossAfterSec: 5, maxCrossSpreadPct: 0.5, takeProfitPct: 0.9, stopLossPct: 3, minPremiumUsd: 1, weekdays: [0, 1, 2, 3, 4, 5, 6], graceMin: 60 } });
  const c = await post('/api/backtest-saves', { name: 'By a strategy', query: { params: WHOLE, tfs: [], methods: [], strategy: made.body.strategy.id } });
  const withIt = await get(`/api/backtest-portfolio?ids=${a.body.save.id},${c.body.save.id}&from=${CLIMB}&to=${QUIET}`);
  assert.deepEqual(withIt.body.members.map((x: any) => [x.problem, x.total.n]), [[null, 6], [null, 3]], 'by its own rules: the three 15m breakouts');
  assert.equal((await del(`/api/strategies/${made.body.strategy.id}`)).status, 200);
  const without = await get(`/api/backtest-portfolio?ids=${a.body.save.id},${c.body.save.id}&from=${CLIMB}&to=${QUIET}`);
  assert.match(without.body.members[1].problem, /strategy it is worked by has been deleted/);
  assert.deepEqual([without.body.members[1].total.n, without.body.total.n], [0, 6]);

  /*
   * The hours for the run (13 Oct 2026): as saved unless asked, else one choice over every member worked by
   * settings -- each then exactly what it is alone with those hours -- and nothing saved is changed by it.
   */
  const pair = `/api/backtest-portfolio?ids=${a.body.save.id},${b.body.save.id}&from=${CLIMB}&to=${QUIET}&limit=own`;
  const asSaved = await get(pair);
  assert.equal(asSaved.body.hours, null, 'not asked: each as it was saved');
  assert.deepEqual((await get(`${pair}&hours=saved`)).body.total, asSaved.body.total);
  const whole = await get(`${pair}&hours=all`);
  assert.deepEqual(whole.body.hours, { window: 'all', own: [] });
  assert.deepEqual(whole.body.total, asSaved.body.total, 'both were saved on the whole day: the same run');
  for (const [ask, alone] of [['hours=desk', 'window=desk'], ['hours=custom&hfrom=22:00&hto=02:00', 'window=custom&hfrom=22:00&hto=02:00']] as const) {
    const run = await get(`${pair}&${ask}`);
    assert.equal(run.status, 200, JSON.stringify(run.body).slice(0, 300));
    const one = await get(`/api/signal-backtest?from=${CLIMB}&to=${QUIET}&${alone}`);
    const two = await get(`/api/signal-backtest?from=${CLIMB}&to=${QUIET}&${alone}&lots=3&tf=15m`);
    assert.deepEqual(run.body.members.map((m: any) => m.total.n), [one.body.total.n, two.body.total.n], `${ask}: each as it is alone in those hours`);
    assert.ok(close(run.body.total.net, one.body.total.net + two.body.total.net), ask);
  }
  assert.deepEqual((await get(`${pair}&hours=custom&hfrom=22:00&hto=02:00`)).body.hours, { window: 'custom', hoursFrom: '22:00', hoursTo: '02:00', own: [] });
  assert.ok((await get(`${pair}&hours=desk`)).body.total.n < asSaved.body.total.n, 'the desk\'s hours are fewer signals than the whole day');
  assert.deepEqual((await get('/api/backtest-saves')).body.saves.find((s: any) => s.id === a.body.save.id).query.params.window, 'all', 'the saved backtest itself is as it was');
  // one worked by a strategy keeps the strategy's hours, and is named as having kept them
  const mixed = await get(`/api/backtest-portfolio?ids=${a.body.save.id},${c.body.save.id}&from=${CLIMB}&to=${QUIET}&limit=own&hours=desk`);
  assert.deepEqual(mixed.body.hours, { window: 'desk', own: [c.body.save.id] });
  // refused in words
  for (const [bad, said] of [['hours=night', /The hours are "saved", "desk", "all" or "custom"/], ['hours=custom', /Custom hours are a From and a To time/],
    ['hours=custom&hfrom=22:00&hto=22:00', /must differ/], ['hours=custom&hfrom=25:00&hto=02:00', /Custom hours are a From and a To time/]] as const) {
    const r = await get(`${pair}&${bad}`);
    assert.equal(r.status, 400, bad);
    assert.match(r.body.error, said);
  }

  /*
   * The other settings for the run (14 Oct 2026): each its own switch. Off -- absent -- every member is as it was
   * saved; on, that one setting is put over every member worked by settings, and each is then exactly what the
   * single backtest gives with it. Nothing saved is changed.
   */
  assert.equal(asSaved.body.over, null, 'none asked: none put over');
  const single = (extra: string) => get(`/api/signal-backtest?from=${CLIMB}&to=${QUIET}${extra.includes('window=') ? '' : '&window=all'}${extra}`);
  for (const [ask, a1, b1, settings] of [
    ['o_lots=5', '&lots=5', '&lots=5&tf=15m', { lots: 5 }],
    ['o_rule=premium&o_value=50', '&rule=premium&value=50', '&rule=premium&value=50&lots=3&tf=15m', { rule: 'premium', value: 50 }],
    ['o_sl=1', '&sl=1', '&sl=1&lots=3&tf=15m', { stopPct: 1 }],
    ['o_minprem=0', '&minprem=0', '&minprem=0&lots=3&tf=15m', { minPremium: 0 }],
    ['o_tp=0.7&o_tsteps=23:30:75', '&tp=0.7&tsteps=23:30:75', '&tp=0.7&tsteps=23:30:75&lots=3&tf=15m', { targetPct: 0.7, targetSteps: [{ at: '23:30', pct: 0.75 }] }],
    ['o_tp=0.8', '&tp=0.8', '&tp=0.8&lots=3&tf=15m', { targetPct: 0.8, targetSteps: [] }],
    ['o_slmin=100&o_tgtmax=900', '&slmin=100&tgtmax=900', '&slmin=100&tgtmax=900&lots=3&tf=15m', { slMin: 100, slMax: 0, tgtMin: 0, tgtMax: 900 }],
    ['o_lots=5&o_sl=1&hours=desk', '&lots=5&sl=1&window=desk', '&lots=5&sl=1&window=desk&tf=15m', { stopPct: 1, lots: 5 }],
    // A trailing SL for the run (18 Oct 2026), over each member's own stop
    ['o_tsl=5pts:5pts', '&tsl=5pts:5pts', '&tsl=5pts:5pts&lots=3&tf=15m', { tsl: { move: 5, moveUnit: 'pts', by: 5, byUnit: 'pts' } }],
    ['o_sl=1&o_tsl=10pct:5pts', '&sl=1&tsl=10pct:5pts', '&sl=1&tsl=10pct:5pts&lots=3&tf=15m', { stopPct: 1, tsl: { move: 10, moveUnit: 'pct', by: 5, byUnit: 'pts' } }],
    // The perp's levels widened with volatility for the run (18 Oct 2026), the two together
    ['o_wsl=10&o_wtgt=20', '&wsl=10&wtgt=20', '&wsl=10&wtgt=20&lots=3&tf=15m', { widenSlAtr: 10, widenTgtAtr: 20, widenMode: 'widest' }],
    ['o_wsl=10&o_wmode=calm', '&wsl=10&wmode=calm', '&wsl=10&wmode=calm&lots=3&tf=15m', { widenSlAtr: 10, widenTgtAtr: 0, widenMode: 'calm' }],
    // The perp's SL left out for the run (18 Oct 2026), the two switches together
    ['o_noperpsl=1&o_noperptgt=0', '&noperpsl=1', '&noperpsl=1&lots=3&tf=15m', { skipPerpSl: true, skipPerpTgt: false }],
    // The option's stop to the price sold for the run (18 Oct 2026)
    ['o_be=10pct', '&be=10pct', '&be=10pct&lots=3&tf=15m', { breakEven: { move: 10, unit: 'pct' } }],
  ] as const) {
    const run = await get(`${pair}&${ask}`);
    assert.equal(run.status, 200, `${ask}: ${JSON.stringify(run.body).slice(0, 300)}`);
    const [one, two] = [await single(a1), await single(b1)];
    assert.deepEqual(run.body.members.map((m: any) => m.total.n), [one.body.total.n, two.body.total.n], `${ask}: each as the single backtest gives it`);
    assert.ok(close(run.body.members[0].total.net, one.body.total.net) && close(run.body.members[1].total.net, two.body.total.net), `${ask}: to the cent`);
    assert.ok(close(run.body.total.charges, one.body.total.charges + two.body.total.charges), ask);
    assert.deepEqual(run.body.over, { settings, own: [] }, `${ask}: said back as it was read`);
  }
  // The perp apart from the options, on the same trades (18 Oct 2026): every grouping adds up to the total, fees take away
  const perpRun = await single('');
  const tot = perpRun.body.total;
  assert.ok(tot.n > 0, 'trades to compare');
  for (const k of ['perpWins', 'perpNetPts', 'perpR', 'perpRNet'] as const) {
    assert.ok(close(perpRun.body.byMethod.reduce((x: number, r: any) => x + r[k], 0), tot[k]), `${k}: by method adds up to the total`);
  }
  assert.ok(tot.perpNetPts < tot.perpPts && tot.perpRNet < tot.perpR && tot.perpWins <= tot.n, 'the perp\'s fees only ever take away');
  /*
   * Methods by win % for the run (19 Oct 2026): each one by settings given the methods that won so on its own record --
   * on the run's own days (in-sample, as the Win tab), or on the days before it. Nothing saved is changed.
   */
  const winSame = await get(`${pair}&o_win=50&o_wintrades=1&o_winon=same`);
  assert.equal(winSame.status, 200, JSON.stringify(winSame.body).slice(0, 300));
  assert.deepEqual([winSame.body.winPick.on, winSame.body.winPick.from, winSame.body.winPick.to], ['same', CLIMB, QUIET]);
  const allA = await single('');
  const wonA = allA.body.choices.methods.filter((m: any) => m.n >= 1 && m.wins / m.n >= 0.5).sort((x: any, y: any) => y.net - x.net).map((m: any) => m.key);
  assert.deepEqual(winSame.body.winPick.picked[a.body.save.id], wonA, 'what the Win tab would pick: won half or more, best net first');
  const withThose = await single(`&method=${wonA.join(',')}`);
  assert.ok(close(winSame.body.members[0].total.net, withThose.body.total.net), 'and traded with exactly those');
  // on the day before the run: the record of that day alone picks
  const winBefore = await get(`/api/backtest-portfolio?ids=${a.body.save.id}&from=${QUIET}&to=${QUIET}&limit=own&o_win=50&o_wintrades=1&o_windays=1`);
  assert.equal(winBefore.status, 200, JSON.stringify(winBefore.body).slice(0, 300));
  assert.deepEqual([winBefore.body.winPick.on, winBefore.body.winPick.from, winBefore.body.winPick.to], ['before', CLIMB, CLIMB]);
  const climbRec = await get(`/api/signal-backtest?from=${CLIMB}&to=${CLIMB}&window=all`);
  const wonClimb = climbRec.body.choices.methods.filter((m: any) => m.n >= 1 && m.wins / m.n >= 0.5).sort((x: any, y: any) => y.net - x.net).map((m: any) => m.key);
  assert.deepEqual(winBefore.body.winPick.picked[a.body.save.id], wonClimb, 'picked on the day before it, never its own');
  // refused in words: nothing before the record, a rate out of range
  for (const [bad, said] of [['o_win=0', /win rate is from 1% to 100%/], ['o_win=50&o_winon=later', /"before" the run or on the "same"/], ['o_win=50&o_windays=31', /1 to 30 days before/]] as const) {
    const r = await get(`${pair}&${bad}`);
    assert.equal(r.status, 400, bad);
    assert.match(r.body.error, said);
  }
  const tooEarly = await get(`/api/backtest-portfolio?ids=${a.body.save.id}&from=2026-10-01&to=${QUIET}&limit=own&o_win=50`);
  assert.equal(tooEarly.status, 400);
  assert.match(tooEarly.body.error, /no finished days before 2026-10-01 to pick from/);
  // a setting put over the run is not a setting saved
  const kept = (await get('/api/backtest-saves')).body.saves.find((s: any) => s.id === a.body.save.id).query.params;
  assert.deepEqual([kept.lots, kept.rule, kept.stopPct], [10, 'delta', 3]);
  // one worked by a strategy keeps the strategy's own rules, and is named
  assert.deepEqual((await get(`/api/backtest-portfolio?ids=${a.body.save.id},${c.body.save.id}&from=${CLIMB}&to=${QUIET}&limit=own&o_lots=5`)).body.over, { settings: { lots: 5 }, own: [c.body.save.id] });
  // refused in the single backtest's own words, and in the run's where a pair is half given
  for (const [bad, said] of [['o_lots=0', /For the run: Lots are a whole number/], ['o_value=0.1', /A strike for the run is its rule and its limit/], ['o_rule=delta', /A strike for the run is its rule and its limit/],
    ['o_rule=delta&o_value=0.9', /For the run: A delta limit is from 0\.02 to 0\.5/], ['o_tsteps=23:30:75', /needs the target it starts from/], ['o_slmin=500&o_slmax=100', /SL maximum must not be under its minimum/],
    ['o_tsl=5pts', /For the run: A trailing SL is a price move and an SL move/], ['o_sl=0&o_tsl=5pts:5pts', /needs an option stop to move/],
    ['o_tsl=5pts:9pts', /SL cannot move further than the price did/], ['o_wsl=101', /For the run: Widening with volatility is from 0 \(off\) to 100 ATRs/], ['o_wmode=both', /"widest" or "calm"/], ['o_noperpsl=yes', /noperpsl is 0 or 1/],
    ['o_be=5', /A move to break-even is a premium fall in pts or pct/], ['o_be=0pts', /break-even is more than 0/]] as const) {
    const r = await get(`${pair}&${bad}`);
    assert.equal(r.status, 400, bad);
    assert.match(r.body.error, said);
  }

  // `o_tsl=off` takes a member's own trailing SL away for the run, said back as none
  const withTsl = await post('/api/backtest-saves', { name: 'Trailed', query: { params: { ...WHOLE, tsl: { move: 5, moveUnit: 'pts', by: 5, byUnit: 'pts' } }, tfs: [], methods: [], strategy: null } });
  assert.equal(withTsl.status, 200, JSON.stringify(withTsl.body));
  assert.deepEqual(withTsl.body.save.query.params.tsl, { move: 5, moveUnit: 'pts', by: 5, byUnit: 'pts' }, 'saved, and read back as saved');
  const trailedRun = await get(`/api/backtest-portfolio?ids=${withTsl.body.save.id}&from=${CLIMB}&to=${QUIET}&limit=own`);
  const trailedOne = await single('&tsl=5pts:5pts');
  assert.ok(close(trailedRun.body.members[0].total.net, trailedOne.body.total.net), 'a saved trailing SL is run as the single backtest runs it');
  const offRun = await get(`/api/backtest-portfolio?ids=${withTsl.body.save.id}&from=${CLIMB}&to=${QUIET}&limit=own&o_tsl=off`);
  assert.ok(close(offRun.body.members[0].total.net, (await single('')).body.total.net), 'off for the run: as with none');
  assert.equal((await get(`/api/signal-backtest?from=${CLIMB}&to=${QUIET}&tsl=5pts:5pts&sl=0`)).status, 400);
  await del(`/api/backtest-saves/${withTsl.body.save.id}`);

  /*
   * The same run beside the live desk (14 Oct 2026: "the live check inside the portfolio"): asked with the run's own
   * query, so it is the run's own trades that are looked up -- its count and money, and the settings put over it.
   */
  const check = await get(`${pair.replace('/api/backtest-portfolio?', '/api/backtest-portfolio/live-check?')}&name=Both`);
  assert.equal(check.status, 200, JSON.stringify(check.body).slice(0, 300));
  assert.deepEqual(check.body.against, { kind: 'portfolio', name: 'Both' });
  assert.deepEqual(check.body.strategies.map((x: any) => [x.name, x.backtest]), asSaved.body.members.map((m: any) => [m.name, m.total.n]), 'each saved backtest, with the trades its run makes');
  assert.equal(check.body.total.backtest, asSaved.body.total.n);
  assert.ok(close(check.body.money.backtest.net, asSaved.body.total.net), 'and the run\'s own money');
  assert.deepEqual(check.body.days.map((d: any) => [d.day, d.backtest]), asSaved.body.days.map((d: any) => [d.day, d.n]));
  // the live rules run with each saved backtest's settings take the same trades, and make the same money
  assert.deepEqual([check.body.total.placed, check.body.total.same, check.body.total.backtestOnly, check.body.total.liveOnly], [asSaved.body.total.n, asSaved.body.total.n, 0, 0]);
  assert.ok(close(check.body.money.real.net, check.body.money.backtest.net));
  const checkLots = await get(`${pair.replace('/api/backtest-portfolio?', '/api/backtest-portfolio/live-check?')}&o_tf=x&hours=desk`);
  assert.equal(checkLots.body.total.backtest, (await get(`${pair}&hours=desk`)).body.total.n, 'the hours put over the run are over its check');
  assert.equal((await get('/api/backtest-portfolio/live-check?from=2026-10-01')).status, 400);

  // refused: none named, one that is gone, too many
  assert.equal((await get(`/api/backtest-portfolio?from=${CLIMB}&to=${QUIET}`)).status, 400);
  assert.equal((await get(`/api/backtest-portfolio?ids=nope&from=${CLIMB}&to=${QUIET}`)).status, 404);
  assert.equal((await get(`/api/backtest-portfolio?ids=${Array.from({ length: 13 }, (_, i) => `x${i}`).join(',')}`)).status, 400);

  // deleted: it leaves its portfolio, and a portfolio left with one is deleted with it -- said
  const gone = await del(`/api/backtest-saves/${b.body.save.id}`);
  assert.deepEqual([gone.status, gone.body.portfoliosDeleted], [200, ['Both']]);
  const left = await get('/api/backtest-saves');
  assert.deepEqual([left.body.saves.map((s: any) => s.name), left.body.portfolios], [['By a strategy', 'Whole day, 10 lots'], []]);
  assert.equal((await del(`/api/backtest-saves/${b.body.save.id}`)).status, 404);
});

test('[critical] saved backtests in groups, cloned under a free name, a group renamed; portfolios cloned (16 Oct 2026)', async () => {
  const del = async (url: string) => (await app.inject({ method: 'DELETE', url, headers: cookie })).statusCode;
  const P = { rule: 'delta', value: 0.1, lots: 1, targetPct: 0.9, stopPct: 3, window: 'all', deskMax: 0, cePct: 100, pePct: 100 };
  const q = { params: P, tfs: [], methods: [], strategy: null };
  // filed in a group, spaces tidied; none is null; too long is refused
  const a = await post('/api/backtest-saves', { name: 'grp a', group: '  80%   Win ', query: q });
  assert.deepEqual([a.status, a.body.save.group], [200, '80% Win']);
  const b = await post('/api/backtest-saves', { name: 'grp b', group: '', query: { ...q, params: { ...P, lots: 2 } } });
  assert.equal(b.body.save.group, null);
  assert.equal((await post('/api/backtest-saves', { name: 'grp c', group: 'x'.repeat(41), query: q })).status, 422);
  // an update that says nothing of the group keeps it; one that names another moves it
  const kept = await post('/api/backtest-saves', { id: a.body.save.id, name: 'grp a', query: { ...q, params: { ...P, lots: 3 } } });
  assert.equal(kept.body.save.group, '80% Win');
  const moved = await post('/api/backtest-saves', { id: b.body.save.id, name: 'grp b', group: '75% Win', query: { ...q, params: { ...P, lots: 2 } } });
  assert.equal(moved.body.save.group, '75% Win');

  // a clone: the same settings and group, under "<name> copy", then "<name> copy 2"
  const c1 = await post(`/api/backtest-saves/${a.body.save.id}/clone`, {});
  assert.deepEqual([c1.status, c1.body.save.name, c1.body.save.group, c1.body.save.query.params.lots], [200, 'grp a copy', '80% Win', 3]);
  assert.notEqual(c1.body.save.id, a.body.save.id);
  const c2 = await post(`/api/backtest-saves/${a.body.save.id}/clone`, {});
  assert.equal(c2.body.save.name, 'grp a copy 2');
  assert.equal((await post('/api/backtest-saves/nope/clone', {})).status, 404);

  // a group renamed: every one in it moves; renamed to nothing, they are in no group
  const ren = await post('/api/backtest-saves/group', { from: '80% win', to: 'High win' });
  assert.deepEqual([ren.status, ren.body.moved], [200, 3]);
  const groups = (await get('/api/backtest-saves')).body.saves.filter((s: any) => s.name.startsWith('grp')).map((s: any) => [s.name, s.group]);
  assert.deepEqual(groups, [['grp a', 'High win'], ['grp a copy', 'High win'], ['grp a copy 2', 'High win'], ['grp b', '75% Win']]);
  assert.equal((await post('/api/backtest-saves/group', { from: '75% Win', to: null })).body.moved, 1);
  assert.equal((await post('/api/backtest-saves/group', { from: '', to: 'x' })).status, 422);

  // a portfolio cloned: the same saved backtests in order, a free name
  const p = await post('/api/backtest-portfolios', { name: 'grp folio', saveIds: [a.body.save.id, b.body.save.id] });
  const pc = await post(`/api/backtest-portfolios/${p.body.portfolio.id}/clone`, {});
  assert.deepEqual([pc.status, pc.body.portfolio.name, pc.body.portfolio.saveIds], [200, 'grp folio copy', [a.body.save.id, b.body.save.id]]);
  assert.equal((await post('/api/backtest-portfolios/nope/clone', {})).status, 404);

  for (const id of [p.body.portfolio.id, pc.body.portfolio.id]) await del(`/api/backtest-portfolios/${id}`);
  for (const s of [a, b, c1, c2]) await del(`/api/backtest-saves/${s.body.save.id}`);
});

test('[critical] a run together is broken down as one backtest is (17 Oct 2026): one saved backtest run alone gives the backtest\'s own breakdowns and counts -- each way of running it', async () => {
  const base = `from=${CLIMB}&to=${CLIMB}&window=all`;
  const single = (await get(`/api/signal-backtest?${base}`)).body;
  const one = await post('/api/backtest-saves', { name: 'alone', query: { params: { ...single.params }, tfs: [], methods: [], strategy: null } });
  assert.equal(one.status, 200, JSON.stringify(one.body));
  try {
    const keys = ['pairs', 'byTf', 'byMethod', 'byPattern', 'byFamily', 'byVol'] as const;
    for (const limit of ['limit=own', 'max=500&ce=100&pe=100']) {
      const run = await get(`/api/backtest-portfolio?ids=${one.body.save.id}&from=${CLIMB}&to=${CLIMB}&${limit}`);
      assert.equal(run.status, 200, JSON.stringify(run.body).slice(0, 300));
      for (const k of keys) assert.deepEqual(run.body.breakdown[k], single[k], `${limit}: ${k}`);
      assert.deepEqual(run.body.total.exits, single.total.exits, `${limit}: by exit`);
      assert.deepEqual([run.body.signals, run.body.skipped], [single.signals, single.skipped], `${limit}: the signals and why some were not traded`);
    }
    // The volatility filter over the run, as the single backtest's: no level by the candles here, so none is "high".
    const vol = await get(`/api/backtest-portfolio?ids=${one.body.save.id}&from=${CLIMB}&to=${CLIMB}&limit=own&o_vol=high`);
    assert.deepEqual([vol.body.total.n, vol.body.skipped.volatility, vol.body.over.settings.vol], [0, single.total.n, 'high']);
    assert.match((await get(`/api/backtest-portfolio?ids=${one.body.save.id}&from=${CLIMB}&to=${CLIMB}&o_vol=extreme`)).body.error, /For the run: The volatility filter/);
  } finally {
    await app.inject({ method: 'DELETE', url: `/api/backtest-saves/${one.body.save.id}`, headers: cookie });
  }
});

test('[critical] a strike rule by time of day (18 Oct 2026): the settings\' rule is block 1, each block its own rule from its time -- held to the form\'s rules, saved with a backtest, put over a run', async () => {
  const base = `from=${CLIMB}&to=${CLIMB}&window=all`;
  const plain = (await get(`/api/signal-backtest?${base}`)).body;
  // From 8:00 PM IST, by delta at most 0.05: the board's strikes are 0.09 out, so none is sold from then.
  const blocks = [{ at: '20:00', strikeRule: 'delta', strikeStep: 0, premium: { mode: 'atMost', usd: 50 }, delta: { max: 0.05 } }];
  const q = `${base}&sblocks=${encodeURIComponent(JSON.stringify(blocks))}`;
  const run = await get(`/api/signal-backtest?${q}`);
  assert.equal(run.status, 200, JSON.stringify(run.body).slice(0, 300));
  const climbFrom = sessionOf(CLIMB).from, eight = climbFrom + 150 * 60_000;
  const list = (await get(`/api/signal-backtest/trades?${base}&day=${CLIMB}`)).body.trades;
  const after = list.filter((t: any) => t.at >= eight).length;
  assert.ok(after > 0 && after < plain.total.n, 'some signals before 8 PM, some after');
  assert.deepEqual([run.body.total.n, run.body.skipped['no-strike'] - plain.skipped['no-strike']], [plain.total.n - after, after]);
  assert.equal(run.body.params.strikeBlocks[0].delta.max, 0.05);
  // The trade list is the run's own.
  assert.equal((await get(`/api/signal-backtest/trades?${q}&day=${CLIMB}`)).body.total, plain.total.n - after);
  // A block by premium from 8 PM sells again: every signal traded.
  const premium = [{ ...blocks[0], strikeRule: 'premium', delta: null, premium: { mode: 'atMost', usd: 500 } }];
  assert.equal((await get(`/api/signal-backtest?${base}&sblocks=${encodeURIComponent(JSON.stringify(premium))}`)).body.total.n, plain.total.n);
  // The form's own rules, against these hours.
  const desk = `from=${CLIMB}&to=${CLIMB}&window=desk`;
  for (const [qq, why] of [
    [`${desk}&sblocks=${encodeURIComponent(JSON.stringify(blocks))}`, /must start after entry \(9:30 PM\) and before exit/],
    [`${base}&sblocks=nope`, /a list, as JSON/],
    [`${base}&sblocks=${encodeURIComponent(JSON.stringify([{ ...blocks[0], delta: { max: 0.9 } }]))}`, /Block 2: /],
  ] as const) assert.match((await get(`/api/signal-backtest?${qq}`)).body.error, why, qq);
  // Saved with a backtest, and put over a run.
  const saved = await post('/api/backtest-saves', { name: 'blocks', query: { params: { ...run.body.params }, tfs: [], methods: [], strategy: null } });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.deepEqual(saved.body.save.query.params.strikeBlocks.map((b: any) => [b.at, b.strikeRule]), [['20:00', 'delta']]);
  const free = await post('/api/backtest-saves', { name: 'no blocks', query: { params: { ...plain.params }, tfs: [], methods: [], strategy: null } });
  try {
    const own = await get(`/api/backtest-portfolio?ids=${saved.body.save.id}&from=${CLIMB}&to=${CLIMB}&limit=own`);
    assert.equal(own.body.total.n, plain.total.n - after, 'its saved blocks');
    const over = await get(`/api/backtest-portfolio?ids=${free.body.save.id}&from=${CLIMB}&to=${CLIMB}&limit=own&o_sblocks=${encodeURIComponent(JSON.stringify(blocks))}`);
    assert.equal(over.status, 200, JSON.stringify(over.body).slice(0, 300));
    assert.equal(over.body.total.n, plain.total.n - after, 'the run\'s blocks over a member by settings');
    assert.equal(over.body.over.settings.strikeBlocks.length, 1);
    const none = await get(`/api/backtest-portfolio?ids=${saved.body.save.id}&from=${CLIMB}&to=${CLIMB}&limit=own&o_sblocks=%5B%5D`);
    assert.equal(none.body.total.n, plain.total.n, '"one rule all day" over the run takes a member\'s own blocks away');
  } finally {
    for (const x of [saved, free]) await app.inject({ method: 'DELETE', url: `/api/backtest-saves/${x.body.save.id}`, headers: cookie });
  }
});

test('[critical] a strategy is backtested on the methods it had at each signal, as it traded -- its daily changes read back from the record (18 Oct 2026)', async () => {
  const config = {
    trigger: 'signal', signal: { mode: 'single', tf: '15m', tfs: ['15m'], methods: ['breakout'], target: 'tp1', maxOpen: 100, enterOn: 'zone', action: 'sell' },
    liveOrders: false, entryTime: '17:35', exitTime: '17:29', lots: 3, legs: 'both',
    strikeRule: 'delta', delta: { max: 0.1 }, premium: { mode: 'atMost', usd: 50, fallbackUsd: null },
    entryPrice: 'offer', crossAfterSec: 5, maxCrossSpreadPct: 0.5, takeProfitPct: 0.9, stopLossPct: 3, minPremiumUsd: 1,
    weekdays: [0, 1, 2, 3, 4, 5, 6], graceMin: 60,
  };
  const made = await post('/api/strategies', { name: 'BT history', config });
  assert.equal(made.status, 200, JSON.stringify(made.body));
  const id = made.body.strategy.id;
  const asked = () => get(`/api/signal-backtest?from=${CLIMB}&to=${CLIMB}&strategy=${id}`);
  try {
    const now = (await asked()).body;
    assert.equal(now.signals, 3, 'no history: today\'s list, all three 15m breakouts');
    // An hour into the day it was switched from pullback to breakout: the first breakout (minute 30) was not its then.
    const climbFrom = sessionOf(CLIMB).from;
    await query(`INSERT INTO strategy_method_updates (at, strategy_id, strategy_name, source, before, after) VALUES ($1, $2, 'BT history', 'daily', '["pullback"]', '["breakout"]')`, [climbFrom + 60 * 60_000, id]);
    clearSignalBacktestCache();
    const then = (await asked()).body;
    assert.equal(then.signals, 2, 'the breakout before the change was not on its list then');
    // The same in a run of saved backtests worked by the strategy.
    const save = await post('/api/backtest-saves', { name: 'by history', query: { params: { ...then.params }, tfs: [], methods: [], strategy: id } });
    assert.equal(save.status, 200, JSON.stringify(save.body));
    try {
      const run = await get(`/api/backtest-portfolio?ids=${save.body.save.id}&from=${CLIMB}&to=${CLIMB}&limit=own`);
      assert.equal(run.body.members[0].signals, 2);
    } finally {
      await app.inject({ method: 'DELETE', url: `/api/backtest-saves/${save.body.save.id}`, headers: cookie });
    }
  } finally {
    await query('DELETE FROM strategy_method_updates WHERE strategy_id = $1', [id]);
    await app.inject({ method: 'DELETE', url: `/api/strategies/${id}`, headers: cookie });
    clearSignalBacktestCache();
  }
});

test('[critical] strike blocks are times of the expiry day: a run\'s block before a member\'s hours open is in force from their start, one after they close is not traded in (18 Oct 2026)', async () => {
  const plain = (await get(`/api/signal-backtest?from=${CLIMB}&to=${CLIMB}&window=all`)).body;
  const one = await post('/api/backtest-saves', { name: 'whole day', query: { params: { ...plain.params }, tfs: [], methods: [], strategy: null } });
  try {
    const block = (at: string) => encodeURIComponent(JSON.stringify([{ at, strikeRule: 'delta', strikeStep: 0, premium: { mode: 'atMost', usd: 50 }, delta: { max: 0.05 } }]));
    const run = (q: string) => get(`/api/backtest-portfolio?ids=${one.body.save.id}&from=${CLIMB}&to=${CLIMB}&limit=own&hours=desk${q}`);
    const desk = (await run('')).body.total.n;
    assert.ok(desk > 0, 'some signals inside 9:30 PM-3:59 PM');
    // 7 PM, before the desk's hours open: in force from 9:30 PM -- no strike under 0.05 on this board, so nothing sold.
    const early = await run(`&o_sblocks=${block('19:00')}`);
    assert.equal(early.status, 200, JSON.stringify(early.body).slice(0, 300));
    assert.equal(early.body.total.n, 0, 'the 7 PM block rules the whole of the hours');
    // 4:30 PM, after they close: never traded in -- the member's own rule all through.
    assert.equal((await run(`&o_sblocks=${block('16:30')}`)).body.total.n, desk);
  } finally {
    await app.inject({ method: 'DELETE', url: `/api/backtest-saves/${one.body.save.id}`, headers: cookie });
  }
});

test('[critical] volatility by ATM IV, and the option stop by volatility against the fixed one, on the same trades (17 Oct 2026)', async () => {
  const climbCode = `${CLIMB.slice(8, 10)}${CLIMB.slice(5, 7)}${CLIMB.slice(2, 4)}`;
  const base = `from=${CLIMB}&to=${CLIMB}&window=all`;
  // No IV on the board yet: no signal has a level by it -- Unknown, never Low.
  const none = await get(`/api/signal-backtest?${base}&volby=iv`);
  assert.equal(none.status, 200);
  assert.equal(none.body.params.volBy, 'iv');
  assert.deepEqual([none.body.total.n, none.body.byVol], [6, []]);
  const noneLow = await get(`/api/signal-backtest?${base}&volby=iv&vol=low`);
  assert.deepEqual([noneLow.body.total.n, noneLow.body.skipped.volatility], [0, 6]);
  assert.equal((await get(`/api/signal-backtest?${base}`)).body.params.volBy, undefined, 'the default is not written into the settings');
  assert.match((await get(`/api/signal-backtest?${base}&volby=vix`)).body.error, /"atr" or "iv"/);

  // Five expiry days before, the ATM pair every five minutes with IV 40 to 60; the climb's own board at 70: above the high third.
  const priorDays = [3, 4, 5, 6, 7].map(dayBack);
  for (const day of priorDays) {
    const code = `${day.slice(8, 10)}${day.slice(5, 7)}${day.slice(2, 4)}`;
    const at: number[] = [], iv: number[] = [];
    for (let m = 0; m < 1_440; m += 5) { at.push(sessionOf(day).from + m * 60_000); iv.push(40 + (20 * ((m / 5) % 12)) / 11); }
    for (const cp of ['C', 'P']) {
      await query(
        `INSERT INTO option_snapshots (at, symbol, expiry, cp, strike, spot, mark, bid, ask, delta, mark_iv)
         SELECT a, $3, $4, $5, 84000, 84000, 500, 499, 501, 0.5, v FROM unnest($1::bigint[], $2::float8[]) AS t(a, v)`,
        [at, iv, `${cp}-BTC-84000-${code}`, code, cp]);
    }
  }
  await query('UPDATE option_snapshots SET mark_iv = 70 WHERE expiry = $1', [climbCode]);
  clearSignalBacktestCache();
  try {
    const high = await get(`/api/signal-backtest?${base}&volby=iv`);
    assert.deepEqual(high.body.byVol.map((r: any) => [r.key, r.n]), [['high', 6]], 'every signal in high volatility by the IV');
    assert.equal((await get(`/api/signal-backtest?${base}&volby=iv&vol=high`)).body.total.n, 6);
    assert.equal((await get(`/api/signal-backtest?${base}&volby=iv&vol=low`)).body.total.n, 0);
    // The trade list reads the same levels as the run it opens from.
    const listed = await get(`/api/signal-backtest/trades?${base}&volby=iv&vol=high&day=${CLIMB}`);
    assert.equal(listed.body.total, 6);
    // A saved backtest keeps how it reads volatility.
    const saved = await post('/api/backtest-saves', { name: 'iv study', query: { params: { ...high.body.params }, tfs: [], methods: [], strategy: null } });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.equal(saved.body.save.query.params.volBy, 'iv');
    assert.equal((await app.inject({ method: 'DELETE', url: `/api/backtest-saves/${saved.body.save.id}`, headers: cookie })).statusCode, 200);

    // The study: the plan's own stop (+300%) against 150 / 200 / 250 by level, read both ways, on the same six trades.
    const study = await get(`/api/signal-backtest/vol-study?${base}`);
    assert.equal(study.status, 200, JSON.stringify(study.body).slice(0, 300));
    assert.deepEqual([study.body.sl, study.body.delta, study.body.lots], [{ low: 2.5, medium: 2, high: 1.5 }, null, null], 'the SL alone, to begin with');
    assert.deepEqual([study.body.fixed, study.body.signals, study.body.days, study.body.sameTrades], [{ pct: 3, stepped: false, each: [3] }, 6, 1, true]);
    assert.deepEqual(study.body.sources.map((s: any) => s.by), ['atr', 'iv']);
    const line = (by: string, rule: string) => study.body.sources.find((s: any) => s.by === by).lines.find((l: any) => l.rule === rule);
    const level = (l: any, k: string) => l.byLevel.find((x: any) => x.level === k).n;
    // By the IV every trade is high; by the candles none can be said (no days before the climb): unknown keeps +300%.
    assert.deepEqual([level(line('iv', 'by-vol'), 'high'), level(line('iv', 'fixed'), 'high')], [6, 6]);
    assert.deepEqual([level(line('atr', 'by-vol'), 'unknown'), level(line('atr', 'fixed'), 'unknown')], [6, 6]);
    for (const l of [line('iv', 'fixed'), line('iv', 'by-vol'), line('atr', 'fixed'), line('atr', 'by-vol')]) {
      assert.equal(l.n, 6);
      assert.equal(l.stopHits, 0, 'the board decays all day: no stop is reached, tight or wide');
      assert.ok(Math.abs(l.net - line('iv', 'fixed').net) < 1e-9, 'the same trades, the same money');
      assert.equal(l.worstDay.day, CLIMB);
      // Each expiry day of the range, with its own figures: what the screen's by-day sheet lists.
      assert.deepEqual(l.byDay.map((d: any) => [d.day, d.live, d.n, d.lots]), [[CLIMB, false, 6, 60]]);
      assert.ok(Math.abs(l.byDay[0].net - l.net) < 1e-9 && l.byDay[0].charges > 0);
    }
    // One day of the study, trade by trade: each side, each way of reading, with each trade's level; adds up to the day's row.
    const ivRow = line('iv', 'by-vol').byDay[0];
    const list = await get(`/api/signal-backtest/vol-study/trades?${base}&day=${CLIMB}&side=by-vol&by=iv`);
    assert.equal(list.status, 200, JSON.stringify(list.body).slice(0, 300));
    assert.equal(list.body.total, ivRow.n);
    assert.deepEqual([...new Set(list.body.trades.map((t: any) => t.level))], ['high']);
    assert.ok(Math.abs(list.body.trades.reduce((a: number, t: any) => a + t.netUsd, 0) - ivRow.net) < 1e-6, 'the list is the day\'s row, trade by trade');
    assert.deepEqual([...new Set((await get(`/api/signal-backtest/vol-study/trades?${base}&day=${CLIMB}&side=fixed&by=atr`)).body.trades.map((t: any) => t.level))], ['unknown']);
    for (const [q, why] of [[`day=${dayBack(20)}&side=fixed&by=iv`, /one of the expiry days/], [`day=${CLIMB}&side=both&by=iv`, /"fixed" \(as set\) or "by-vol"/], [`day=${CLIMB}&side=fixed&by=vix`, /"atr" or "iv"/]] as const) {
      assert.match((await get(`/api/signal-backtest/vol-study/trades?${base}&${q}`)).body.error, why, q);
    }
    // The per cent of each level is the owner's to set; out of range, refused in words.
    const own = await get(`/api/signal-backtest/vol-study?${base}&vh=120&vm=180&vl=300`);
    assert.deepEqual(own.body.sl, { low: 3, medium: 1.8, high: 1.2 });
    assert.match((await get(`/api/signal-backtest/vol-study?${base}&vh=5`)).body.error, /high volatility stop is from 10% to 1,000%/);
    assert.match((await get(`/api/signal-backtest/vol-study?${base}&vl=abc`)).body.error, /low volatility stop/);

    // The lots by level: every trade high by the IV, so every trade 1 lot -- a tenth of the 10 the settings sell.
    const lots = await get(`/api/signal-backtest/vol-study?${base}&vsl=0&vlots=1`);
    assert.deepEqual([lots.body.sl, lots.body.lots], [null, { high: 1, medium: 2, low: 2 }]);
    const ivLots = lots.body.sources.find((x: any) => x.by === 'iv').lines;
    assert.deepEqual(ivLots.map((l: any) => [l.rule, l.n, l.lots]), [['fixed', 6, 60], ['by-vol', 6, 6]]);
    assert.ok(Math.abs(ivLots[1].net - ivLots[0].net / 10) < 0.02, 'the same trades at a tenth of the size, near enough (charges are per fill)');
    // The delta by level: high reads 0.08, and the board's only strikes are 0.09 out -- none inside it, so none is sold.
    const delta = await get(`/api/signal-backtest/vol-study?${base}&vsl=0&vdelta=1`);
    assert.deepEqual(delta.body.delta, { high: 0.08, medium: 0.1, low: 0.12 });
    const ivDelta = delta.body.sources.find((x: any) => x.by === 'iv').lines;
    assert.deepEqual(ivDelta.map((l: any) => l.n), [6, 0], 'no strike inside 0.08: the rule by volatility trades none of them');
    assert.equal(delta.body.sameTrades, false, 'and says the two rules did not trade the same signals');
    const atrDelta = delta.body.sources.find((x: any) => x.by === 'atr').lines;
    assert.deepEqual(atrDelta.map((l: any) => l.n), [6, 6], 'no level by the candles: the strike rule as set');
    assert.equal((await get(`/api/signal-backtest/vol-study?${base}&vsl=0&vdelta=1&dh=0.09`)).body.sources.find((x: any) => x.by === 'iv').lines[1].n, 6, 'its own delta, typed');
    for (const [q, why] of [['vsl=0', /SL, the delta or the lots/], ['vdelta=1&dm=0.9', /medium volatility delta is from 0\.02 to 0\.50/], ['vlots=1&lh=1.5', /high volatility lots are a whole number/], ['vlots=yes', /vlots is 0 or 1/]] as const) {
      assert.match((await get(`/api/signal-backtest/vol-study?${base}&${q}`)).body.error, why, q);
    }

    // Saved backtests run together: each on its own signals, no limit -- the shared one too -- and added up.
    const one = await post('/api/backtest-saves', { name: 'vol one', query: { params: { ...high.body.params, volBy: undefined }, tfs: ['15m'], methods: [], strategy: null } });
    const two = await post('/api/backtest-saves', { name: 'vol two', query: { params: { ...high.body.params, volBy: undefined, stopPct: 2 }, tfs: ['1h'], methods: [], strategy: null } });
    try {
      const folio = await get(`/api/backtest-portfolio/vol-study?ids=${one.body.save.id},${two.body.save.id}&from=${CLIMB}&to=${CLIMB}&max=1&vlots=1`);
      assert.equal(folio.status, 200, JSON.stringify(folio.body).slice(0, 300));
      assert.deepEqual(folio.body.members.map((m: any) => [m.name, m.problem]), [['vol one', null], ['vol two', null]]);
      assert.deepEqual(folio.body.fixed.each, [3, 2], 'each one\'s own stop');
      const f = folio.body.sources.find((x: any) => x.by === 'iv').lines;
      assert.deepEqual(f.map((l: any) => l.n), [5, 5], 'the 15m three and the 1h two: the run\'s "at most 1 open" is not laid over the study');
      assert.match((await get(`/api/backtest-portfolio/vol-study?ids=${one.body.save.id}&from=${CLIMB}&to=${CLIMB}&vh=9`)).body.error, /high volatility stop/);
      const ft = await get(`/api/backtest-portfolio/vol-study/trades?ids=${one.body.save.id},${two.body.save.id}&from=${CLIMB}&to=${CLIMB}&vlots=1&day=${CLIMB}&side=by-vol&by=iv`);
      assert.deepEqual([ft.body.total, [...new Set(ft.body.trades.map((t: any) => t.member))].sort(), [...new Set(ft.body.trades.map((t: any) => t.lots))]], [5, ['vol one', 'vol two'], [1]], 'whose each trade is, at its level\'s lots');
    } finally {
      for (const x of [one, two]) await app.inject({ method: 'DELETE', url: `/api/backtest-saves/${x.body.save.id}`, headers: cookie });
    }
  } finally {
    await query('UPDATE option_snapshots SET mark_iv = NULL WHERE expiry = $1', [climbCode]);
    for (const day of priorDays) await query('DELETE FROM option_snapshots WHERE expiry = $1', [`${day.slice(8, 10)}${day.slice(5, 7)}${day.slice(2, 4)}`]);
    clearSignalBacktestCache();
  }
});
