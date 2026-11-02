import { test } from 'node:test';
import assert from 'node:assert/strict';
import { REENTRY_DEFAULT, reentryKeepingEntries, reentryOf, reentryOpenAt, reentryProblem } from '../../src/strategy/types.js';
import { optionExitOf } from '../../src/trading/option-exit.js';
import { ceProduct, planFor, quote, rig } from '../trading/harness.js';

/** Re-entry after an option exit (1 Nov 2026): the setting, its time range, and which closes are the option's own. */

const SL = { on: true, from: '07:00', to: '17:29', entries: 1 };
const TGT = { on: true, from: '07:00', to: '10:00', entries: 1 };

test('[critical] re-entry is off until set: after an SL all day, after a target 7-10 AM; no most in a row; one trade an exit', () => {
  assert.deepEqual(REENTRY_DEFAULT, { sl: { ...SL, on: false }, tgt: { ...TGT, on: false } });
  for (const raw of [null, '', 'not json', '[1]', '{"sl":"yes"}']) assert.deepEqual(reentryOf(raw), REENTRY_DEFAULT, String(raw));
  assert.deepEqual(reentryOf(JSON.stringify({ sl: { ...SL, entries: 2 }, tgt: { ...TGT, from: '08:00', entries: 4 } })),
    { sl: { ...SL, entries: 2 }, tgt: { ...TGT, from: '08:00', entries: 4 } });
  // out of range or unreadable, field by field: that field's default; a size is not a field (the strategy's lots), nor a max (2 Nov 2026)
  assert.deepEqual(reentryOf(JSON.stringify({ sl: { on: true, from: '7am', to: '17:29', max: 6, size: 3, entries: 5 }, tgt: { on: true, max: 1, entries: 0 } })),
    { sl: SL, tgt: TGT });
});

test('[critical] the first shape -- {on, max, size}, after an SL only -- reads as the SL rule all day, its size not read; the target rule stays off', () => {
  assert.deepEqual(reentryOf('{"on":true,"max":3,"size":2}'), { sl: SL, tgt: { ...TGT, on: false } });
  assert.deepEqual(reentryOf('{"on":false,"max":2,"size":1}'), REENTRY_DEFAULT);
});

test('[critical] a re-entry setting is saved only whole: both rules, each on, a range of two times; a max from an older page is not read', () => {
  assert.equal(reentryProblem(null), null);
  assert.equal(reentryProblem({ sl: SL, tgt: TGT }), null);
  assert.equal(reentryProblem({ sl: { ...SL, from: '22:00', to: '06:00', max: 0 }, tgt: { ...TGT, max: 9 } }), null, 'past midnight is a range too; a max is not read');
  assert.match(reentryProblem({ sl: SL })!, /\{"sl": \{\.\.\.\}, "tgt": \{\.\.\.\}\}/);
  assert.match(reentryProblem({ sl: { ...SL, on: 'yes' }, tgt: TGT })!, /^After an SL: say whether it is on/);
  assert.match(reentryProblem({ sl: SL, tgt: { ...TGT, to: '10' } })!, /^After a target: the time range is two IST times/);
  assert.match(reentryProblem({ sl: SL, tgt: { ...TGT, to: '07:00' } })!, /not start and end at the same minute/);
  assert.match(reentryProblem({ sl: SL, tgt: { ...TGT, entries: 5 } })!, /^After a target: trades at once must be a whole number from 1 to 4/);
  assert.match(reentryProblem({ sl: { ...SL, entries: 1.5 }, tgt: TGT })!, /^After an SL: trades at once/);
});

test('[critical] trades at once (2 Nov 2026): 1 to 4 a rule; a page that sends none keeps the number saved rather than going back to one', () => {
  const { entries: _sl, ...slWithout } = SL;
  const { entries: _tgt, ...tgtWithout } = TGT;
  assert.equal(reentryProblem({ sl: slWithout, tgt: tgtWithout }), null, 'none sent is not a problem');
  const saved = reentryOf(JSON.stringify({ sl: { ...SL, entries: 3 }, tgt: { ...TGT, entries: 2 } }));
  assert.deepEqual(reentryOf(JSON.stringify(reentryKeepingEntries({ sl: { ...slWithout, max: 4 }, tgt: tgtWithout }, saved))),
    { sl: { ...SL, entries: 3 }, tgt: { ...TGT, entries: 2 } });
  assert.deepEqual(reentryOf(JSON.stringify(reentryKeepingEntries({ sl: { ...SL, entries: 4 }, tgt: TGT }, saved))),
    { sl: { ...SL, entries: 4 }, tgt: TGT }, 'one sent is the one kept');
});

test('a rule\'s time range: its first minute in, its last out; one past midnight wraps', () => {
  const at = (h: number, m = 0) => h * 60 + m;
  assert.equal(reentryOpenAt(TGT, at(7)), true);
  assert.equal(reentryOpenAt(TGT, at(9, 59)), true);
  assert.equal(reentryOpenAt(TGT, at(10)), false);
  assert.equal(reentryOpenAt(TGT, at(6, 59)), false);
  assert.equal(reentryOpenAt({ from: '22:00', to: '06:00' }, at(23)), true);
  assert.equal(reentryOpenAt({ from: '22:00', to: '06:00' }, at(5, 59)), true);
  assert.equal(reentryOpenAt({ from: '22:00', to: '06:00' }, at(12)), false);
});

test('[critical] the desk\'s stop watch closing a trade is an option stop; its target filling is a target; a close by hand is neither', async () => {
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
  assert.equal(optionExitOf(stopped.state, stopped.events), 'stop');
  assert.equal(optionExitOf(byHand.state, byHand.events), null);
  // The stop resting at Delta filling is one, whatever the journal says; the target resting there is the other.
  assert.equal(optionExitOf({ exitWinner: 'stop_loss' }, []), 'stop');
  assert.equal(optionExitOf({ exitWinner: 'take_profit' }, []), 'target');
  assert.equal(optionExitOf({ exitWinner: 'manual' }, [{ t: 'exit_submitted', role: 'manual', clientOrderId: 'x', reason: 'BTC perp at 84590 reached the signal\'s stop 84600', at: 0 }]), null, 'the perp\'s stop is not the option\'s');
  assert.equal(optionExitOf({ exitWinner: 'take_profit' }, stopped.events), 'stop', 'a stop judged while the target filled is a stop');
});
