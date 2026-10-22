import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startMinuteLog } from '../../src/observability/minute-log.js';
import { noteSignalRun } from '../../src/observability/desk-metrics.js';

/** The thread, a minute at a time, in the server log (22 Oct 2026): its lateness, each hold, the signals' time. */

const hold = (ms: number) => { const end = performance.now() + ms; while (performance.now() < end) { /* the thread held, as the methods held it */ } };
const after = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('[critical] a hold of the thread is caught with when it began and how long; the minute\'s worst is it', async () => {
  const m = startMinuteLog({ log: () => {}, every: null });
  try {
    await after(250);
    const began = Date.now();
    hold(450);
    await after(250);
    const l = m.line();
    assert.equal(l.stalls.length, 1, JSON.stringify(l.stalls));
    assert.ok(l.stalls[0]!.ms >= 350 && l.stalls[0]!.ms < 700, `${l.stalls[0]!.ms} ms`);
    assert.ok(Math.abs(l.stalls[0]!.at - began) < 250, 'when it began, near enough');
    assert.ok(l.loop.maxMs >= 350, `worst ${l.loop.maxMs} ms`);
    // The next minute starts clean.
    await after(250);
    assert.deepEqual(m.line().stalls, []);
  } finally { m.stop(); }
});

test('[critical] the minute\'s signal run is said with where it was worked and what of it this thread spent', async () => {
  const said: { msg: string; fields: Record<string, unknown> }[] = [];
  const m = startMinuteLog({ log: (msg, fields) => said.push({ msg, fields }), every: 300 });
  try {
    noteSignalRun(120, 640, { where: 'thread', mainMs: 9, afterCloseMs: 2_100 });
    await after(900);
    const line = said.find((s) => /signals/.test(s.msg));
    assert.ok(line, said.map((s) => s.msg).join(' / '));
    assert.match(line!.msg, /^minute \d\d:\d\d: loop p99 [\d.]+ ms, worst [\d.]+ ms; signals read 120 ms, worked 640 ms in their own thread \(9 ms on this one\)$/);
    assert.deepEqual((line!.fields.minute as { signal: unknown }).signal, { readMs: 120, calcMs: 640, mainMs: 9, where: 'thread', afterCloseMs: 2_100 });
  } finally { m.stop(); }
});
