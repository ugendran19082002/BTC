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
