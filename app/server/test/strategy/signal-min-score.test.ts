import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_SCORE, minScoreFor, minScoreProblems, signalRuleProblems } from '../../src/strategy/types.js';

/**
 * The minimum score (owner, 10 Nov 2026: "score enable 0 to 100, each timeframe, like the perp SL min"): a signal
 * strategy takes a signal only at its timeframe's setup score or more -- the chain's own number with the chain -- and
 * 0, a blank or no setting at all is off, as every strategy saved before it.
 */
const rule = { mode: 'single' as const, tf: '5m' as const, methods: ['breakout'], target: 'tp1' as const, maxOpen: 1 };

test('the number read per timeframe; 0 or absent is off; with the chain only the chain\'s own', () => {
  assert.equal(minScoreFor({ mode: 'single' }, '5m'), 0, 'no setting: off');
  assert.equal(minScoreFor({ mode: 'single', minScore: { '5m': 30 } }, '5m'), 30);
  assert.equal(minScoreFor({ mode: 'single', minScore: { '5m': 30 } }, '15m'), 0, 'another timeframe: off');
  assert.equal(minScoreFor({ mode: 'single', minScore: { '5m': 0 } }, '5m'), 0);
  assert.equal(minScoreFor({ mode: 'mtf', minScore: { '5m': 99, chain: 40 } }, '5m'), 40, 'with the chain: the chain\'s, not the 5m\'s');
  assert.equal(minScoreFor({ mode: 'mtf', minScore: { '5m': 99 } }, '5m'), 0, 'a timeframe\'s number is never carried to the chain');
});

test('whole numbers from 0 to 100, per timeframe or chain; anything else said in words', () => {
  assert.equal(MAX_SCORE, 100);
  assert.deepEqual(minScoreProblems(undefined), []);
  assert.deepEqual(minScoreProblems({ '5m': 0, '15m': 100, chain: 50 }), []);
  assert.deepEqual(minScoreProblems({ '5m': 101 }), ['The minimum score for 5m must be a whole number from 0 to 100.']);
  assert.deepEqual(minScoreProblems({ chain: -1 }), ['The minimum score with the chain must be a whole number from 0 to 100.']);
  assert.deepEqual(minScoreProblems({ '1h': 12.5 }), ['The minimum score for 1h must be a whole number from 0 to 100.']);
  assert.deepEqual(minScoreProblems({ '1h': '20' }), ['The minimum score for 1h must be a whole number from 0 to 100.']);
  assert.deepEqual(minScoreProblems({ '7m': 20 }), ['No such timeframe for a minimum score: 7m.']);
  assert.deepEqual(minScoreProblems([20]), ['The minimum score must be given per timeframe.']);
  // And through the rule's own check, beside the rest of it.
  assert.deepEqual(signalRuleProblems({ ...rule, minScore: { '5m': 30 } }), []);
  assert.ok(signalRuleProblems({ ...rule, minScore: { '5m': 300 } }).includes('The minimum score for 5m must be a whole number from 0 to 100.'));
});
