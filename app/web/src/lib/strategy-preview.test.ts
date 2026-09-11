import { describe, expect, it } from 'vitest';
import {
  addExamples, describeAdd, describeDays, describeEntry, describeExit, describePremium, describeStrategy, sizingOf,
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
    expect(s).toContain('05:30');
    expect(s).toContain('every day');
    expect(s).toContain('a call and a put');
    expect(s).toContain('at least $15');
    expect(s).toContain('10 lots');
    expect(s).toContain('17:29');
    expect(s).toContain('95%');
  });

  it('says when there is no gate rather than staying quiet about it', () => {
    expect(describeStrategy(cfg({ probGate: null, doubleWhenOneSided: false })))
      .toContain('no probability gate');
  });

  it('only claims doubling when doubling can actually happen', () => {
    // On a single-leg strategy there is never a survivor to double.
    expect(describeStrategy(cfg({ legs: 'CE', doubleWhenOneSided: true })))
      .not.toContain('doubles');
    expect(describeStrategy(cfg({ probGate: null, doubleWhenOneSided: true })))
      .not.toContain('doubles');
    expect(describeStrategy(cfg({ doubleWhenOneSided: true }))).toContain('doubles');
  });

  it('uses the singular for one lot', () => {
    expect(describeStrategy(cfg({ lots: 1 }))).toContain('1 lot each');
  });
});

describe('what the size actually costs', () => {
  const SPOT = 78_600;   // margin per contract at 200x is spot/200 * 0.001

  it('prices both legs at one lot', () => {
    const s = sizingOf(cfg({ lots: 10, doubleWhenOneSided: false }), 300, SPOT);
    expect(s.maxContracts).toBe(20);
    expect(s.marginUsd).toBeCloseTo(20 * (SPOT / 200) * 0.001, 5);
  });

  it('[critical] prices the doubled day, not the typical one', () => {
    // A form that quotes the typical size is a form that runs out of margin on
    // the day it matters. Two legs at one lot and one leg at two are the same
    // number of contracts, so the peak is unchanged -- but it must be reached
    // deliberately rather than by luck.
    const s = sizingOf(cfg({ lots: 10, doubleWhenOneSided: true }), 300, SPOT);
    expect(s.maxContracts).toBe(20);
  });

  it('a single-leg strategy carries half the contracts', () => {
    expect(sizingOf(cfg({ legs: 'CE', lots: 10, doubleWhenOneSided: false }), 300, SPOT).maxContracts)
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

  it('flags the settings that quietly do nothing', () => {
    expect(sizingOf(cfg({ probGate: null, doubleWhenOneSided: true }), 300, SPOT)
      .warnings.join(' ')).toMatch(/without the probability gate/);
    expect(sizingOf(cfg({ legs: 'PE', doubleWhenOneSided: true }), 300, SPOT)
      .warnings.join(' ')).toMatch(/needs both legs/);
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

describe('adding to the other leg, read back with its own numbers', () => {
  const add = (minPriceUsd: number, maxMultiple: number, over: Partial<StrategyConfig> = {}) =>
    cfg({ addToOpposite: { minPriceUsd, maxMultiple }, ...over });

  it('says the minimum and the multiple that were typed, not fixed ones', () => {
    expect(describeAdd(add(3, 2))).toMatch(/bid is \$3 or more and it is under 2x what it was sold for/);
    expect(describeAdd(add(4.5, 1.5))).toMatch(/bid is \$4\.5 or more and it is under 1\.5x/);
  });

  it('is part of the whole sentence when on, and absent when off or one-legged', () => {
    expect(describeStrategy(add(3, 2))).toMatch(/sells that many more of the other leg/);
    expect(describeAdd(cfg())).toBeNull();
    expect(describeAdd(add(3, 2, { legs: 'CE' }))).toBeNull();
  });

  it('tries the rule on prices: 7 and exactly 3 add, 2 does not, 30 (double 15) does not', () => {
    expect(addExamples({ minPriceUsd: 3, maxMultiple: 2 }).map((x) => [x.bid, x.adds])).toEqual([
      [7, true], [3, true], [2, false], [30, false],
    ]);
  });

  it('redraws when the numbers change: at $5 and 1.5x, 7 still adds, 4 does not, 22.50 does not', () => {
    const rows = addExamples({ minPriceUsd: 5, maxMultiple: 1.5 });
    expect(rows.map((x) => [x.bid, x.adds])).toEqual([[7, true], [5, true], [4, false], [22.5, false]]);
    expect(rows[2]!.why).toBe('below $5');
  });
});
