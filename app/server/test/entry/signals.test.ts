import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { pruneSignals, recentSignals, recordSignals, signalPage } from '../../src/entry/signals.js';
import { allReads, SINGLE_TFS } from '../../src/entry/engine.js';
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
  await query(`UPDATE entry_setups SET status = 'tp1', fill_price = 84391, exit_price = 84000, exit_at = $1, r_net = 1.1 WHERE trigger_at = $2`, [T + 900, T + 600]);
  const [trade] = await recentSignals({ tf: '5m', state: 'TRADE' });
  assert.deepEqual(trade!.outcome, { status: 'tp1', fillPrice: 84_391, exitPrice: 84_000, exitAt: T + 900, rNet: 1.1 });
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

test('[critical] the summary over every match: TP1 hits and the points made, stops and the points lost, net points and R', async () => {
  const mk = (k: number) => read({ id: 'bos', tf: '1m', triggerTime: T + 20_000 + k, dir: 'long', state: 'TRADE', plan: PLAN });
  for (let k = 0; k < 4; k++) { await recordSignals([mk(k)], (T + 20_000 + k) * 1000); await recordSetups([mk(k)], (T + 20_000 + k) * 1000); }
  const set = (k: number, status: string, fill: number, exit: number | null, r: number | null) =>
    query(`UPDATE entry_setups SET status = $1, fill_price = $2, exit_price = $3, r_net = $4 WHERE tf = '1m' AND trigger_at = $5`, [status, fill, exit, r, T + 20_000 + k]);
  await set(0, 'tp1', 84_000, 84_300, 1.5);   // +300
  await set(1, 'tp1', 84_000, 84_150, 0.7);   // +150
  await set(2, 'stop', 84_000, 83_800, -1.1); // -200
  await set(3, 'filled', 84_000, null, null); // open
  const { summary, total } = await signalPage({ tf: '1m', limit: 1 });
  assert.equal(total, 4);
  assert.deepEqual(summary, { trades: 4, tp1: 2, tp1Pts: 450, stops: 1, slPts: 200, timeouts: 0, netPts: 250, netR: 1.1, open: 1 },
    'over all four, though the page holds one');
  const live = await signalPage({ tf: '1m', live: true });
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
