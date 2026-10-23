import { describe, expect, it } from 'vitest';
import { CHASE_DEFAULT, chaseProblems, chaseQuery, chaseWords } from '@/lib/backtest-chase';

describe('the chase guard, as the server holds it (22 Oct 2026)', () => {
  it('[critical] the check after the reference in the expiry day, read from 5:30 PM; whole points 50 to 20,000', () => {
    expect(chaseProblems(CHASE_DEFAULT)).toEqual([]);
    expect(chaseQuery(CHASE_DEFAULT)).toBe('07:00-11:00-400');
    // 7 PM to 1 AM runs forward across midnight: one expiry day
    expect(chaseQuery({ from: '19:00', after: '01:00', pts: 300 })).toBe('19:00-01:00-300');
    // 11 AM back to 7 AM, the same time twice, and 5 PM to 6 PM across the settlement: not one day forward
    for (const c of [{ from: '11:00', after: '07:00', pts: 400 }, { from: '11:00', after: '11:00', pts: 400 }, { from: '17:00', after: '18:00', pts: 400 }]) {
      expect(chaseProblems(c)).toEqual(['The check starts after the time the move is read from, in the same expiry day (from 5:30 PM).']);
      expect(chaseQuery(c)).toBeNull();
    }
    for (const pts of [0, 49, 20_001, 400.5, Number.NaN]) expect(chaseQuery({ ...CHASE_DEFAULT, pts })).toBeNull();
    expect(chaseQuery({ ...CHASE_DEFAULT, after: '' })).toBeNull();
    expect(chaseQuery(null)).toBeNull();
  });

  it('in a few words, or none', () => {
    expect(chaseWords(CHASE_DEFAULT)).toBe('chase guard from 11:00 AM, 400 pts since 7:00 AM');
    expect(chaseWords(undefined)).toBeNull();
  });
});
