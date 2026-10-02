import { describe, expect, it } from 'vitest';
import {
  describeDays, describeEntry, describeExit, describePremium,
  describeStrategy, sizingOf,
} from '@/lib/strategy-preview';
import { DEFAULT_CONFIG, type StrategyConfig } from '@/types/strategy';

const cfg = (over: Partial<StrategyConfig> = {}): StrategyConfig => ({ ...DEFAULT_CONFIG, ...over });

describe('the days, said the shortest way that is still true', () => {
  it('collapses a full week', () => {
    expect(describeDays([0, 1, 2, 3, 4, 5, 6])).toBe('every day');
  });

  it('names the common groupings rather than listing them', () => {
    expect(describeDays([1, 2, 3, 4, 5])).toBe('weekdays');
    expect(describeDays([0, 6])).toBe('weekends');
  });

  it('lists anything else in order, whatever order it was clicked in', () => {
    expect(describeDays([5, 1, 3])).toBe('Mon Wed Fri');
  });

  it('says plainly when a strategy can never run', () => {
    // A silent "" here would read as "every day" to somebody skimming.
    expect(describeDays([])).toMatch(/never/);
  });
});

describe('the premium rule, which is the one that got picked by accident', () => {
  it('spells out which strike "at least" takes', () => {
    const s = describePremium(cfg({ premium: { mode: 'atLeast', usd: 15 } }));
    expect(s).toContain('at least $15');
    expect(s).toContain('furthest strike');
  });

  it('spells out which strike "at most" takes', () => {
    const s = describePremium(cfg({ premium: { mode: 'atMost', usd: 15 } }));
    expect(s).toContain('at most $15');
    expect(s).toContain('richest strike');
  });

  it('[critical] the two descriptions are not interchangeable', () => {
    // The whole point. One click apart, a third of the return and nearly half
    // the drawdown between them.
    const a = describePremium(cfg({ premium: { mode: 'atLeast', usd: 15 } }));
    const b = describePremium(cfg({ premium: { mode: 'atMost', usd: 15 } }));
    expect(a).not.toBe(b);
  });
});

describe('the entry, in the words the ticket uses', () => {
  it('says how long it waits before crossing', () => {
    expect(describeEntry(cfg({ entryPrice: 'offer', crossAfterSec: 5 }))).toContain('crosses after 5s');
  });

  it('says when it will never cross, because that is the surprising case', () => {
    expect(describeEntry(cfg({ entryPrice: 'offer', crossAfterSec: 0 }))).toContain('until it fills');
  });

  it('describes crossing and a named price', () => {
    expect(describeEntry(cfg({ entryPrice: 'now' }))).toContain('crosses immediately');
    expect(describeEntry(cfg({ entryPrice: 'set', entryLimit: 12.5 }))).toContain('12.5');
  });
});

describe('the exit', () => {
  it('reports the target and that there is no stop', () => {
    const s = describeExit(cfg({ takeProfitPct: 0.95, stopLossPct: 0 }));
    expect(s).toContain('95% decay');
    expect(s).toContain('no stop');
  });

  it('reports holding to settlement when there is no target', () => {
    expect(describeExit(cfg({ takeProfitPct: 0 }))).toContain('holds to settlement');
  });

  it('reports a stop when there is one', () => {
    expect(describeExit(cfg({ stopLossPct: 1.5 }))).toContain('+150%');
  });
});

describe('the whole rule, read back as a sentence', () => {
  it('covers the settings somebody would check before arming it', () => {
    const s = describeStrategy(cfg());
    expect(s).toContain('At 5:30 AM IST');
    expect(s).toContain('every day');
    expect(s).toContain('a call and a put');
    expect(s).toContain('at least $15');
    expect(s).toContain('10 lots');
    expect(s).toContain('closes at 5:29 PM');
    expect(s).toContain('95%');
  });

  it('uses the singular for one lot', () => {
    expect(describeStrategy(cfg({ lots: 1 }))).toContain('1 lot each');
  });
});

describe('what the size actually costs', () => {
  const SPOT = 78_600;   // margin per contract at 200x is spot/200 * 0.001

  it('prices both legs at one lot', () => {
    const s = sizingOf(cfg({ lots: 10, }), 300, SPOT);
    expect(s.maxContracts).toBe(20);
    expect(s.marginUsd).toBeCloseTo(20 * (SPOT / 200) * 0.001, 5);
  });

  it('a single-leg strategy carries half the contracts', () => {
    expect(sizingOf(cfg({ legs: 'CE', lots: 10, }), 300, SPOT).maxContracts)
      .toBe(10);
  });

  it('warns when the size cannot be funded at all', () => {
    const s = sizingOf(cfg({ lots: 450 }), 305, SPOT);
    expect(s.shareOfAccount).toBeGreaterThan(1);
    expect(s.warnings.join(' ')).toMatch(/cannot be funded/);
  });

  it('warns before it becomes unfundable, not only after', () => {
    const s = sizingOf(cfg({ lots: 450 }), 500, SPOT);
    expect(s.warnings.join(' ')).toMatch(/tie up/);
  });

  it('says nothing about margin it cannot know', () => {
    const s = sizingOf(cfg(), null, null);
    expect(s.marginUsd).toBe(0);
    expect(s.shareOfAccount).toBeNull();
    expect(s.warnings.join(' ')).not.toMatch(/tie up|cannot be funded/);
  });

  it('flags a trade with neither a target nor a stop', () => {
    expect(sizingOf(cfg({ takeProfitPct: 0, stopLossPct: 0 }), 300, SPOT)
      .warnings.join(' ')).toMatch(/runs to settlement/);
  });

  it('flags a strategy with no days', () => {
    expect(sizingOf(cfg({ weekdays: [] }), 300, SPOT).warnings.join(' ')).toMatch(/never run/);
  });

  it('a sensible config raises nothing', () => {
    expect(sizingOf(cfg({ lots: 10 }), 300, SPOT).warnings).toEqual([]);
  });
});


describe('a signal strategy, sized and said', () => {
  const sig = cfg({ trigger: 'signal', lots: 2, legs: 'both', signal: { mode: 'single', tf: '15m', methods: ['a', 'b', 'c'], target: 'tp2', maxOpen: 3 } });
  it('[critical] sized as one leg per signal, up to its most open at once -- not both legs', () => {
    expect(sizingOf(sig, null, 80_000).maxContracts).toBe(6);
    expect(sizingOf({ ...sig, trigger: 'time' }, null, 80_000).maxContracts).toBe(4);
  });
  it('said: the window, the methods, the legs, the perp exits, and whether orders are live', () => {
    const s = describeStrategy(sig);
    expect(s).toMatch(/^From 5:30 AM to 5:29 PM IST on every day, takes the TRADE signals of 3 methods without the chain, on 15m: a BUY sells a put, a SELL a call/);
    expect(s).toMatch(/2 lots, at most 3 open at once/);
    expect(s).toMatch(/BTC perp reaches the signal's SL or TGT2 \(else TGT1\)/);
    expect(s).toMatch(/Live orders off/);
    expect(describeStrategy({ ...sig, liveOrders: true })).toMatch(/Live orders ON/);
  });
});
