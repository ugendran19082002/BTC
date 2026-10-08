import { describe, expect, it } from 'vitest';
import {
  appliedWords, applyToAllBlocks, blockHoursOf, blockNow, blockRanges, blocksWords, hoursLabel, istMinuteOf, ownPick, pickWords, splitBlocks,
  strikeBlockProblems,
} from '@/lib/strategy-blocks';
import { strategyProblems } from '@/lib/strategy-rules';
import { describeStrategy } from '@/lib/strategy-preview';
import { DEFAULT_CONFIG, DEFAULT_SIGNAL_RULE, MAX_STRIKE_BLOCKS, type StrategyConfig, type StrikeBlock } from '@/types/strategy';

/**
 * The strike rule over a signal strategy's window (4 Oct 2026): the window cut
 * into blocks, each with its own rule. The split and the checks are pure, and
 * the checks say what the server's `strikeBlockProblems` says, word for word
 * (app/server/test/strategy/strike-blocks.test.ts pins those).
 */
const cfg = (over: Partial<StrategyConfig> = {}): StrategyConfig => ({
  ...DEFAULT_CONFIG,
  trigger: 'signal', signal: { ...DEFAULT_SIGNAL_RULE, methods: ['breakout'] }, liveOrders: false, lots: 3,
  entryTime: '17:35', exitTime: '17:29',
  strikeRule: 'premium', premium: { mode: 'atMost', usd: 50, fallbackUsd: 75 },
  ...over,
});
const premium = (at: string, usd: number, mode: 'atLeast' | 'atMost' = 'atMost', fallbackUsd: number | null = null): StrikeBlock =>
  ({ at, strikeRule: 'premium', strikeStep: 0, premium: { mode, usd, fallbackUsd } });
const strict = (at: string, strikeStep: number): StrikeBlock =>
  ({ at, strikeRule: 'strict', strikeStep, premium: { mode: 'atMost', usd: 50, fallbackUsd: null } });

describe('splitting the window', () => {
  it('[critical] 5:35 PM to 5:29 PM every 4 hours: 4, 4, 4, 4, 4 and the 3 h 54 min left', () => {
    const blocks = splitBlocks(cfg(), 240);
    expect(blocks.map((b) => b.at)).toEqual(['21:35', '01:35', '05:35', '09:35', '13:35']);
    const c = cfg({ strikeBlocks: blocks });
    expect(blockRanges(c).map((r) => r!.minutes)).toEqual([240, 240, 240, 240, 240, 234]);
    expect(blockRanges(c).at(-1)).toEqual({ from: '13:35', until: '17:29', minutes: 234 });
    expect(blockRanges(c)[0]).toEqual({ from: '17:35', until: '21:35', minutes: 240 });
  });

  it('[critical] the length is whatever is typed: 6 hours, 2 hours, 90 minutes', () => {
    expect(splitBlocks(cfg(), 360).map((b) => b.at)).toEqual(['23:35', '05:35', '11:35']);
    expect(splitBlocks(cfg(), 120)).toHaveLength(11);
    expect(splitBlocks(cfg({ entryTime: '09:00', exitTime: '17:00' }), 90).map((b) => b.at)).toEqual(['10:30', '12:00', '13:30', '15:00', '16:30']);
  });

  it('a block never starts at the exit: 8 hours cut by 4 is two blocks, not three', () => {
    expect(splitBlocks(cfg({ entryTime: '09:00', exitTime: '17:00' }), 240).map((b) => b.at)).toEqual(['13:00']);
  });

  it('every new block starts as the strategy\'s own rule', () => {
    for (const b of splitBlocks(cfg(), 240)) {
      expect(b.strikeRule).toBe('premium');
      expect(b.premium).toEqual({ mode: 'atMost', usd: 50, fallbackUsd: 75 });
    }
    expect(splitBlocks(cfg({ strikeRule: 'strict', strikeStep: 2 }), 240)[0]).toMatchObject({ strikeRule: 'strict', strikeStep: 2 });
  });

  it('[critical] splitting again keeps what was typed, where its time still falls', () => {
    const typed = cfg({ strikeBlocks: [premium('21:35', 40), premium('05:35', 20), strict('13:35', 2)] });
    const again = splitBlocks(typed, 120);
    const at = (t: string) => again.find((b) => b.at === t)!;
    expect(at('19:35').premium.usd).toBe(50);          // still the strategy's own
    expect(at('21:35').premium.usd).toBe(40);
    expect(at('03:35').premium.usd).toBe(40);          // inside the 9:35 PM block
    expect(at('05:35').premium.usd).toBe(20);
    expect(at('15:35')).toMatchObject({ strikeRule: 'strict', strikeStep: 2 });
  });

  it('a window shorter than one length, a bad time or a zero length makes no blocks', () => {
    expect(splitBlocks(cfg({ entryTime: '09:00', exitTime: '11:00' }), 240)).toEqual([]);
    expect(splitBlocks(cfg({ entryTime: '' }), 240)).toEqual([]);
    expect(splitBlocks(cfg(), 0)).toEqual([]);
  });

  it(`never more than ${MAX_STRIKE_BLOCKS}`, () => {
    expect(splitBlocks(cfg(), 10)).toHaveLength(MAX_STRIKE_BLOCKS);
  });

  it('an open-interest rule has no block of its own: its blocks start by premium', () => {
    expect(ownPick(cfg({ strikeRule: 'oiWall' })).strikeRule).toBe('premium');
  });
});

describe('in words', () => {
  it('a block\'s rule, short', () => {
    expect(pickWords(premium('21:35', 40))).toBe('≤ $40');
    expect(pickWords(premium('21:35', 15, 'atLeast', 10))).toBe('≥ $15 (if none, ≥ $10)');
    expect(pickWords(strict('21:35', 2))).toBe('OTM 2');
    expect(pickWords(strict('21:35', 0))).toBe('ATM');
  });

  it('hours', () => {
    expect([hoursLabel(240), hoursLabel(234), hoursLabel(45)]).toEqual(['4 h', '3 h 54 min', '45 min']);
  });

  it('[critical] the rule sentence names every block, and says nothing new when there are none', () => {
    expect(blocksWords(cfg())).toBe('');
    const c = cfg({ strikeBlocks: [premium('21:35', 40), strict('05:35', 2)] });
    expect(blocksWords(c)).toBe(' — then from 9:35 PM ≤ $40, from 5:35 AM OTM 2');
    expect(describeStrategy(c)).toContain('(none? then the last strike at or below $75) — then from 9:35 PM ≤ $40, from 5:35 AM OTM 2, 3 lots');
    expect(describeStrategy(cfg())).not.toContain('then from');
  });
});

describe('what is refused -- the server\'s words', () => {
  const say = (blocks: StrikeBlock[], entry = '09:00', exit = '17:00') => strikeBlockProblems(blocks, entry, exit);

  it('a good split has nothing wrong with it', () => {
    const c = cfg();
    expect(strikeBlockProblems(splitBlocks(c, 240), c.entryTime, c.exitTime)).toEqual([]);
    expect(strikeBlockProblems(undefined, '09:00', '17:00')).toEqual([]);
  });

  it('[critical] outside the window, or out of order: said against the block it is on', () => {
    expect(say([premium('09:00', 20)])).toEqual([{ index: 0, message: 'Block 2 (9:00 AM) must start after entry (9:00 AM) and before exit (5:00 PM).' }]);
    expect(say([premium('18:00', 20)])[0]!.message).toMatch(/must start after entry/);
    expect(say([premium('13:00', 20), premium('11:00', 20)])).toEqual([{ index: 1, message: 'Block 3 (11:00 AM) must start after block 2.' }]);
    expect(say([premium('', 20)])[0]!.message).toBe('Block 2 needs a time of day, like 9:35 PM.');
  });

  it('[critical] a block\'s premium and fallback are held to the strategy\'s own rules', () => {
    expect(say([premium('12:00', 0)])[0]!.message).toBe('Block 2: the premium must be a positive number of dollars.');
    expect(say([premium('12:00', 20, 'atMost', 15)])[0]!.message).toBe('Block 2: The fallback must be above $20: it is tried when nothing is at or below $20.');
    expect(say([premium('12:00', 20, 'atLeast', 30)])[0]!.message).toBe('Block 2: The fallback must be below $20: it is tried when nothing pays $20.');
    expect(say([strict('12:00', 21)])[0]!.message).toBe('Block 2: pick a strike between ITM 20 and OTM 20, or at the money.');
  });

  it('[critical] on the form they are problems of the Strike & lots tab, and stop a save', () => {
    const bad = strategyProblems(cfg({ strikeBlocks: [premium('17:35', 20)] }), 'S');
    expect(bad).toEqual([{ field: 'strikeBlocks', tab: 'sell', message: 'Block 2 (5:35 PM) must start after entry (5:35 PM) and before exit (5:29 PM).' }]);
    expect(strategyProblems(cfg({ strikeBlocks: splitBlocks(cfg(), 240) }), 'S')).toEqual([]);
  });

  it('moving the window leaves the blocks behind, and that is said', () => {
    const c = cfg({ strikeBlocks: splitBlocks(cfg(), 240) });
    const moved = { ...c, entryTime: '09:00', exitTime: '17:00' };
    const found = strategyProblems(moved, 'S').map((p) => p.message);
    expect(found.some((m) => /Block 2 \(9:35 PM\) must start after entry \(9:00 AM\) and before exit \(5:00 PM\)/.test(m))).toBe(true);
  });
});

describe('the distance rule and its else strike', () => {
  const floored = (minOtm: number | null, elseOtm?: number | null) => cfg({ premium: { mode: 'atMost', usd: 50, fallbackUsd: 75, minOtm, elseOtm } });

  it('[critical] in words: on the rule, on a block, and in the sentence -- "else" is the else strike, "if none" the second premium', () => {
    expect(pickWords({ strikeRule: 'premium', strikeStep: 0, premium: { mode: 'atMost', usd: 50, fallbackUsd: 75, minOtm: 6, elseOtm: 8 } })).toBe('≤ $50 (if none, ≤ $75) at OTM 6 or further, else OTM 8');
    expect(pickWords({ strikeRule: 'premium', strikeStep: 0, premium: { mode: 'atLeast', usd: 15, minOtm: 3, elseOtm: 3 } })).toBe('≥ $15 at OTM 3 or further, else OTM 3');
    // saved before the else had a strike of its own: it is the rule's strike
    expect(pickWords({ strikeRule: 'premium', strikeStep: 0, premium: { mode: 'atLeast', usd: 15, minOtm: 3 } })).toBe('≥ $15 at OTM 3 or further, else OTM 3');
    expect(pickWords({ strikeRule: 'strict', strikeStep: 2, premium: { mode: 'atMost', usd: 50, minOtm: 6, elseOtm: 8 } })).toBe('OTM 2');
    expect(describeStrategy(floored(6, 8))).toContain('(none? then the last strike at or below $75), only at OTM 6 or further — else sells OTM 8, 3 lots');
    expect(describeStrategy(floored(6))).toContain('only at OTM 6 or further — else sells OTM 6, 3 lots');
    expect(describeStrategy(floored(null))).not.toContain('or further');
  });

  it('[critical] each a whole number from OTM 1 to OTM 20 -- the server\'s words, on the Strike & lots tab', () => {
    for (const [m, e] of [[null, null], [1, 1], [6, 8], [8, 6], [20, 20], [6, undefined]] as const) expect(strategyProblems(floored(m, e), 'S')).toEqual([]);
    for (const bad of [0, 21, 2.5]) {
      expect(strategyProblems(floored(bad, 6), 'S')).toEqual([
        { field: 'premiumMinOtm', tab: 'sell', message: 'The nearest strike a premium rule may sell must be OTM 1 to OTM 20, or switched off.' },
      ]);
      expect(strategyProblems(floored(6, bad), 'S')).toEqual([
        { field: 'premiumMinOtm', tab: 'sell', message: 'The else strike must be OTM 1 to OTM 20.' },
      ]);
    }
    // with no rule there is no else to be wrong
    expect(strategyProblems(floored(null, 0), 'S')).toEqual([]);
  });

  it('[critical] a block has its own two strikes, held to the same rule', () => {
    const b = (minOtm: number | null, elseOtm?: number): StrikeBlock => ({ at: '12:00', strikeRule: 'premium', strikeStep: 0, premium: { mode: 'atMost', usd: 20, fallbackUsd: null, minOtm, elseOtm } });
    expect(strikeBlockProblems([b(6, 9)], '09:00', '17:00')).toEqual([]);
    expect(strikeBlockProblems([b(0, 6)], '09:00', '17:00')).toEqual([
      { index: 0, message: 'Block 2: The nearest strike a premium rule may sell must be OTM 1 to OTM 20, or switched off.' },
    ]);
    expect(strikeBlockProblems([b(6, 21)], '09:00', '17:00')).toEqual([{ index: 0, message: 'Block 2: The else strike must be OTM 1 to OTM 20.' }]);
    // a by-strike block names its strike: a rule left on it is not read
    expect(strikeBlockProblems([{ ...b(0, 0), strikeRule: 'strict', strikeStep: 2 }], '09:00', '17:00')).toEqual([]);
  });

  it('splitting carries the rule\'s two strikes into every new block', () => {
    for (const blk of splitBlocks(floored(6, 8), 240)) expect([blk.premium.minOtm, blk.premium.elseOtm]).toEqual([6, 8]);
    for (const blk of splitBlocks(floored(null), 240)) expect(blk.premium.minOtm ?? null).toBeNull();
  });
});

describe('the split length, read back from the saved blocks', () => {
  it('[critical] a window split every 3 hours and saved reads as 3 -- not the form\'s default 4', () => {
    for (const hours of [3, 4, 6, 2, 1.5]) {
      expect(blockHoursOf(cfg({ strikeBlocks: splitBlocks(cfg(), hours * 60) }))).toBe(hours);
    }
  });

  it('no blocks, or a first block with no time: the default 4', () => {
    expect(blockHoursOf(cfg())).toBe(4);
    expect(blockHoursOf(cfg({ strikeBlocks: [] }))).toBe(4);
    expect(blockHoursOf(cfg({ strikeBlocks: [premium('', 40)] }))).toBe(4);
  });

  it('[critical] a window moved from under its blocks falls back to 4, so "Split again" still makes blocks', () => {
    // 9:00 AM to 5:00 PM with a block left at 9:35 PM: 12 h 35 min from the start is not a length of this window
    const moved = cfg({ entryTime: '09:00', exitTime: '17:00', strikeBlocks: [premium('21:35', 40)] });
    expect(blockHoursOf(moved)).toBe(4);
    expect(splitBlocks(moved, blockHoursOf(moved) * 60).map((b) => b.at)).toEqual(['13:00']);
  });

  it('a first block moved by hand reads as where it now starts: 5:35 PM to 9:00 PM is 3.42 h', () => {
    expect(blockHoursOf(cfg({ strikeBlocks: [premium('21:00', 40), premium('01:35', 30)] }))).toBe(3.42);
  });
});

describe('the block the clock is in now', () => {
  const m = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3));
  // 5:35 PM to 5:29 PM every 3 hours: eight blocks, the last from 2:35 PM
  const day = cfg({ strikeBlocks: splitBlocks(cfg(), 180).map((b, i) => ({ ...b, premium: { mode: 'atMost', usd: 50 - i, fallbackUsd: null } })) });

  it('[critical] the last block started by now, its number as the form counts it, and how long it has left', () => {
    const at = (t: string) => blockNow(day, m(t))!;
    expect(at('17:35')).toMatchObject({ n: 1, of: 8, from: '17:35', until: '20:35', minutesLeft: 180 });
    expect(at('20:34')).toMatchObject({ n: 1, minutesLeft: 1 });
    expect(at('20:35')).toMatchObject({ n: 2, from: '20:35', until: '23:35' });
    expect(at('00:10')).toMatchObject({ n: 3, from: '23:35', until: '02:35' });       // past midnight, still the 11:35 PM block
    expect(at('15:40')).toMatchObject({ n: 8, of: 8, from: '14:35', until: '17:29', minutesLeft: 109 });
  });

  it('[critical] the rule is that block\'s own: block 1 is the strategy\'s, the rest their own', () => {
    expect(blockNow(day, m('18:00'))!.pick.premium).toEqual({ mode: 'atMost', usd: 50, fallbackUsd: 75 });
    expect(blockNow(day, m('21:00'))!.pick.premium.usd).toBe(50);                    // the first split block, i = 0
    expect(blockNow(day, m('15:40'))!.pick.premium.usd).toBe(44);                    // the seventh, i = 6
  });

  it('[critical] what comes next: the following block and when -- none after the last', () => {
    expect(blockNow(day, m('18:00'))!.next).toMatchObject({ n: 2, at: '20:35' });
    expect(blockNow(day, m('15:40'))!.next).toBeNull();
  });

  it('one rule all the time is one block, the whole window', () => {
    expect(blockNow(cfg(), m('03:00'))).toMatchObject({ n: 1, of: 1, from: '17:35', until: '17:29', next: null });
  });

  it('[critical] outside the window -- between its end and its next start -- there is no block', () => {
    expect(blockNow(day, m('17:29'))).toBeNull();
    expect(blockNow(day, m('17:32'))).toBeNull();
    expect(blockNow(cfg({ entryTime: '09:00', exitTime: '17:00' }), m('08:00'))).toBeNull();
    expect(blockNow(cfg({ entryTime: '' }), m('12:00'))).toBeNull();
  });

  it('the IST minute of an instant', () => {
    expect(istMinuteOf(Date.UTC(2026, 9, 4, 10, 10))).toBe(15 * 60 + 40);            // 10:10 UTC is 3:40 PM IST
    expect(istMinuteOf(Date.UTC(2026, 9, 4, 20, 0))).toBe(90);                       // 8:00 PM UTC is 1:30 AM IST
  });
});

describe('apply to all blocks (owner, 8 Oct 2026)', () => {
  const day = () => cfg({
    premium: { mode: 'atMost', usd: 50, fallbackUsd: 75, minOtm: 4, elseOtm: 6 },
    strikeBlocks: [
      { ...premium('21:35', 40, 'atLeast', 20), premium: { mode: 'atLeast', usd: 40, fallbackUsd: 20, minOtm: 8, elseOtm: 10 } },
      strict('01:35', 3),
      premium('05:35', 15),
    ],
  });

  it('[critical] one block\'s premium, its ≥ or ≤ and its "if none" go onto every block; times and distance rules stay', () => {
    const next = applyToAllBlocks(day(), 0)!;
    // block 1 is the source: unchanged
    expect(next.premium).toEqual({ mode: 'atMost', usd: 50, fallbackUsd: 75, minOtm: 4, elseOtm: 6 });
    expect(next.strikeBlocks!.map((b) => [b.at, b.strikeRule, b.premium.mode, b.premium.usd, b.premium.fallbackUsd])).toEqual([
      ['21:35', 'premium', 'atMost', 50, 75], ['01:35', 'premium', 'atMost', 50, 75], ['05:35', 'premium', 'atMost', 50, 75],
    ]);
    // each block's own distance rule is not touched
    expect(next.strikeBlocks![0]!.premium).toMatchObject({ minOtm: 8, elseOtm: 10 });
    expect(next.strikeBlocks![2]!.premium.minOtm ?? null).toBeNull();
    // and what comes out is a set of blocks the form accepts
    expect(strikeBlockProblems(next.strikeBlocks, '17:35', '17:29')).toEqual([]);
  });

  it('from a later block: block 1, the strategy\'s own rule, is written too; no "if none" clears the others\'', () => {
    const next = applyToAllBlocks(day(), 3)!;
    expect([next.strikeRule, next.premium.mode, next.premium.usd, next.premium.fallbackUsd]).toEqual(['premium', 'atMost', 15, null]);
    expect(next.premium).toMatchObject({ minOtm: 4, elseOtm: 6 });
    expect(next.strikeBlocks!.map((b) => [b.premium.usd, b.premium.fallbackUsd])).toEqual([[15, null], [15, null], [15, null]]);
  });

  it('a block picked by strike copies its strike, and turns the others to by strike', () => {
    const next = applyToAllBlocks(day(), 2)!;
    expect([next.strikeRule, next.strikeStep]).toEqual(['strict', 3]);
    expect(next.strikeBlocks!.map((b) => [b.strikeRule, b.strikeStep])).toEqual([['strict', 3], ['strict', 3], ['strict', 3]]);
    // their premiums are kept under it, for going back
    expect(next.strikeBlocks![0]!.premium.usd).toBe(40);
  });

  it('nothing is copied from a premium that is not a usable number, an "if none" on the wrong side, or a block that is not there', () => {
    expect(applyToAllBlocks(cfg({ premium: { mode: 'atMost', usd: 0, fallbackUsd: null }, strikeBlocks: [premium('21:35', 40)] }), 0)).toBeNull();
    // at most $50, "if none" $40: the second number has to find more strikes, not fewer
    expect(applyToAllBlocks(cfg({ strikeBlocks: [premium('21:35', 50, 'atMost', 40)] }), 1)).toBeNull();
    expect(applyToAllBlocks(day(), 9)).toBeNull();
    // the strategy handed in is not changed
    const c = day(); applyToAllBlocks(c, 0);
    expect(c.strikeBlocks![0]!.premium.usd).toBe(40);
  });

  it('said in the form\'s own words, without the distance rule it does not copy', () => {
    expect(appliedWords(ownPick(day()))).toBe('≤ $50 (if none, ≤ $75)');
    expect(appliedWords(day().strikeBlocks![2]!)).toBe('≤ $15');
    expect(appliedWords(day().strikeBlocks![1]!)).toBe(pickWords(day().strikeBlocks![1]!));
  });
});

/*
 * By delta and by distance (8 Oct 2026): two more rules a block -- or the whole window -- may pick its strike by.
 * Each is one number; the checks say what the server's say, word for word.
 */
describe('by delta and by distance', () => {
  const byDelta = (at: string, max: number): StrikeBlock => ({ at, strikeRule: 'delta', strikeStep: 0, premium: { mode: 'atMost', usd: 50, fallbackUsd: null }, delta: { max } });
  const byDistance = (at: string, pct: number, scale: 'fixed' | 'time'): StrikeBlock =>
    ({ at, strikeRule: 'distance', strikeStep: 0, premium: { mode: 'atMost', usd: 50, fallbackUsd: null }, distance: { pct, scale } });

  it('[critical] the words say the rule: the delta to two places, the distance with what it is measured against', () => {
    expect(pickWords(byDelta('21:35', 0.1))).toBe('delta ≤ 0.10');
    expect(pickWords(byDistance('21:35', 1.5, 'fixed'))).toBe('≥ 1.5% from BTC');
    expect(pickWords(byDistance('21:35', 0.45, 'time'))).toBe('≥ 0.45% × √hours left from BTC');
    expect(pickWords({ strikeRule: 'delta', strikeStep: 0, premium: { mode: 'atMost', usd: 50 } })).toBe('delta not set');
    expect(blocksWords(cfg({ strikeBlocks: [byDelta('21:35', 0.07), byDistance('01:35', 2, 'fixed')] })))
      .toBe(' — then from 9:35 PM delta ≤ 0.07, from 1:35 AM ≥ 2% from BTC');
  });

  it('[critical] the strategy\'s own rule as block 1 keeps its rule and its number; a rule that never had one carries no key', () => {
    expect(ownPick(cfg({ strikeRule: 'delta', delta: { max: 0.1 } }))).toMatchObject({ strikeRule: 'delta', delta: { max: 0.1 } });
    expect(ownPick(cfg({ strikeRule: 'distance', distance: { pct: 0.45, scale: 'time' } }))).toMatchObject({ strikeRule: 'distance', distance: { pct: 0.45, scale: 'time' } });
    expect(Object.keys(ownPick(cfg()))).toEqual(['strikeRule', 'strikeStep', 'premium']);
  });

  it('[critical] splitting carries a delta rule into every new block, each with a copy of its own', () => {
    const c = cfg({ strikeRule: 'delta', delta: { max: 0.1 } });
    const blocks = splitBlocks(c, 240);
    expect(blocks).toHaveLength(5);
    for (const b of blocks) expect(b).toMatchObject({ strikeRule: 'delta', delta: { max: 0.1 } });
    expect(blocks[0]!.delta).not.toBe(c.delta);
    // Split again, and a block already by distance keeps it where its time still falls.
    const again = splitBlocks({ ...c, strikeBlocks: [byDistance('21:35', 2, 'fixed')] }, 240);
    expect(again[0]).toMatchObject({ at: '21:35', strikeRule: 'distance', distance: { pct: 2, scale: 'fixed' } });
  });

  it('[critical] a block\'s delta or distance is held to the server\'s rules, in its words', () => {
    const say = (b: StrikeBlock) => strikeBlockProblems([b], '17:35', '17:29').map((p) => p.message);
    expect(say(byDelta('21:35', 0.1))).toEqual([]);
    expect(say(byDelta('21:35', 0.6))).toEqual(['Block 2: Delta must be between 0.01 and 0.50.']);
    expect(say({ ...byDelta('21:35', 0.1), delta: null })).toEqual(['Block 2: Delta must be between 0.01 and 0.50.']);
    expect(say(byDistance('21:35', 0.45, 'time'))).toEqual([]);
    expect(say(byDistance('21:35', 0, 'fixed'))).toEqual(['Block 2: The distance from BTC must be above 0% and at most 20%.']);
    expect(say({ ...byDelta('21:35', 0.1), strikeRule: 'oiWall' as never })).toEqual(['Block 2: pick the strike by premium, by strike, by delta or by distance.']);
  });

  it('[critical] the form says a delta or a distance that cannot be saved, only under the rule that reads it', () => {
    const said = (over: Partial<StrategyConfig>, field: string) => strategyProblems(cfg(over), 'x').filter((p) => p.field === field).map((p) => p.message);
    expect(said({ strikeRule: 'delta' }, 'delta')).toEqual(['Delta must be between 0.01 and 0.50.']);
    expect(said({ strikeRule: 'delta', delta: { max: 0.1 } }, 'delta')).toEqual([]);
    expect(said({ strikeRule: 'premium', delta: { max: 9 } }, 'delta')).toEqual([]);
    expect(said({ strikeRule: 'distance', distance: { pct: 25, scale: 'fixed' } }, 'distance')).toEqual(['The distance from BTC must be above 0% and at most 20%.']);
    expect(said({ strikeRule: 'distance', distance: { pct: 0.45, scale: 'time' } }, 'distance')).toEqual([]);
  });

  it('[critical] "Apply to all blocks" from a delta block puts its number on every block, and from a distance block its distance', () => {
    const c = cfg({ strikeBlocks: [byDelta('21:35', 0.07), premium('01:35', 30)] });
    const d = applyToAllBlocks(c, 1)!;
    expect(d.strikeRule).toBe('delta');
    expect(d.delta).toEqual({ max: 0.07 });
    expect(d.strikeBlocks!.map((b) => [b.at, b.strikeRule, b.delta])).toEqual([['21:35', 'delta', { max: 0.07 }], ['01:35', 'delta', { max: 0.07 }]]);
    // The premium each block had is still there under it, for the way back.
    expect(d.strikeBlocks![1]!.premium.usd).toBe(30);
    expect(appliedWords(c.strikeBlocks![0]!)).toBe('delta ≤ 0.07');

    const far = applyToAllBlocks(cfg({ strikeBlocks: [byDistance('21:35', 0.45, 'time')] }), 1)!;
    expect([far.strikeRule, far.distance, far.strikeBlocks![0]!.distance]).toEqual(['distance', { pct: 0.45, scale: 'time' }, { pct: 0.45, scale: 'time' }]);
    // A number that cannot be saved is not spread across the day.
    expect(applyToAllBlocks(cfg({ strikeBlocks: [byDelta('21:35', 0)] }), 1)).toBeNull();
    expect(applyToAllBlocks(cfg({ strikeBlocks: [byDistance('21:35', 99, 'fixed')] }), 1)).toBeNull();
    // From a premium block, a strategy that never used either still carries neither.
    const plain = applyToAllBlocks(cfg({ strikeBlocks: [premium('21:35', 30)] }), 0)!;
    expect([plain.delta, plain.distance]).toEqual([undefined, undefined]);
  });

  it('the sentence the strategy is described in names the rule', () => {
    expect(describeStrategy(cfg({ strikeRule: 'delta', delta: { max: 0.1 } }))).toMatch(/nearest strike with a delta of 0\.10 or less/);
    expect(describeStrategy(cfg({ strikeRule: 'distance', distance: { pct: 0.45, scale: 'time' } }))).toMatch(/at least 0\.45% × √hours left from BTC/);
    expect(describeStrategy(cfg({ strikeRule: 'distance', distance: { pct: 1.5, scale: 'fixed' } }))).toMatch(/at least 1\.5% from BTC/);
  });
});
