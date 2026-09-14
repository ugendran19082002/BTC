import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shockGate } from '../../src/strategy/gate.js';
import { holdFor, noteHold, clearHold, resetHolds, statusOf } from '../../src/strategy/holds.js';

/**
 * The sudden-move gate: enter only while the tape is calm enough.
 *
 * The thing that must not happen is an unreadable tape passing for a calm one.
 * A desk one minute old can take no reading at all, and "no reading" scored as
 * zero would be a gate that opens widest exactly when it knows least.
 */

const reading = (score: number | null, reasons: string[] = []) =>
  ({ score, band: 'normal' as const, reasons });

test('off is off: no reading is taken and nothing is held', () => {
  assert.deepEqual(shockGate(null, null), { pass: true, reason: null });
  assert.deepEqual(shockGate(null, reading(99)), { pass: true, reason: null });
});

test('[critical] at the limit passes -- "25 or less" includes 25', () => {
  assert.equal(shockGate(25, reading(25)).pass, true);
  assert.equal(shockGate(25, reading(24)).pass, true);
  assert.equal(shockGate(25, reading(26)).pass, false);
});

test('[critical] an unreadable tape is not a calm one', () => {
  const v = shockGate(25, reading(null));
  assert.equal(v.pass, false);
  assert.match(v.reason!, /could not be read/);

  // and the same when the reading itself could not be assembled at all
  assert.equal(shockGate(25, null).pass, false);
});

test('a refusal carries the number and why it is that number', () => {
  const v = shockGate(25, reading(62, [
    '5m range is 2.4x what it was priced for',
    '5m volume is 3.1x its median',
    'positioning is lopsided at 0.44 puts per call',
  ]));
  assert.equal(v.pass, false);
  assert.match(v.reason!, /62\/100/);
  assert.match(v.reason!, /above the 25 limit/);
  assert.match(v.reason!, /2\.4x what it was priced for/);
  // two reasons, not every reason: this goes in a line on a card
  assert.ok(!v.reason!.includes('lopsided'));
});

test('a reading with no reasons still says the number', () => {
  const v = shockGate(10, reading(40));
  assert.match(v.reason!, /40\/100, above the 10 limit$/);
});

// ---------------------------------------------------------------------------

test('[critical] a hold is about one day, and never shows against another', () => {
  resetHolds();
  noteHold('s1', '2026-09-14', 'sudden-move risk is 62/100', 1000);
  assert.equal(holdFor('s1', '2026-09-14')?.reason, 'sudden-move risk is 62/100');
  assert.equal(holdFor('s1', '2026-09-15'), null, 'yesterday\'s reason is not today\'s');
  assert.equal(holdFor('s2', '2026-09-14'), null);
});

test('a hold is cleared the moment the answer changes', () => {
  resetHolds();
  noteHold('s1', '2026-09-14', 'waiting', 1000);
  clearHold('s1');
  assert.equal(holdFor('s1', '2026-09-14'), null);
});

test('the newest reason replaces the last one', () => {
  resetHolds();
  noteHold('s1', '2026-09-14', 'first', 1000);
  noteHold('s1', '2026-09-14', 'second', 2000);
  assert.equal(holdFor('s1', '2026-09-14')?.reason, 'second');
  assert.equal(holdFor('s1', '2026-09-14')?.at, 2000);
});

test('[critical] a hold is what the screen says, instead of "due now"', () => {
  // The clock said due, the desk waited, and the screen said "due now" minute
  // after minute while nothing happened.
  assert.equal(statusOf({ due: true }, null), 'due now');
  assert.equal(
    statusOf({ due: true }, { day: 'd', reason: 'sudden-move risk is 62/100', at: 1 }),
    'sudden-move risk is 62/100',
  );
});

test('a stale hold never talks over a fact about the day', () => {
  assert.equal(
    statusOf({ due: false, because: 'already ran today (2026-09-14)' },
      { day: 'd', reason: 'sudden-move risk is 62/100', at: 1 }),
    'already ran today (2026-09-14)',
  );
});
