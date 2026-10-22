import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { allReads } from '../../src/entry/engine.js';
import { readsOf, stopReadsThread, useReadsThread } from '../../src/entry/reads-run.js';
import type { EntryContext, Frames } from '../../src/entry/types.js';
import { ctxOf, path, T0, wave } from './bars.js';

/**
 * The minute's signals in a thread of their own (22 Oct 2026): the same reads as the desk's own thread works, every
 * one, and never a minute without them -- a thread that will not start, fails or stalls is worked around here.
 */

afterEach(() => stopReadsThread());

/** Every timeframe, the chain's and the rest, with a tape, flow and walls: as much of the board as the methods read. */
function board(): EntryContext {
  const tf = (step: number, drift: number, amp = 60) => path(wave(220, 84_000, amp, 12, drift), { step, t0: T0 });
  const frames: Frames = {
    '1m': tf(60, 1, 20), '3m': tf(180, 2, 30), '5m': tf(300, 3), '15m': tf(900, 4), '30m': tf(1_800, 5),
    '1h': tf(3_600, 6), '2h': tf(7_200, 6), '4h': tf(14_400, 7),
  };
  const last = frames['5m']!.at(-1)!;
  const nowSec = last.time + 300 + 5;
  return ctxOf({
    now: nowSec * 1000, frames,
    walls: [{ side: 'ask', price: 84_900, size: 5_000 }, { side: 'bid', price: 83_100, size: 4_000 }],
    flow: Array.from({ length: 120 }, (_, i) => ({ time: nowSec - (120 - i) * 60, buy: 10 + (i % 7), sell: 9 + (i % 5), largeBuy: i % 3, largeSell: i % 4 })),
    prints: Array.from({ length: 600 }, (_, i) => ({ at: (nowSec - 1_800 + i * 3) * 1000, price: 84_000 + (i % 40) - 20, size: 1 + (i % 9), side: i % 2 ? 'buy' as const : 'sell' as const })),
    spreadPct: 0.01,
    options: { spot: 84_020, atmIv: 0.45, emDay: 1_800, callWall: 86_000, putWall: 82_000, maxPain: 84_000, toSettleSec: 20_000 },
  });
}

test('[critical] worked in their own thread, the reads are the desk thread\'s own: every method, every timeframe, alike', async () => {
  const ctx = board();
  const mine = allReads(ctx);
  useReadsThread();
  const w = await readsOf(ctx);
  assert.equal(w.where, 'thread');
  assert.equal(w.reads.length, mine.length);
  assert.deepEqual(w.reads, mine);
  assert.ok(mine.some((r) => r.state !== 'NO_TRADE'), 'a board some methods read as more than nothing');
  assert.ok(w.mainMs < w.calcMs + 50, `this thread spent ${w.mainMs.toFixed(1)} ms of the ${w.calcMs.toFixed(1)}`);
  // The thread is kept: the next minute is asked of the same one.
  assert.equal((await readsOf(ctx)).where, 'thread');
});

test('[critical] no thread asked for: worked here, as before', async () => {
  const ctx = board();
  const w = await readsOf(ctx);
  assert.equal(w.where, 'here');
  assert.deepEqual(w.reads, allReads(ctx));
});

test('[critical] a thread that will not start: the minute\'s signals worked here, said once, and no thread tried again for a while', async () => {
  const said: string[] = [];
  useReadsThread((m) => said.push(m), new URL('./fixtures/no-such-worker.ts', import.meta.url));
  const ctx = board();
  const w = await readsOf(ctx);
  assert.equal(w.where, 'here');
  assert.deepEqual(w.reads, allReads(ctx));
  assert.equal(said.length, 1);
  assert.match(said[0]!, /^no signal thread could be started, so the signals are worked on the desk's own thread for now/);
  assert.equal((await readsOf(ctx)).where, 'here', 'given up on for a while');
  assert.equal(said.length, 1, 'and not said again every minute');
});

test('[critical] a thread that stalls: given up on at its time, the minute worked here; a thread that fails: the same', async () => {
  const said: string[] = [];
  useReadsThread((m) => said.push(m), new URL('./fixtures/silent-reads-worker.ts', import.meta.url));
  const ctx = board();
  const from = Date.now();
  const w = await readsOf(ctx, { timeoutMs: 300 });
  assert.equal(w.where, 'here');
  assert.deepEqual(w.reads, allReads(ctx));
  assert.ok(Date.now() - from < 5_000, 'not a wait without end');
  assert.match(said[0]!, /no answer in 0.3 s/);
  stopReadsThread();
  const broken: string[] = [];
  useReadsThread((m) => broken.push(m), new URL('./fixtures/broken-reads-worker.ts', import.meta.url));
  const b = await readsOf(ctx);
  assert.equal(b.where, 'here');
  assert.match(broken[0]!, /it broke/);
});
