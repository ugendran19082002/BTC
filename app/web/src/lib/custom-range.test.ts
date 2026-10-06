import { describe, expect, it } from 'vitest';
import { daysIn, quickPicks, rangeProblem } from '@/lib/custom-range';

describe('custom P&L range', () => {
  // Tuesday 6 Oct 2026
  const today = '2026-10-06';

  it('quick picks: yesterday, the week from Monday, last week Monday to Sunday, this month, last month', () => {
    const p = Object.fromEntries(quickPicks(today).map((q) => [q.label, q.range]));
    expect(p['Yesterday']).toEqual({ from: '2026-10-05', to: '2026-10-05' });
    expect(p['This week']).toEqual({ from: '2026-10-05', to: '2026-10-06' });
    expect(p['Last week']).toEqual({ from: '2026-09-28', to: '2026-10-04' });
    expect(p['This month']).toEqual({ from: '2026-10-01', to: '2026-10-06' });
    expect(p['Last month']).toEqual({ from: '2026-09-01', to: '2026-09-30' });
  });

  it('on a Monday, this week is just today', () => {
    expect(quickPicks('2026-10-05').find((q) => q.label === 'This week')!.range).toEqual({ from: '2026-10-05', to: '2026-10-05' });
  });

  it('[critical] refuses what the server would: backwards, after today, over a year, half-picked', () => {
    expect(rangeProblem({ from: '2026-10-01', to: '2026-10-06' }, today)).toBeNull();
    expect(rangeProblem({ from: '2026-10-06', to: '2026-10-01' }, today)).toMatch(/on or before/);
    expect(rangeProblem({ from: '2026-10-01', to: '2026-10-07' }, today)).toMatch(/after today/);
    expect(rangeProblem({ from: '2025-10-01', to: '2026-10-06' }, today)).toMatch(/a year/);
    expect(rangeProblem({ from: '', to: '2026-10-06' }, today)).toMatch(/both dates/);
  });

  it('counts both ends', () => {
    expect(daysIn({ from: '2026-10-01', to: '2026-10-06' })).toBe(6);
    expect(daysIn({ from: '2026-10-06', to: '2026-10-06' })).toBe(1);
  });
});
