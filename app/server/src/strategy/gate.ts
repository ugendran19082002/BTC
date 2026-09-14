import type { SuddenMove } from '../domain/shock.js';

/**
 * Whether the tape is calm enough to sell into.
 *
 * Pure, and separate from the runner that reads the tape, for the same reason
 * `select.ts` is separate: the runner is the one part of this that cannot be
 * tested by hand — it reads a clock, reads the board and sends orders — so
 * every judgement it makes is made somewhere else and checked there.
 *
 * ## Why holding beats refusing
 *
 * A verdict here does not spend the day. Above the limit the answer is `wait`,
 * the runner claims nothing, and the next tick asks again until the entry
 * window closes and the missed-entry alert fires. The gate was asked for as
 * "enter when the risk is 25 or less", and a rule that burned the whole day on
 * one noisy five-minute window would be a different rule.
 *
 * ## Why an unreadable score also waits
 *
 * A desk one minute old has no volatility history and no open-interest history,
 * so it can take no reading at all and the score is null. Treating that as calm
 * would report a quiet market on the strength of not knowing, which is the one
 * failure that would get somebody short into a move. Absent is not zero, here
 * as everywhere else in this repo.
 */
export type GateVerdict =
  /** Enter. Either the gate is off, or the reading is at or under the limit. */
  | { pass: true; reason: null }
  /** Wait and look again. Never spends the day. */
  | { pass: false; reason: string };

/** How many reasons from the reading are worth printing beside the number. */
const REASONS_SHOWN = 2;

export function shockGate(
  limit: number | null,
  reading: Pick<SuddenMove, 'score' | 'band' | 'reasons'> | null,
): GateVerdict {
  if (limit === null) return { pass: true, reason: null };

  if (!reading || reading.score === null) {
    return {
      pass: false,
      reason: 'sudden-move risk could not be read, and an unread risk is not a calm one',
    };
  }
  if (reading.score <= limit) return { pass: true, reason: null };

  // The number, then why it is that number: a refusal nobody can check is a
  // refusal nobody will trust the next time it stops a trade they wanted.
  const why = reading.reasons.slice(0, REASONS_SHOWN).join('; ');
  return {
    pass: false,
    reason: `sudden-move risk is ${reading.score}/100, above the ${limit} limit`
      + (why ? ` — ${why}` : ''),
  };
}
