import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { LIVE_RULES, clearOptionReplayCache, onList, optionReplay, optionReplayCsv, pickSignalStrike, replayExit, rulesProblem, shortNetUsd, type BoardQuote, type OptionPath, type PerpPath, type ReplayRules } from '../../src/report/option-replay.js';
import { replayAskOf } from '../../src/http/routes/report.routes.js';
import { sessionDayOf, sessionOf } from '../../src/report/market-day.js';
import { optionSnapshotsSchema } from '../../src/market/option-snapshots.js';
import { flowSchema } from '../../src/market/flow.js';
import { entrySchema } from '../../src/entry/paper.js';
import { methodsSchema } from '../../src/entry/catalogue.js';
import { initTradingService, tradingService } from '../../src/trading/service.js';
import { initStrategyStore } from '../../src/http/routes/strategy.routes.js';
import { closePool, query } from '../../src/db/pool.js';

/**
 * The option history (3 Nov 2026): the desk's own sold options, each exit worked again on the contract's recorded
 * quotes under other rules. The rules one at a time on a path drawn by hand, then one expiry day through the real
 * database -- a put sold on a buy signal whose perp falls through the signal's SL -- with the figures worked here.
 */

const MIN = 60_000;
const T0 = Date.UTC(2026, 9, 20, 4, 0); // 9:30 AM IST
const NO_PERP: PerpPath = { at: new Float64Array(), high: new Float64Array(), low: new Float64Array() };
const pathOf = (asks: number[], from = T0 + MIN): OptionPath => ({ at: Float64Array.from(asks.map((_, i) => from + i * MIN)), ask: Float64Array.from(asks) });
const perpOf = (bars: [number, number][], from = T0 + MIN): PerpPath => ({
  at: Float64Array.from(bars.map((_, i) => from + i * MIN)), high: Float64Array.from(bars.map((b) => b[0])), low: Float64Array.from(bars.map((b) => b[1])),
});
const TRADE = { enteredAt: T0 + 5_000, entry: 10, dir: 1 as const, closeAt: T0 + 60 * MIN, perpSl: 84_000, perpTgt: 85_000 };
const rules = (r: Partial<ReplayRules>): ReplayRules => ({ ...LIVE_RULES, ...r });

test('the option TGT buys back at the target, a resting limit, at the first quote at or under it', () => {
  const x = replayExit(TRADE, rules({ targetPct: 0.9 }), pathOf([9, 5, 2, 0.8, 0.5]), NO_PERP);
  assert.deepEqual(x, { at: T0 + 4 * MIN, price: 1, why: 'option-tgt' });
});

test('the option SL buys back at the quote that reached it -- a gap past it is paid', () => {
  const x = replayExit(TRADE, rules({ stopPct: 2.5 }), pathOf([12, 20, 40, 30]), NO_PERP);
  assert.deepEqual(x, { at: T0 + 3 * MIN, price: 40, why: 'option-sl' });
  // 0 is none: held to the last quote by the close.
  assert.deepEqual(replayExit(TRADE, rules({ stopPct: 0 }), pathOf([12, 20, 40, 30]), NO_PERP), { at: T0 + 4 * MIN, price: 30, why: 'close' });
});

test('the perp crossing the signal\'s SL buys back at the next quote, unless the perp SL is skipped', () => {
  const path = pathOf([10, 11, 13, 9]);
  // A buy signal: its SL is under the perp. The second minute's low goes through it.
  const perp = perpOf([[84_300, 84_100], [84_200, 83_950], [84_100, 84_000], [84_100, 84_000]]);
  assert.deepEqual(replayExit(TRADE, rules({ skipPerpSl: false }), path, perp), { at: T0 + 3 * MIN, price: 13, why: 'perp-sl' });
  assert.equal(replayExit(TRADE, rules({ skipPerpSl: true }), path, perp)?.why, 'close');
  // A sell signal (a CE sold) reads the other way: its SL is over the perp, its TGT under.
  const sell = { ...TRADE, dir: -1 as const, perpSl: 85_000, perpTgt: 84_000 };
  assert.equal(replayExit(sell, rules({ skipPerpSl: false, skipPerpTgt: false }), path, perp)?.why, 'perp-tgt');
});

test('the perp TGT, when it is not skipped; the minute the fill was in is not read', () => {
  const path = pathOf([10, 8, 7]);
  // The minute the entry filled inside reached the TGT before the fill: not counted. The third did: out at the quote after it.
  const perp = perpOf([[85_100, 84_500], [84_900, 84_500], [85_050, 84_600]], T0);
  assert.deepEqual(replayExit(TRADE, rules({ skipPerpTgt: false }), path, perp), { at: T0 + 3 * MIN, price: 7, why: 'perp-tgt' });
  const later = perpOf([[85_100, 84_500], [85_050, 84_600], [84_900, 84_500]], T0);
  assert.deepEqual(replayExit(TRADE, rules({ skipPerpTgt: false }), path, later), { at: T0 + 2 * MIN, price: 8, why: 'perp-tgt' });
});

test('nothing after the entry and by the close: nothing to replay on', () => {
  assert.equal(replayExit(TRADE, LIVE_RULES, pathOf([10, 9], T0 - 5 * MIN), NO_PERP), null);
  assert.equal(replayExit({ ...TRADE, closeAt: T0 }, LIVE_RULES, pathOf([10]), NO_PERP), null);
});

test('net after the charges on both fills, the fee capped at 3.5% of the premium plus GST', () => {
  // Sold 1 at 40, bought back at 4: 36 points of 0.001 BTC, less 3.5% × 1.18 of each premium.
  assert.ok(Math.abs(shortNetUsd(40, 4, 1) - (0.036 - 0.04 * 0.035 * 1.18 - 0.004 * 0.035 * 1.18)) < 1e-12);
});

test('a signal is sold at the strike nearest the money with a delta of at most 0.10 and a bid of at least $13', () => {
  const q = (strike: number, delta: number, bid: number, cp: 'C' | 'P' = 'P'): BoardQuote => ({ at: T0, symbol: `${cp}-${strike}`, cp, strike, bid, delta });
  const board = [q(84_400, -0.2, 90), q(84_000, -0.09, 39), q(83_800, -0.06, 20), q(83_600, -0.03, 9), q(85_600, 0.08, 30, 'C')];
  assert.equal(pickSignalStrike(board, 'P')?.strike, 84_000);
  assert.equal(pickSignalStrike(board, 'C')?.strike, 85_600);
  assert.equal(pickSignalStrike([q(83_600, -0.03, 9)], 'P'), null, 'under $13: nothing the strategies would sell');
});

test('the rules and the question are checked, in words', () => {
  assert.equal(rulesProblem(LIVE_RULES), null);
  assert.match(rulesProblem(rules({ stopPct: 25 }))!, /option SL/);
  assert.match(rulesProblem(rules({ targetPct: 1 }))!, /option TGT/);
  const now = Date.UTC(2026, 10, 3, 6, 0);
  const a = replayAskOf({}, now);
  assert.ok(typeof a !== 'string');
  assert.deepEqual([a.from, a.to, a.rules, a.window, a.tfs], ['2026-10-28', '2026-11-03', LIVE_RULES, null, null]);
  const b = replayAskOf({ from: '2026-10-01', to: '2026-10-31', skipPerpSl: '0', sl: '150', tgt: '95', tf: '5m,chain', fromTime: '07:00', toTime: '11:00' }, now);
  assert.ok(typeof b !== 'string');
  assert.deepEqual(b.rules, { skipPerpSl: false, skipPerpTgt: true, stopPct: 1.5, targetPct: 0.95 });
  assert.deepEqual(b.tfs, ['5m', 'chain']);
  assert.deepEqual(b.window, { from: 13 * 60 + 30, to: 17 * 60 + 30 });
  assert.match(replayAskOf({ from: '2026-09-01', to: '2026-10-31' }, now) as string, /At most 31 days/);
  assert.match(replayAskOf({ tgt: '100' }, now) as string, /option TGT/);
  assert.match(replayAskOf({ from: '2026-10-05', to: '2026-10-01' }, now) as string, /start date/);
  assert.equal((replayAskOf({ source: 'signals' }, now) as { source: string }).source, 'signals');
  assert.match(replayAskOf({ source: 'all' }, now) as string, /source/);
  assert.deepEqual((replayAskOf({ day: '2026-11-01', show: 'worse', offset: '200', limit: '200' }, now) as { list: object }).list, { day: '2026-11-01', show: 'worse', offset: 200, limit: 200 });
  assert.match(replayAskOf({ day: '2026-09-01' }, now) as string, /day of the range/);
  assert.match(replayAskOf({ show: 'best' }, now) as string, /Show must be/);
  assert.match(replayAskOf({ limit: '5000' }, now) as string, /page holds/);
});

// ------------------------------------------------------------ one expiry day through the database

const dayBefore = (d: string) => new Date(Date.parse(`${d}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
const DAY = new Date(Date.parse(`${sessionDayOf(Date.now())}T00:00:00Z`) - 3 * 86_400_000).toISOString().slice(0, 10);
const SPAN = sessionOf(DAY);
const ENTRY_AT = SPAN.from + 16 * 60 * MIN; // 9:30 AM IST
const SYMBOL = `P-BTC-84000-${DAY.slice(8, 10)}${DAY.slice(5, 7)}${DAY.slice(2, 4)}`;
const TRIGGER = Math.floor((ENTRY_AT - 2 * MIN) / 1000);

before(async () => {
  await initTradingService();
  await initStrategyStore();
  await Promise.all([optionSnapshotsSchema(), flowSchema(), entrySchema(), methodsSchema()]);
  await query('TRUNCATE trade_flow_1m, entry_setups, option_snapshots, option_snapshots_1m');
  await query('DELETE FROM trades');
  // The put decays 40 → 4 over an hour after the entry; the perp dips through the signal's SL at the 20th minute.
  for (let i = 1; i <= 60; i++) {
    const at = ENTRY_AT - (ENTRY_AT % MIN) + i * MIN;
    const ask = 40 - (36 * i) / 60;
    await query(`INSERT INTO option_snapshots_1m (at, symbol, expiry, cp, strike, ask, mark) VALUES ($1, $2, $3, 'P', 84000, $4, $4)`, [at, SYMBOL, DAY, ask]);
    const low = i === 20 ? 84_390 : 84_450;
    await query(`INSERT INTO trade_flow_1m (at, buy_volume, sell_volume, buy_count, sell_count, large_buy_volume, large_sell_volume, high, low)
                 VALUES ($1, 1, 1, 1, 1, 0, 0, 84600, $2)`, [at, low]);
  }
  // Two signals that filled half a minute before the entry: the desk traded the first; the second (nr7) it did not.
  for (const method of ['pullback', 'nr7']) {
    await query(`INSERT INTO entry_setups (method, mode, tf, dir, trigger_at, first_seen, entry_lo, entry_hi, stop, tp1, rr, graded_to, filled_at, fill_price)
                 VALUES ($2, 'single', '5m', 1, $1, $1, 84500, 84520, 84400, 85000, 1.5, $1, $3, 84510)`, [TRIGGER, method, ENTRY_AT / 1000 - 30]);
  }
  // The board at the minute after the fills: the put at 84,000 is the nearest the money inside 0.10.
  for (const [strike, delta, bid] of [[84_400, -0.2, 90], [84_000, -0.09, 39], [83_600, -0.04, 15]] as const) {
    await query(`INSERT INTO option_snapshots_1m (at, symbol, expiry, cp, strike, bid, ask, mark, delta) VALUES ($1, $2, $3, 'P', $4, $5, $5, $5, $6)`,
      [ENTRY_AT, SYMBOL.replace('84000', String(strike)), `${DAY.slice(8, 10)}${DAY.slice(5, 7)}${DAY.slice(2, 4)}`, strike, bid, delta]);
  }
  const plan = {
    action: 'sell', origin: 'strategy', symbol: SYMBOL, strategyId: 's-5m', strategyName: '5m time',
    signal: { tf: '5m', dir: 1, mode: 'single', method: 'pullback', triggerTime: TRIGGER },
    expect: { strike: 84000, expiryTs: SPAN.to / 1000, optionSide: 'PE' }, underlying: { dir: 1, stop: null, entry: 84510, target: null },
  };
  const state = {
    phase: 'flat', contractValue: 0.001, exitWinner: 'take_profit',
    fills: [{ ts: ENTRY_AT, role: 'entry', side: 'sell', size: 2, price: 40 }, { ts: ENTRY_AT + 59 * MIN, role: 'take_profit', side: 'buy', size: 2, price: 4 }],
  };
  await query(`INSERT INTO trades (trade_id, symbol, phase, position, plan, state, updated_at, broker_account_id) VALUES ('t1', $1, 'flat', 0, $2, $3, $4, NULL)`,
    [SYMBOL, JSON.stringify(plan), JSON.stringify(state), ENTRY_AT + 59 * MIN]);
  // A row of the journal's older shape, before 5 Oct 2026: no \`action\` -- sold, by its entry fill. Another strategy's, on the same signal.
  const { action: _, ...older } = plan;
  await query(`INSERT INTO trades (trade_id, symbol, phase, position, plan, state, updated_at, broker_account_id) VALUES ('t0', $1, 'flat', 0, $2, $3, $4, NULL)`,
    [SYMBOL, JSON.stringify({ ...older, strategyId: 's-old' }), JSON.stringify({ ...state, fills: [{ ...state.fills[0], ts: ENTRY_AT + 1_000 }, state.fills[1]] }), ENTRY_AT + 59 * MIN]);
  clearOptionReplayCache();
});
after(async () => { tradingService().stop(); await closePool(); });

const ask = (r: Partial<ReplayRules>, more: Partial<Parameters<typeof optionReplay>[0]> = {}) =>
  optionReplay({ from: dayBefore(DAY), to: DAY, window: null, tfs: null, methods: null, account: null, rules: rules(r), now: Date.now(), ...more });

test('a real trade replayed: as live it is held, with the perp SL it is out at the 21st minute', async () => {
  const live = await ask({ targetPct: 0 });
  assert.equal(live.replay.trades, 2, 'the older row as well');
  // Every day asked for has its line: the day before, with no trade, too.
  assert.deepEqual(live.days.map((d) => [d.key, d.trades]), [[DAY, 2], [dayBefore(DAY), 0]]);
  const row = live.rows.find((r) => r.tradeId === 't1');
  assert.equal(row!.replay.why, 'close');
  assert.equal(row!.replay.exit, 4);
  assert.equal(row!.perpSl, 84_400, 'the signal\'s own SL, the desk having left it out');
  assert.equal(row!.actual.why, 'option-tgt');
  assert.ok(Math.abs(row!.actual.netUsd - shortNetUsd(40, 4, 2)) < 1e-12);

  const withSl = await ask({ skipPerpSl: false, targetPct: 0 });
  const r = withSl.rows.find((x) => x.tradeId === 't1')!;
  assert.equal(r.replay.why, 'perp-sl');
  assert.equal(r.replay.exit, 40 - (36 * 21) / 60);
  assert.ok(Math.abs(withSl.replay.netUsd - 2 * shortNetUsd(40, r.replay.exit!, 2)) < 1e-12);
  assert.equal(withSl.exits['perp-sl'], 2);
  assert.deepEqual(withSl.timeframes.map((d) => d.key), ['5m']);
  // By the hour entered (9:30 AM IST: the 9 AM hour) and by method in it; the one day, made money on (out at 27.4 of 40).
  assert.deepEqual(withSl.hours.map((g) => [g.key, g.name, g.trades, g.daysUp, g.daysDown]), [['09', '9 AM', 2, 1, 0]]);
  assert.deepEqual(withSl.slots.map((g) => [g.key, g.name, g.trades, g.daysUp]), [['pullback|09', '#9 Pullback · 9 AM', 2, 1]]);
  // An option SL of 1%: out at the first quote over 40.4 -- a loss -- so the day is one lost on.
  assert.deepEqual((await ask({ stopPct: 0.01, targetPct: 0 })).hours.map((g) => [g.daysUp, g.daysDown]), [[0, 1]]);
  // Out at 27.4 against the real 4: both trades the worse for it.
  assert.deepEqual([withSl.better, withSl.worse, withSl.methods[0]!.worse], [0, 2, 2]);

  // One contract each: the real trade's net is halved -- the charges are a share of the premium -- and the replay is of one.
  const one = await ask({ skipPerpSl: false, targetPct: 0 }, { oneContract: true });
  assert.ok(Math.abs(one.actual.netUsd - 2 * shortNetUsd(40, 4, 1)) < 1e-12);
  assert.ok(Math.abs(one.replay.netUsd - 2 * shortNetUsd(40, r.replay.exit!, 1)) < 1e-12);
  assert.equal(one.rows[0]!.contracts, 1);
});

test('the filters: a timeframe, a method and hours with none of it leave nothing', async () => {
  assert.equal((await ask({}, { tfs: ['15m'] })).replay.trades, 0);
  assert.equal((await ask({}, { tfs: ['5m'] })).replay.trades, 2);
  assert.equal((await ask({}, { methods: ['nr7'] })).replay.trades, 0);
  // 9:30 AM is the 960th minute of the expiry day; 10:00 to 11:00 AM leaves it out.
  assert.equal((await ask({}, { window: { from: 990, to: 1050 } })).replay.trades, 0);
  assert.equal((await ask({}, { window: { from: 900, to: 1000 } })).replay.trades, 2);
});

test('every signal: each filled one sold at the strategies\' strike, one contract, the desk\'s first order beside it', async () => {
  const x = await ask({ targetPct: 0 }, { source: 'signals' });
  assert.equal(x.source, 'signals');
  assert.equal(x.replay.trades, 2);
  assert.equal(x.traded, 1, 'the desk traded pullback, not nr7');
  const byMethod = new Map(x.rows.map((r) => [r.method, r]));
  const p = byMethod.get('pullback')!, n = byMethod.get('nr7')!;
  assert.deepEqual([p.symbol, p.entry, p.contracts, p.enteredAt], [SYMBOL, 39, 1, ENTRY_AT]);
  assert.equal(n.actual, null);
  assert.ok(Math.abs(p.actual!.netUsd - shortNetUsd(40, 4, 1)) < 1e-12, 'the first order, at one contract');
  assert.ok(Math.abs(x.actual.netUsd - p.actual!.netUsd) < 1e-12, 'the real side counts the traded signal alone');
  assert.deepEqual(x.accounts, []);
  // A method filter narrows the signals as it does the orders.
  assert.equal((await ask({}, { source: 'signals', methods: ['nr7'] })).replay.trades, 1);
  // No account's rules: an account named does not narrow the signals, nor the orders set beside them.
  const acct = await ask({ targetPct: 0 }, { source: 'signals', account: 99 });
  assert.deepEqual([acct.replay.trades, acct.traded], [2, 1]);
});

test('the list: a page at a time, of a day or all, by profit / loss / better / worse; and every trade as a spreadsheet', async () => {
  const page1 = await ask({ skipPerpSl: false, targetPct: 0 }, { list: { day: null, show: 'all', offset: 0, limit: 1 } });
  const page2 = await ask({ skipPerpSl: false, targetPct: 0 }, { list: { day: null, show: 'all', offset: 1, limit: 1 } });
  assert.deepEqual([page1.rowsTotal, page1.rows.length, page2.rows.length], [2, 1, 1]);
  assert.notEqual(page1.rows[0]!.tradeId, page2.rows[0]!.tradeId);
  assert.equal((await ask({ skipPerpSl: false, targetPct: 0 }, { list: { day: null, show: 'worse', offset: 0, limit: 10 } })).rowsTotal, 2);
  assert.equal((await ask({ skipPerpSl: false, targetPct: 0 }, { list: { day: null, show: 'better', offset: 0, limit: 10 } })).rowsTotal, 0);
  assert.equal((await ask({}, { list: { day: dayBefore(DAY), show: 'all', offset: 0, limit: 10 } })).rowsTotal, 0);
  const r = page1.rows[0]!;
  assert.equal(onList({ ...r, actual: null }, 'worse'), false, 'a signal not traded is neither better nor worse');
  const csv = optionReplayCsv(page1.rows).split('\n');
  assert.match(csv[0]!, /^expiry_day,entered_ist,account,/);
  assert.match(csv[1]!, new RegExp(`^${DAY},.*,${SYMBOL},2,40,84400,85000,.*,option-tgt,.*,perp-sl,`));
});
