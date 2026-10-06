import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CHAIN_PTS, MAX_SL_PTS, maxSlPtsFor, maxTgtPtsFor, minSlPtsFor, minTgtPtsFor, signalRuleProblems, type SignalRule } from '../../src/strategy/types.js';

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

test('[critical] with the timeframe chain a timeframe\'s number is not read: a rule switched to the chain brings no filter with it', () => {
  assert.equal(minSlPtsFor(rule({ mode: 'mtf', minSlPts: { '5m': 150 } }), '5m'), 0);
});

test('[critical] with the chain the filter is the chain\'s own number -- SL and TGT, least and most -- and it is not read without the chain (6 Oct 2026)', () => {
  assert.equal(CHAIN_PTS, 'chain');
  // The live case: a rule copied from one without the chain, its timeframes' numbers still on it, then given the chain's own.
  const r = rule({ mode: 'mtf', minSlPts: { '5m': 100, '4h': 100, chain: 180 }, maxSlPts: { chain: 600 }, minTgtPts: { '5m': 100, chain: 250 }, maxTgtPts: { chain: 900 } });
  assert.deepEqual([minSlPtsFor(r, '5m'), maxSlPtsFor(r, '5m'), minTgtPtsFor(r, '5m'), maxTgtPtsFor(r, '5m')], [180, 600, 250, 900]);
  // Off until it is set: the leftover numbers alone filter nothing.
  const left = rule({ mode: 'mtf', minSlPts: { '5m': 100, '4h': 100 }, minTgtPts: { '5m': 100, '4h': 100 } });
  assert.deepEqual([minSlPtsFor(left, '5m'), maxSlPtsFor(left, '5m'), minTgtPtsFor(left, '5m'), maxTgtPtsFor(left, '5m')], [0, 0, 0, 0]);
  assert.equal(minSlPtsFor(rule({ mode: 'mtf', minSlPts: { chain: 0 } }), '5m'), 0, 'zero is off');
  // Without the chain the chain's number is nobody's: each timeframe keeps its own.
  const single = rule({ minSlPts: { '5m': 150, chain: 999 } });
  assert.deepEqual([minSlPtsFor(single, '5m'), minSlPtsFor(single, '15m')], [150, 0]);
});

test('[critical] the chain\'s numbers are held to the same limits, and said as the chain\'s', () => {
  const chain = (over: Partial<SignalRule>) => rule({ mode: 'mtf', ...over });
  assert.deepEqual(signalRuleProblems(chain({ minSlPts: { chain: 180 }, maxSlPts: { chain: 600 }, minTgtPts: { chain: 250 }, maxTgtPts: { chain: 900 } })), []);
  assert.deepEqual(signalRuleProblems(chain({ minSlPts: { chain: -1 } })), ['The SL distance with the chain must be from 0 to 100,000 points.']);
  assert.deepEqual(signalRuleProblems(chain({ maxTgtPts: { chain: MAX_SL_PTS + 1 } })), ['The TGT maximum distance with the chain must be from 0 to 100,000 points.']);
  assert.deepEqual(signalRuleProblems(chain({ minSlPts: { chain: 300 }, maxSlPts: { chain: 100 } })),
    ['The SL maximum with the chain (100) is under its minimum (300): no signal could pass both.']);
  assert.deepEqual(signalRuleProblems(chain({ minTgtPts: { chain: 500 }, maxTgtPts: { chain: 400 } })),
    ['The TGT maximum with the chain (400) is under its minimum (500): no signal could pass both.']);
  // A key that is neither a timeframe nor the chain is still refused.
  assert.deepEqual(signalRuleProblems(chain({ minSlPts: { chains: 100 } as SignalRule['minSlPts'] })), ['No such timeframe for an SL distance: chains.']);
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

// ------------------------------------------------------------ the same filter on the target

test('[critical] the TGT distance is its own number per timeframe, 0 or absent being off', () => {
  const r = rule({ minSlPts: { '5m': 150 }, minTgtPts: { '5m': 300, '15m': 0 } });
  assert.equal(minTgtPtsFor(r, '5m'), 300);
  assert.equal(minSlPtsFor(r, '5m'), 150, 'the SL keeps its own');
  assert.equal(minTgtPtsFor(r, '15m'), 0, 'zero is off');
  assert.equal(minTgtPtsFor(r, '1h'), 0, 'no number: off');
  assert.equal(minTgtPtsFor(rule(), '5m'), 0, 'a strategy saved before it existed');
  assert.equal(minTgtPtsFor(rule({ mode: 'mtf', minTgtPts: { '5m': 300 } }), '5m'), 0, 'not read with the chain');
});

test('[critical] a TGT distance is held to the same limits as the SL\'s, and said by its own name', () => {
  assert.deepEqual(signalRuleProblems(rule({ minTgtPts: { '5m': 300, '4h': 900.5 } })), []);
  assert.deepEqual(signalRuleProblems(rule({ minTgtPts: { '5m': -1 } })), ['The TGT distance for 5m must be from 0 to 100,000 points.']);
  assert.deepEqual(signalRuleProblems(rule({ minTgtPts: { '5m': MAX_SL_PTS + 1 } })), ['The TGT distance for 5m must be from 0 to 100,000 points.']);
  assert.deepEqual(signalRuleProblems(rule({ minTgtPts: { '2m': 100 } as SignalRule['minTgtPts'] })), ['No such timeframe for a TGT distance: 2m.']);
  assert.deepEqual(signalRuleProblems(rule({ minTgtPts: [300] as unknown as SignalRule['minTgtPts'] })), ['The TGT distances must be given per timeframe.']);
  // both wrong: both said
  assert.deepEqual(signalRuleProblems(rule({ minSlPts: { '5m': -1 }, minTgtPts: { '5m': -1 } })),
    ['The SL distance for 5m must be from 0 to 100,000 points.', 'The TGT distance for 5m must be from 0 to 100,000 points.']);
});

// ------------------------------------------------------------ the desk-wide cap, as stored

test('[critical] the desk-wide cap reads 0 -- no cap -- for anything that is not a whole number from 1 to 500', async () => {
  const { globalMaxOpenOf, globalMaxOpenProblem, MAX_GLOBAL_OPEN } = await import('../../src/strategy/types.js');
  for (const [raw, n] of [['6', 6], ['1', 1], ['500', 500], [null, 0], [undefined, 0], ['', 0], ['0', 0], ['501', 0], ['-2', 0], ['2.5', 0], ['many', 0]] as const) {
    assert.equal(globalMaxOpenOf(raw), n, String(raw));
  }
  assert.equal(MAX_GLOBAL_OPEN, 500);
  for (const ok of [0, 1, 6, 500]) assert.equal(globalMaxOpenProblem(ok), null);
  for (const bad of [-1, 501, 1.5, '6', null, undefined]) assert.match(globalMaxOpenProblem(bad)!, /whole number from 0 \(no limit\) to 500/);
});

test('[critical] a cap above what the switched-on strategies allow between them is refused, with their sum', async () => {
  const { globalMaxOpenProblem, signalEntriesAllowed, DEFAULT_CONFIG } = await import('../../src/strategy/types.js');
  const sig = (maxOpen: number, enabled = true, trigger: 'signal' | 'time' = 'signal') => ({
    enabled, config: { ...DEFAULT_CONFIG, trigger, signal: { mode: 'single' as const, tf: '5m' as const, methods: ['breakout'], target: 'tp1' as const, maxOpen } },
  });
  // 1 + 9 + 10 + 7 + 1 on; one switched off and one clock strategy are not counted
  const all = [sig(1), sig(9), sig(10), sig(7), sig(1), sig(50, false), sig(30, true, 'time')];
  assert.equal(signalEntriesAllowed(all), 28);
  assert.equal(globalMaxOpenProblem(28, 28), null, 'the sum itself');
  assert.equal(globalMaxOpenProblem(6, 28), null);
  assert.equal(globalMaxOpenProblem(0, 28), null, '0 is always no limit');
  assert.equal(globalMaxOpenProblem(29, 28), 'The strategies switched on allow 28 entries between them, so a limit above 28 changes nothing. Enter 28 or less.');
  assert.equal(globalMaxOpenProblem(2, 1), 'The strategies switched on allow 1 entry between them, so a limit above 1 changes nothing. Enter 1 or less.');
  // none switched on: there is no sum to hold it to
  assert.equal(signalEntriesAllowed([sig(5, false)]), 0);
  assert.equal(globalMaxOpenProblem(40, 0), null);
});
