/**
 * A range of IST moments, From a date and a time To a date and a time (owner, 19 Oct 2026: "trade history -- a custom
 * date and time range, user friendly"). Pure, on `YYYY-MM-DD` and `HH:MM` strings read as IST, so the phone's own zone
 * cannot move an end. The quick picks are this desk's own windows: the expiry day runs 5:30 PM to 5:30 PM IST.
 */
export type DateTimeRange = { from: string; fromTime: string; to: string; toTime: string };

const IST = 330 * 60_000;
const DAY = 86_400_000;
/** The moment an IST date and time stand for, epoch ms. */
export const istMs = (day: string, hhmm: string) => Date.parse(`${day}T${hhmm}:00+05:30`);
const istDay = (ms: number) => new Date(ms + IST).toISOString().slice(0, 10);
const istHhmm = (ms: number) => new Date(ms + IST).toISOString().slice(11, 16);
const shift = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);

/** The range's two ends, epoch ms: From's minute, and the last millisecond of To's. */
export const rangeMs = (r: DateTimeRange): { from: number; to: number } => ({ from: istMs(r.from, r.fromTime), to: istMs(r.to, r.toTime) + 59_999 });

/** The expiry day `now` is in: from 5:30 PM IST, the day before when it is earlier than that. */
export function expiryDayStart(now: number): number {
  const day = istDay(now);
  const start = istMs(day, '17:30');
  return now >= start ? start : istMs(shift(day, -1), '17:30');
}

export type TimeQuick = { label: string; range: DateTimeRange };
/** The windows asked for most: this expiry day and the last, today, yesterday, the last 7 days, and last night. */
export function timeQuickPicks(now: number): TimeQuick[] {
  const today = istDay(now), nowHhmm = istHhmm(now);
  const exp = expiryDayStart(now), expDay = istDay(exp), prevDay = istDay(exp - DAY);
  return [
    { label: 'This expiry day', range: { from: expDay, fromTime: '17:30', to: today, toTime: nowHhmm } },
    { label: 'Last expiry day', range: { from: prevDay, fromTime: '17:30', to: expDay, toTime: '17:29' } },
    { label: 'Today', range: { from: today, fromTime: '00:00', to: today, toTime: nowHhmm } },
    { label: 'Yesterday', range: { from: shift(today, -1), fromTime: '00:00', to: shift(today, -1), toTime: '23:59' } },
    { label: 'Last night', range: { from: shift(today, -1), fromTime: '21:30', to: today, toTime: '06:00' } },
    { label: 'Last 7 days', range: { from: shift(today, -6), fromTime: '00:00', to: today, toTime: nowHhmm } },
  ];
}

/** What is wrong with the range, in words, or null. */
export function timeRangeProblem(r: DateTimeRange, now: number): string | null {
  const okDay = (d: string) => /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(Date.parse(`${d}T00:00:00Z`));
  const okTime = (t: string) => /^([01]\d|2[0-3]):[0-5]\d$/.test(t);
  if (!okDay(r.from) || !okDay(r.to)) return 'Pick both dates.';
  if (!okTime(r.fromTime) || !okTime(r.toTime)) return 'Pick both times.';
  const { from, to } = rangeMs(r);
  if (from > to) return 'The From must be before the To.';
  if (from > now) return 'The From cannot be in the future.';
  if (to - from > 366 * DAY) return 'At most a year at a time.';
  return null;
}

/** "18 Oct 9:30 PM → 19 Oct 3:00 PM": the range said, the date left out of an end on the same day as the other. */
export function timeRangeWords(r: DateTimeRange): string {
  const day = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
  const time = (t: string) => { const [h, m] = t.split(':').map(Number) as [number, number]; return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`; };
  return r.from === r.to ? `${day(r.from)} ${time(r.fromTime)} → ${time(r.toTime)}` : `${day(r.from)} ${time(r.fromTime)} → ${day(r.to)} ${time(r.toTime)}`;
}
