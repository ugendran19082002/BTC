/**
 * Why a strategy that is due has not entered.
 *
 * `schedule.ts` answers "is it time" from the clock alone, and that is all the
 * screen used to have — so a strategy held back by the sudden-move gate read
 * "due now" on the screen while nothing happened, minute after minute. A hold
 * with no reason on screen is the same fault as a control that does nothing:
 * the desk knows something the person watching it does not.
 *
 * In memory, deliberately. A hold is true of this minute and nothing else; it
 * is cleared the moment the strategy enters or the answer changes, and a
 * restart is allowed to forget it. Nothing is decided from what is kept here —
 * it is read by the screen and by no one else.
 */
import type { DueVerdict } from './schedule.js';

export type Hold = {
  /** The entry slot's IST day, so yesterday's reason never shows against today. */
  day: string;
  reason: string;
  at: number;
};

const holds = new Map<string, Hold>();

export function noteHold(strategyId: string, day: string, reason: string, at: number): void {
  holds.set(strategyId, { day, reason, at });
}

/** The reason, if it is about the day being asked about. */
export function holdFor(strategyId: string, day: string): Hold | null {
  const h = holds.get(strategyId);
  return h && h.day === day ? h : null;
}

export function clearHold(strategyId: string): void {
  holds.delete(strategyId);
}

/** Tests only: the map is process-wide, so one test's hold is another's state. */
export function resetHolds(): void {
  holds.clear();
}

/**
 * The one line the screen shows for a strategy, from the clock and the hold.
 *
 * A hold outranks "due now", which is the whole point of it: the clock says it
 * is time and the desk has decided to wait, and that is exactly the case the
 * screen was silent about. It never outranks a clock reason -- "already ran
 * today" is a fact about the day, and a stale hold must not talk over it.
 */
export function statusOf(due: DueVerdict, hold: Hold | null): string {
  if (!due.due) return due.because;
  return hold?.reason ?? 'due now';
}
