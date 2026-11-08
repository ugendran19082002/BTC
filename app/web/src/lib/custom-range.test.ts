import { describe, expect, it } from 'vitest';
import { daysIn, quickPicks, rangeProblem, sinceStart } from '@/lib/custom-range';

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

  it('[critical] a screen\'s own limit: the ledger\'s 92 days, said as days', () => {
    expect(rangeProblem({ from: '2026-07-07', to: '2026-10-06' }, today, 92)).toBeNull();
    expect(rangeProblem({ from: '2026-07-06', to: '2026-10-06' }, today, 92)).toBe('At most 92 days at a time.');
  });

  it('[critical] since start: the first trading day to today -- the last 92 days when it began longer ago, and said', () => {
    expect(sinceStart('2026-09-08', today, 92)).toEqual({ from: '2026-09-08', to: today, clipped: false });
    expect(sinceStart('2026-09-08', '2026-12-20', 92)).toEqual({ from: '2026-09-20', to: '2026-12-20', clipped: true });
    expect(daysIn(sinceStart('2026-01-01', today, 92))).toBe(92);
    expect(sinceStart('2026-10-09', today)).toEqual({ from: today, to: today, clipped: false }); // a first day after today (clock skew) is today
  });

  it('counts both ends', () => {
    expect(daysIn({ from: '2026-10-01', to: '2026-10-06' })).toBe(6);
    expect(daysIn({ from: '2026-10-06', to: '2026-10-06' })).toBe(1);
  });
});
