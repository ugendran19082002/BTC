import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemorySettings, groupKey } from '../../src/db/settings.js';
import { NO_GROUP_OWN, countsOwn, groupLimitsOf, groupOwnOf } from '../../src/strategy/group-limits.js';
import { STRIKE_FIXED_MAX, strikeFixedOf, strikeFixedProblem, strikeMostOf, strikeRuleWords } from '../../src/strategy/types.js';
import { CONTRACT_TRADES_MAX, strikeLimitOf } from '../../src/trading/contract-restrictions.js';
import { deskCapsOf } from '../../src/report/signal-backtest.js';

/**
 * The most on one strike as a fixed number (owner, 26 Nov 2026: "% and fixed rendu-um venum"): either rule, the fixed
 * number in force where it is set, the per cent where it is not; held under the cap and under what Delta lets a contract carry.
 */

test('[critical] the fixed number read: 1 to 48 whole; empty, absent or anything else is none (the per cent rules)', () => {
  assert.equal(STRIKE_FIXED_MAX, CONTRACT_TRADES_MAX, 'the largest that can bind: what Delta lets one contract carry');
  assert.deepEqual(['1', '48', ' 20 '].map(strikeFixedOf), [1, 48, 20]);
  assert.deepEqual([null, undefined, '', '0', '49', '2.5', 'ten', '-3'].map(strikeFixedOf), [null, null, null, null, null, null, null, null]);
  assert.equal(strikeFixedProblem(null), null, 'null: back to the per cent');
  assert.deepEqual([1, 48].map(strikeFixedProblem), [null, null]);
  for (const bad of [0, 49, 2.5, '10', true]) assert.match(strikeFixedProblem(bad) ?? '', /from 1 to 48/, String(bad));
});

test('[critical] the limit by either rule: the fixed number under the cap; with no cap it still holds; the per cent as before', () => {
  assert.equal(strikeMostOf(400, 12, null), 48, '12% of 400, as before');
  assert.equal(strikeMostOf(400, 12, 30), 30, 'fixed: the per cent waits unused');
  assert.equal(strikeMostOf(20, 12, 30), 20, 'never more than the account may hold');
  assert.equal(strikeMostOf(0, 12, 30), 30, 'no "at most open": the fixed number still holds');
  assert.equal(strikeMostOf(0, 12, null), null, 'no cap and a per cent: nothing to take it of');
  assert.equal(strikeMostOf(400, 100, null), null, '100%: none of its own');
  assert.deepEqual(strikeLimitOf(strikeMostOf(400, 100, 48)), { most: 48, byDelta: false }, '48 fixed: the strike rule, not Delta\'s');
  assert.equal(strikeRuleWords(400, 12, 30), 'a fixed 30 a strike');
  assert.equal(strikeRuleWords(400, 12, null), '12% of the 400');
  assert.equal(strikeRuleWords(100, 5, null, "the group's"), "5% of the group's 100");
});

test('[critical] a group: its own fixed number, or its own per cent (an account\'s fixed number does not override it), or the account\'s rule whole', () => {
  const account = { cap: 300, sidePct: { CE: 80, PE: 80 }, strikePct: 10, strikeFixed: 25 };
  assert.equal(groupLimitsOf({ ...NO_GROUP_OWN, strikeFixed: 7 }, account)!.strikeCap, 7);
  const ownPct = groupLimitsOf({ ...NO_GROUP_OWN, maxOpen: 100, strikeMax: 5 }, account)!;
  assert.deepEqual([ownPct.strikeCap, ownPct.strikeFixed], [5, null], 'its per cent: of its own 100');
  const inherits = groupLimitsOf({ ...NO_GROUP_OWN, maxOpen: 100 }, account)!;
  assert.deepEqual([inherits.strikeCap, inherits.strikeFixed], [25, 25], 'neither of its own: the account\'s fixed number');
  assert.equal(groupLimitsOf({ ...NO_GROUP_OWN, maxOpen: 100 }, { ...account, strikeFixed: null })!.strikeCap, 10, 'the account\'s per cent, of the group\'s 100');
  assert.equal(countsOwn({ ...NO_GROUP_OWN, strikeFixed: 3 }), true, 'a fixed number of its own: the group counts its own trades');
  const s = new MemorySettings({ [groupKey('signal_strike_max_fixed', 'g')]: '12', [groupKey('signal_strike_max_fixed', 'h')]: '', [groupKey('signal_strike_max_fixed', 'k')]: '99' });
  assert.deepEqual(['g', 'h', 'k'].map((g) => groupOwnOf(s, g).strikeFixed), [12, null, null], 'stored empty or unreadable: none of its own');
});

test('a live check holds a fixed strike as the runner does', () => {
  assert.equal(deskCapsOf({ deskMax: 400, cePct: 80, pePct: 80, strikePct: 12, strikeFixed: 30 })!.strike, 30);
  assert.equal(deskCapsOf({ deskMax: 400, cePct: 80, pePct: 80, strikePct: 12 })!.strike, 48, 'no fixed number: the per cent, as before');
});
