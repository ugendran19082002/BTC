import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SIGNAL_SWAP_DEFAULT, signalSwapOf, signalSwapProblem } from '../../src/strategy/types.js';

/** Swap on every signal (owner, 20 Nov 2026): the setting, per account, off unless set. */
test('[critical] off unless set; 90% kept and 20 a minute by default', () => {
  assert.deepEqual(SIGNAL_SWAP_DEFAULT, { on: false, pct: 90, perMin: 20 });
  assert.deepEqual(signalSwapOf(null), SIGNAL_SWAP_DEFAULT);
  assert.deepEqual(signalSwapOf(''), SIGNAL_SWAP_DEFAULT);
  assert.deepEqual(signalSwapOf('not json'), SIGNAL_SWAP_DEFAULT);
  assert.deepEqual(signalSwapOf('[1]'), SIGNAL_SWAP_DEFAULT);
});

test('a saved setting reads back; a number out of range falls back to its default', () => {
  assert.deepEqual(signalSwapOf('{"on":true,"pct":80,"perMin":10}'), { on: true, pct: 80, perMin: 10 });
  assert.deepEqual(signalSwapOf('{"on":true,"pct":99,"perMin":120}'), { on: true, pct: 99, perMin: 120 });
  assert.deepEqual(signalSwapOf('{"on":true,"pct":100,"perMin":0}'), { on: true, pct: 90, perMin: 20 });
  assert.deepEqual(signalSwapOf('{"on":"yes","pct":49.5}'), { on: false, pct: 90, perMin: 20 });
});

test('what cannot be saved says why in words; null is back to the default and can', () => {
  assert.equal(signalSwapProblem(null), null);
  assert.equal(signalSwapProblem({ on: true }), null);
  assert.equal(signalSwapProblem({ on: true, pct: 80, perMin: 5 }), null);
  assert.equal(signalSwapProblem({ on: false, pct: 50 }), null);
  assert.match(signalSwapProblem({ on: 'yes' })!, /on: true or false/);
  assert.match(signalSwapProblem({ on: true, pct: 49 })!, /whole per cent from 50 to 99/);
  assert.match(signalSwapProblem({ on: true, pct: 100 })!, /whole per cent from 50 to 99/);
  assert.match(signalSwapProblem({ on: true, pct: 85.5 })!, /whole per cent from 50 to 99/);
  assert.match(signalSwapProblem({ on: true, perMin: 0 })!, /1 to 120/);
  assert.match(signalSwapProblem({ on: true, perMin: 121 })!, /1 to 120/);
  assert.match(signalSwapProblem([1])!, /\{"on": true/);
  assert.match(signalSwapProblem('on')!, /\{"on": true/);
});
