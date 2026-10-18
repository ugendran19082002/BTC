import { describe, expect, it } from 'vitest';
import { overQuery } from '@/api/backtest-saves';
import { tslExample, tslProblems, tslQuery, tslWords } from '@/lib/backtest-tsl';
import type { Tsl } from '@/types/signal-backtest';

/** A trailing SL on the backtest's option stop (18 Oct 2026): checked, asked for and said as the server does. */
const T: Tsl = { move: 5, moveUnit: 'pts', by: 5, byUnit: 'pts' };

describe('the backtest\'s trailing SL', () => {
  it('[critical] checked in the server\'s own words', () => {
    expect(tslProblems(T, 3)).toEqual([]);
    expect(tslProblems({ ...T, by: 6 }, 3)).toEqual(['The SL cannot move further than the price did: the SL move must be at most the price move.']);
    expect(tslProblems({ ...T, by: 6, byUnit: 'pct' }, 3)).toEqual([]);
    expect(tslProblems(T, 0)).toEqual(['A trailing SL needs an option stop to move: set the option stop.']);
    expect(tslProblems({ ...T, move: 0 }, 3)[0]).toMatch(/^The price move is more than 0/);
    expect(tslProblems({ ...T, moveUnit: 'pct', move: 120 }, 3)[0]).toMatch(/at most 100%/);
  });

  it('[critical] asked for only when right, in the server\'s shape; and over a run together, `off` to take each one\'s away', () => {
    expect(tslQuery({ tsl: T, stopPct: 3 })).toBe('5pts:5pts');
    expect(tslQuery({ tsl: { move: 10, moveUnit: 'pct', by: 2.5, byUnit: 'pts' }, stopPct: 3 })).toBe('10pct:2.5pts');
    expect(tslQuery({ tsl: T, stopPct: 0 })).toBeNull();
    expect(tslQuery({ stopPct: 3 })).toBeNull();
    expect(overQuery({ tsl: { tsl: T } }).o_tsl).toBe('5pts:5pts');
    expect(overQuery({ tsl: { tsl: null } }).o_tsl).toBe('off');
    expect(overQuery({}).o_tsl).toBeUndefined();
  });

  it('said in a few words, and worked through on a premium as the server steps it', () => {
    expect(tslWords(T)).toBe('TSL every 5 pts → SL −5 pts');
    expect(tslWords({ move: 10, moveUnit: 'pct', by: 1, byUnit: 'pts' })).toBe('TSL every 10% → SL −1 pt');
    expect(tslWords(undefined)).toBeNull();
    // sold at 40, stop 100: every 5 down, the stop 5 down
    expect(tslExample(T, 40, 100)).toEqual([{ premium: 35, stop: 95 }, { premium: 30, stop: 90 }, { premium: 25, stop: 85 }]);
    // 10% of 40 is 4; the stop by 10% of 40 too
    expect(tslExample({ move: 10, moveUnit: 'pct', by: 10, byUnit: 'pct' }, 40, 100)).toEqual([{ premium: 36, stop: 96 }, { premium: 32, stop: 92 }, { premium: 28, stop: 88 }]);
  });
});
