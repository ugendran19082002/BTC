import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { allReads, SINGLE_TFS } from '../../src/entry/engine.js';
import { RESEARCH } from '../../src/entry/candidates.js';
import { METHODS } from '../../src/entry/methods.js';
import { recordSignals, signalPage } from '../../src/entry/signals.js';
import { entryRecord, recordSetups } from '../../src/entry/paper.js';
import { wanted } from '../../src/entry/alerts.js';
import type { MethodRead } from '../../src/entry/types.js';
import { closePool } from '../../src/db/pool.js';
import { ctxOf } from './bars.js';

after(closePool);

/**
 * The research track (owner, 1 Oct 2026): the candidate methods read live beside the twelve and paper-logged
 * for a week of forward evidence -- never alerted, never mixed into the twelve's history or record.
 */

test('[critical] a minute\'s pass with research reads the twelve and every candidate, the chain and each timeframe; without it, the twelve alone', () => {
  const all = allReads(ctxOf(), SINGLE_TFS, { research: true });
  assert.equal(all.length, (METHODS.length + RESEARCH.length) * (1 + SINGLE_TFS.length));
  assert.ok(all.filter((r) => r.research).every((r) => RESEARCH.some((m) => m.id === r.id)));
  assert.ok(all.filter((r) => !r.research).every((r) => METHODS.some((m) => m.id === r.id)));
  assert.ok(!allReads(ctxOf()).some((r) => r.research));
});

const T = 1_790_600_000;
const PLAN = { entryLo: 84_000, entryHi: 84_010, stop: 83_900, tp1: 84_200, tp2: null, tp3: null, tpWhy: [], rr: 1.9 };
const read = (over: Partial<MethodRead>): MethodRead => ({
  id: 'bos', n: 6, name: 'BOS', group: 'breakout', summary: '', mode: 'single', tf: '15m', dir: 'long', state: 'TRADE',
  steps: [], gates: [], plan: PLAN, score: 50, scoreParts: [], alignment: null, reason: 'x', triggerTime: T, ...over,
});

test('[critical] research rows are stored as research: out of the twelve\'s history and record by default, on their own track when asked', async () => {
  const main = read({}), res = read({ id: 'trap', n: 14, name: 'Failed breakout / breakdown (trap)', research: true });
  await recordSignals([main, res], (T + 60) * 1000);
  await recordSetups([main, res], (T + 60) * 1000);
  const since = (T - 60) * 1000;
  const ids = async (track?: 'main' | 'research' | 'all') => (await signalPage({ tf: '15m', since, track })).signals.map((s) => `${s.method}${s.research ? '*' : ''}`).sort();
  assert.deepEqual(await ids(), ['bos'], 'the twelve by default');
  assert.deepEqual(await ids('research'), ['trap*']);
  assert.deepEqual(await ids('all'), ['bos', 'trap*']);
  const page = await signalPage({ tf: '15m', since, track: 'research' });
  assert.deepEqual([page.signals[0]!.n, page.signals[0]!.name], [14, 'Failed breakout / breakdown (trap)'], "a candidate's number and name");
  assert.ok(!(await entryRecord()).records.some((r) => r.method === 'trap'), "never in the twelve's record");
});

test('[critical] a research TRADE is never alerted, whatever the switches say', () => {
  const on = [{ mode: 'single' as const, enabled: true, changedAt: 1, tfs: ['15m' as const] }, { mode: 'mtf' as const, enabled: true, changedAt: 1, tfs: ['5m' as const] }];
  assert.equal(wanted({ mode: 'single', tf: '15m' }, on), true);
  assert.equal(wanted({ mode: 'single', tf: '15m', research: true }, on), false);
  assert.equal(wanted({ mode: 'mtf', tf: '5m', research: true }, on), false);
});
