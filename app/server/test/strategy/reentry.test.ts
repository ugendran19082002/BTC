import { test } from 'node:test';
import assert from 'node:assert/strict';
import { REENTRY_DEFAULT, reentryOf, reentryProblem } from '../../src/strategy/types.js';
import { optionStopped } from '../../src/trading/option-stop.js';
import { ceProduct, planFor, quote, rig } from '../trading/harness.js';

/** Re-entry after an option SL (1 Nov 2026): the setting, and which closes count as the option's stop. */

test('[critical] re-entry is off until set, two in a row and the lots once; unreadable or out of range is the default', () => {
  assert.deepEqual(REENTRY_DEFAULT, { on: false, max: 2, size: 1 });
  for (const raw of [null, '', 'not json', '[1]', '{"on":"yes"}']) assert.deepEqual(reentryOf(raw), { on: false, max: 2, size: 1 }, String(raw));
  assert.deepEqual(reentryOf('{"on":true,"max":3,"size":2}'), { on: true, max: 3, size: 2 });
  assert.deepEqual(reentryOf('{"on":true,"max":6,"size":8}'), { on: true, max: 2, size: 1 });
  assert.deepEqual(reentryOf('{"on":true,"max":1.5,"size":0}'), { on: true, max: 2, size: 1 });
});

test('[critical] a re-entry setting is saved only whole: on, 1 to 5 in a row, 1 to 7 times the lots', () => {
  assert.equal(reentryProblem(null), null);
  assert.equal(reentryProblem({ on: true, max: 2, size: 1 }), null);
  assert.equal(reentryProblem({ on: false, max: 5, size: 7 }), null);
  assert.match(reentryProblem({ on: true, max: 0, size: 1 })!, /in a row must be a whole number from 1 to 5/);
  assert.match(reentryProblem({ on: true, max: 6, size: 1 })!, /from 1 to 5/);
  assert.match(reentryProblem({ on: true, max: 2, size: 8 })!, /times the lots, from 1 to 7/);
  assert.match(reentryProblem({ on: true, max: 2 })!, /times the lots/);
  assert.match(reentryProblem({ on: 'yes', max: 2, size: 1 })!, /true or false/);
  assert.match(reentryProblem([2])!, /"on": true, "max": 2, "size": 1/);
});

test('[critical] the desk\'s stop watch closing a trade is an option stop; a close by hand is not', async () => {
  const CE = ceProduct().symbol;
  const r = rig({ products: [ceProduct()], quotes: [quote(CE, 100.5, 101)], limits: { allowPyramiding: true } });
  for (const id of ['stopped', 'by-hand']) {
    assert.equal((await r.engine.open(planFor(ceProduct(), { tradeId: id, stopPrice: 110, lots: 10 }))).ok, true);
    await r.engine.poll(id);
  }
  await r.engine.closeNow('by-hand', 'manual exit');
  // The offer through the stop for its seconds: the watch closes it, in its own words.
  for (let s = 0; s <= 3; s++) {
    if (s) r.advance(1_000);
    r.ex.tick(quote(CE, 111, 112, { ts: r.now(), mark: 100 }));
    await r.engine.checkStops(CE, ['stopped']);
  }
  const stopped = (await r.store.get('stopped'))!;
  const byHand = (await r.store.get('by-hand'))!;
  assert.equal(stopped.state.position, 0);
  assert.equal(byHand.state.position, 0);
  assert.equal(optionStopped(stopped.state, stopped.events), true);
  assert.equal(optionStopped(byHand.state, byHand.events), false);
  // The stop resting at Delta filling is one too, whatever the journal says.
  assert.equal(optionStopped({ exitWinner: 'stop_loss' }, []), true);
  assert.equal(optionStopped({ exitWinner: 'take_profit' }, []), false);
  assert.equal(optionStopped({ exitWinner: 'manual' }, [{ t: 'exit_submitted', role: 'manual', clientOrderId: 'x', reason: 'BTC perp at 84590 reached the signal\'s stop 84600', at: 0 }]), false, 'the perp\'s stop is not the option\'s');
});
