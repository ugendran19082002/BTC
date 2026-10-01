import { after, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { gradeLive, resetLiveGrade, type Tape } from '../../src/entry/live-grade.js';
import { gradeSetups, gradeTicks, recordSetups, type PaperRow } from '../../src/entry/paper.js';
import type { MethodRead } from '../../src/entry/types.js';
import { closePool, rows } from '../../src/db/pool.js';

after(closePool);
beforeEach(() => resetLiveGrade());

/**
 * The paper log on the live tape: each trade of the perpetual moves a setup on
 * the second it prints, at the price it printed -- the rules of a 1m candle,
 * one price at a time. Candles stay the backstop, and never replay a minute
 * the tape has done.
 */

const T = 1_790_200_000 - (1_790_200_000 % 60); // a minute boundary, epoch s
const ms = (sec: number) => sec * 1000;
const tick = (sec: number, price: number) => ({ at: ms(sec), price });

/** A long: zone 84,000-84,010 (fills at 84,010), stop 83,900, TP1 84,300; seen at T. */
const long = (over: Partial<PaperRow> = {}): PaperRow => ({
  dir: 1, tf: '5m', triggerAt: T - 300, firstSeen: ms(T), entryLo: 84_000, entryHi: 84_010, stop: 83_900, tp1: 84_300,
  status: 'open', filledAt: null, fillPrice: null, exitAt: null, exitPrice: null, rNet: null, gradedTo: T - 60, ...over,
});

test('[critical] a resting limit fills at its own price when a trade goes through it -- never better; times are the trade\'s second', () => {
  const { row: r, lastAt } = gradeTicks(long(), [tick(T + 5, 84_040), tick(T + 17, 84_006), tick(T + 18, 84_002)], true);
  assert.deepEqual([r.status, r.fillPrice, r.filledAt, lastAt], ['filled', 84_010, T + 17, ms(T + 18)]);
});

test('[critical] a limit placed into a market already past it fills at that trade, as a marketable limit does', () => {
  const { row: r } = gradeTicks(long(), [tick(T + 3, 84_004)], false);
  assert.deepEqual([r.status, r.fillPrice, r.filledAt], ['filled', 84_004, T + 3]);
});

test('[critical] in the trade: TP1 exactly at the level, the second it prints; a stop at the first trade through it, slippage and all', () => {
  const filled = long({ status: 'filled', fillPrice: 84_010, filledAt: T });
  const win = gradeTicks(filled, [tick(T + 40, 84_250), tick(T + 41, 84_301)], true).row;
  assert.deepEqual([win.status, win.exitPrice, win.exitAt, win.tp1At], ['tp1', 84_300, T + 41, T + 41]);
  const loss = gradeTicks(filled, [tick(T + 40, 83_950), tick(T + 42, 83_897)], true).row;
  assert.deepEqual([loss.status, loss.exitPrice, loss.exitAt], ['stop', 83_897, T + 42], 'the trade that went through 83,900');
});

test('[critical] waiting, and price runs to TP1 without the zone: expired by target, on the trade that reached it', () => {
  const r = gradeTicks(long(), [tick(T + 2, 84_100), tick(T + 30, 84_305), tick(T + 50, 84_005)], true).row;
  assert.deepEqual([r.status, r.expireWhy, r.fillPrice], ['expired', 'target', null]);
});

test('trades from before the setup was seen are not its trades', () => {
  const r = gradeTicks(long(), [tick(T - 5, 84_001)], false).row;
  assert.equal(r.status, 'open');
});

// ------------------------------------------------------------ the pass, on the database

const read = (over: Partial<MethodRead> = {}): MethodRead => ({
  id: 'pullback', n: 9, name: 'Pullback', group: 'pullback', summary: '', mode: 'single', tf: '5m', dir: 'long', state: 'TRADE',
  steps: [], gates: [], score: 70, scoreParts: [], alignment: null, reason: '', triggerTime: T - 300,
  plan: { entryLo: 84_000, entryHi: 84_010, stop: 83_900, tp1: 84_300, tp2: 84_500, tp3: null, tpWhy: [], rr: 2.6 },
  ...over,
});
const tape = (ts: { at: number; price: number }[], o: { fresh?: boolean; reconnects?: number } = {}): Tape => ({
  fresh: () => o.fresh ?? true, perpSince: (from) => ts.filter((t) => t.at >= from), reconnects: () => o.reconnects ?? 0,
});
const row = async (trigger: number) => (await rows<Record<string, unknown>>('SELECT * FROM entry_setups WHERE trigger_at = $1', [trigger]))[0]!;

test('[critical] live: filled and out at TP1 the second they print, a runner set for TP2; the minute it happened is closed to the candles', async () => {
  await recordSetups([read()], ms(T));
  const ts = [tick(T + 10, 84_030), tick(T + 21, 84_008), tick(T + 75, 84_301)];
  assert.equal(await gradeLive(tape(ts.slice(0, 2))), 1, 'filled');
  assert.equal(await gradeLive(tape(ts)), 1, 'TP1');
  const x = await row(T - 300);
  assert.deepEqual([x.status, Number(x.fill_price), Number(x.filled_at), Number(x.exit_price), Number(x.exit_at), x.runner],
    ['tp1', 84_010, T + 21, 84_300, T + 75, 'running']);
  assert.equal(Number(x.graded_to), T + 60, 'the minute of the TP1 trade');
  // The candle grader, a minute later, with a bar of that minute dipping to the fill: it does not replay it as breakeven.
  await gradeSetups([{ time: T + 60, open: 84_100, high: 84_310, low: 84_005, close: 84_300, volume: 1 }]);
  assert.equal((await row(T - 300)).runner, 'running');
});

test('[critical] a stale tape grades nothing -- the candles carry on; a reconnect starts again from what the candles graded', async () => {
  await recordSetups([read({ id: 'bos', triggerTime: T - 600 })], ms(T));
  assert.equal(await gradeLive(tape([tick(T + 10, 84_008)], { fresh: false })), 0);
  assert.equal((await row(T - 600)).status, 'open');
  assert.equal(await gradeLive(null), 0, 'no socket at all');
  await gradeLive(tape([tick(T + 5, 84_050)], { reconnects: 1 }));
  assert.equal(await gradeLive(tape([tick(T + 5, 84_050), tick(T + 9, 84_009)], { reconnects: 2 })), 1, 'after a reconnect it still grades');
  assert.equal(Number((await row(T - 600)).fill_price), 84_010, 're-read from the graded minute: resting since the :05 trade, it fills at its own price');
});
