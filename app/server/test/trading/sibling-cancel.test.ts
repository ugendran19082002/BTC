import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rig, ceProduct, planFor, quote, type Rig } from './harness.js';
import { LEFTOVER_ALARM_MS } from '../../src/trading/engine.js';

/**
 * The other exit, once one has won (1 Oct 2026).
 *
 * When the target fills, the stop has to come off the book, and the record must
 * say it is off only when it is. Until 1 Oct 2026 `cancelSiblings` wrote
 * `sibling_cancelled` whatever happened -- a lookup that failed, a cancel the
 * venue did not honour -- and the desk forgot an order that could still be
 * resting: a reduce-only buy which, with two trades on one contract (0011),
 * buys back the other trade's contracts. And a flat trade is never polled
 * again, so nothing would ever have tried it a second time.
 *
 * What must hold:
 *   - a leg is struck off the record only once the venue confirms it is gone;
 *   - an unconfirmed leg on a finished trade is tried again by `sweepLeftovers`;
 *   - a minute of it is said out loud, once;
 *   - a close still goes out when the cancel cannot be confirmed: a stop that
 *     does not exit is worse than a reduce-only order resting a moment longer.
 */

const CE = 'C-BTC-80000-080926';

/** 100 CE sold at 100.5, target 90, stop 110, both on the book. */
async function short100() {
  const r = rig({ quotes: [quote(CE, 100.5, 101)] });
  const plan = planFor(ceProduct());
  await r.engine.open(plan);
  await r.engine.poll(plan.tradeId);
  const armed = r.store.peek(plan.tradeId)!.state;
  assert.ok(armed.protection.takeProfit && armed.protection.stopLoss, 'both legs are on to begin with');
  return { r, id: plan.tradeId };
}

/** The venue takes cancels quietly and does nothing, until `restore` is called. */
function ignoreCancels(r: Rig) {
  const real = r.ex.cancelOrder.bind(r.ex);
  r.ex.cancelOrder = async () => {};
  return { restore: () => { r.ex.cancelOrder = real; } };
}

const resting = async (r: Rig) => (await r.ex.getOpenOrders(CE)).map((o) => o.type);
const cancelledRoles = (r: Rig, id: string) => r.store.peek(id)!.events
  .filter((e) => e.t === 'sibling_cancelled').map((e) => (e as { role: string }).role);

/** The offer comes down through the 90 target, which fills. */
async function targetFills(r: Rig, id: string) {
  r.ex.tick(quote(CE, 88, 89, { ts: r.now() }));
  const s = await r.engine.poll(id);
  assert.equal(s?.position, 0);
  assert.equal(s?.exitWinner, 'take_profit');
  return s!;
}

test('[critical] a stop the venue would not cancel stays on the record, and the sweep takes it off later', async () => {
  const { r, id } = await short100();
  const venue = ignoreCancels(r);

  const s = await targetFills(r, id);
  assert.ok(s.protection.stopLoss, 'the stop is still on the record: nobody confirmed it gone');
  assert.ok(!cancelledRoles(r, id).includes('stop_loss'), 'and it is not written down as cancelled');
  assert.deepEqual(await resting(r), ['stop_limit'], 'because it is in fact still resting');
  assert.deepEqual(await r.engine.sweepLeftovers(), [id], 'the sweep is still waiting on it');

  venue.restore();
  assert.deepEqual(await r.engine.sweepLeftovers(), [], 'once the venue honours the cancel, nothing is left');
  assert.deepEqual(await resting(r), []);
  assert.equal(r.store.peek(id)!.state.protection.stopLoss, null);
});

test('[critical] a lookup that fails is not a confirmed cancel', async () => {
  const { r, id } = await short100();
  const stop = r.store.peek(id)!.state.protection.stopLoss!;
  const get = r.ex.getOrderByClientId.bind(r.ex);
  let down = true;
  r.ex.getOrderByClientId = async (cid) => {
    if (down && cid === stop) throw new Error('socket hang up');
    return get(cid);
  };

  const s = await targetFills(r, id);
  assert.ok(s.protection.stopLoss, 'could not ask is not gone');
  assert.ok(r.swallowed.some((x) => x.what === 'cancel sibling'), 'and the failure is written down');

  down = false;
  assert.deepEqual(await r.engine.sweepLeftovers(), []);
  assert.deepEqual(await resting(r), []);
});

test('[critical] a minute without a confirmation is said out loud, once', async () => {
  const { r, id } = await short100();
  ignoreCancels(r);
  await targetFills(r, id);
  await r.engine.sweepLeftovers();
  assert.equal(r.alarms.length, 0, 'a blip is not an alarm');

  r.advance(LEFTOVER_ALARM_MS);
  await r.engine.sweepLeftovers();
  await r.engine.sweepLeftovers();
  const said = r.alarms.filter((a) => a.tradeId === id);
  assert.equal(said.length, 1, `said once: ${JSON.stringify(said)}`);
  assert.match(said[0]!.message, /stop cancelled at Delta.*cancel it by hand/);
});

test('[critical] a close still goes out when its exits cannot be confirmed off the book', async () => {
  const { r, id } = await short100();
  const venue = ignoreCancels(r);

  const s = await r.engine.closeNow(id);
  assert.equal(s?.position, 0, 'the position is closed regardless');
  assert.deepEqual(cancelledRoles(r, id), [], 'but neither exit is written down as cancelled');
  assert.deepEqual(await r.engine.sweepLeftovers(), [id]);

  venue.restore();
  assert.deepEqual(await r.engine.sweepLeftovers(), []);
  assert.deepEqual(await resting(r), [], 'both exits come off once the venue answers');
});

test('when the cancels work, nothing is left over and the sweep has nothing to do', async () => {
  const { r, id } = await short100();
  await targetFills(r, id);
  assert.deepEqual(cancelledRoles(r, id), ['stop_loss']);
  assert.deepEqual(await r.engine.sweepLeftovers(), []);
  assert.deepEqual(await resting(r), []);
});
