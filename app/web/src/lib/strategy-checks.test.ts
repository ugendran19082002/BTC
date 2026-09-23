import { describe, expect, it } from 'vitest';
import { nameWarning, overlapWarnings, stepWarnings } from '@/lib/strategy-checks';
import { DEFAULT_CONFIG, type StrategyConfig } from '@/types/strategy';

/** The two strategies as saved on the live desk, 22 Sep 2026 21:38. */
const UG_PE: StrategyConfig = {
  ...DEFAULT_CONFIG, legs: 'PE', lots: 100, premium: { mode: 'atMost', usd: 20, fallbackUsd: 50 },
  takeProfitPct: 0.8, targetSteps: [{ at: '07:30', value: 0.85 }, { at: '09:30', value: 0.9 }, { at: '11:30', value: 0.95 }],
  stopMode: 'price', stopLossAt: 70,
};
const UG_CE: StrategyConfig = {
  ...UG_PE, entryLimit: 12,
  targetSteps: [{ at: '07:30', value: 0.8 }, { at: '09:30', value: 0.85 }, { at: '11:30', value: 0.9 }],
};
const s = (id: string, name: string, config: StrategyConfig) => ({ id, name, config });

describe('the mistakes the live desk actually had', () => {
  it('[critical] UG-CE and UG-PE both sell PE at 5:30 AM -- 200 lots on one strike', () => {
    const w = overlapWarnings([s('ug-ce', 'UG-CE', UG_CE), s('ug-pe', 'UG-PE', UG_PE)]);
    expect(w).toHaveLength(1);
    expect(w[0]!.text).toBe('UG-CE and UG-PE both sell PE at 5:30 AM -- with the same strike rule that is 200 lots on one strike when both are on.');
  });

  it('[critical] a call strategy beside a put one is not an overlap', () => {
    expect(overlapWarnings([s('ug-ce', 'UG-CE', { ...UG_CE, legs: 'CE' }), s('ug-pe', 'UG-PE', UG_PE)])).toEqual([]);
  });

  it('different minutes, or no shared day, is not an overlap', () => {
    expect(overlapWarnings([s('a', 'A', UG_PE), s('b', 'B', { ...UG_PE, entryTime: '06:00' })])).toEqual([]);
    expect(overlapWarnings([s('a', 'A', { ...UG_PE, weekdays: [1] }), s('b', 'B', { ...UG_PE, weekdays: [2] })])).toEqual([]);
  });

  it('[critical] "UG-CE" selling a put is said out loud', () => {
    expect(nameWarning('UG-CE', 'PE')).toBe('The name says CE, but this sells a put (PE).');
    expect(nameWarning('UG-PE', 'CE')).toBe('The name says PE, but this sells a call (CE).');
    expect(nameWarning('UG-CE', 'CE')).toBeNull();
    expect(nameWarning('CE+PE strangle', 'both')).toBeNull();
    expect(nameWarning('Recent', 'PE')).toBeNull();
  });

  it('[critical] UG-CE\'s 7:30 step repeats the 80% before it; UG-PE\'s ladder is clean', () => {
    expect(stepWarnings(UG_CE, 'target')).toEqual(['The 7:30 AM step keeps 80% -- it changes nothing. Remove it, or give it a new value.']);
    expect(stepWarnings(UG_PE, 'target')).toEqual([]);
  });

  it('a target step that goes down is said, since it takes profit sooner', () => {
    expect(stepWarnings({ ...UG_PE, takeProfitPct: 0.95, targetSteps: [{ at: '07:30', value: 0.8 }] }, 'target')[0])
      .toMatch(/lowers the target from 95% to 80%/);
  });
});
