import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rig, ceProduct, planFor, quote } from './harness.js';
import { CLOSE_FOLLOW_UP_MS, MAX_CLOSE_TRIES } from '../../src/trading/engine.js';

/**
 * The rest of a close that filled in part (30 Sep 2026).
 *
 * "Close now" on a thin book bought back what was offered and stopped. What
 * was left sat in exit_pending -- no target, no stop, nobody watching -- until
 * somebody noticed. Each case here is the desk finishing the job, or saying
 * plainly that it could not.
 */

const CE = ceProduct().symbol;

async function shortThenThinClose(over: { want?: number } = {}) {
  const r = rig();
  const plan = planFor(ceProduct(), { lots: 100 });
  await r.engine.open(plan);
  await r.engine.poll(plan.tradeId);
  // Only 40 offered: the market buy takes them and no more.
  r.ex.configure({ slippageLadder: [{ price: 101, size: 40 }] });
  await r.engine.closeNow(plan.tradeId, 'manual exit', over.want);
  return { r, plan };
}

test('[critical] a close that bought back 40 of 100 goes again for the other 60', async () => {
  const { r, plan } = await shortThenThinClose();
  assert.equal(r.store.peek(plan.tradeId)!.state.position, -60);
  assert.equal(r.store.peek(plan.tradeId)!.state.phase, 'exit_pending');
  r.ex.configure({ slippageLadder: undefined });       // the offer refills
  r.ex.tick(quote(CE, 100, 101, { ts: r.now() }));
  r.advance(CLOSE_FOLLOW_UP_MS);
  const s = await r.engine.poll(plan.tradeId);
  assert.equal(s?.position, 0, 'the rest went at the market');
  assert.equal(s?.phase, 'flat');
});

test('not before the close has had its moment -- it may still be filling', async () => {
  const { r, plan } = await shortThenThinClose();
  r.ex.configure({ slippageLadder: undefined });
  const s = await r.engine.poll(plan.tradeId);
  assert.equal(s?.position, -60);
  assert.equal(r.store.peek(plan.tradeId)!.events.filter((e) => e.t === 'exit_submitted').length, 1);
});

test('[critical] a close of part goes again only for what it still owes', async () => {
  // Asked to close 50 of 100; 40 filled, so 10 are owed -- not the 60 still held.
  const { r, plan } = await shortThenThinClose({ want: 50 });
  r.ex.configure({ slippageLadder: undefined });
  r.ex.tick(quote(CE, 100, 101, { ts: r.now() }));
  r.advance(CLOSE_FOLLOW_UP_MS);
  const s = await r.engine.poll(plan.tradeId);
  assert.equal(s?.position, -50, 'closed 50, as asked -- the other 50 are still a position');
});

test('[critical] it stops after its tries and says so once, rather than buying into an empty book forever', async () => {
  const { r, plan } = await shortThenThinClose();
  r.ex.configure({ slippageLadder: [{ price: 101, size: 5 }] });   // the book stays thin
  for (let i = 0; i < MAX_CLOSE_TRIES + 3; i++) {
    r.advance(CLOSE_FOLLOW_UP_MS);
    await r.engine.poll(plan.tradeId);
  }
  const s = r.store.peek(plan.tradeId)!.state;
  assert.ok(s.position < 0, 'still short');
  assert.equal(r.store.peek(plan.tradeId)!.events.filter((e) => e.t === 'exit_submitted').length, MAX_CLOSE_TRIES);
  assert.equal(r.alarms.filter((a) => /after 3 tries at the market/.test(a.message)).length, 1);
});

/**
 * 25 Oct 2026, 14:43: two P-80200 stops at 84 were judged on time (the offer at 89) and their buy-backs sent, but the
 * follow-up -- what is still resting cancelled and sent at the market -- ran in the loop's pass, and with 44 trades open
 * it came 22 and 33 s late: bought back at 118 and 129. A close is now urgent from the moment it is sent, and the
 * watch that polls urgent trades four times a second looks at it first, up to the stops' share of the quota.
 */
const { EntryWatch, ENTRY_WATCH_MS, ENTRY_WATCH_QUOTA_PCT, CLOSE_WATCH_QUOTA_PCT, CLOSE_WATCH_PER_LOOK, isUrgent } = await import('../../src/trading/entry-watch.js');

const settle = async (done: () => boolean) => { for (let i = 0; i < 200 && !done(); i++) await new Promise((r) => setTimeout(r, 1)); };

test('[critical] a close sent is followed up by the urgent watch, not the loop: the rest goes at the market about 1.5 s on, with Delta\'s quota past the entries\' share', async () => {
  const used = ENTRY_WATCH_QUOTA_PCT + 5;
  // As the service wires it: every close sent is put on the watch at once.
  let watch: InstanceType<typeof EntryWatch>;
  const r = rig({ onEvent: (e, _b, after) => { if (e.t === 'exit_submitted' && after.position !== 0) watch.add(after.tradeId, true); } });
  watch = new EntryWatch({ poll: (id) => r.engine.poll(id), quotaUsedPct: () => used });
  const plan = planFor(ceProduct(), { lots: 100 });
  await r.engine.open(plan);
  await r.engine.poll(plan.tradeId);
  r.ex.configure({ slippageLadder: [{ price: 101, size: 40 }] });
  await r.engine.closeNow(plan.tradeId, 'stop reached');
  assert.equal(r.store.peek(plan.tradeId)!.state.position, -60);
  assert.equal(watch.size, 1, 'on the watch from the moment it was sent');
  r.ex.configure({ slippageLadder: undefined });
  r.ex.tick(quote(CE, 100, 101, { ts: r.now() }));
  // No loop pass at all: the watch's looks alone, every 250 ms.
  for (let t = 0; t < 2_000 && r.store.peek(plan.tradeId)!.state.position !== 0; t += ENTRY_WATCH_MS) {
    r.advance(ENTRY_WATCH_MS);
    watch.tick();
    await settle(() => r.store.peek(plan.tradeId)!.state.position === 0);
  }
  const s = r.store.peek(plan.tradeId)!.state;
  assert.deepEqual([s.position, s.phase], [0, 'flat'], 'the rest went at the market within two seconds, with no pass');
  await settle(() => watch.size === 0);
  assert.equal(watch.size, 0, 'and off the watch once done');
});

test('[critical] the closes first, and on past the entries\' share of the quota -- none at all past the stops\'', () => {
  const polled: string[] = [];
  let used = 0;
  const now = 1_000_000;
  const w = new EntryWatch({ poll: async (id) => { polled.push(id); return { phase: id.startsWith('close') ? 'exit_pending' : 'entry_pending', position: -1, closing: id.startsWith('close') ? {} : undefined }; }, quotaUsedPct: () => used, now: () => now });
  // A close sent two seconds ago: due its follow-up (22 Nov 2026: a close is looked at once it is due, with places of its own).
  w.add('entry-1'); w.add('entry-2'); w.add('close-1', true, now - 2_000);
  assert.deepEqual(w.tick(), ['close-1', 'entry-1', 'entry-2'], 'the close first, and the entries their own two');
  used = ENTRY_WATCH_QUOTA_PCT;
  assert.deepEqual(w.tick().filter((id) => id.startsWith('entry')), [], 'entries wait at their share');
  used = CLOSE_WATCH_QUOTA_PCT;
  assert.deepEqual(w.tick(), [], 'past the stops\' share, nothing');
  // What counts as urgent: a close still working, and not one done or a target's own fill.
  const st = (s: object) => ({ state: { phase: 'exit_pending', position: -1, closing: { all: true }, ...s } }) as unknown as Parameters<typeof isUrgent>[0];
  assert.equal(isUrgent(st({})), true);
  assert.equal(isUrgent(st({ position: 0 })), false);
  assert.equal(isUrgent(st({ closing: null })), false);
});


/*
 * Closes due their follow-up, looked at on time (22 Nov 2026). At 14:05 IST dozens of stops closed at once into calls
 * running up; the two places a look were shared by every close, due or not, and a close owed its market follow-up at
 * 1.5 s waited 12 s -- the 60,400 CE judged at an offer of 103 bought back at 218.
 */
function closeWatch(o: { quota?: number } = {}) {
  let now = 5_000_000;
  const polled: string[] = [];
  const working = new Set<string>();
  const sentAt = new Map<string, number>();
  const w = new EntryWatch({
    poll: async (id) => {
      polled.push(id);
      // A close still working, re-sent at the market by its follow-up: sent again now.
      if (working.has(id)) { sentAt.set(id, now); return { phase: 'exit_pending', position: -1, closing: { submittedAt: now } }; }
      return { phase: 'done', position: 0 };
    },
    quotaUsedPct: () => o.quota ?? 0,
    now: () => now,
  });
  return { w, polled, working, sentAt, at: () => now, move: (ms: number) => { now += ms; } };
}

test('[critical] a close is not looked at before its follow-up is due, and is looked at the moment it is', async () => {
  const c = closeWatch();
  c.w.add('close-a', true, c.at());
  assert.deepEqual(c.w.tick(), [], 'sent just now: nothing owed yet');
  c.move(CLOSE_FOLLOW_UP_MS - 1);
  assert.deepEqual(c.w.tick(), []);
  c.move(1);
  assert.deepEqual(c.w.tick(), ['close-a'], 'due: looked at');
});

test('[critical] thirty stops closing at once: every follow-up within about a second of its due moment, oldest first', async () => {
  const c = closeWatch();
  const sent = c.at();
  for (let i = 0; i < 30; i++) c.w.add(`close-${String(i).padStart(2, '0')}`, true, sent + i * 10);
  c.move(CLOSE_FOLLOW_UP_MS + 300);
  const seenAt = new Map<string, number>();
  for (let t = 0; t < 12 && seenAt.size < 30; t++) {
    for (const id of c.w.tick()) seenAt.set(id, c.at());
    await new Promise((r) => setImmediate(r));
    c.move(ENTRY_WATCH_MS);
  }
  assert.equal(seenAt.size, 30, 'all thirty looked at');
  const lateMs = Math.max(...[...seenAt.values()]) - (sent + 290 + CLOSE_FOLLOW_UP_MS);
  assert.ok(lateMs <= 1_250, `the last within ~1 s of due, not 12 (late ${lateMs} ms)`);
  assert.deepEqual([...seenAt.keys()].slice(0, CLOSE_WATCH_PER_LOOK), ['close-00', 'close-01', 'close-02', 'close-03', 'close-04', 'close-05'], 'oldest first');
});

test('[critical] a close still working after its look is due again at its new follow-up -- not looked at every beat', async () => {
  const c = closeWatch();
  c.working.add('close-w');
  c.w.add('close-w', true, c.at());
  c.move(CLOSE_FOLLOW_UP_MS);
  assert.deepEqual(c.w.tick(), ['close-w']);
  await new Promise((r) => setImmediate(r));
  c.move(ENTRY_WATCH_MS);
  assert.deepEqual(c.w.tick(), [], 'sent again at the market: owed its next look 1.5 s on');
  c.move(CLOSE_FOLLOW_UP_MS);
  assert.deepEqual(c.w.tick(), ['close-w']);
});

test('[critical] the closes\' own places never take the entries\' two; past the stops\' share of the quota, nothing', async () => {
  const c = closeWatch();
  for (let i = 0; i < 10; i++) c.w.add(`close-${i}`, true, c.at() - 5_000);
  c.w.add('entry-x'); c.w.add('entry-y');
  const first = c.w.tick();
  assert.equal(first.filter((id) => id.startsWith('close')).length, CLOSE_WATCH_PER_LOOK);
  assert.deepEqual(first.filter((id) => id.startsWith('entry')), ['entry-x', 'entry-y']);
  const busy = closeWatch({ quota: CLOSE_WATCH_QUOTA_PCT });
  busy.w.add('close-q', true, busy.at() - 5_000);
  assert.deepEqual(busy.w.tick(), []);
});
