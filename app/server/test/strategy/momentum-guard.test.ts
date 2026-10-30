import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MOMENTUM_GUARD_DEFAULT, momentumBlocks, momentumGuardOf, momentumGuardProblem } from '../../src/strategy/types.js';

/**
 * The momentum guard, one account's (owner, 30 Oct 2026: "Momentum 1h >= +250, CE mattum, default off"): no call sold
 * while the perp has risen its points or more in the hour. Stored as JSON; whatever cannot be read is off.
 */

test('[critical] off unless set; stored: on and its points, a figure out of range keeps 250', () => {
  assert.deepEqual(MOMENTUM_GUARD_DEFAULT, { on: false, pts: 250 });
  for (const raw of [null, '', 'not json', '[1]', '{"on":"yes"}']) assert.deepEqual(momentumGuardOf(raw), { on: false, pts: 250 }, String(raw));
  assert.deepEqual(momentumGuardOf('{"on":true,"pts":300}'), { on: true, pts: 300 });
  assert.deepEqual(momentumGuardOf('{"on":true,"pts":10}'), { on: true, pts: 250 });
  assert.deepEqual(momentumGuardOf('{"on":true,"pts":250.5}'), { on: true, pts: 250 });
});

test('[critical] what it holds back: a call to be sold, the guard on, the rise at its points or more -- nothing else', () => {
  const on = { on: true, pts: 250 };
  assert.equal(momentumBlocks(on, 'CE', 250), true, 'at the points');
  assert.equal(momentumBlocks(on, 'CE', 555), true);
  assert.equal(momentumBlocks(on, 'CE', 249), false, 'a point short');
  assert.equal(momentumBlocks(on, 'CE', -400), false, 'a fall');
  assert.equal(momentumBlocks(on, 'PE', 555), false, 'puts are never held back');
  assert.equal(momentumBlocks(on, null, 555), false, 'nor an option bought');
  assert.equal(momentumBlocks(on, 'CE', null), false, 'a rise that cannot be read holds nothing back');
  assert.equal(momentumBlocks({ on: false, pts: 250 }, 'CE', 555), false, 'off');
});

test('what may be saved: on true or false, whole points 50 to 2000; null is back to off', () => {
  assert.equal(momentumGuardProblem(null), null);
  assert.equal(momentumGuardProblem({ on: true, pts: 250 }), null);
  assert.equal(momentumGuardProblem({ on: false, pts: 50 }), null);
  assert.equal(momentumGuardProblem({ on: true, pts: 2_000 }), null);
  assert.match(momentumGuardProblem({ on: true, pts: 49 })!, /whole points from 50 to 2000/);
  assert.match(momentumGuardProblem({ on: true, pts: 250.5 })!, /whole points/);
  assert.match(momentumGuardProblem({ on: true })!, /whole points/);
  assert.match(momentumGuardProblem({ on: 'yes', pts: 250 })!, /true or false/);
  assert.match(momentumGuardProblem([250])!, /"on": true, "pts": 250/);
});
