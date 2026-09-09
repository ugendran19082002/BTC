import { price } from '@/lib/format';

/**
 * Whether a stop and a target make sense against the price right now.
 *
 * Every position this desk holds is short: sold to open, bought to close. So
 * the target sits *below* where the mark is and the stop *above* it, and the
 * bars enforce that much by construction — a target is a percentage down from
 * the entry and a stop a percentage up.
 *
 * What the bars cannot know is where the mark has got to since. Once it has
 * moved past a level, that level is *already reached*, and the order will act
 * the moment it is placed. For a target that is usually welcome — the money has
 * been made. For a stop it means taking the loss immediately. Neither is a
 * fault, and neither is blocked: the desk closing a position at a level you
 * asked it to close at is the system working. But it is not what somebody
 * dragging a bar usually expects, so it is said plainly before the button.
 *
 * Returned as data rather than rendered here so the ticket and the exits sheet
 * cannot drift into telling the same story two different ways.
 */

export type ExitCheck = {
  leg: 'target' | 'stop';
  /** `now` fires immediately; `wrong-side` cannot be reached at all. */
  kind: 'now' | 'wrong-side';
  message: string;
};

export function checkExits(input: {
  /** The exchange's mark. Without it there is nothing to check against. */
  mark: number | null | undefined;
  /** The price the position was opened at. */
  entry: number | null | undefined;
  targetPrice: number | null;
  stopPrice: number | null;
}): ExitCheck[] {
  const { mark, entry, targetPrice, stopPrice } = input;
  if (mark === null || mark === undefined || !Number.isFinite(mark) || mark <= 0) return [];

  const out: ExitCheck[] = [];

  if (targetPrice !== null && Number.isFinite(targetPrice)) {
    if (targetPrice >= mark) {
      out.push({
        leg: 'target',
        kind: 'now',
        message:
          `The mark is already ${price(mark)}, so a target at ${price(targetPrice)} fills as soon ` +
          `as it is set. It is a limit buy and cannot pay more than ${price(targetPrice)} — it ` +
          'simply closes the position now rather than later.',
      });
    }
    // A "target" above the entry buys back higher than it sold: a loss, whatever
    // it is called. The bars cannot produce one, but a number typed in can.
    if (entry != null && Number.isFinite(entry) && targetPrice > entry) {
      out.push({
        leg: 'target',
        kind: 'wrong-side',
        message:
          `This target of ${price(targetPrice)} is above the ${price(entry)} it was sold at, so ` +
          'taking it would book a loss. A target on a short belongs below the entry.',
      });
    }
  }

  if (stopPrice !== null && Number.isFinite(stopPrice)) {
    if (stopPrice <= mark) {
      out.push({
        leg: 'stop',
        kind: 'now',
        message:
          `The mark is already ${price(mark)}, at or above this stop of ${price(stopPrice)}, so ` +
          'it fires as soon as it is set and closes the position at the market. Use close now if ' +
          'that is what you want.',
      });
    }
    if (entry != null && Number.isFinite(entry) && stopPrice < entry) {
      out.push({
        leg: 'stop',
        kind: 'wrong-side',
        message:
          `This stop of ${price(stopPrice)} is below the ${price(entry)} it was sold at, so it ` +
          'would close at a profit. That is a target, not a stop.',
      });
    }
  }

  return out;
}
