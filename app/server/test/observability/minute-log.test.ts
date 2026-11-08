import { test } from 'node:test';
import assert from 'node:assert/strict';
import { passMinutes, passWords, startMinuteLog } from '../../src/observability/minute-log.js';
import { notePass, noteSignalRun } from '../../src/observability/desk-metrics.js';

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

const parts = (account: number | null, pollsMs: number, slowestPollMs = pollsMs / 4) =>
  ({ account, openMs: 12, pollsMs, slowestPollMs, leftoversMs: 40, orphansMs: 300 });

test('[critical] each account\'s passes are said apart, with what the slowest spent its time on (8 Nov 2026)', () => {
  const ms = passMinutes([
    { ms: 400, trades: 10, parts: parts(1, 300) },
    { ms: 2_400, trades: 31, parts: parts(1, 2_000, 900) },
    { ms: 600, trades: 10, parts: parts(1, 500) },
    { ms: 150, trades: 2, parts: parts(2, 90) },
  ]);
  assert.equal(ms.length, 2);
  const one = ms[0]!;
  assert.equal(one.account, 1);
  assert.equal(one.count, 3);
  assert.equal(one.p50Ms, 600);
  assert.equal(one.maxMs, 2_400);
  assert.equal(one.slowest.trades, 31);
  assert.equal(one.slowest.parts!.pollsMs, 2_000);
  assert.equal(passWords(one), 'account 1: 3 passes, median 600 ms, slowest 2.4 s over 31 trades (read 12 ms, polls 2.0 s, slowest poll 900 ms, leftovers 40 ms, orphans 300 ms)');
  assert.equal(ms[1]!.account, 2);
  // A pass from before the parts were kept still counts, without them.
  const old = passMinutes([{ ms: 900, trades: 4 }]);
  assert.equal(old[0]!.account, null);
  assert.equal(passWords(old[0]!), 'account -: 1 pass, median 900 ms, slowest 900 ms over 4 trades');
});

test('the minute\'s line carries the passes that had trades in them, and leaves out a flat account\'s', async () => {
  const said: { msg: string; fields: Record<string, unknown> }[] = [];
  const m = startMinuteLog({ log: (msg, fields) => said.push({ msg, fields }), every: 200 });
  try {
    notePass(1_800, 25, Date.now(), parts(3, 1_500));
    notePass(5, 0, Date.now(), parts(4, 0));
    await after(450);
    const withPasses = said.find((x) => x.msg.includes('passes'));
    assert.ok(withPasses, said.map((x) => x.msg).join(' | '));
    assert.match(withPasses.msg, /passes account 3: 1 pass, median 1\.8 s, slowest 1\.8 s over 25 trades/);
    assert.doesNotMatch(withPasses.msg, /account 4/);
    const fields = withPasses.fields.minute as { passes: { account: number }[] };
    assert.deepEqual(fields.passes.map((p) => p.account).sort(), [3, 4], 'both kept in the fields');
  } finally { m.stop(); }
});
