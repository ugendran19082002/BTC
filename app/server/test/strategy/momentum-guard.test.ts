import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MOMENTUM_GUARD_DEFAULT, momentumBlocks, momentumGuardOf, momentumGuardProblem, momentumPtsAt, momentumWords } from '../../src/strategy/types.js';

/**
 * The momentum guard, one account's (owner, 30 Oct 2026: "Momentum 1h >= +250, CE mattum, default off"): no call sold
 * while the perp has risen its points or more in the hour. Stored as JSON; whatever cannot be read is off.
 */

test('[critical] off unless set; stored: on and its points, a figure out of range keeps 250', () => {
  assert.deepEqual(MOMENTUM_GUARD_DEFAULT, { on: false, pts: 250, unit: 'pts', pct: 0.25 });
  for (const raw of [null, '', 'not json', '[1]', '{"on":"yes"}']) assert.deepEqual(momentumGuardOf(raw), { on: false, pts: 250, unit: 'pts', pct: 0.25 }, String(raw));
  assert.deepEqual(momentumGuardOf('{"on":true,"pts":300}'), { on: true, pts: 300, unit: 'pts', pct: 0.25 }, 'saved before the unit: points');
  assert.deepEqual(momentumGuardOf('{"on":true,"pts":10}'), { on: true, pts: 250, unit: 'pts', pct: 0.25 });
  assert.deepEqual(momentumGuardOf('{"on":true,"pts":250.5}'), { on: true, pts: 250, unit: 'pts', pct: 0.25 });
});

test('[critical] what it holds back: a call to be sold, the guard on, the rise at its points or more -- nothing else', () => {
  const on = { on: true, pts: 250, unit: 'pts' as const, pct: 0.25 };
  assert.equal(momentumBlocks(on, 'CE', 250), true, 'at the points');
  assert.equal(momentumBlocks(on, 'CE', 555), true);
  assert.equal(momentumBlocks(on, 'CE', 249), false, 'a point short');
  assert.equal(momentumBlocks(on, 'CE', -400), false, 'a fall');
  assert.equal(momentumBlocks(on, 'PE', 555), false, 'puts are never held back');
  assert.equal(momentumBlocks(on, null, 555), false, 'nor an option bought');
  assert.equal(momentumBlocks(on, 'CE', null), false, 'a rise that cannot be read holds nothing back');
  assert.equal(momentumBlocks({ ...on, on: false }, 'CE', 555), false, 'off');
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

/** 14 Nov 2026 (owner "0.25% of price"): the rise as a per cent of the perp's price, so it scales with BTC. */
test('[critical] per cent of the price: read, saved, and turned into points at the perp now', () => {
  assert.deepEqual(momentumGuardOf('{"on":true,"pts":200,"unit":"pct","pct":0.25}'), { on: true, pts: 200, unit: 'pct', pct: 0.25 });
  assert.deepEqual(momentumGuardOf('{"on":true,"pts":200,"unit":"pct","pct":9}'), { on: true, pts: 200, unit: 'pct', pct: 0.25 }, 'out of range keeps 0.25');
  assert.deepEqual(momentumGuardOf('{"on":true,"pts":200,"unit":"weird"}').unit, 'pts');
  const g = momentumGuardOf('{"on":true,"pts":200,"unit":"pct","pct":0.25}');
  assert.equal(momentumPtsAt(g, 67_500), 168.75, '0.25% of 67,500');
  assert.equal(momentumPtsAt(g, 100_000), 250, 'and of 1,00,000');
  assert.equal(momentumPtsAt(g, null), null, 'no price, no level');
  assert.equal(momentumPtsAt({ ...g, unit: 'pts' }, 67_500), 200, 'points ignore the price');
  assert.equal(momentumBlocks(g, 'CE', 169, 67_500), true, 'at 0.25%');
  assert.equal(momentumBlocks(g, 'CE', 168, 67_500), false, 'a point short');
  assert.equal(momentumBlocks(g, 'CE', 240, 100_000), false, 'the same rise at 1,00,000 is under 0.25%');
  assert.equal(momentumBlocks(g, 'CE', 250, 100_000), true);
  assert.equal(momentumBlocks(g, 'CE', 999, null), false, 'no price: nothing held back');
  assert.equal(momentumBlocks(g, 'PE', 999, 67_500), false, 'puts are never held back');
  assert.equal(momentumWords(g, 67_567), '0.25% (169 pts at 67567)');
  assert.equal(momentumWords(g, null), '0.25%');
  assert.equal(momentumWords({ ...g, unit: 'pts' }, 67_567), '200', 'points worded as before');
  assert.equal(momentumGuardProblem({ on: true, unit: 'pct', pct: 0.25 }), null, 'points not needed for a per cent');
  assert.equal(momentumGuardProblem({ on: true, unit: 'pct', pct: 0.25, pts: 200 }), null);
  assert.equal(momentumGuardProblem({ on: true, unit: 'pts', pts: 200, pct: 0.25 }), null);
  assert.match(momentumGuardProblem({ on: true, unit: 'pct', pct: 0.04 })!, /per cent from 0.05 to 2/);
  assert.match(momentumGuardProblem({ on: true, unit: 'pct', pct: 0.255 })!, /two decimals/);
  assert.match(momentumGuardProblem({ on: true, unit: 'pct' })!, /per cent/);
  assert.match(momentumGuardProblem({ on: true, unit: 'pct', pct: 0.25, pts: 10 })!, /whole points/);
  assert.match(momentumGuardProblem({ on: true, unit: 'bps', pts: 200 })!, /"pts" or "pct"/);
});
