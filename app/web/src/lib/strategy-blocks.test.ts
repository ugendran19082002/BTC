import { describe, expect, it } from 'vitest';
import {
  blockRanges, blocksWords, hoursLabel, ownPick, pickWords, splitBlocks, strikeBlockProblems,
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
    expect(pickWords(premium('21:35', 40))).toBe('at most $40');
    expect(pickWords(premium('21:35', 15, 'atLeast', 10))).toBe('at least $15 (else $10)');
    expect(pickWords(strict('21:35', 2))).toBe('OTM 2');
    expect(pickWords(strict('21:35', 0))).toBe('ATM');
  });

  it('hours', () => {
    expect([hoursLabel(240), hoursLabel(234), hoursLabel(45)]).toEqual(['4 h', '3 h 54 min', '45 min']);
  });

  it('[critical] the rule sentence names every block, and says nothing new when there are none', () => {
    expect(blocksWords(cfg())).toBe('');
    const c = cfg({ strikeBlocks: [premium('21:35', 40), strict('05:35', 2)] });
    expect(blocksWords(c)).toBe(' — then from 9:35 PM at most $40, from 5:35 AM OTM 2');
    expect(describeStrategy(c)).toContain('(none? then the last strike at or below $75) — then from 9:35 PM at most $40, from 5:35 AM OTM 2, 3 lots');
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

describe('"at least OTM n": the nearest strike a premium rule may sell', () => {
  const floored = (minOtm: number | null) => cfg({ premium: { mode: 'atMost', usd: 50, fallbackUsd: 75, minOtm } });

  it('[critical] in words: on the rule, on a block, and in the sentence', () => {
    expect(pickWords({ strikeRule: 'premium', strikeStep: 0, premium: { mode: 'atMost', usd: 50, fallbackUsd: 75, minOtm: 6 } })).toBe('at most $50 (else $75), OTM 6 or further');
    expect(pickWords({ strikeRule: 'premium', strikeStep: 0, premium: { mode: 'atLeast', usd: 15, minOtm: 3 } })).toBe('at least $15, OTM 3 or further');
    expect(pickWords({ strikeRule: 'strict', strikeStep: 2, premium: { mode: 'atMost', usd: 50, minOtm: 6 } })).toBe('OTM 2');
    expect(describeStrategy(floored(6))).toContain('(none? then the last strike at or below $75), never nearer than OTM 6, 3 lots');
    expect(describeStrategy(floored(null))).not.toContain('never nearer');
  });

  it('[critical] a whole number from 1 to 20 or off -- the server\'s words, on the Strike & lots tab', () => {
    for (const ok of [null, 1, 6, 20]) expect(strategyProblems(floored(ok), 'S')).toEqual([]);
    for (const bad of [0, 21, 2.5]) {
      expect(strategyProblems(floored(bad), 'S')).toEqual([
        { field: 'premiumMinOtm', tab: 'sell', message: 'The nearest strike a premium rule may sell must be OTM 1 to OTM 20, or switched off.' },
      ]);
    }
  });

  it('[critical] a block has its own, held to the same rule', () => {
    const b = (minOtm: number | null): StrikeBlock => ({ at: '12:00', strikeRule: 'premium', strikeStep: 0, premium: { mode: 'atMost', usd: 20, fallbackUsd: null, minOtm } });
    expect(strikeBlockProblems([b(6)], '09:00', '17:00')).toEqual([]);
    expect(strikeBlockProblems([b(0)], '09:00', '17:00')).toEqual([
      { index: 0, message: 'Block 2: The nearest strike a premium rule may sell must be OTM 1 to OTM 20, or switched off.' },
    ]);
    // a by-strike block names its strike: a floor left on it is not read
    expect(strikeBlockProblems([{ ...b(0), strikeRule: 'strict', strikeStep: 2 }], '09:00', '17:00')).toEqual([]);
  });

  it('splitting carries the rule\'s floor into every new block', () => {
    for (const blk of splitBlocks(floored(6), 240)) expect(blk.premium.minOtm).toBe(6);
    for (const blk of splitBlocks(floored(null), 240)) expect(blk.premium.minOtm ?? null).toBeNull();
  });
});
