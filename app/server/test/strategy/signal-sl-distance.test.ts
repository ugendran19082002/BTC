import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_SL_PTS, minSlPtsFor, signalRuleProblems, type SignalRule } from '../../src/strategy/types.js';

/**
 * The SL-distance filter of a signal strategy (4 Oct 2026): without the chain,
 * each timeframe has its own least distance, in BTC points, from the perp entry
 * to the signal's SL. These pin which number a signal is held to, and what is
 * refused before it can be saved; the runner's use of it is in
 * test/e2e/signal-strategy.test.ts.
 */
const rule = (over: Partial<SignalRule> = {}): SignalRule =>
  ({ mode: 'single', tf: '5m', tfs: ['5m', '15m'], methods: ['breakout'], target: 'tp1', maxOpen: 1, ...over });

test('[critical] each timeframe is held to its own number, and one with none is not filtered', () => {
  const r = rule({ minSlPts: { '5m': 150, '15m': 300 } });
  assert.equal(minSlPtsFor(r, '5m'), 150);
  assert.equal(minSlPtsFor(r, '15m'), 300);
  assert.equal(minSlPtsFor(r, '1h'), 0, 'no number for 1h: no filter');
  assert.equal(minSlPtsFor(rule(), '5m'), 0, 'a strategy saved before the filter existed');
  assert.equal(minSlPtsFor(rule({ minSlPts: { '5m': 0 } }), '5m'), 0, 'zero is off');
});

test('[critical] with the timeframe chain the filter is not read', () => {
  assert.equal(minSlPtsFor(rule({ mode: 'mtf', minSlPts: { '5m': 150 } }), '5m'), 0);
});

test('[critical] a distance is 0 to 100,000 points on a real timeframe -- anything else is refused in words', () => {
  assert.deepEqual(signalRuleProblems(rule({ minSlPts: { '5m': 150, '4h': 1200.5 } })), []);
  assert.deepEqual(signalRuleProblems(rule({ minSlPts: {} })), []);
  assert.deepEqual(signalRuleProblems(rule({ minSlPts: { '5m': -1 } })), ['The SL distance for 5m must be from 0 to 100,000 points.']);
  assert.deepEqual(signalRuleProblems(rule({ minSlPts: { '5m': MAX_SL_PTS + 1 } })), ['The SL distance for 5m must be from 0 to 100,000 points.']);
  assert.deepEqual(signalRuleProblems(rule({ minSlPts: { '5m': 'far' as unknown as number } })), ['The SL distance for 5m must be from 0 to 100,000 points.']);
  assert.deepEqual(signalRuleProblems(rule({ minSlPts: { '2m': 100 } as SignalRule['minSlPts'] })), ['No such timeframe for an SL distance: 2m.']);
  assert.deepEqual(signalRuleProblems(rule({ minSlPts: [150] as unknown as SignalRule['minSlPts'] })), ['The SL distances must be given per timeframe.']);
});
