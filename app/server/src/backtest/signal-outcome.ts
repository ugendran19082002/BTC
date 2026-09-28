import type { Candle } from '../market/delta.js';
import type { Plan, Side } from '../domain/market-state.js';

/**
 * How a market-state call turned out, judged against the bars that followed.
 *
 * Pure: the momentum study grades its replayed calls with it. It lived in
 * `market/state-history.ts` beside the live journal (the `market_states`
 * table), which was removed with the Signal History list on 28 Sep 2026.
 */

/**
 * What became of a call, in the words of what actually happened.
 *
 * It used to be CORRECT / WRONG / UNRESOLVED, and **WRONG was a lie most of
 * the time it appeared**. A breakout watch says "over 84,532 this goes to
 * 84,731" -- if price never reached 84,532 the setup never happened, and
 * marking it wrong grades a trade nobody could have taken. The screen filled
 * with red for calls that were never anything but a plan.
 *
 * So a call now ends where it actually ended:
 *
 * * `NOT_TRIGGERED` -- the trigger was never reached. Nothing happened. This
 *   is not a failure and is never shown as one.
 * * `TARGET_HIT` -- triggered, and the first target came before the stop.
 * * `INVALIDATED` -- triggered, and the invalidation came first. A bar that
 *   reached both counts here: the order is not in the bar, and the assumption
 *   against the call is the only one that cannot flatter it.
 * * `EXPIRED` -- triggered, and the window closed with neither reached. Price
 *   drifted. Counting that either way would be choosing an answer.
 * * `NOT_GRADED` -- a range. "Nothing is happening" is not a prediction.
 *
 * The word *wrong* belongs on a backtest page, after a window has closed, next
 * to what was predicted and what happened. It does not belong on a live screen
 * where most of what it marks has not finished yet.
 */
export type Outcome = 'TARGET_HIT' | 'INVALIDATED' | 'NOT_TRIGGERED' | 'EXPIRED' | 'NOT_GRADED';

export type SignalAudit = {
  outcome: Outcome;
  triggeredAt: number | null;
  confirmedAt: number | null;
  targetHitAt: number | null;
  stopHitAt: number | null;
  expiredAt: number | null;
  firstHit: 'TARGET' | 'STOP' | 'NONE';
  firstHitPrice: number | null;
  firstHitTime: number | null;
  mfe: number | null;
  mae: number | null;
  mfePrice: number | null;
  maePrice: number | null;
};

/**
 * Full intrabar audit evaluation of a signal over the bars following its call.
 *
 * Tracks the trigger moment, whether target or stop was hit first, the exact price
 * and timestamp of that first hit, and the maximum favorable and adverse excursion.
 */
export function evaluateSignalOutcome(input: {
  plan: Plan | null;
  side: Side | null;
  stage: string;
  callAt: number;
  closeAtCall: number;
  windowMs: number;
  after: readonly Candle[];
}): SignalAudit {
  const { plan, side, stage, callAt, closeAtCall, windowMs, after } = input;
  const defAudit: SignalAudit = {
    outcome: 'NOT_GRADED',
    triggeredAt: null,
    confirmedAt: null,
    targetHitAt: null,
    stopHitAt: null,
    expiredAt: null,
    firstHit: 'NONE',
    firstHitPrice: null,
    firstHitTime: null,
    mfe: null,
    mae: null,
    mfePrice: null,
    maePrice: null,
  };

  if (!plan || side === null) return defAudit;
  if (!after.length) {
    return { ...defAudit, outcome: 'EXPIRED', expiredAt: callAt + windowMs };
  }

  const through = (bar: Candle) => (side === 'UP' ? bar.high >= plan.trigger : bar.low <= plan.trigger);
  const alreadyThrough = stage === 'CONFIRMED' || stage === 'RETEST' || stage === 'FAILED';
  const from = alreadyThrough ? 0 : after.findIndex(through);

  if (from < 0) {
    return {
      ...defAudit,
      outcome: 'NOT_TRIGGERED',
      expiredAt: callAt + windowMs,
    };
  }

  const triggerBar = after[from]!;
  const triggeredAt = alreadyThrough ? callAt : triggerBar.time * 1000;
  const confirmedAt = (alreadyThrough || stage === 'CONFIRMED') ? callAt : null;
  const tradeBars = after.slice(from);
  const entryPrice = alreadyThrough ? closeAtCall : plan.trigger;

  let bestPrice = entryPrice;
  let worstPrice = entryPrice;
  let firstHit: 'TARGET' | 'STOP' | 'NONE' = 'NONE';
  let firstHitPrice: number | null = null;
  let firstHitTime: number | null = null;
  let targetHitAt: number | null = null;
  let stopHitAt: number | null = null;
  let outcome: Outcome = 'EXPIRED';

  for (const bar of tradeBars) {
    const barTimeMs = bar.time * 1000;
    if (side === 'UP') {
      if (bar.high > bestPrice) bestPrice = bar.high;
      if (bar.low < worstPrice) worstPrice = bar.low;
    } else {
      if (bar.low < bestPrice) bestPrice = bar.low;
      if (bar.high > worstPrice) worstPrice = bar.high;
    }

    const hitTarget = side === 'UP' ? bar.high >= plan.target1 : bar.low <= plan.target1;
    const hitStop = side === 'UP' ? bar.low <= plan.invalidation : bar.high >= plan.invalidation;

    if (firstHit === 'NONE') {
      if (hitStop && hitTarget) {
        firstHit = 'STOP';
        firstHitPrice = plan.invalidation;
        firstHitTime = barTimeMs;
        stopHitAt = barTimeMs;
        outcome = 'INVALIDATED';
      } else if (hitStop) {
        firstHit = 'STOP';
        firstHitPrice = plan.invalidation;
        firstHitTime = barTimeMs;
        stopHitAt = barTimeMs;
        outcome = 'INVALIDATED';
      } else if (hitTarget) {
        firstHit = 'TARGET';
        firstHitPrice = plan.target1;
        firstHitTime = barTimeMs;
        targetHitAt = barTimeMs;
        outcome = 'TARGET_HIT';
      }
    }
  }

  const expiredAt = outcome === 'EXPIRED' ? callAt + windowMs : null;
  const mfe = side === 'UP'
    ? Math.max(0, Math.round((bestPrice - entryPrice) * 100) / 100)
    : Math.max(0, Math.round((entryPrice - bestPrice) * 100) / 100);
  const mae = side === 'UP'
    ? Math.max(0, Math.round((entryPrice - worstPrice) * 100) / 100)
    : Math.max(0, Math.round((worstPrice - entryPrice) * 100) / 100);

  return {
    outcome,
    triggeredAt,
    confirmedAt,
    targetHitAt,
    stopHitAt,
    expiredAt,
    firstHit,
    firstHitPrice,
    firstHitTime,
    mfe,
    mae,
    mfePrice: bestPrice,
    maePrice: worstPrice,
  };
}

/**
 * What happened after the call, judged in the order it could have happened.
 *
 * The trigger comes first. A setup is a conditional -- over this price,
 * towards that one -- so the bars are read for the trigger before anything
 * else is asked. Until price reaches it there is no trade and no verdict.
 */
export function outcomeFor(input: {
  plan: Plan | null;
  side: Side | null;
  /** WATCH and CANDIDATE are setups; CONFIRMED and RETEST are already through. */
  stage: string;
  after: readonly Candle[];
}): Outcome {
  return evaluateSignalOutcome({
    plan: input.plan,
    side: input.side,
    stage: input.stage,
    callAt: 0,
    closeAtCall: input.plan?.trigger ?? 0,
    windowMs: 0,
    after: input.after,
  }).outcome;
}
