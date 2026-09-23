import { test } from 'node:test';
import assert from 'node:assert/strict';
import { outcomeWords, verdictFor } from '../../src/market/state-history.js';
import type { Candle } from '../../src/market/delta.js';
import type { Plan } from '../../src/domain/market-state.js';

const bar = (high: number, low: number): Candle =>
  ({ time: 0, open: (high + low) / 2, high, low, close: (high + low) / 2, volume: 1 });

const long: Plan = { side: 'UP', trigger: 86_800, target1: 87_200, target2: 87_600, invalidation: 86_400 };
const short: Plan = { side: 'DOWN', trigger: 86_200, target1: 85_800, target2: 85_400, invalidation: 86_600 };

test('[critical] the target before the invalidation is correct; the other way round is wrong', () => {
  assert.equal(verdictFor(long, 'UP', [bar(86_900, 86_700), bar(87_250, 86_850)]), 'CORRECT');
  assert.equal(verdictFor(long, 'UP', [bar(86_900, 86_700), bar(86_800, 86_350)]), 'WRONG');
  assert.equal(verdictFor(short, 'DOWN', [bar(86_150, 85_750)]), 'CORRECT');
  assert.equal(verdictFor(short, 'DOWN', [bar(86_650, 86_100)]), 'WRONG');
});

test('[critical] a bar that reaches both counts against the call', () => {
  /*
   * Which came first is not in the bar, and the assumption that goes against
   * the call is the only one that cannot flatter the hit rate.
   */
  assert.equal(verdictFor(long, 'UP', [bar(87_300, 86_300)]), 'WRONG');
});

test('[critical] going neither way is unresolved, not a win', () => {
  // Price drifted the right way and reached nothing. Counting that as correct
  // is how a hit rate ends up describing the grader rather than the model.
  assert.equal(verdictFor(long, 'UP', [bar(87_000, 86_700), bar(87_100, 86_900)]), 'UNRESOLVED');
  assert.equal(verdictFor(long, 'UP', []), 'UNRESOLVED', 'no bars yet is not a verdict either');
});

test('a call with no plan behind it is not graded at all', () => {
  // A range says nothing is happening, and nothing happening is not a
  // prediction anybody can be wrong about.
  assert.equal(verdictFor(null, null, [bar(87_300, 86_300)]), 'NOT_GRADED');
  assert.equal(verdictFor(long, null, [bar(87_300, 86_300)]), 'NOT_GRADED');
});

test('the words the list shows for each verdict', () => {
  assert.equal(outcomeWords('CORRECT'), 'Correct');
  assert.equal(outcomeWords('WRONG'), 'Wrong');
  assert.equal(outcomeWords('UNRESOLVED'), 'No follow-through');
  assert.equal(outcomeWords('NOT_GRADED'), '—');
  assert.equal(outcomeWords(null), '—', 'not graded yet reads the same as never graded');
});
