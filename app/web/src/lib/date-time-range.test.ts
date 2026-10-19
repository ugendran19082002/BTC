import { describe, expect, it } from 'vitest';
import { expiryDayStart, istMs, rangeMs, timeQuickPicks, timeRangeProblem, timeRangeWords } from '@/lib/date-time-range';

/** IST date-and-time ranges for the phone's trade history (owner, 19 Oct 2026: "a custom date and time range"). */
const NOW = istMs('2026-10-19', '15:00');

describe('date-time-range', () => {
  it('[critical] reads both ends as IST, To to the end of its minute', () => {
    const r = rangeMs({ from: '2026-10-18', fromTime: '21:30', to: '2026-10-19', toTime: '06:00' });
    expect(r.from).toBe(Date.parse('2026-10-18T16:00:00Z'));
    expect(r.to).toBe(Date.parse('2026-10-19T00:30:59.999Z'));
  });

  it('[critical] the expiry day starts 5:30 PM IST: the day before when earlier', () => {
    expect(expiryDayStart(NOW)).toBe(istMs('2026-10-18', '17:30'));
    expect(expiryDayStart(istMs('2026-10-19', '17:30'))).toBe(istMs('2026-10-19', '17:30'));
  });

  it('quick picks: this and the last expiry day, today, yesterday, last night, 7 days', () => {
    const q = Object.fromEntries(timeQuickPicks(NOW).map((x) => [x.label, x.range]));
    expect(q['This expiry day']).toEqual({ from: '2026-10-18', fromTime: '17:30', to: '2026-10-19', toTime: '15:00' });
    expect(q['Last expiry day']).toEqual({ from: '2026-10-17', fromTime: '17:30', to: '2026-10-18', toTime: '17:29' });
    expect(q['Last night']).toEqual({ from: '2026-10-18', fromTime: '21:30', to: '2026-10-19', toTime: '06:00' });
    expect(q['Last 7 days']!.from).toBe('2026-10-13');
    for (const r of Object.values(q)) expect(timeRangeProblem(r, NOW)).toBeNull();
  });

  it('[critical] says what is wrong: an end missing, backwards, in the future, over a year', () => {
    const ok = { from: '2026-10-19', fromTime: '09:00', to: '2026-10-19', toTime: '10:00' };
    expect(timeRangeProblem({ ...ok, to: '' }, NOW)).toBe('Pick both dates.');
    expect(timeRangeProblem({ ...ok, fromTime: '' }, NOW)).toBe('Pick both times.');
    expect(timeRangeProblem({ ...ok, fromTime: '11:00' }, NOW)).toBe('The From must be before the To.');
    expect(timeRangeProblem({ ...ok, fromTime: '16:00', toTime: '17:00' }, NOW)).toBe('The From cannot be in the future.');
    expect(timeRangeProblem({ ...ok, from: '2025-10-01' }, NOW)).toBe('At most a year at a time.');
  });

  it('says the range in words, the date once on one day', () => {
    expect(timeRangeWords({ from: '2026-10-18', fromTime: '21:30', to: '2026-10-19', toTime: '00:05' })).toBe('18 Oct 9:30 PM → 19 Oct 12:05 AM');
    expect(timeRangeWords({ from: '2026-10-19', fromTime: '09:00', to: '2026-10-19', toTime: '12:00' })).toBe('19 Oct 9:00 AM → 12:00 PM');
  });
});
