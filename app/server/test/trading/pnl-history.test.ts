import { test } from 'node:test';
import assert from 'node:assert/strict';
import { daysCsv, daysReport, mtmStats, type MtmSample } from '../../src/trading/pnl-history.js';
import { PgTradeStore } from '../../src/trading/store.js';
import { SettingsCache } from '../../src/db/settings.js';
import { closePool } from '../../src/db/pool.js';
import { initialTrade } from '../../src/trading/machine.js';
import type { TradeRecord } from '../../src/trading/engine.js';
import type { Fill } from '../../src/trading/types.js';

/**
 * The record as a calendar.
 *
 * What must not happen: a day's money moving to another day when a trade is
 * looked at again, or the days adding up to something other than the trades.
 * Both are pinned by attributing every dollar to the fill that booked it.
 */

// 2026-09-11 IST begins at 2026-09-10T18:30Z
const T = (day: number, hourIst: number) => Date.UTC(2026, 8, day - 1, 18, 30) + hourIst * 3_600_000;

const fill = (role: string, size: number, price: number, ts: number): Fill =>
  ({ orderId: `o${ts}`, role, side: role === 'entry' ? 'sell' : 'buy', size, price, ts } as Fill);

const record = (id: string, fills: Fill[]): TradeRecord => ({
  state: {
    ...initialTrade({ tradeId: id, symbol: 'C-BTC-80000-120926', productId: 1, optionSide: 'CE', requestedSize: 100, at: fills[0]!.ts }),
    fills, position: 0, phase: 'flat', contractValue: 0.001,
  },
  plan: {
    tradeId: id, symbol: 'C-BTC-80000-120926', optionSide: 'CE', lots: 100, leverage: 200,
    entry: { type: 'limit', limitPrice: 15, timeoutMs: 0, marketFallback: false, chase: null },
    takeProfitPrice: 1, stopPrice: null,
    expect: { underlying: 'BTC', optionSide: 'CE', strike: 80_000, expiryTs: 1 },
  },
  events: [],
});

test('[critical] money is booked on the day of the fill that booked it', () => {
  // Sold Friday night, bought back Monday morning: Monday's money.
  const rec = record('t1', [fill('entry', 100, 15, T(11, 23)), fill('take_profit', 100, 1, T(14, 6))]);
  const r = daysReport([rec], { from: '2026-09-01', to: '2026-09-30', spot: 80_000 });
  assert.deepEqual(r.days.map((d) => d.day), ['2026-09-11', '2026-09-14']);
  const [fri, mon] = r.days;
  assert.equal(fri!.realisedUsd, 0, 'nothing was anybody\'s on Friday');
  assert.ok(fri!.chargesUsd > 0, 'but the entry was charged on Friday');
  assert.equal(mon!.realisedUsd, (15 - 1) * 100 * 0.001, 'Monday booked the whole gain');
});

test('[critical] a bought trade is booked the buyer\'s way: sold for less than it cost is a loss, not a profit of the same size', () => {
  // Bought 1 at 46 and sold at 9 (the BUY account, 5 Oct 2026): a loss of 37 a contract.
  const buy = (role: string, size: number, price: number, ts: number): Fill =>
    ({ orderId: `b${ts}`, role, side: role === 'entry' ? 'buy' : 'sell', size, price, ts } as Fill);
  const lost = record('long-1', [buy('entry', 1, 46, T(11, 7)), buy('exit', 1, 9, T(11, 9))]);
  const won = record('long-2', [buy('entry', 10, 40, T(11, 8)), buy('take_profit', 10, 180, T(11, 10))]);
  const r = daysReport([lost, won], { from: '2026-09-11', to: '2026-09-11', spot: 80_000 });
  const d = r.days[0]!;
  assert.ok(Math.abs(d.lossUsd - (46 - 9) * 1 * 0.001) < 1e-12, 'the loss, as a loss');
  assert.ok(Math.abs(d.profitUsd - (180 - 40) * 10 * 0.001) < 1e-12, 'the gain, as a gain');
  assert.ok(Math.abs(d.realisedUsd - (d.profitUsd - d.lossUsd)) < 1e-12);
  // A sold trade beside them is booked as it always was.
  const short = record('short-1', [fill('entry', 100, 15, T(11, 7)), fill('stop_loss', 100, 20, T(11, 8))]);
  const mixed = daysReport([lost, short], { from: '2026-09-11', to: '2026-09-11', spot: 80_000 }).days[0]!;
  assert.ok(Math.abs(mixed.lossUsd - (0.037 + (20 - 15) * 100 * 0.001)) < 1e-12);
  assert.equal(mixed.profitUsd, 0);
});

test('[critical] a day\'s profit and its loss are both kept: a winner and a loser do not cancel into their difference', () => {
  const win = record('w', [fill('entry', 100, 15, T(11, 7)), fill('take_profit', 100, 5, T(11, 9))]);
  const lose = record('l', [fill('entry', 100, 15, T(11, 7)), fill('stop_loss', 100, 22, T(11, 10))]);
  const d = daysReport([win, lose], { from: '2026-09-11', to: '2026-09-11', spot: 80_000 }).days[0]!;
  assert.deepEqual([d.profitUsd, d.lossUsd].map((x) => Math.round(x * 1e6) / 1e6), [1, 0.7]);
  assert.ok(Math.abs(d.realisedUsd - 0.3) < 1e-9);
  assert.ok(Math.abs(d.netUsd - (d.profitUsd - d.lossUsd - d.chargesUsd)) < 1e-12);
});

test('[critical] the days add up to the trades', () => {
  // Two buy-backs on two days: each day gets its piece, and the pieces are the
  // trade's realised total to the cent.
  const rec = record('t1', [
    fill('entry', 100, 15, T(11, 7)),
    fill('take_profit', 40, 5, T(11, 12)),
    fill('take_profit', 60, 1, T(12, 9)),
  ]);
  const r = daysReport([rec], { from: '2026-09-01', to: '2026-09-30', spot: 80_000 });
  const total = r.days.reduce((n, d) => n + d.realisedUsd, 0);
  assert.ok(Math.abs(total - ((15 - 5) * 40 + (15 - 1) * 60) * 0.001) < 1e-9);
  assert.equal(r.totals.tradingDays, 2);
  assert.equal(r.days[1]!.cumulativeUsd, total - r.totals.chargesUsd, 'the running line ends on the total, net of charges');
});

test('an add is in the average the buy-backs are judged against', () => {
  // 100 @ 15 then 100 more @ 5: average 10. Bought back at 1 -> 9 per BTC.
  const rec = record('t1', [
    fill('entry', 100, 15, T(11, 7)), fill('entry', 100, 5, T(11, 9)), fill('take_profit', 200, 1, T(11, 15)),
  ]);
  const r = daysReport([rec], { from: '2026-09-11', to: '2026-09-11', spot: 80_000 });
  assert.ok(Math.abs(r.days[0]!.realisedUsd - 9 * 200 * 0.001) < 1e-9);
});

test('the range is a filter on days, and the totals name the best and worst', () => {
  const a = record('a', [fill('entry', 100, 15, T(11, 7)), fill('take_profit', 100, 1, T(11, 15))]);
  const b = record('b', [fill('entry', 100, 15, T(12, 7)), fill('stop_loss', 100, 30, T(12, 15))]);
  const r = daysReport([a, b], { from: '2026-09-12', to: '2026-09-12', spot: 80_000 });
  assert.deepEqual(r.days.map((d) => d.day), ['2026-09-12']);
  assert.equal(r.totals.lossDays, 1);
  assert.equal(r.totals.worst?.day, '2026-09-12');
  const both = daysReport([a, b], { from: '2026-09-01', to: '2026-09-30', spot: 80_000 });
  assert.equal(both.totals.best?.day, '2026-09-11');
  assert.equal(both.totals.winDays, 1);
});

test('an empty range is an empty report, not an error', () => {
  const r = daysReport([], { from: '2026-09-01', to: '2026-09-30', spot: null });
  assert.deepEqual(r.days, []);
  assert.equal(r.totals.best, null);
  assert.equal(r.totals.netUsd, 0);
});

test('the spreadsheet has a header and one line per day, to the cent', () => {
  const rec = record('t1', [fill('entry', 100, 15, T(11, 7)), fill('take_profit', 100, 1, T(11, 15))]);
  const csv = daysCsv(daysReport([rec], { from: '2026-09-11', to: '2026-09-11', spot: 80_000 }));
  const [head, row, rest] = csv.split('\n');
  assert.equal(head, 'day,trades,realised_usd,charges_usd,net_usd,cumulative_usd');
  assert.match(row!, /^2026-09-11,1,1\.40,/);
  assert.equal(rest, '');
});

// ---------------------------------------------------------------- the line

const s = (minute: number, netUsd: number): MtmSample =>
  ({ at: T(14, 6) + minute * 60_000, day: '2026-09-14', realisedUsd: 0, unrealisedUsd: netUsd, chargesUsd: 0, netUsd });

test('[critical] drawdown is the fall from a high, not the low itself', () => {
  // Opened at -8, climbed to +6, fell to +2, closed +4. The minimum is -8 and
  // nothing fell to get there; the worst fall is 6 -> 2.
  const st = mtmStats([s(0, -8), s(1, -3), s(2, 6), s(3, 2), s(4, 4)]);
  assert.equal(st.min?.netUsd, -8);
  assert.equal(st.max?.netUsd, 6);
  assert.equal(st.maxDrawdown?.usd, 4);
  assert.equal(st.maxDrawdown?.at, s(3, 0).at, 'and it says when it bottomed');
  assert.equal(st.nowUsd, 4);
});

test('a day that only fell draws down its whole fall', () => {
  const st = mtmStats([s(0, 5), s(1, 1), s(2, -9)]);
  assert.equal(st.maxDrawdown?.usd, 14);
});

test('no samples is no statistics, not zeros', () => {
  assert.deepEqual(mtmStats([]), { nowUsd: null, min: null, max: null, maxDrawdown: null });
});

test('[critical] the store keeps the line, per day, oldest first, and prunes old days', async () => {
  await new SettingsCache().load();
  const store = await PgTradeStore.open();
  try {
    await store.sampleMtm(s(1, 3));
    await store.sampleMtm(s(0, -2));
    await store.sampleMtm(s(1, 999));   // the same millisecond again: ignored, never overwritten
    await store.sampleMtm({ ...s(0, 1), at: T(1, 6), day: '2026-09-01' });
    assert.deepEqual((await store.mtmSamples('2026-09-14')).map((x) => x.netUsd), [-2, 3]);
    assert.deepEqual(await store.mtmDays(), ['2026-09-14', '2026-09-01']);
    assert.equal(await store.pruneMtm(T(14, 6) + 10 * 86_400_000, 12), 1, 'the 1 Sep reading is past twelve days');
    assert.deepEqual(await store.mtmDays(), ['2026-09-14']);
  } finally {
    await closePool();
  }
});

// ------------------------------------------------------------ trade statistics (6 Oct 2026)

const { tradeStats, closedNet } = await import('../../src/trading/pnl-history.js');

const tagged = (rec: TradeRecord, strategyId: string | undefined, accountId: number | null): TradeRecord =>
  ({ ...rec, plan: { ...rec.plan, strategyId, accountId } });

test('[critical] statistics count each closed trade once, on its closing day, after every charge', () => {
  const win = tagged(record('w', [fill('entry', 100, 15, T(11, 7)), fill('take_profit', 100, 5, T(11, 9))]), 's1', 1);
  const lose = tagged(record('l', [fill('entry', 100, 15, T(11, 7)), fill('stop_loss', 100, 22, T(11, 10))]), 's1', 1);
  const hand = tagged(record('h', [fill('entry', 100, 15, T(12, 7)), fill('take_profit', 100, 10, T(12, 9))]), undefined, 2);
  const r = tradeStats([win, lose, hand], { from: '2026-09-11', to: '2026-09-12', spot: 80_000 });
  const nets = [win, lose, hand].map((x) => closedNet(x, 80_000)!.netUsd);
  assert.ok(nets[0]! < (15 - 5) * 0.1 && nets[0]! > 0, 'the gain, less its charges');
  assert.equal(r.overall.trades, 3);
  assert.equal(r.overall.wins, 2);
  assert.equal(r.overall.losses, 1);
  assert.ok(Math.abs(r.overall.winRate! - 2 / 3) < 1e-12);
  assert.ok(Math.abs(r.overall.grossLossUsd + nets[1]!) < 1e-12, 'the loss, as a positive number');
  assert.ok(Math.abs(r.overall.profitFactor! - (nets[0]! + nets[2]!) / -nets[1]!) < 1e-12);
  assert.ok(Math.abs(r.overall.netUsd - nets.reduce((a, n) => a + n, 0)) < 1e-12);
  assert.deepEqual(r.byStrategy.map((g) => [g.key, g.trades]).sort(), [['manual', 1], ['s1', 2]]);
  assert.deepEqual(r.byAccount.map((g) => [g.key, g.trades]).sort(), [['1', 2], ['2', 1]]);
});

test('statistics leave out a trade still open, and one that closed outside the range', () => {
  const open = record('o', [fill('entry', 100, 15, T(11, 7))]);
  open.state.position = -100;
  open.state.phase = 'protected';
  const before = record('b', [fill('entry', 100, 15, T(9, 7)), fill('take_profit', 100, 5, T(9, 9))]);
  // Opened before the range and closed inside it: counted, on the day it closed.
  const across = record('x', [fill('entry', 100, 15, T(10, 23)), fill('take_profit', 100, 5, T(11, 6))]);
  const r = tradeStats([open, before, across], { from: '2026-09-11', to: '2026-09-11', spot: 80_000 });
  assert.equal(closedNet(open, 80_000), null);
  assert.equal(r.overall.trades, 1);
});

test('with no losing trade there is no profit factor, rather than an infinite one; with none at all, no rates', () => {
  const win = record('w', [fill('entry', 100, 15, T(11, 7)), fill('take_profit', 100, 5, T(11, 9))]);
  assert.equal(tradeStats([win], { from: '2026-09-11', to: '2026-09-11', spot: 80_000 }).overall.profitFactor, null);
  const none = tradeStats([], { from: '2026-09-11', to: '2026-09-11', spot: 80_000 }).overall;
  assert.deepEqual([none.trades, none.winRate, none.avgWinUsd, none.bestUsd], [0, null, null, null]);
});

test('statistics also split by CE / PE, sold / bought, and a signal trade\'s entry method', () => {
  const sig = { method: 'breakout', n: 1, name: 'Breakout', mode: 'single' as const, tf: '5m', dir: 1 as const, triggerTime: 0 };
  const ce = record('c', [fill('entry', 100, 15, T(11, 7)), fill('take_profit', 100, 5, T(11, 9))]);
  const pe = { ...record('p', [fill('entry', 100, 15, T(11, 7)), fill('stop_loss', 100, 22, T(11, 10))]) };
  pe.state = { ...pe.state, optionSide: 'PE' };
  pe.plan = { ...pe.plan, signal: sig };
  const r = tradeStats([ce, pe], { from: '2026-09-11', to: '2026-09-11', spot: 80_000 });
  assert.deepEqual(r.byOption.map((g) => [g.key, g.trades, g.wins]).sort(), [['CE', 1, 1], ['PE', 1, 0]]);
  assert.deepEqual(r.byAction.map((g) => [g.key, g.trades]), [['sell', 2]]);
  assert.deepEqual(r.byMethod.map((g) => [g.key, g.trades, g.losses]), [['breakout', 1, 1]]);
});

test('statistics pair a method with the timeframe it was read on: the same method on two timeframes is two pairs', () => {
  const sig = (tf: string, mode: 'mtf' | 'single' = 'single') => ({ method: 'breakout', n: 1, name: 'Breakout', mode, tf, dir: 1 as const, triggerTime: 0 });
  const on = (id: string, signal: ReturnType<typeof sig> | undefined, exit: number) => {
    const rec = record(id, [fill('entry', 100, 15, T(11, 7)), fill(exit < 15 ? 'take_profit' : 'stop_loss', 100, exit, T(11, 9))]);
    return { ...rec, plan: { ...rec.plan, signal } };
  };
  const r = tradeStats(
    [on('a', sig('15m'), 5), on('b', sig('15m'), 5), on('c', sig('30m'), 22), on('d', sig('5m', 'mtf'), 5), on('e', sig('5m'), 22), on('hand', undefined, 5)],
    { from: '2026-09-11', to: '2026-09-11', spot: 80_000 },
  );
  // Best first, by what the pair made; the trade by hand is in no pair.
  assert.deepEqual(r.byPair.map((g) => [g.key, g.trades, g.wins]), [
    ['breakout|single|15m', 2, 2], ['breakout|mtf|5m', 1, 1], ['breakout|single|30m', 1, 0], ['breakout|single|5m', 1, 0],
  ]);
  assert.equal(r.byPair.reduce((n, g) => n + g.trades, 0), r.overall.trades - 1);
  assert.equal(r.byMethod[0]!.trades, 5);
});
