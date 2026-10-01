import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { clockKeyOf, exportSignals, signalsCsv, pruneSignals, recentSignals, recordSignals, setupClocks, signalPage } from '../../src/entry/signals.js';
import { allReads, entryBoard, SINGLE_TFS, VIEW_ONLY_TFS } from '../../src/entry/engine.js';
import type { MethodRead } from '../../src/entry/types.js';
import { closePool, query, rows } from '../../src/db/pool.js';
import { recordSetups } from '../../src/entry/paper.js';
import { ctxOf } from './bars.js';

after(closePool);

const T = 1_790_035_200;
const read = (over: Partial<MethodRead> = {}): MethodRead => ({
  id: 'fvg-retest', n: 4, name: 'FVG retest', group: 'pullback', summary: '', mode: 'single', tf: '3m', dir: 'short', state: 'WAIT',
  steps: [], gates: [], plan: null, score: 50, scoreParts: [], alignment: null, reason: 'waiting for 3m: reaction', triggerTime: T,
  ...over,
});
const PLAN = { entryLo: 84_391, entryHi: 84_500, stop: 84_700, tp1: 84_000, tp2: null, tp3: null, tpWhy: [], rr: 1.9 };

test('[critical] every WAIT and TRADE is kept, on any timeframe; nothing forming and NO TRADE are not signals', async () => {
  const n = await recordSignals([
    read(), read({ tf: '1h', id: 'bos' }), read({ state: 'NO_TRADE' }), read({ dir: null, state: 'NO_TRADE', id: 'momentum' }),
  ], T * 1000);
  assert.equal(n, 2);
  const all = await recentSignals();
  assert.deepEqual(all.map((s) => [s.method, s.tf, s.state]).sort(), [['bos', '1h', 'WAIT'], ['fvg-retest', '3m', 'WAIT']]);
});

test('[critical] one row per setup per state: seen again it is not a new row, its last-seen moves; a WAIT that becomes a TRADE is two', async () => {
  assert.equal(await recordSignals([read()], (T + 60) * 1000), 0, 'the same WAIT a minute later');
  const [w] = await recentSignals({ tf: '3m', state: 'WAIT' });
  assert.deepEqual([w!.firstSeen, w!.lastSeen], [T * 1000, (T + 60) * 1000], 'it stood a minute');
  assert.equal(await recordSignals([read({ state: 'TRADE', plan: PLAN, gates: [{ key: 'rr', label: 'R:R after fees', rule: '', value: '1.2', ok: false, why: null, enabled: false }] })], (T + 120) * 1000), 1);
  const [t] = await recentSignals({ tf: '3m', state: 'TRADE' });
  assert.deepEqual([t!.entryLo, t!.entryHi, t!.stop, t!.tp1, t!.rr, t!.gatesOff], [84_391, 84_500, 84_700, 84_000, 1.9, ['rr']], 'its levels, and the gates it stood on');
  const count = await rows<{ n: string }>("SELECT count(*) AS n FROM entry_signals WHERE method = 'fvg-retest' AND tf = '3m'");
  assert.equal(Number(count[0]!.n), 2);
});

test('the journal reads back newest first, filtered by way, timeframe and state', async () => {
  assert.ok((await recentSignals({ mode: 'mtf' })).every((s) => s.mode === 'mtf'));
  assert.deepEqual((await recentSignals({ tf: '1h' })).map((s) => s.method), ['bos']);
  assert.equal((await recentSignals({ limit: 1 })).length, 1);
});

test('[critical] a TRADE in the history carries what became of it in the paper log; a WAIT carries none; each has its method\'s name', async () => {
  const t = read({ state: 'TRADE', plan: PLAN, triggerTime: T + 600, tf: '5m' });
  await recordSignals([t, read({ triggerTime: T + 600, tf: '5m', id: 'bos' })], (T + 660) * 1000);
  await recordSetups([t], (T + 660) * 1000);
  await query(`UPDATE entry_setups SET status = 'tp1', fill_price = 84391, filled_at = $3, exit_price = 84000, exit_at = $1, r_net = 1.1 WHERE trigger_at = $2`, [T + 900, T + 600, T + 720]);
  const [trade] = await recentSignals({ tf: '5m', state: 'TRADE' });
  assert.deepEqual(trade!.outcome, {
    status: 'tp1', fillPrice: 84_391, exitPrice: 84_000, exitAt: T + 900, rNet: 1.1,
    filledAt: T + 720, fillBy: T + 900 + 300 * 12, timeoutAt: T + 720 + 300 * 48, // the window runs from the trigger bar's close, later than first seen here
    fillEdge: 84_391, fillBetterPts: 0, exitLevel: 84_000, exitPastPts: 0, exitWhy: 'level',
    tp1At: null, tp2At: null, tp3At: null, runner: null, runnerEnd: null,
  }, 'a short fills at the zone\'s low edge; TP1 is a limit, exactly the level');
  assert.equal(trade!.barCloseAt, T + 900, 'the 5m trigger bar closed at its start + 5 min');
  assert.equal(trade!.seenAfterMs, (T + 660) * 1000 - (T + 900) * 1000);
  assert.equal(trade!.alert, null, 'no alert tried');
  assert.deepEqual([trade!.n, trade!.name], [4, 'FVG retest']);
  const [wait] = await recentSignals({ tf: '5m', state: 'WAIT' });
  assert.equal(wait!.outcome, null);
  assert.equal((await recentSignals({ since: (T + 650) * 1000 })).length, 2, 'since a moment');
});

test('[critical] the price when the signal appeared -- LTP and index -- is kept from its first sighting, not overwritten', async () => {
  const x = read({ id: 'momentum', tf: '30m', triggerTime: T + 7_000 });
  await recordSignals([x], (T + 7_060) * 1000, { ltp: 84_205.5, index: 84_190.2 });
  await recordSignals([x], (T + 7_120) * 1000, { ltp: 85_000, index: 85_000 });
  const [row] = await recentSignals({ tf: '30m' });
  assert.deepEqual([row!.ltp, row!.indexPrice], [84_205.5, 84_190.2]);
});

test('[critical] a page of the history: the total matching, a page from an offset, BUY or SELL, sorted by a column', async () => {
  for (let k = 0; k < 7; k++) {
    await recordSignals([read({ id: 'pullback', tf: '4h', triggerTime: T + 10_000 + k, dir: k % 2 ? 'long' : 'short', state: 'TRADE', plan: { ...PLAN, rr: k }, score: 10 * k })], (T + 10_000 + k) * 1000);
  }
  const first = await signalPage({ tf: '4h', limit: 3 });
  assert.equal(first.total, 7);
  assert.equal(first.signals.length, 3);
  const third = await signalPage({ tf: '4h', limit: 3, offset: 6 });
  assert.equal(third.signals.length, 1, 'the last page holds what is left');
  assert.equal(new Set([...first.signals, ...(await signalPage({ tf: '4h', limit: 3, offset: 3 })).signals, ...third.signals].map((x) => x.triggerAt)).size, 7, 'no row twice, none missed');
  const buys = await signalPage({ tf: '4h', dir: 1 });
  assert.deepEqual([buys.total, buys.signals.every((x) => x.dir === 1)], [3, true]);
  const sells = await signalPage({ tf: '4h', dir: -1, state: 'TRADE' });
  assert.equal(sells.total, 4);
  assert.deepEqual((await signalPage({ tf: '4h', sort: 'rr' })).signals.map((x) => x.rr), [6, 5, 4, 3, 2, 1, 0]);
  assert.deepEqual((await signalPage({ tf: '4h', sort: 'score', asc: true })).signals.map((x) => x.score), [0, 10, 20, 30, 40, 50, 60]);
});

test('[critical] the summary over every match: TP1 hits and the points made, stops and the points lost, the net -- adding up exactly', async () => {
  const mk = (k: number) => read({ id: 'bos', tf: '15m', triggerTime: T + 20_000 + k, dir: 'long', state: 'TRADE', plan: PLAN });
  for (let k = 0; k < 4; k++) { await recordSignals([mk(k)], (T + 20_000 + k) * 1000); await recordSetups([mk(k)], (T + 20_000 + k) * 1000); }
  const set = (k: number, status: string, fill: number, exit: number | null, r: number | null) =>
    query(`UPDATE entry_setups SET status = $1, fill_price = $2, exit_price = $3, r_net = $4 WHERE tf = '15m' AND trigger_at = $5`, [status, fill, exit, r, T + 20_000 + k]);
  await set(0, 'tp1', 84_000, 84_300, 1.5);   // +300
  await set(1, 'tp1', 84_000, 84_150, 0.7);   // +150
  await set(2, 'stop', 84_000, 83_800, -1.1); // -200
  await set(3, 'filled', 84_000, null, null); // open
  const { summary, total } = await signalPage({ tf: '15m', limit: 1 });
  assert.equal(total, 4);
  assert.deepEqual(summary, { trades: 4, tp1: 2, tp1Pts: 450, stops: 1, slPts: 200, timeouts: 0, timeoutPts: 0, netPts: 250, open: 1, tp2: 0, tp3: 0 },
    'over all four, though the page holds one');
  const live = await signalPage({ tf: '15m', live: true });
  assert.deepEqual([live.total, live.signals.map((x) => x.outcome?.status)], [1, ['filled']], 'trading now: the one still in, not the closed');
});

test('signals older than the keep period go; the rest stay', async () => {
  assert.equal(await pruneSignals((T + 400 * 86_400) * 1000, 365), 17);
  assert.equal((await recentSignals()).length, 0);
});

test("[critical] a minute's pass reads every way the screen can show: the chain once, and each timeframe without it", () => {
  const reads = allReads(ctxOf());
  assert.equal(reads.length, 12 + 12 * SINGLE_TFS.length);
  assert.equal(reads.filter((r) => r.mode === 'mtf').length, 12);
  assert.deepEqual([...new Set(reads.filter((r) => r.mode === 'single').map((r) => r.tf))], [...SINGLE_TFS]);
});

test('[critical] 1m without the chain is view-only: never read, never a signal, never in the history (the chain keeps its 1m step: engine.test)', async () => {
  assert.deepEqual([SINGLE_TFS.includes('1m'), VIEW_ONLY_TFS], [false, ['1m']]);
  assert.ok(!allReads(ctxOf()).some((r) => r.mode === 'single' && r.tf === '1m'), 'the recorder reads no 1m');
  const board = entryBoard(ctxOf(), '1m');
  assert.deepEqual([board.length, board.every((r) => r.mode === 'mtf')], [12, true], 'the board on 1m: the chain only, the chart alone without it');
  // Even handed a 1m read, the journal does not keep it.
  await recordSignals([read({ tf: '1m', triggerTime: T + 90_000 }), read({ tf: '3m', triggerTime: T + 90_000 })], (T + 90_060) * 1000);
  assert.deepEqual((await recentSignals({ since: (T + 90_000) * 1000 })).map((x) => x.tf), ['3m']);
});

test('[critical] an exit past its stop says by how much and why (the minute opened past it: a gap); a fill inside the zone says how much better', async () => {
  const t = read({ id: 'order-flow', state: 'TRADE', dir: 'long', tf: '1h', triggerTime: T + 30_000,
    plan: { entryLo: 83_615, entryHi: 83_752, stop: 83_463, tp1: 83_865, tp2: null, tp3: null, tpWhy: [], rr: 1.9 } });
  await recordSignals([t], (T + 33_660) * 1000);
  await recordSetups([t], (T + 33_660) * 1000);
  await query(`UPDATE entry_setups SET status = 'stop', fill_price = 83668, filled_at = $2, exit_price = 83441, exit_at = $3, r_net = -1.1
                WHERE method = 'order-flow' AND trigger_at = $1`, [T + 30_000, T + 33_720, T + 34_000]);
  await query(`INSERT INTO entry_alert_log (at, mode, tf, method, dir, trigger_at, text, status) VALUES ($1, 'single', '1h', 'order-flow', 1, $2, 'x', 'sent')`,
    [(T + 33_663) * 1000, T + 30_000]);
  const [row] = await recentSignals({ tf: '1h', state: 'TRADE' });
  const o = row!.outcome!;
  assert.deepEqual([o.fillEdge, o.fillBetterPts], [83_752, 84], 'a long rests at the top edge; it opened 84 pts lower, inside the zone');
  assert.deepEqual([o.exitLevel, o.exitPastPts, o.exitWhy], [83_463, 22, 'gap'], 'SL 83,463, out at 83,441: 22 pts past, the minute opened there');
  assert.deepEqual(row!.alert, { at: (T + 33_663) * 1000, status: 'sent' });
  // The board's clock for the same setup: when it was seen, until when it may fill, when it times out, when the alert went.
  const clock = (await setupClocks([t])).get(clockKeyOf(t))!;
  assert.deepEqual([clock.status, clock.filledAt, clock.timeoutAt, clock.alertAt], ['stop', T + 33_720, T + 33_720 + 3_600 * 48, (T + 33_663) * 1000]);
  assert.equal(clock.fillBy, T + 33_660 + 3_600 * 12, 'from the first whole minute after it was seen, past the bar close');
});

test('[critical] the whole plan is kept with the signal: TP2, TP3, and why the SL and each target are where they are', async () => {
  const why = { stop: 'the sweep extreme 83,488 − 0.25 ATR', tp1: 'entry swing high 83,865', tp2: '1h swing high 84,100', tp3: null };
  const t = read({ id: 'liquidity-sweep', state: 'TRADE', dir: 'long', tf: '30m', triggerTime: T + 50_000,
    plan: { ...PLAN, tp2: 84_100, tp3: null, why } });
  await recordSignals([t], (T + 50_060) * 1000);
  const [row] = await recentSignals({ tf: '30m', state: 'TRADE' });
  assert.deepEqual([row!.tp2, row!.tp3, row!.why], [84_100, null, why]);
});


test('[critical] TGT1 / TGT2 / TGT3 reach the history, the totals count TGT2 and TGT3 hits, and a running runner is in play', async () => {
  const t = read({ id: 'bos', state: 'TRADE', dir: 'long', tf: '4h', triggerTime: T + 70_000, plan: { ...PLAN, tp2: 84_600, tp3: 84_900 } });
  await recordSignals([t], (T + 84_460) * 1000);
  await recordSetups([t], (T + 84_460) * 1000);
  await query(`UPDATE entry_setups SET status = 'tp1', fill_price = 84500, filled_at = $2, exit_price = 84000, exit_at = $3, r_net = 2,
                      tp1_at = $3, tp2_at = $4, runner = 'running' WHERE method = 'bos' AND trigger_at = $1`, [T + 70_000, T + 84_480, T + 84_600, T + 84_660]);
  const page = await signalPage({ tf: '4h', state: 'TRADE', since: (T + 84_000) * 1000 });
  const o = page.signals[0]!.outcome!;
  assert.deepEqual([o.tp1At, o.tp2At, o.tp3At, o.runner], [T + 84_600, T + 84_660, null, 'running']);
  assert.deepEqual([page.summary.tp2, page.summary.tp3], [1, 0]);
  assert.equal((await signalPage({ tf: '4h', live: true, since: (T + 84_000) * 1000 })).total, 1, 'a runner still out for TGT3 is trading');
});

test('[critical] every column sorts, both ways, on the server: method by number, way then timeframe, result in points; nothing else gets into the SQL', async () => {
  const base = (k: number, over: Partial<MethodRead>) => read({ tf: '15m', triggerTime: T + 120_000 + k, state: 'TRADE', plan: { ...PLAN, rr: 2 }, ...over });
  const xs = [base(0, { id: 'order-flow', score: 30 }), base(1, { id: 'breakout', score: 90 }), base(2, { id: 'fvg-retest', score: 60 })];
  await recordSignals(xs, (T + 130_000) * 1000);
  const since = (T + 129_000) * 1000;
  const names = async (sort: string, asc = false) => (await signalPage({ tf: '15m', since, sort: sort as never, asc })).signals.map((x) => x.n);
  assert.deepEqual(await names('method', true), [1, 4, 11]);
  assert.deepEqual(await names('method'), [11, 4, 1]);
  assert.deepEqual(await names('score'), [1, 4, 11]);
  assert.deepEqual(await names('nonsense'), await names('time'), 'an unknown column is the default, never SQL');
  for (const sort of ['time', 'way', 'signal', 'ltp', 'entry', 'sl', 'tp1', 'tp2', 'tp3', 'fill', 'exit', 'result', 'stood', 'rr']) {
    assert.equal((await signalPage({ tf: '15m', since, sort: sort as never, asc: true })).signals.length, 3, sort);
  }
});

test('[critical] the totals add up to the point: each trade rounded as its row shows it, net = target pts − SL pts + time-out pts', async () => {
  const mk = (k: number) => read({ id: 'momentum', tf: '1h', triggerTime: T + 140_000 + k, dir: 'long', state: 'TRADE', plan: PLAN });
  for (let k = 0; k < 3; k++) { await recordSignals([mk(k)], (T + 140_000 + k) * 1000); await recordSetups([mk(k)], (T + 140_000 + k) * 1000); }
  const set = (k: number, status: string, exit: number) =>
    query(`UPDATE entry_setups SET status = $1, fill_price = 84000, exit_price = $2 WHERE method = 'momentum' AND tf = '1h' AND trigger_at = $3`, [status, exit, T + 140_000 + k]);
  await set(0, 'tp1', 84_300.4);  // +300
  await set(1, 'stop', 83_799.6); // -200 (200.4 -> 200)
  await set(2, 'timeout', 84_010.6); // +11
  const { summary: s } = await signalPage({ tf: '1h', since: (T + 139_000) * 1000 });
  assert.deepEqual([s.tp1Pts, s.slPts, s.timeoutPts, s.netPts], [300, 200, 11, 111]);
  assert.equal(s.netPts, s.tp1Pts - s.slPts + s.timeoutPts);
});

test("[critical] the Excel download: every row the filters match in the table's order, a BOM, CRLF, quoted fields, no formula can run", async () => {
  const { rows: all, total } = await exportSignals({ tf: '15m', sort: 'method', asc: true, since: (T + 129_000) * 1000 });
  assert.equal(all.length, total);
  assert.deepEqual(all.map((x) => x.n), [1, 4, 11], 'the same order as the table');
  const csv = signalsCsv([{ ...all[0]!, reason: '=HYPERLINK("x"), then "more"', name: 'A, B' }]);
  assert.ok(csv.startsWith('﻿signal_time_ist,method_no,method,way,tf,signal,'), 'a BOM, then the header');
  assert.ok(csv.endsWith('\r\n') && csv.split('\r\n').length === 3, 'CRLF lines: header, one row, the end');
  const header = csv.slice(1).split('\r\n')[0]!.split(',');
  assert.ok(['tgt1', 'tgt2', 'tgt3', 'tgt1_hit_ist', 'fill_ist', 'exit_ist', 'exit_by', 'result_pts', 'sl_why'].every((h) => header.includes(h)));
  assert.match(csv, /,"A, B",/, 'a comma in a field is quoted');
  assert.ok(csv.endsWith(`,"'=HYPERLINK(""x""), then ""more"""\r\n`), 'a leading = is defused with an apostrophe, quotes doubled');
});

test('[critical] the history by ending: TGT hit, SL hit, timed out, expired, missed -- each exactly that; anything else is no filter', async () => {
  const mk = (k: number) => read({ id: 'breakout', tf: '30m', triggerTime: T + 200_000 + k, dir: 'long', state: 'TRADE', plan: PLAN });
  const ends = ['tp1', 'stop', 'timeout', 'expired', 'missed', 'open'];
  for (let k = 0; k < ends.length; k++) {
    await recordSignals([mk(k)], (T + 200_000 + k) * 1000);
    await recordSetups([mk(k)], (T + 200_000 + k) * 1000);
    await query(`UPDATE entry_setups SET status = $1 WHERE method = 'breakout' AND tf = '30m' AND trigger_at = $2`, [ends[k], T + 200_000 + k]);
  }
  const since = (T + 199_000) * 1000;
  for (const o of ['tp1', 'stop', 'timeout', 'expired', 'missed'] as const) {
    const p = await signalPage({ tf: '30m', since, outcome: o });
    assert.deepEqual([p.total, p.signals[0]?.outcome?.status], [1, o], o);
  }
  assert.equal((await signalPage({ tf: '30m', since, outcome: 'nonsense' as never })).total, 6, 'not a filter');
});
