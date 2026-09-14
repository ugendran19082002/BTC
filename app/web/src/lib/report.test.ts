import { describe, expect, it } from 'vitest';
import { cumulative, daysAgoIst, heat, monthsOf, netOf, todayIst } from '@/lib/report';
import type { DayRow } from '@/types/report';

/**
 * The calendar's arithmetic, on strings that name IST days.
 *
 * The thing that must not happen is the browser's own time zone leaking in:
 * a day named "2026-09-14" must land in September's grid on the 14th
 * wherever the page is opened.
 */
const row = (day: string, realisedUsd: number, chargesUsd = 0): DayRow =>
  ({ day, realisedUsd, chargesUsd, netUsd: realisedUsd - chargesUsd, trades: 1, cumulativeUsd: 0 });

describe('months in a range', () => {
  it('[critical] lays September 2026 out with the 1st on a Tuesday', () => {
    const [sep] = monthsOf('2026-09-01', '2026-09-30');
    expect(sep!.key).toBe('2026-09');
    expect(sep!.weeks[0]).toEqual([null, null, '2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04', '2026-09-05']);
    expect(sep!.weeks.at(-1)!.filter(Boolean).at(-1)).toBe('2026-09-30');
    expect(sep!.weeks.every((w) => w.length === 7)).toBe(true);
  });

  it('spans every month the range touches, and blanks the days outside it', () => {
    const ms = monthsOf('2026-06-17', '2026-09-13');
    expect(ms.map((m) => m.key)).toEqual(['2026-06', '2026-07', '2026-08', '2026-09']);
    const june = ms[0]!.weeks.flat().filter(Boolean);
    expect(june[0]).toBe('2026-06-17');
    const sep = ms[3]!.weeks.flat().filter(Boolean);
    expect(sep.at(-1)).toBe('2026-09-13');
  });

  it('names the month the way the eye scans a calendar', () => {
    expect(monthsOf('2026-09-01', '2026-09-30')[0]!.label).toBe('SEP 26');
  });
});

describe('the shade of a day', () => {
  it('is four steps against the biggest day, and nothing for nothing', () => {
    expect(heat(0, 100)).toBe(0);
    expect(heat(10, 100)).toBe(1);
    expect(heat(50, 100)).toBe(2);
    expect(heat(-90, 100)).toBe(3);
    expect(heat(5, 0)).toBe(0);
  });
});

describe('charges in or out', () => {
  it('[critical] the toggle changes every figure, not just the total', () => {
    const rows = [row('2026-09-11', 10, 1), row('2026-09-12', -4, 1)];
    expect(rows.map((r) => netOf(r, true))).toEqual([9, -5]);
    expect(rows.map((r) => netOf(r, false))).toEqual([10, -4]);
    expect(cumulative(rows, true).map((p) => p.usd)).toEqual([9, 4]);
    expect(cumulative(rows, false).map((p) => p.usd)).toEqual([10, 6]);
  });
});

describe('IST days from the clock', () => {
  it('names the IST day, not the UTC one', () => {
    // 2026-09-13T20:00Z is already the 14th in IST
    expect(todayIst(Date.UTC(2026, 8, 13, 20))).toBe('2026-09-14');
    expect(daysAgoIst(90, Date.UTC(2026, 8, 13, 20))).toBe('2026-06-16');
  });
});
