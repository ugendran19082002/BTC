/**
 * Where a call got to, between its trigger and its target.
 *
 * The owner's reference draws each signal as a track: the trigger at one end,
 * the target at the other, the stop behind, and a dot for where price actually
 * reached. It answers in one glance what three columns of numbers answer
 * slowly -- did this trigger, how far did it get, and which way did it end.
 *
 * Pure, because the arithmetic is the part that can be wrong: a dot on the
 * wrong side of a trigger is a row that says the opposite of the truth, and a
 * canvas or a stylesheet cannot be asked whether it did that.
 */

export type Track = {
  /** 0 at the trigger, 1 at the target. Clamped, so an overshoot sits at the end. */
  at: number;
  /** Before the trigger, this is how far short it is, in points. */
  shortBy: number | null;
  /** Which way the track runs, for the colour. */
  tone: 'up' | 'down' | 'flat';
  reached: boolean;
};

export function trackFor(input: {
  side: 'UP' | 'DOWN' | null;
  trigger: number | null;
  target: number | null;
  /** The furthest price got, or the price now while it is still running. */
  price: number | null;
  outcome: string | null;
}): Track | null {
  const { side, trigger, target, price } = input;
  if (side === null || trigger === null || target === null || price === null) return null;
  if (trigger === target) return null;

  // The trigger is reached when price trades through it the way the call says.
  const reached = side === 'UP' ? price >= trigger : price <= trigger;
  const span = target - trigger;
  const done = (price - trigger) / span;
  return {
    at: Math.max(0, Math.min(1, done)),
    shortBy: reached ? null : Math.round(Math.abs(trigger - price)),
    tone: input.outcome === 'INVALIDATED' ? 'down'
      : input.outcome === 'TARGET_HIT' ? 'up'
        : reached ? (side === 'UP' ? 'up' : 'down') : 'flat',
    reached,
  };
}
