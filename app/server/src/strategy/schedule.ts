/**
 * When should a strategy run, and has it already?
 *
 * Pure, like `trading/machine.ts` and for the same reason: this decides whether
 * real orders are sent, so every case has to be constructible by hand. Time
 * arrives as an argument. Nothing here reads a clock, opens a database or
 * touches the exchange.
 *
 * The rule the whole file exists to enforce: **a strategy runs at most once per
 * IST day.** A desk that restarts at 05:31 must not enter a second time, and a
 * poll every thirty seconds must not enter thirty times. The day already run is
 * passed in, read from the journal, and compared here.
 */
import type { Strategy } from './types.js';
import { minutesForward, minutesOf, time12 } from './types.js';

/** IST is UTC+5:30 and has no daylight saving, so the offset is a constant. */
const IST_OFFSET_MIN = 330;

/** The IST calendar day a moment falls in, as `YYYY-MM-DD`. */
export function istDate(nowMs: number): string {
  const shifted = new Date(nowMs + IST_OFFSET_MIN * 60_000);
  return shifted.toISOString().slice(0, 10);
}

/** Minutes since IST midnight. */
export function istMinutes(nowMs: number): number {
  const shifted = new Date(nowMs + IST_OFFSET_MIN * 60_000);
  return shifted.getUTCHours() * 60 + shifted.getUTCMinutes();
}

/** 0 = Sunday … 6 = Saturday, in IST. */
export function istWeekday(nowMs: number): number {
  return new Date(nowMs + IST_OFFSET_MIN * 60_000).getUTCDay();
}

export type DueVerdict =
  | { due: true }
  | { due: false; because: string };

/**
 * How late an entry may be taken after its time passes.
 *
 * A desk that was down at 05:30 and comes up at 05:34 should still trade: the
 * contract has twelve hours to run and four minutes is nothing. One that comes
 * up at 09:00 should not, because the strategy measured on the record entered
 * at 05:30 and a five-hour-late entry is a different trade wearing its name.
 *
 * Sixty minutes, raised from thirty on 10 September 2026: a restart or a slow
 * price feed around the entry minute should not cost the day. Anything later
 * than that is still refused.
 */
export const GRACE_MIN = 60;

/**
 * The moment this strategy's entry time last came round, at or before `nowMs`.
 *
 * The anchor for everything below. A strategy is not really scheduled against
 * the calendar day but against its own entry: one that enters at 11:30 PM and
 * exits at 5:30 AM spends its life across two dates, and asking "what day is
 * it" gives the wrong answer for half of it. Asking "when did this strategy
 * last begin" gives the right one on both sides of midnight.
 */
export function entrySlotAt(s: Strategy, nowMs: number): number {
  const since = minutesForward(minutesOf(s.config.entryTime), istMinutes(nowMs));
  return Math.floor(nowMs / 60_000) * 60_000 - since * 60_000;
}

/**
 * The IST day the current entry slot belongs to -- the day the journal records
 * it under, and the day the once-a-day guard is about.
 *
 * For an entry taken at 00:10 on a 11:30 PM strategy, that is yesterday. Using
 * today's date instead would spend a day that has not run yet.
 */
export function entrySlotDate(s: Strategy, nowMs: number): string {
  return istDate(entrySlotAt(s, nowMs));
}

/** How long this strategy holds, in minutes: entry to exit, round midnight if need be. */
function holdMinutes(s: Strategy): number {
  return minutesForward(minutesOf(s.config.entryTime), minutesOf(s.config.exitTime)) || 1440;
}

/**
 * When this entry window closes, in epoch ms: the entry minute plus GRACE_MIN,
 * inclusive of that last minute. An entry still resting then is cancelled
 * rather than left on the book into the day.
 */
export function entryWindowEnd(s: Strategy, nowMs: number): number {
  return entrySlotAt(s, nowMs) + (GRACE_MIN + 1) * 60_000;
}

/**
 * Should this strategy enter right now?
 *
 * @param lastRunDate the IST day it last ran, from the journal, or null
 */
export function entryDue(
  s: Strategy,
  nowMs: number,
  lastRunDate: string | null,
): DueVerdict {
  if (!s.enabled) return { due: false, because: 'strategy is off' };

  const start = minutesOf(s.config.entryTime);
  // How long ago this strategy's entry time came round, and the slot it opened.
  const since = minutesForward(start, istMinutes(nowMs));
  const slotMs = entrySlotAt(s, nowMs);
  const slotDay = istDate(slotMs);

  // The first thing checked, because it is the one that must never be got
  // wrong: whatever else is true, a day that has run does not run again.
  if (lastRunDate === slotDay) {
    return {
      due: false,
      because: slotDay === istDate(nowMs) ? `already ran today (${slotDay})` : `already ran on ${slotDay}`,
    };
  }

  // The weekday of the slot, not of the moment: an 11:30 PM Friday strategy
  // reaching 00:10 on Saturday is still running Friday's slot.
  if (!s.config.weekdays.includes(istWeekday(slotMs))) {
    return { due: false, because: 'not one of its days' };
  }

  const hold = holdMinutes(s);
  if (since > GRACE_MIN) {
    // Inside the slot's own window it is late for this one; past it, the next
    // one is simply not here yet.
    return since < hold
      ? { due: false, because: `too late -- ${time12(s.config.entryTime)} passed more than ${GRACE_MIN} minutes ago` }
      : { due: false, because: `waiting for ${time12(s.config.entryTime)} IST` };
  }
  // Entering after the exit would open a position the same pass wants to close.
  // Only reachable on a window shorter than the grace period, which is a
  // misconfigured pair rather than a real strategy -- but it is cheap to catch.
  if (since >= hold) return { due: false, because: 'past its own exit time' };
  return { due: true };
}

/**
 * Should whatever this strategy opened today be closed now?
 *
 * Deliberately not symmetrical with `entryDue`. There is no grace window and no
 * once-a-day guard: an exit that was missed at 17:29 is still wanted at 17:40,
 * and asking twice to close a position that is already flat costs nothing while
 * failing to ask once costs the position. Late is fine; never is not.
 */
export function exitDue(s: Strategy, nowMs: number, hasOpenPosition: boolean): DueVerdict {
  if (!hasOpenPosition) return { due: false, because: 'nothing open' };
  if (nowMs < exitMomentAt(s, nowMs)) {
    return { due: false, because: `holding until ${time12(s.config.exitTime)} IST` };
  }
  return { due: true };
}

/**
 * The moment the exit is due for whatever the last entry slot opened.
 *
 * Measured from the entry rather than read off the clock, which is what lets an
 * overnight strategy hold: at 11:35 PM a 5:30 AM exit has not passed, it is six
 * hours away. Reading the clock alone would close the position five minutes
 * after opening it.
 */
export function exitMomentAt(s: Strategy, nowMs: number): number {
  return entrySlotAt(s, nowMs) + holdMinutes(s) * 60_000;
}

/**
 * The next moment this strategy would enter, for the screen to count down to.
 *
 * Returns null when it never would -- switched off, or no days selected.
 */
export function nextEntryAt(s: Strategy, nowMs: number, lastRunDate: string | null): number | null {
  if (!s.enabled || s.config.weekdays.length === 0) return null;
  const start = minutesOf(s.config.entryTime);
  for (let ahead = 0; ahead <= 8; ahead++) {
    const probe = nowMs + ahead * 86_400_000;
    if (!s.config.weekdays.includes(istWeekday(probe))) continue;
    const day = istDate(probe);
    if (day === istDate(nowMs)) {
      if (lastRunDate === day) continue;          // today is spent
      // Today's entry has been and gone, and its grace window with it.
      if (istMinutes(nowMs) >= start && minutesForward(start, istMinutes(nowMs)) > GRACE_MIN) continue;
    }
    // midnight IST of that day, in epoch ms, plus the entry minute
    const midnightUtc = Date.parse(`${day}T00:00:00Z`) - IST_OFFSET_MIN * 60_000;
    const at = midnightUtc + start * 60_000;
    if (at >= nowMs - GRACE_MIN * 60_000) return at;
  }
  return null;
}

/**
 * How many lots each leg gets, given which legs the gate let through.
 *
 * The doubling rule lives here rather than in the runner so it can be tested
 * without an exchange: when exactly one leg survives a gate that was actually
 * applied, it carries two lots.
 */
export function lotsPerLeg(
  s: Strategy,
  qualified: readonly ('CE' | 'PE')[],
): Record<'CE' | 'PE', number> {
  const base = s.config.lots;
  const out: Record<'CE' | 'PE', number> = { CE: 0, PE: 0 };
  const gateOn = s.config.probGate !== null;
  const doubling = s.config.doubleWhenOneSided && gateOn
    && s.config.legs === 'both' && qualified.length === 1;
  for (const leg of qualified) out[leg] = doubling ? base * 2 : base;
  return out;
}
