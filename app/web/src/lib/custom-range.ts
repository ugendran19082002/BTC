import type { DateRangeValue } from '@/components/ui/date-range-picker';

/**
 * A custom range of IST days for the phone's P&L (owner, 6 Oct 2026): quick picks, and the rules a range must keep
 * -- the same the server holds it to (`report.routes.ts` `rangeOf`: from not after to, at most a year), plus no day
 * after today, which has no record yet. Pure, on `YYYY-MM-DD` strings, so a timezone cannot move a day.
 */

const DAY = 86_400_000;
const ms = (iso: string) => Date.parse(`${iso}T00:00:00Z`);
const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
export const shiftDay = (d: string, days: number) => iso(ms(d) + days * DAY);

/** Days in the range, both ends counted. */
export const daysIn = (r: DateRangeValue) => Math.round((ms(r.to) - ms(r.from)) / DAY) + 1;

/** Monday of the week the day is in: an Indian trading week. */
const monday = (d: string) => shiftDay(d, -((new Date(ms(d)).getUTCDay() + 6) % 7));

export type QuickPick = { label: string; range: DateRangeValue };

export function quickPicks(today: string): QuickPick[] {
  const thisMonth = `${today.slice(0, 7)}-01`;
  const lastMonthEnd = shiftDay(thisMonth, -1);
  return [
    { label: 'Yesterday', range: { from: shiftDay(today, -1), to: shiftDay(today, -1) } },
    { label: 'This week', range: { from: monday(today), to: today } },
    { label: 'Last week', range: { from: shiftDay(monday(today), -7), to: shiftDay(monday(today), -1) } },
    { label: 'This month', range: { from: thisMonth, to: today } },
    { label: 'Last month', range: { from: `${lastMonthEnd.slice(0, 7)}-01`, to: lastMonthEnd } },
  ];
}

/** What is wrong with the range, in words, or null. */
export function rangeProblem(r: { from: string; to: string }, today: string): string | null {
  const ok = (d: string) => /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(ms(d));
  if (!ok(r.from) || !ok(r.to)) return 'Pick both dates.';
  if (r.from > r.to) return 'The From date must be on or before the To date.';
  if (r.to > today) return 'The To date cannot be after today.';
  if (daysIn(r) > 366) return 'At most a year at a time.';
  return null;
}
