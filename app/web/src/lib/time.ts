/**
 * Times of day, as the desk stores them and as a person reads them.
 *
 * Stored and sent as 24-hour "HH:MM" IST, because "5:30" alone is two different
 * moments. Shown as 12-hour with AM or PM, because that is how a time is read.
 * The server has the same helpers in strategy/types.ts, and the two must agree.
 */

export type Period = 'AM' | 'PM';

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** The daily contract settles at 17:30 IST. */
export const SETTLEMENT = '17:30';
/** How long before the exit the default latest-add time sits. */
export const DEFAULT_ADD_CUTOFF_MIN = 30;

export const isHhmm = (v: unknown): v is string => typeof v === 'string' && HHMM.test(v);

/** "05:30" -> 330. */
export function minutesOf(hhmm: string): number {
  const [h, m] = hhmm.split(':');
  return Number(h) * 60 + Number(m);
}

/** 330 -> "05:30", wrapping around midnight. */
export function hhmmOf(minutes: number): string {
  const m = ((Math.round(minutes) % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

/** "17:29" -> "5:29 PM". Anything that is not a time comes back as it was. */
export function time12(hhmm: string): string {
  if (!isHhmm(hhmm)) return hhmm;
  const { hour, minute, period } = partsOf(hhmm);
  return `${hour}:${String(minute).padStart(2, '0')} ${period}`;
}

/** "17:29" -> { hour: 5, minute: 29, period: 'PM' }. */
export function partsOf(hhmm: string): { hour: number; minute: number; period: Period } {
  const total = isHhmm(hhmm) ? minutesOf(hhmm) : 0;
  const h = Math.floor(total / 60);
  return { hour: h % 12 === 0 ? 12 : h % 12, minute: total % 60, period: h < 12 ? 'AM' : 'PM' };
}

/** { hour: 5, minute: 29, period: 'PM' } -> "17:29". `hour` is 1-12. */
export function fromParts(hour: number, minute: number, period: Period): string {
  const h = (hour % 12) + (period === 'PM' ? 12 : 0);
  return hhmmOf(h * 60 + minute);
}

/**
 * Whatever somebody types, if it is clearly a time: "5:29 pm", "5.29PM",
 * "5 pm", "17:29", "1729", "529pm". Null when it is not -- never a guess.
 */
export function parseTyped(text: string): string | null {
  const t = text.trim().toLowerCase().replace(/\s+/g, '');
  const m = /^(\d{1,2})(?:[:.]?(\d{2}))?(am|pm|a|p)?$/.exec(t);
  if (!m) return null;
  const hour = Number(m[1]);
  const minute = m[2] === undefined ? 0 : Number(m[2]);
  const suffix = m[3];
  if (minute > 59) return null;
  if (suffix) {
    if (hour < 1 || hour > 12) return null;
    return fromParts(hour, minute, suffix.startsWith('p') ? 'PM' : 'AM');
  }
  // No AM or PM: read as 24-hour -- "17:29", "1729", "0530".
  if (hour > 23) return null;
  return hhmmOf(hour * 60 + minute);
}

/** Inclusive: is this time within [min, max]? Either end may be absent. */
export function inRange(hhmm: string, min?: string | null, max?: string | null): boolean {
  const v = minutesOf(hhmm);
  if (min && isHhmm(min) && v < minutesOf(min)) return false;
  if (max && isHhmm(max) && v > minutesOf(max)) return false;
  return true;
}

/** "11 h 59 min", "45 min" -- from one time of day to a later one. */
export function spanLabel(from: string, to: string): string {
  if (!isHhmm(from) || !isHhmm(to)) return '';
  const d = minutesOf(to) - minutesOf(from);
  if (d <= 0) return '';
  const h = Math.floor(d / 60);
  const m = d % 60;
  return h === 0 ? `${m} min` : m === 0 ? `${h} h` : `${h} h ${m} min`;
}

/** Half an hour before the exit -- or a minute before, on a strategy shorter than that. */
export function defaultAddUntil(exitTime: string): string {
  const exit = isHhmm(exitTime) ? minutesOf(exitTime) : minutesOf('17:29');
  return hhmmOf(exit - DEFAULT_ADD_CUTOFF_MIN > 0 ? exit - DEFAULT_ADD_CUTOFF_MIN : Math.max(0, exit - 1));
}
