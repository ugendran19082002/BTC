import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { pruneSignals, recentSignals, recordSignals } from '../../src/entry/signals.js';
import { allReads, SINGLE_TFS } from '../../src/entry/engine.js';
import type { MethodRead } from '../../src/entry/types.js';
import { closePool, rows } from '../../src/db/pool.js';
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

test('signals older than the keep period go; the rest stay', async () => {
  assert.equal(await pruneSignals((T + 400 * 86_400) * 1000, 365), 3);
  assert.equal((await recentSignals()).length, 0);
});

test("[critical] a minute's pass reads every way the screen can show: the chain once, and each timeframe without it", () => {
  const reads = allReads(ctxOf());
  assert.equal(reads.length, 12 + 12 * SINGLE_TFS.length);
  assert.equal(reads.filter((r) => r.mode === 'mtf').length, 12);
  assert.deepEqual([...new Set(reads.filter((r) => r.mode === 'single').map((r) => r.tf))], [...SINGLE_TFS]);
});
