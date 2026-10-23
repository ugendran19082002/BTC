import { SETTLEMENT, isHhmm, minutesForward, minutesOf, time12 } from '@/lib/time';
import type { Chase } from '@/types/signal-backtest';

/**
 * The chase guard's own rules, as the server holds them (`backtestParamsOf`): two times of the expiry day, the check
 * after the reference read forward from 5:30 PM, and 50 to 20,000 points.
 */
export const CHASE_PTS_MIN = 50;
export const CHASE_PTS_MAX = 20_000;
/** The owner's own, from the afternoon study (22 Oct 2026): from 11 AM, 400 points or more since 7 AM. */
export const CHASE_DEFAULT: Chase = { from: '07:00', after: '11:00', pts: 400 };

export function chaseProblems(c: Chase): string[] {
  const out: string[] = [];
  if (!isHhmm(c.from) || !isHhmm(c.after)) out.push('Pick both times.');
  else if (!(minutesForward(minutesOf(SETTLEMENT), minutesOf(c.after)) > minutesForward(minutesOf(SETTLEMENT), minutesOf(c.from)))) out.push('The check starts after the time the move is read from, in the same expiry day (from 5:30 PM).');
  if (!(Number.isInteger(c.pts) && c.pts >= CHASE_PTS_MIN && c.pts <= CHASE_PTS_MAX)) out.push(`The move is a whole number of points from ${CHASE_PTS_MIN} to ${CHASE_PTS_MAX.toLocaleString('en-IN')}.`);
  return out;
}
/** The guard as the server reads it, `07:00-11:00-400`; null where it is off or wrong. */
export const chaseQuery = (c: Chase | null | undefined): string | null => (c && !chaseProblems(c).length ? `${c.from}-${c.after}-${c.pts}` : null);
/** "chase guard from 11:00 AM, 400 pts since 7:00 AM": a few words; null with none. */
export const chaseWords = (c: Chase | null | undefined): string | null => (c ? `chase guard from ${time12(c.after)}, ${c.pts} pts since ${time12(c.from)}` : null);
