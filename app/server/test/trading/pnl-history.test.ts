import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { daysCsv, daysReport, mtmStats, type MtmSample } from '../../src/trading/pnl-history.js';
import { SqliteTradeStore } from '../../src/trading/store.js';
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

test('[critical] the store keeps the line, per day, oldest first, and prunes old days', () => {
  const store = new SqliteTradeStore(join(mkdtempSync(join(tmpdir(), 'mtm-')), 'trades.db'));
  store.sampleMtm(s(1, 3));
  store.sampleMtm(s(0, -2));
  store.sampleMtm(s(1, 999));   // the same millisecond again: ignored, never overwritten
  store.sampleMtm({ ...s(0, 1), at: T(1, 6), day: '2026-09-01' });
  assert.deepEqual(store.mtmSamples('2026-09-14').map((x) => x.netUsd), [-2, 3]);
  assert.deepEqual(store.mtmDays(), ['2026-09-14', '2026-09-01']);
  assert.equal(store.pruneMtm(T(14, 6) + 10 * 86_400_000, 12), 1, 'the 1 Sep reading is past twelve days');
  assert.deepEqual(store.mtmDays(), ['2026-09-14']);
});
