import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Candle } from '../../src/market/delta.js';
import { FILL_WITHIN_BARS, HOLD_BARS, entryRecord, gradeRow, gradeSetups, rNetOf, recordSetups, statsOf, type PaperRow } from '../../src/entry/paper.js';
import type { MethodRead } from '../../src/entry/types.js';
import { closePool, rows } from '../../src/db/pool.js';

after(closePool);

/**
 * The paper log, graded the way a resting limit would have gone -- and never
 * in the setup's favour where a candle cannot say which came first.
 */

const T = 1_790_035_200;
const minute = (k: number, o: number, h: number, l: number, c: number): Candle => ({ time: T + 60 * k, open: o, high: h, low: l, close: c, volume: 1 });

/** A long: enter 84,000-84,010, stop 83,900, TP1 84,300, triggered on the 5m bar at T. */
const long = (over: Partial<PaperRow> = {}): PaperRow => ({
  dir: 1, tf: '5m', triggerAt: T, firstSeen: (T + 300) * 1000,
  entryLo: 84_000, entryHi: 84_010, stop: 83_900, tp1: 84_300,
  status: 'open', filledAt: null, fillPrice: null, exitAt: null, exitPrice: null, rNet: null, gradedTo: T + 240, ...over,
});

test('[critical] fills at the zone, then TP1: closed at the target, R after fees', () => {
  const r = gradeRow(long(), [
    minute(5, 84_050, 84_060, 84_005, 84_020),   // trades into the zone: filled at 84,010
    minute(6, 84_020, 84_310, 84_015, 84_290),   // through TP1
  ]);
  assert.equal(r.status, 'tp1');
  assert.equal(r.fillPrice, 84_010);
  assert.equal(r.exitPrice, 84_300);
  assert.equal(r.rNet, rNetOf(1, 84_010, 84_300, 83_900));
  assert.ok(r.rNet! < (84_300 - 84_010) / 110, 'the fees come off');
});

test('[critical] a bar touching both the stop and TP1 is the stop -- the reading that cannot flatter the record', () => {
  const r = gradeRow(long(), [minute(5, 84_050, 84_060, 84_005, 84_020), minute(6, 84_020, 84_320, 83_880, 84_000)]);
  assert.equal(r.status, 'stop');
  assert.ok(r.rNet! < -1, 'a full R and the fees');
});

test('[critical] in the fill bar only the stop counts', () => {
  const r = gradeRow(long(), [minute(5, 84_050, 84_320, 83_880, 84_100)]);
  assert.equal(r.status, 'stop');
});

test('[critical] a gap through the stop fills at the open, not at the stop', () => {
  const r = gradeRow(long(), [minute(5, 84_050, 84_060, 84_005, 84_020), minute(6, 83_850, 83_860, 83_800, 83_820)]);
  assert.equal(r.exitPrice, 83_850);
});

test('[critical] a price that gaps past the stop before the entry fills is not a trade: expired', () => {
  const r = gradeRow(long({ entryLo: 83_950, entryHi: 83_960 }), [minute(5, 84_050, 84_060, 84_040, 84_045), minute(6, 83_890, 83_895, 83_870, 83_880)]);
  assert.equal(r.status, 'expired', 'it opened under the stop: the setup was wrong before it was in');
});

test('an open inside the zone is a fill, and a stop in the same bar is a loss, not a miss', () => {
  const r = gradeRow(long({ entryLo: 83_950, entryHi: 83_960 }), [minute(5, 84_050, 84_060, 84_040, 84_045), minute(6, 83_950, 83_955, 83_880, 83_890)]);
  assert.equal(r.status, 'stop');
});

test(`an entry not reached within ${FILL_WITHIN_BARS} bars expires`, () => {
  const bars = Array.from({ length: 5 * (FILL_WITHIN_BARS + 1) + 2 }, (_, k) => minute(5 + k, 84_100, 84_110, 84_090, 84_100));
  assert.equal(gradeRow(long(), bars).status, 'expired');
});

test('[critical] the fill window runs from when the setup was on the board, not from its trigger bar', () => {
  // An FVG formed forty bars before price came back to it: its trigger is old, the setup is new.
  const old = long({ triggerAt: T - 40 * 300 });
  const r = gradeRow(old, [minute(5, 84_100, 84_110, 84_090, 84_100), minute(6, 84_100, 84_110, 84_090, 84_100), minute(7, 84_050, 84_060, 84_005, 84_020)]);
  assert.equal(r.status, 'filled', 'not expired on its first minute');
});

test('[critical] the minute the setup was seen in is not graded: it traded partly before the setup existed', () => {
  const r = gradeRow(long({ firstSeen: (T + 300) * 1000 + 20_000 }), [minute(5, 84_050, 84_060, 84_005, 84_020)]);
  assert.equal(r.status, 'open', 'a touch in that minute is not a fill');
});

test(`a filled trade still open after ${HOLD_BARS} bars is closed at the market`, () => {
  const bars = [minute(5, 84_050, 84_060, 84_005, 84_020),
    ...Array.from({ length: 5 * HOLD_BARS + 2 }, (_, k) => minute(6 + k, 84_100, 84_110, 84_090, 84_105))];
  const r = gradeRow(long(), bars);
  assert.equal(r.status, 'timeout');
  assert.equal(r.exitPrice, 84_105);
});

test('a short is the mirror', () => {
  const r = gradeRow(long({ dir: -1, entryLo: 84_290, entryHi: 84_300, stop: 84_400, tp1: 84_000 }), [
    minute(5, 84_250, 84_295, 84_240, 84_280), minute(6, 84_280, 84_285, 83_990, 84_010),
  ]);
  assert.equal(r.status, 'tp1');
  assert.equal(r.fillPrice, 84_290);
});

test('grading goes forward only: bars already graded are not read again', () => {
  const first = gradeRow(long(), [minute(5, 84_050, 84_060, 84_005, 84_020)]);
  const again = gradeRow(first, [minute(5, 84_050, 84_060, 83_000, 84_020)]);
  assert.equal(again.status, 'filled', 'the same minute, re-sent with a crash in it, is ignored');
});

// ------------------------------------------------------------ the table

const read = (over: Partial<MethodRead> = {}): MethodRead => ({
  id: 'breakout', n: 1, name: 'Breakout', group: 'breakout', summary: '', mode: 'single', tf: '5m', dir: 'long', state: 'TRADE',
  steps: [], gates: [], score: 70, scoreParts: [], alignment: null, reason: '', triggerTime: T,
  plan: { entryLo: 84_000, entryHi: 84_010, stop: 83_900, tp1: 84_300, tp2: null, tp3: null, tpWhy: [], rr: 2.1 },
  ...over,
});

test('[critical] a TRADE is written once, however many minutes it stays on the board; WAIT is not written', async () => {
  assert.equal(await recordSetups([read(), read({ mode: 'mtf' }), read({ state: 'WAIT', plan: null, id: 'bos' })], (T + 300) * 1000), 2);
  assert.equal(await recordSetups([read()], (T + 360) * 1000), 0, 'the same setup a minute later');
  await gradeSetups([minute(5, 84_050, 84_060, 84_005, 84_020), minute(6, 84_020, 84_310, 84_015, 84_290)]);
  const [x] = await rows<{ status: string; r_net: number }>("SELECT status, r_net FROM entry_setups WHERE mode = 'single'");
  assert.equal(x?.status, 'tp1');
  const { records, totals } = await entryRecord();
  assert.deepEqual(records.map((r) => [r.method, r.mode, r.trades, r.wins]), [['breakout', 'mtf', 1, 1], ['breakout', 'single', 1, 1]],
    'with the chain and without it, counted apart');
  assert.deepEqual(totals.map((t) => [t.mode, t.trades]).sort(), [['mtf', 1], ['single', 1]], 'and each mode totalled');
});

test('[critical] the record\'s figures: win rate, profit factor, and the deepest fall of the running total', () => {
  const s = statsOf([2, -1, -1, -1, 3, -1]);
  assert.equal(s.trades, 6);
  assert.equal(s.wins, 2);
  assert.equal(s.sumR, 1);
  assert.equal(s.profitFactor, 5 / 4);
  assert.equal(s.maxDrawdownR, -3, 'from +2 down to -1');
  assert.equal(s.avgWinR, 2.5);
  assert.equal(s.avgLossR, -1);
  assert.equal(statsOf([1, 2]).profitFactor, null, 'no loss to divide by');
  assert.equal(statsOf([]).trades, 0);
});
