import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Candle } from '../../src/market/delta.js';
import { FILL_WITHIN_BARS, HOLD_BARS, entryRecord, gradeRow, gradeSetups, rOf, recordSetups, statsOf, type PaperRow } from '../../src/entry/paper.js';
import type { MethodRead } from '../../src/entry/types.js';
import { closePool, query, rows } from '../../src/db/pool.js';
import { gatesOff, gateSettings, setGate, GateLocked } from '../../src/entry/gates.js';

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

test('[critical] fills at the zone, then TP1: closed at the target, R in plain points over risk', () => {
  const r = gradeRow(long(), [
    minute(5, 84_050, 84_060, 84_005, 84_020),   // trades into the zone: filled at 84,010
    minute(6, 84_020, 84_310, 84_015, 84_290),   // through TP1
  ]);
  assert.equal(r.status, 'tp1');
  assert.equal(r.fillPrice, 84_010);
  assert.equal(r.exitPrice, 84_300);
  assert.equal(r.rNet, rOf(1, 84_010, 84_300, 83_900));
  assert.equal(r.rNet, (84_300 - 84_010) / 110, 'no fee term');
});

test('[critical] a bar touching both the stop and TP1 is the stop -- the reading that cannot flatter the record', () => {
  const r = gradeRow(long(), [minute(5, 84_050, 84_060, 84_005, 84_020), minute(6, 84_020, 84_320, 83_880, 84_000)]);
  assert.equal(r.status, 'stop');
  assert.equal(r.rNet, -1, 'a full R at the stop, no fee term');
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

// ------------------------------------------------------------ TGT1 / TGT2 / TGT3: the runner after TP1

const FILL = minute(5, 84_050, 84_060, 84_005, 84_020); // filled at 84,010
const TP1 = minute(6, 84_020, 84_310, 84_015, 84_290);  // TP1 84,300

test('[critical] after TP1 the runner watches TP2 then TP3, its stop at breakeven; the record\'s R stays the TP1 exit', () => {
  const r = gradeRow(long({ tp2: 84_500, tp3: 84_700 }), [FILL, TP1,
    minute(7, 84_290, 84_520, 84_280, 84_510),   // TP2
    minute(8, 84_510, 84_710, 84_500, 84_700)]); // TP3
  assert.deepEqual([r.status, r.exitPrice, r.rNet], ['tp1', 84_300, (84_300 - 84_010) / 110], 'the record: out at TP1');
  assert.deepEqual([r.tp1At, r.tp2At, r.tp3At, r.runner, r.runnerEnd], [T + 360, T + 420, T + 480, 'done', 'tp3']);
});

test('[critical] a runner back to the fill is breakeven, and a bar touching breakeven and TP2 is breakeven', () => {
  const be = gradeRow(long({ tp2: 84_500, tp3: null }), [FILL, TP1, minute(7, 84_290, 84_300, 84_005, 84_100)]);
  assert.deepEqual([be.tp2At, be.runner, be.runnerEnd], [null, 'done', 'be']);
  const both = gradeRow(long({ tp2: 84_500, tp3: null }), [FILL, TP1, minute(7, 84_290, 84_520, 84_000, 84_100)]);
  assert.deepEqual([both.tp2At, both.runnerEnd], [null, 'be'], 'which came first is not knowable: the reading that cannot flatter');
});

test('a runner with no TP3 ends at TP2; one still out stays running across passes; no TP2, no runner', () => {
  const two = gradeRow(long({ tp2: 84_500, tp3: null }), [FILL, TP1, minute(7, 84_290, 84_520, 84_280, 84_510)]);
  assert.deepEqual([two.tp2At, two.runnerEnd], [T + 420, 'tp2']);
  const half = gradeRow(long({ tp2: 84_500, tp3: 84_700 }), [FILL, TP1, minute(7, 84_290, 84_520, 84_280, 84_510)]);
  assert.deepEqual([half.tp2At, half.runner], [T + 420, 'running']);
  const on = gradeRow(half, [minute(8, 84_510, 84_710, 84_500, 84_700)]);
  assert.deepEqual([on.tp3At, on.runnerEnd], [T + 480, 'tp3'], 'picked up on the next pass');
  assert.equal(gradeRow(long(), [FILL, TP1]).runner, null);
});

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
  const [y] = await rows<{ tp1_at: number; runner: string | null }>("SELECT tp1_at, runner FROM entry_setups WHERE mode = 'single'");
  assert.deepEqual([Number(y?.tp1_at), y?.runner], [T + 360, null], 'TGT1 reached at 6 min; no TP2 in this plan, no runner');
  const { records, totals } = await entryRecord();
  assert.deepEqual(records.map((r) => [r.method, r.mode, r.trades, r.wins]), [['breakout', 'mtf', 1, 1], ['breakout', 'single', 1, 1]],
    'with the chain and without it, counted apart');
  assert.deepEqual([records[1]!.tgtPts, records[1]!.slPts, records[1]!.netPts], [290, 0, 290], 'filled at 84,010, out at TP1 84,300: +290 pts');
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

// ------------------------------------------------------------ the gate switches

test('[critical] a gate switched off is stored, logged, and read back; Data fresh cannot be', async () => {
  assert.deepEqual(await gatesOff(), []);
  await setGate('rr', false, 1_000);
  assert.deepEqual(await gatesOff(), ['rr'], 'read fresh after the change, not from a stale cache');
  const rr = (await gateSettings()).find((g) => g.key === 'rr')!;
  assert.deepEqual([rr.enabled, rr.changedAt], [false, 1_000]);
  await assert.rejects(setGate('data', false), GateLocked);
  const log = await rows<{ key: string; enabled: boolean }>('SELECT key, enabled FROM entry_gate_changes ORDER BY id');
  assert.deepEqual(log.map((r) => [r.key, r.enabled]), [['rr', false]], 'every change is kept; the refused one is not a change');
  await setGate('rr', true, 2_000);
  assert.deepEqual(await gatesOff(), []);
});

test('[critical] a setup taken with a gate off is logged with it, and kept out of the record', async () => {
  await query('DELETE FROM entry_setups');
  const offRead = read({ id: 'fvg-retest', triggerTime: T + 900, gates: [
    { key: 'rr', label: 'R:R', rule: '', value: '1.20', ok: false, why: 'no room', enabled: false },
  ] });
  assert.equal(await recordSetups([read({ id: 'pullback' }), offRead], (T + 300) * 1000), 2);
  const logged = await rows<{ method: string; gates_off: string[] }>('SELECT method, gates_off FROM entry_setups ORDER BY method');
  assert.deepEqual(logged.map((r) => [r.method, r.gates_off]), [['fvg-retest', ['rr']], ['pullback', []]]);
  const { totals } = await entryRecord();
  const single = totals.find((t) => t.mode === 'single')!;
  assert.equal(single.setups, 1, 'only the setup taken with every gate on');
  assert.equal(single.gatesOff, 1, 'the other is counted apart, never mixed in');
  const { totalsAll } = await entryRecord();
  const everything = totalsAll.find((t) => t.mode === 'single')!;
  assert.equal(everything.setups, 2, 'the including-gates-off total counts both -- shown apart, labelled');
  assert.equal(everything.gatesOff, 1);
  assert.deepEqual([single.tgtPts, single.slPts], [0, 0], 'nothing closed with every gate on: no points either way');
});

test('[critical] never filled is EXPIRED, with its reason: price ran to TP1 without the zone (target), the stop came first (stop), the window passed (window)', () => {
  // The 1 Oct 07:00 VWAP short as a long: the zone below, price runs straight up through TP1 without touching it.
  const r = gradeRow(long(), [minute(5, 84_050, 84_200, 84_040, 84_190), minute(6, 84_190, 84_320, 84_180, 84_310), minute(7, 84_300, 84_300, 84_000, 84_010)]);
  assert.deepEqual([r.status, r.expireWhy], ['expired', 'target']);
  assert.equal(r.fillPrice, null, 'and the dip back into the zone at minute 7 does not fill it');
  const stopFirst = gradeRow(long(), [minute(5, 84_050, 84_060, 84_040, 84_045), minute(6, 83_890, 83_895, 83_850, 83_860)]);
  assert.deepEqual([stopFirst.status, stopFirst.expireWhy], ['expired', 'stop'], 'opened past the stop before any fill');
  const late = gradeRow(long(), Array.from({ length: 80 }, (_, k) => minute(5 + k, 84_100, 84_110, 84_090, 84_100)));
  assert.deepEqual([late.status, late.expireWhy], ['expired', 'window']);
});

test('[critical] an expiry and its reason are stored, and it counts as never filled, not as a trade', async () => {
  const at = T + 50_000;
  await recordSetups([read({ id: 'momentum', triggerTime: at })], (at + 300) * 1000);
  const k = (n: number) => minute((at - T) / 60 + 5 + n, 0, 0, 0, 0).time;
  await gradeSetups([
    { time: k(0), open: 84_050, high: 84_200, low: 84_040, close: 84_190, volume: 1 },
    { time: k(1), open: 84_190, high: 84_320, low: 84_180, close: 84_310, volume: 1 },
  ]);
  const [x] = await rows<{ status: string; fill_price: number | null; expire_why: string }>("SELECT status, fill_price, expire_why FROM entry_setups WHERE method = 'momentum' AND trigger_at = $1", [at]);
  assert.deepEqual([x?.status, x?.expire_why, x?.fill_price], ['expired', 'target', null]);
  const m = (await entryRecord()).records.find((r) => r.method === 'momentum')!;
  assert.deepEqual([m.trades, m.expired], [0, 1]);
});
