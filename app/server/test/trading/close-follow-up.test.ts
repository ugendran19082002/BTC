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
const { EntryWatch, ENTRY_WATCH_MS, ENTRY_WATCH_QUOTA_PCT, CLOSE_WATCH_QUOTA_PCT, isUrgent } = await import('../../src/trading/entry-watch.js');

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
  const w = new EntryWatch({ poll: async (id) => { polled.push(id); return { phase: id.startsWith('close') ? 'exit_pending' : 'entry_pending', position: -1, closing: id.startsWith('close') ? {} : undefined }; }, quotaUsedPct: () => used });
  w.add('entry-1'); w.add('entry-2'); w.add('close-1', true);
  assert.deepEqual(w.tick(), ['close-1', 'entry-1'], 'the close first');
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
