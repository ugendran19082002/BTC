import type { DayRow } from '@/types/report';

/**
 * The calendar's arithmetic, kept out of the drawing so it can be checked.
 *
 * Everything here is about IST calendar days as `YYYY-MM-DD` strings, which
 * sort as dates and never touch the browser's own time zone.
 */

export type Month = { key: string; label: string; weeks: (string | null)[][] };

const pad = (n: number) => String(n).padStart(2, '0');

/** `YYYY-MM-DD` for a UTC date -- the strings are day names, not moments. */
export const dayKey = (d: Date) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;

/** Today in IST, from the clock. */
export const todayIst = (now = Date.now()) => dayKey(new Date(now + 5.5 * 3_600_000));

export const daysAgoIst = (n: number, now = Date.now()) => dayKey(new Date(now + 5.5 * 3_600_000 - n * 86_400_000));

/**
 * Every month the range touches, each as rows of seven starting on Sunday.
 * Days outside the range are null so the grid keeps its shape without
 * pretending those days were looked at.
 */
export function monthsOf(from: string, to: string): Month[] {
  const out: Month[] = [];
  const start = new Date(`${from.slice(0, 7)}-01T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  for (let m = new Date(start); m <= end; m.setUTCMonth(m.getUTCMonth() + 1)) {
    const y = m.getUTCFullYear();
    const mo = m.getUTCMonth();
    const first = new Date(Date.UTC(y, mo, 1));
    const daysIn = new Date(Date.UTC(y, mo + 1, 0)).getUTCDate();
    const weeks: (string | null)[][] = [];
    let week: (string | null)[] = Array<string | null>(first.getUTCDay()).fill(null);
    for (let d = 1; d <= daysIn; d++) {
      const key = dayKey(new Date(Date.UTC(y, mo, d)));
      week.push(key >= from && key <= to ? key : null);
      if (week.length === 7) { weeks.push(week); week = []; }
    }
    if (week.length) weeks.push([...week, ...Array<string | null>(7 - week.length).fill(null)]);
    out.push({
      key: `${y}-${pad(mo + 1)}`,
      label: first.toLocaleDateString('en-GB', { month: 'short', year: '2-digit', timeZone: 'UTC' }).toUpperCase(),
      weeks,
    });
  }
  return out;
}

/**
 * How strongly to colour a day: its net against the largest in the range, in
 * four steps. Four, because a heatmap is read as "good day / bad day / big
 * one", and a continuous scale turns every square into a number to squint at.
 */
export function heat(netUsd: number, maxAbsUsd: number): 0 | 1 | 2 | 3 {
  if (netUsd === 0 || maxAbsUsd <= 0) return 0;
  const share = Math.abs(netUsd) / maxAbsUsd;
  return share > 0.66 ? 3 : share > 0.33 ? 2 : 1;
}

export const byDay = (rows: DayRow[]) => new Map(rows.map((r) => [r.day, r]));

/** Net of charges or before them, as the toggle asks. */
export const netOf = (r: DayRow, includeCharges: boolean) => includeCharges ? r.netUsd : r.realisedUsd;

/** The running total under the toggle, recomputed rather than trusted. */
export function cumulative(rows: DayRow[], includeCharges: boolean): { day: string; usd: number }[] {
  let n = 0;
  return rows.map((r) => ({ day: r.day, usd: (n += netOf(r, includeCharges)) }));
}
