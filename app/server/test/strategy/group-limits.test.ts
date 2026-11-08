import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemorySettings, groupKey, groupOwn, groupSetting } from '../../src/db/settings.js';
import { NO_GROUP_OWN, countsOwn, groupBlock, groupLimitsOf, groupOwnOf } from '../../src/strategy/group-limits.js';

/**
 * A group's own limits (owner, 8 Nov 2026: "every account has these settings, but change them for each group"). A group's
 * value where it sets one, its account's where it does not; the account's limits over every trade stay, the group's count
 * its own strategies' trades.
 */

const ACCOUNT = { cap: 300, sidePct: { CE: 80, PE: 80 }, strikePct: 15 };
const open = (ce: number, pe: number) => [...Array(ce).fill({ optionSide: 'CE' as const }), ...Array(pe).fill({ optionSide: 'PE' as const })];

test('[critical] a group\'s value where it sets one, its account\'s where it does not; empty is none of its own', () => {
  const s = new MemorySettings({ 'signal_max_open@1': '300', [groupKey('signal_max_open', 'g-a')]: '120', [groupKey('signal_ce_max_pct', 'g-a')]: '' });
  assert.equal(groupSetting(s, 'signal_max_open', 1, 'g-a'), '120');
  assert.equal(groupSetting(s, 'signal_max_open', 1, 'g-b'), '300', 'another group: the account\'s');
  assert.equal(groupSetting(s, 'signal_max_open', 1, null), '300', 'no group: the account\'s');
  assert.equal(groupOwn(s, 'signal_ce_max_pct', 'g-a'), null, 'stored empty: none of its own');
  assert.equal(groupKey('signal_max_open', 'g-a'), 'signal_max_open@g:g-a');
});

test('[critical] a group\'s own settings read: each parsed as the account\'s are; a bad at most open is none, not "no limit"', () => {
  const s = new MemorySettings({
    [groupKey('signal_max_open', 'g')]: '150', [groupKey('signal_ce_max_pct', 'g')]: '70', [groupKey('signal_strike_full', 'g')]: 'skip',
    [groupKey('signal_momentum_guard', 'g')]: JSON.stringify({ on: true, pts: 200 }),
  });
  const own = groupOwnOf(s, 'g');
  assert.deepEqual([own.maxOpen, own.ce, own.pe, own.strikeMax, own.strikeFull, own.momentum], [150, 70, null, null, 'skip', { on: true, pts: 200 }]);
  assert.deepEqual(groupOwnOf(s, null), NO_GROUP_OWN);
  assert.equal(groupOwnOf(new MemorySettings({ [groupKey('signal_max_open', 'g')]: 'lots' }), 'g').maxOpen, null);
});

test('[critical] a group that sets none of the counted limits counts nothing of its own: its account\'s alone stand', () => {
  const own = { ...NO_GROUP_OWN, strikeFull: 'skip' as const, momentum: { on: true, pts: 200 } };
  assert.equal(countsOwn(own), false);
  assert.equal(groupLimitsOf(own, ACCOUNT), null);
});

test('[critical] its own at most open, over its own trades: at it, a signal of the group\'s is skipped in words', () => {
  const lim = groupLimitsOf({ ...NO_GROUP_OWN, maxOpen: 100 }, ACCOUNT)!;
  assert.deepEqual([lim.cap, lim.own, lim.sides, lim.strikeCap], [100, true, { CE: 80, PE: 80 }, 15]);
  assert.equal(groupBlock(lim, open(40, 59), 'PE', 'Scalps'), null);
  assert.equal(groupBlock(lim, open(40, 60), 'PE', 'Scalps'), 'the group Scalps already has 100 open -- at most 100 at once in the group');
});

test('[critical] its own side limit is of its own at most open; with none of its own, of the account\'s', () => {
  const own = groupLimitsOf({ ...NO_GROUP_OWN, maxOpen: 100, ce: 50 }, ACCOUNT)!;
  assert.equal(groupBlock(own, open(49, 0), 'CE', 'G'), null);
  assert.equal(groupBlock(own, open(50, 0), 'CE', 'G'), "the group G already has 50 CE open -- at most 50 CE (50% of the group's 100)");
  assert.equal(groupBlock(own, open(50, 0), 'PE', 'G'), null, 'the other side is not touched');
  // A side's own share and no cap of its own: a per cent of the account's 300, over the group's trades.
  const side = groupLimitsOf({ ...NO_GROUP_OWN, pe: 10 }, ACCOUNT)!;
  assert.deepEqual([side.cap, side.own, side.sides], [300, false, { CE: 240, PE: 30 }]);
  assert.match(groupBlock(side, open(0, 30), 'PE', 'G')!, /at most 30 PE \(10% of the group's 300\)/);
  // No cap of its own: 239 CE is under the side's 240, and the 300 itself is the account's to hold, over every trade.
  assert.equal(groupBlock(side, open(239, 0), 'CE', 'G'), null);
});

test('its own strike limit: a per cent of its own at most open', () => {
  assert.equal(groupLimitsOf({ ...NO_GROUP_OWN, maxOpen: 100, strikeMax: 5 }, ACCOUNT)!.strikeCap, 5);
  assert.equal(groupLimitsOf({ ...NO_GROUP_OWN, strikeMax: 5 }, ACCOUNT)!.strikeCap, 15, '5% of the account\'s 300');
  assert.equal(groupLimitsOf({ ...NO_GROUP_OWN, maxOpen: 100, strikeMax: 100 }, ACCOUNT)!.strikeCap, null, '100%: no limit of its own');
});
