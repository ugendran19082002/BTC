import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectLegs, type Candidate } from '../../src/strategy/select.js';
import {
  DEFAULT_CONFIG, MAX_STRIKE_BLOCKS, strikeBlockProblems, strikePickAt, validateConfig,
  type Strategy, type StrategyConfig, type StrikeBlock,
} from '../../src/strategy/types.js';

/**
 * The strike rule over a signal strategy's window (4 Oct 2026).
 *
 * A signal strategy takes signals for up to a day -- 5:35 PM to 5:29 PM -- and
 * one premium number cannot be right at both ends of it. The window is cut into
 * blocks, each with its own rule; these pin which rule is in force at a minute,
 * and what is refused before it can be saved.
 */

const premium = (at: string, mode: 'atLeast' | 'atMost', usd: number, fallbackUsd: number | null = null): StrikeBlock =>
  ({ at, strikeRule: 'premium', strikeStep: 0, premium: { mode, usd, fallbackUsd } });
const strict = (at: string, strikeStep: number): StrikeBlock =>
  ({ at, strikeRule: 'strict', strikeStep, premium: { mode: 'atMost', usd: 50, fallbackUsd: null } });

/** The owner's window: 23 h 54 m, cut every four hours -- 4, 4, 4, 4, 4 and the 3 h 54 m that is left. */
const DAY: StrategyConfig = {
  ...DEFAULT_CONFIG,
  trigger: 'signal',
  signal: { mode: 'single', tf: '5m', methods: ['breakout'], target: 'tp1', maxOpen: 1 },
  entryTime: '17:35', exitTime: '17:29',
  strikeRule: 'premium', premium: { mode: 'atMost', usd: 50, fallbackUsd: 75 },
  strikeBlocks: [
    premium('21:35', 'atMost', 40),
    premium('01:35', 'atMost', 30),
    strict('05:35', 2),
    premium('09:35', 'atLeast', 15, 10),
    premium('13:35', 'atMost', 8),
  ],
};
const min = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3));

test('[critical] before the first block the strategy\'s own rule is in force', () => {
  for (const t of ['17:35', '19:00', '21:34']) {
    const got = strikePickAt(DAY, min(t));
    assert.equal(got.block, 0, t);
    assert.equal(got.from, '17:35');
    assert.deepEqual(got.pick.premium, { mode: 'atMost', usd: 50, fallbackUsd: 75 });
  }
});

test('[critical] each block is in force from its own minute until the next -- round midnight too', () => {
  const at = (t: string) => strikePickAt(DAY, min(t));
  assert.equal(at('21:35').block, 1, 'the minute it starts');
  assert.equal(at('23:59').block, 1);
  assert.equal(at('00:00').block, 1, 'midnight is inside the 9:35 PM block, not back at the start');
  assert.equal(at('01:34').block, 1);
  assert.equal(at('01:35').block, 2);
  assert.deepEqual(at('03:00').pick.premium, { mode: 'atMost', usd: 30, fallbackUsd: null });
  assert.equal(at('05:35').block, 3);
  assert.equal(at('07:00').pick.strikeRule, 'strict');
  assert.equal(at('07:00').pick.strikeStep, 2);
  assert.equal(at('09:35').block, 4);
  assert.deepEqual(at('12:00').pick.premium, { mode: 'atLeast', usd: 15, fallbackUsd: 10 });
  assert.equal(at('13:35').block, 5);
  assert.equal(at('17:28').block, 5, 'the last block runs to the exit');
  assert.equal(at('17:28').from, '13:35');
});

test('a strategy saved before blocks existed reads as one rule all window', () => {
  const { strikeBlocks: _gone, ...old } = DAY;
  for (const t of ['17:35', '00:00', '09:00', '17:28']) {
    const got = strikePickAt(old as StrategyConfig, min(t));
    assert.equal(got.block, 0);
    assert.equal(got.pick.premium.usd, 50);
  }
  assert.equal(strikePickAt({ ...DAY, strikeBlocks: [] }, min('12:00')).block, 0);
});

test('[critical] the block in force decides the strike that is sold', () => {
  const leg = (strike: number, sellPrice: number): Candidate => ({ cp: 'P', strike, sellPrice, pOtm: 0.9, moneyness: 'OTM' });
  // Puts under an 85,000 spot, cheaper further out.
  const board = [leg(84_800, 62), leg(84_600, 44), leg(84_400, 33), leg(84_200, 21), leg(84_000, 12), leg(83_800, 6)];
  const sold = (t: string) => {
    const s: Strategy = { id: 's', name: 't', enabled: true, createdAt: 0, updatedAt: 0, config: { ...DAY, ...strikePickAt(DAY, min(t)).pick, legs: 'PE' } };
    return selectLegs(s, board, { spot: 85_000 }).legs[0];
  };
  assert.equal(sold('18:00')?.strike, 84_600, 'at most $50: the richest under it, 44');
  assert.equal(sold('22:00')?.strike, 84_400, 'at most $40: 33');
  assert.equal(sold('02:00')?.strike, 84_200, 'at most $30: 21');
  assert.equal(sold('06:00')?.strike, 84_600, 'OTM 2, whatever it pays');
  assert.equal(sold('10:00')?.strike, 84_200, 'at least $15: the furthest still paying it, 21');
  assert.equal(sold('14:00')?.strike, 83_800, 'at most $8: 6');
});

test('the blocks as saved are accepted', () => {
  assert.deepEqual(strikeBlockProblems(DAY.strikeBlocks, DAY.entryTime, DAY.exitTime), []);
  assert.deepEqual(validateConfig(DAY), []);
});

test('[critical] a block outside the window, or out of order, is refused in words', () => {
  const say = (blocks: StrikeBlock[]) => strikeBlockProblems(blocks, '09:00', '17:00');
  assert.match(say([premium('09:00', 'atMost', 20)])[0]!, /Block 2 \(9:00 AM\) must start after entry \(9:00 AM\) and before exit \(5:00 PM\)/);
  assert.match(say([premium('17:00', 'atMost', 20)])[0]!, /must start after entry/);
  assert.match(say([premium('18:00', 'atMost', 20)])[0]!, /must start after entry/, 'past the exit');
  assert.match(say([premium('13:00', 'atMost', 20), premium('11:00', 'atMost', 20)])[0]!, /Block 3 \(11:00 AM\) must start after block 2/);
  assert.match(say([premium('13:00', 'atMost', 20), premium('13:00', 'atMost', 10)])[0]!, /Block 3 .* must start after block 2/, 'the same minute twice');
  assert.match(say([{ ...premium('', 'atMost', 20) }])[0]!, /Block 2 needs a time of day/);
});

test('[critical] a block\'s rule is held to the same rules as the strategy\'s own', () => {
  const say = (b: unknown) => strikeBlockProblems([b], '09:00', '17:00');
  assert.match(say(premium('12:00', 'atMost', 0))[0]!, /Block 2: the premium must be a positive number of dollars/);
  assert.match(say(premium('12:00', 'atMost', 20, 15))[0]!, /Block 2: The fallback must be above \$20/);
  assert.match(say(premium('12:00', 'atLeast', 20, 30))[0]!, /Block 2: The fallback must be below \$20/);
  assert.match(say(strict('12:00', 21))[0]!, /Block 2: pick a strike between ITM 20 and OTM 20/);
  assert.match(say({ at: '12:00', strikeRule: 'oiWall', strikeStep: 0, premium: { mode: 'atMost', usd: 20 } })[0]!, /by premium or by strike/);
  assert.match(say({ at: '12:00', strikeRule: 'premium', strikeStep: 0, premium: { mode: 'sideways', usd: 20 } })[0]!, /"at least" or "at most"/);
  // A by-strike block's premium is not read, so a stale number in it is not a problem.
  assert.deepEqual(say({ ...strict('12:00', 1), premium: { mode: 'atMost', usd: 0 } }), []);
});

test('not a list, or more blocks than hours, is refused', () => {
  assert.deepEqual(strikeBlockProblems('every 4h', '09:00', '17:00'), ['The strike blocks must be a list.']);
  const many = Array.from({ length: MAX_STRIKE_BLOCKS + 1 }, (_, i) => premium(`${String(9 + Math.floor(i / 4)).padStart(2, '0')}:${String(1 + (i % 4) * 15).padStart(2, '0')}`, 'atMost', 20));
  assert.match(strikeBlockProblems(many, '09:00', '17:00')[0]!, /at most 24 times/);
});

test('[critical] blocks belong to a signal strategy: a clock strategy carrying them is refused', () => {
  const clock = { ...DEFAULT_CONFIG, strikeBlocks: [premium('09:00', 'atMost', 20)] };
  assert.ok(validateConfig(clock).some((m) => /Strike blocks are for a signal strategy/.test(m)));
  assert.deepEqual(validateConfig({ ...DEFAULT_CONFIG, strikeBlocks: [] }), []);
  assert.ok(validateConfig({ ...DAY, strikeBlocks: [premium('17:35', 'atMost', 20)] }).some((m) => /must start after entry/.test(m)));
});

// ------------------------------------------------------------ the nearest strike, on the rule and on a block

test('[critical] "at least OTM n" is a whole number from 1 to 20, or off -- on the rule and on a block', () => {
  const own = (minOtm: unknown) => validateConfig({ ...DAY, strikeBlocks: [], premium: { mode: 'atMost', usd: 50, minOtm: minOtm as number } });
  for (const ok of [null, undefined, 1, 6, 20]) assert.deepEqual(own(ok), [], String(ok));
  for (const bad of [0, 21, -3, 1.5, 'six']) {
    assert.deepEqual(own(bad), ['The nearest strike a premium rule may sell must be OTM 1 to OTM 20, or switched off.'], String(bad));
  }
  const block = (minOtm: unknown) => strikeBlockProblems(
    [{ at: '12:00', strikeRule: 'premium', strikeStep: 0, premium: { mode: 'atMost', usd: 20, minOtm } }], '09:00', '17:00');
  assert.deepEqual(block(6), []);
  assert.deepEqual(block(0), ['Block 2: The nearest strike a premium rule may sell must be OTM 1 to OTM 20, or switched off.']);
});

test('[critical] the else strike is OTM 1 to OTM 20 too, equal to the rule or not -- and is not read without a rule', () => {
  const own = (minOtm: unknown, elseOtm: unknown) => validateConfig({ ...DAY, strikeBlocks: [], premium: { mode: 'atMost', usd: 50, minOtm: minOtm as number, elseOtm: elseOtm as number } });
  for (const [m, e] of [[6, 6], [6, 8], [8, 6], [1, 20], [6, null], [6, undefined]]) assert.deepEqual(own(m, e), [], `${m}/${e}`);
  for (const bad of [0, 21, -1, 2.5, 'eight']) assert.deepEqual(own(6, bad), ['The else strike must be OTM 1 to OTM 20.'], String(bad));
  assert.deepEqual(own(0, 0), ['The nearest strike a premium rule may sell must be OTM 1 to OTM 20, or switched off.', 'The else strike must be OTM 1 to OTM 20.']);
  assert.deepEqual(own(null, 0), [], 'no rule: no else to be wrong');
  assert.deepEqual(
    strikeBlockProblems([{ at: '12:00', strikeRule: 'premium', strikeStep: 0, premium: { mode: 'atMost', usd: 20, minOtm: 6, elseOtm: 21 } }], '09:00', '17:00'),
    ['Block 2: The else strike must be OTM 1 to OTM 20.']);
});

test('[critical] each block has its own else strike, and it is the one sold in that block', () => {
  const leg = (strike: number, sellPrice: number): Candidate => ({ cp: 'P', strike, sellPrice, pOtm: 0.9, moneyness: 'OTM' });
  const board = [leg(84_800, 62), leg(84_600, 44), leg(84_400, 33), leg(84_200, 21), leg(84_000, 12), leg(83_800, 6)];
  const c: StrategyConfig = {
    ...DAY,
    premium: { mode: 'atMost', usd: 50, minOtm: 4, elseOtm: 5 },                       // picks OTM 2: else OTM 5
    strikeBlocks: [
      { at: '21:35', strikeRule: 'premium', strikeStep: 0, premium: { mode: 'atMost', usd: 50, minOtm: 4, elseOtm: 6 } },   // else OTM 6
      { at: '01:35', strikeRule: 'premium', strikeStep: 0, premium: { mode: 'atMost', usd: 50, minOtm: 4, elseOtm: 4 } },   // else = the rule
      { at: '05:35', strikeRule: 'premium', strikeStep: 0, premium: { mode: 'atMost', usd: 50, minOtm: 2, elseOtm: 6 } },   // rule met: OTM 2, else unread
    ],
  };
  const sold = (t: string) => {
    const s: Strategy = { id: 's', name: 't', enabled: true, createdAt: 0, updatedAt: 0, config: { ...c, ...strikePickAt(c, min(t)).pick, legs: 'PE' } };
    const l = selectLegs(s, board, { spot: 85_000 }).legs[0]!;
    return [l.strike, l.elseOtm];
  };
  assert.deepEqual(sold('18:00'), [84_000, 5]);
  assert.deepEqual(sold('22:00'), [83_800, 6]);
  assert.deepEqual(sold('02:00'), [84_200, 4]);
  assert.deepEqual(sold('06:00'), [84_600, undefined]);
});

test('[critical] each block carries its own floor, and it decides the strike sold in that block', () => {
  const leg = (strike: number, sellPrice: number): Candidate => ({ cp: 'P', strike, sellPrice, pOtm: 0.9, moneyness: 'OTM' });
  // OTM 1..6: 62, 44, 33, 21, 12, 6
  const board = [leg(84_800, 62), leg(84_600, 44), leg(84_400, 33), leg(84_200, 21), leg(84_000, 12), leg(83_800, 6)];
  const c: StrategyConfig = {
    ...DAY,
    premium: { mode: 'atMost', usd: 50, minOtm: 4 },                                  // would sell OTM 2 @ 44: the floor makes it OTM 4
    strikeBlocks: [
      { at: '21:35', strikeRule: 'premium', strikeStep: 0, premium: { mode: 'atMost', usd: 50, minOtm: 6 } },   // OTM 6
      { at: '01:35', strikeRule: 'premium', strikeStep: 0, premium: { mode: 'atMost', usd: 10, minOtm: 4 } },   // picks OTM 6 @ 6: further than 4, stands
      { at: '05:35', strikeRule: 'premium', strikeStep: 0, premium: { mode: 'atMost', usd: 50 } },              // no floor: OTM 2
    ],
  };
  const sold = (t: string) => {
    const s: Strategy = { id: 's', name: 't', enabled: true, createdAt: 0, updatedAt: 0, config: { ...c, ...strikePickAt(c, min(t)).pick, legs: 'PE' } };
    return selectLegs(s, board, { spot: 85_000 }).legs[0]!;
  };
  assert.deepEqual([sold('18:00').strike, sold('18:00').minOtm], [84_200, 4]);
  assert.deepEqual([sold('22:00').strike, sold('22:00').minOtm], [83_800, 6]);
  assert.deepEqual([sold('02:00').strike, sold('02:00').minOtm], [83_800, undefined], 'the premium\'s own pick, already past the floor');
  assert.deepEqual([sold('06:00').strike, sold('06:00').minOtm], [84_600, undefined]);
});
