import { describe, expect, it } from 'vitest';
import {
  exitPrice, exitRuleProblems, exitRules, exitWords, fillSteps, premiumFallbackProblem, suggestedFallback, withExitRule,
} from '@/lib/strategy-exits';
import { distanceOf, exitAskOf, inputProblem, levelOf, switchMode, valueOf } from '@/lib/exit-input';
import { DEFAULT_CONFIG } from '@/types/strategy';

describe('fillSteps', () => {
  it('[critical] entry 5:30, 80%, every 2 h +5%: 7:30 85%, 9:30 90%, 11:30 95%, 13:30 99% -- and stops at the ceiling', () => {
    expect(fillSteps({ leg: 'target', mode: 'pct', entryTime: '05:30', exitTime: '17:29', start: 0.8, everyMin: 120, by: 0.05 }))
      .toEqual([{ at: '07:30', value: 0.85 }, { at: '09:30', value: 0.9 }, { at: '11:30', value: 0.95 }, { at: '13:30', value: 0.99 }]);
  });
  it('never writes a step at or after the exit', () => {
    const steps = fillSteps({ leg: 'stop', mode: 'pct', entryTime: '05:30', exitTime: '09:30', start: 1, everyMin: 120, by: 0.5 });
    expect(steps).toEqual([{ at: '07:30', value: 1.5 }]);
  });
  it('a stop may climb past 100%', () => {
    const steps = fillSteps({ leg: 'stop', mode: 'pct', entryTime: '05:30', exitTime: '17:29', start: 1.5, everyMin: 240, by: 1 });
    expect(steps).toEqual([{ at: '09:30', value: 2.5 }, { at: '13:30', value: 3.5 }]);  // 17:30 is past the 17:29 exit
  });
  it('runs past midnight for an overnight strategy', () => {
    expect(fillSteps({ leg: 'stop', mode: 'points', entryTime: '23:30', exitTime: '05:00', start: 10, everyMin: 120, by: 5 }))
      .toEqual([{ at: '01:30', value: 15 }, { at: '03:30', value: 20 }]);
  });
  it('a change of zero, or a bad window, writes nothing', () => {
    expect(fillSteps({ leg: 'target', mode: 'pct', entryTime: '05:30', exitTime: '17:29', start: 0.8, everyMin: 60, by: 0 })).toEqual([]);
    expect(fillSteps({ leg: 'target', mode: 'pct', entryTime: 'x', exitTime: '17:29', start: 0.8, everyMin: 60, by: 0.1 })).toEqual([]);
    expect(fillSteps({ leg: 'target', mode: 'pct', entryTime: '05:30', exitTime: '17:29', start: 0.8, everyMin: 0, by: 0.1 })).toEqual([]);
  });
  it('holds at most 24 steps', () => {
    expect(fillSteps({ leg: 'stop', mode: 'points', entryTime: '05:30', exitTime: '17:29', start: 1, everyMin: 10, by: 1 })).toHaveLength(24);
  });
});

describe('exitRuleProblems -- the server\'s words', () => {
  const ok = { mode: 'pct' as const, value: 0.8, steps: [] };
  it('accepts the example ladder', () => {
    expect(exitRuleProblems('target', { ...ok, steps: [{ at: '07:30', value: 0.85 }, { at: '09:30', value: 0.9 }] }, '05:30', '17:29')).toEqual([]);
  });
  it('[critical] the maximum is the exit time', () => {
    expect(exitRuleProblems('target', { ...ok, steps: [{ at: '17:29', value: 0.9 }] }, '05:30', '17:29'))
      .toEqual(['Take profit step 1 (5:29 PM) must be after entry (5:30 AM) and before exit (5:29 PM).']);
  });
  it('a stop over 100% is fine; over 2000% is not', () => {
    expect(exitRuleProblems('stop', { mode: 'pct', value: 5, steps: [] }, '05:30', '17:29')).toEqual([]);
    expect(exitRuleProblems('stop', { mode: 'pct', value: 21, steps: [] }, '05:30', '17:29'))
      .toEqual(['Stop loss must be between 0 and 2000% of the credit.']);
  });
  it('a step value is checked in its mode', () => {
    expect(exitRuleProblems('target', { ...ok, steps: [{ at: '07:30', value: 1 }] }, '05:30', '17:29'))
      .toEqual(['Step 1: Take profit must be between 0 and 99% of the credit.']);
  });
});

describe('prices -- the same arithmetic as the server', () => {
  // Pinned to the values test/strategy/exit-steps.test.ts asserts on the server.
  it.each([
    ['stop', 'points', 10, 15, 25],
    ['target', 'points', 10, 15, 5],
    ['target', 'points', 40, 15, 0.2],
    ['target', 'points', 5, 3, 0.1],
    ['stop', 'pct', 2.5, 10, 35],
    ['target', 'pct', 0.8, 15, 3],
    ['target', 'pct', 0.85, 15, 2.3],
  ] as const)('%s %s %s off %s is %s', (leg, mode, value, entry, want) => {
    expect(exitPrice(leg, mode, value, entry)).toBe(want);
  });
  it('off or no entry is no price', () => {
    expect(exitPrice('stop', 'pct', 0, 10)).toBeNull();
    expect(exitPrice('stop', 'pct', 1, null)).toBeNull();
  });
});

describe('reading and writing a config', () => {
  it('an old strategy reads as a percentage, all day', () => {
    const { targetMode: _a, takeProfitPoints: _b, targetSteps: _c, ...old } = DEFAULT_CONFIG;
    expect(exitRules(old as typeof DEFAULT_CONFIG).target).toEqual({ mode: 'pct', value: 0.95, steps: [] });
  });
  it('writing points keeps the percentage, and the other way round', () => {
    const c = withExitRule({ ...DEFAULT_CONFIG, stopLossPct: 1.5 }, 'stop', { mode: 'points', value: 12, steps: [] });
    expect(c).toMatchObject({ stopMode: 'points', stopLossPoints: 12, stopLossPct: 1.5 });
  });
  it('exitWords', () => {
    expect(exitWords('pct', 0.85)).toBe('85%');
    expect(exitWords('points', 12.5)).toBe('12.5 pts');
    expect(exitWords('pct', 0)).toBe('off');
  });
});

describe('premium fallback', () => {
  it('at most: above the cap; at least: below the floor', () => {
    expect(premiumFallbackProblem({ mode: 'atMost', usd: 20, fallbackUsd: 50 })).toBeNull();
    expect(premiumFallbackProblem({ mode: 'atMost', usd: 20, fallbackUsd: 20 })).toMatch(/above \$20/);
    expect(premiumFallbackProblem({ mode: 'atLeast', usd: 20, fallbackUsd: 10 })).toBeNull();
    expect(premiumFallbackProblem({ mode: 'atLeast', usd: 20, fallbackUsd: 25 })).toMatch(/below \$20/);
    expect(premiumFallbackProblem({ mode: 'atMost', usd: 20, fallbackUsd: 0 })).toMatch(/positive/);
    expect(premiumFallbackProblem({ mode: 'atMost', usd: 20, fallbackUsd: null })).toBeNull();
  });
  it('the suggestion is always valid', () => {
    for (const usd of [1, 5, 15, 20, 99]) {
      for (const mode of ['atMost', 'atLeast'] as const) {
        const f = suggestedFallback({ mode, usd });
        if (mode === 'atLeast' && usd === 1) continue;   // nothing positive is below $1 in whole dollars
        expect(premiumFallbackProblem({ mode, usd, fallbackUsd: f })).toBeNull();
      }
    }
  });
});

describe('the ticket\'s exit inputs', () => {
  const t = { on: true, mode: 'pct' as const, pct: 0.8, points: 10, price: 0 };
  const s = { on: true, mode: 'points' as const, pct: 1.5, points: 10, price: 0 };
  it('[critical] sends only the mode in force, the other as zero', () => {
    expect(exitAskOf(t, s)).toEqual({ takeProfitPct: 0.8, takeProfitPoints: 0, stopLossPct: 0, stopLossPoints: 10 });
    expect(exitAskOf({ ...t, on: false }, { ...s, on: false })).toEqual({ takeProfitPct: 0, takeProfitPoints: 0, stopLossPct: 0, stopLossPoints: 0 });
  });
  it('values and levels', () => {
    expect(valueOf(s)).toBe(10);
    expect(levelOf('stop', s, 15)).toBe(25);
    expect(levelOf('target', t, 15)).toBe(3);
  });
  it('an unticked exit is never a problem, whatever it holds', () => {
    expect(inputProblem('target', { ...t, on: false, pct: 5 })).toBeNull();
    expect(inputProblem('target', { ...t, pct: 5 })).toMatch(/99%/);
  });
});

describe('the ticket\'s Price mode', () => {
  const x = (over: Partial<import('@/lib/exit-input').ExitInput>) => ({ on: true, mode: 'price' as const, pct: 0, points: 0, price: 0, ...over });
  it('[critical] entry 16, stop typed as 70: the level is 70, 54 points and 338% over', () => {
    expect(levelOf('stop', x({ price: 70 }), 16)).toBe(70);
    expect(distanceOf(70, 16)).toEqual({ points: 54, pct: 337.5 });
    expect(distanceOf(4, 16)).toEqual({ points: -12, pct: -75 });
  });
  it('[critical] is sent as the price, with the other modes zero', () => {
    expect(exitAskOf(x({ price: 4 }), x({ price: 70 }))).toEqual({
      takeProfitPct: 0, takeProfitPoints: 0, stopLossPct: 0, stopLossPoints: 0, takeProfitPrice: 4, stopPrice: 70,
    });
  });
  it('[critical] a price the wrong side of the entry is refused -- it would fire on placement', () => {
    expect(inputProblem('stop', x({ price: 70 }), 16)).toBeNull();
    expect(inputProblem('stop', x({ price: 16 }), 16)).toMatch(/must be over the 16 entry/);
    expect(inputProblem('target', x({ price: 20 }), 16)).toMatch(/must be under the 16 entry/);
    expect(inputProblem('target', x({ price: 0 }), 16)).toBe('Type the price to buy back at.');
    expect(inputProblem('stop', x({ price: 70 }), null)).toBeNull();
  });
  it('switching to Price opens on the level the old mode meant', () => {
    expect(switchMode('target', { on: true, mode: 'pct', pct: 0.8, points: 0, price: 0 }, 'price', 16)).toEqual({ mode: 'price', price: 3.2 });
    expect(switchMode('stop', { on: true, mode: 'points', pct: 0, points: 54, price: 0 }, 'price', 16)).toEqual({ mode: 'price', price: 70 });
    expect(switchMode('stop', { on: true, mode: 'points', pct: 0, points: 54, price: 66 }, 'price', 16)).toEqual({ mode: 'price' });
  });
});
