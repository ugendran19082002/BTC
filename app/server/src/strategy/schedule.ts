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
import { minutesOf } from './types.js';

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

  const today = istDate(nowMs);
  // The first thing checked, because it is the one that must never be got
  // wrong: whatever else is true, a day that has run does not run again.
  if (lastRunDate === today) return { due: false, because: `already ran today (${today})` };

  if (!s.config.weekdays.includes(istWeekday(nowMs))) {
    return { due: false, because: 'not one of its days' };
  }

  const now = istMinutes(nowMs);
  const start = minutesOf(s.config.entryTime);
  if (now < start) return { due: false, because: `waiting for ${s.config.entryTime} IST` };
  if (now > start + GRACE_MIN) {
    return { due: false, because: `too late -- ${s.config.entryTime} passed more than ${GRACE_MIN} minutes ago` };
  }
  // Entering after the exit time would open a position the same pass wants to
  // close. Cheap to check, and it catches a misconfigured pair.
  if (now >= minutesOf(s.config.exitTime)) {
    return { due: false, because: 'past its own exit time' };
  }
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
  const now = istMinutes(nowMs);
  if (now < minutesOf(s.config.exitTime)) {
    return { due: false, because: `holding until ${s.config.exitTime} IST` };
  }
  return { due: true };
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
      if (istMinutes(nowMs) > start + GRACE_MIN) continue;
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
