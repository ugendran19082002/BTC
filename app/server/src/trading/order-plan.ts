import type { TradePlan } from './engine.js';
import { clampLeverage } from './margin.js';

/**
 * An order request, turned into the plan the engine trades.
 *
 * Kept apart from the service so the exact plan a screen tap, a scheduled entry
 * or an add to the other leg produces can be built in a test without starting
 * the service, its database or its exchange.
 */

/**
 * Two hundred, matching Delta's own app.
 *
 * This is the leverage the account already trades at, so the desk defaults to
 * it rather than quietly disagreeing with the exchange screen beside it. It
 * cuts both ways and the ticket says so:
 *
 *   - the margin behind a lot is half a percent of spot, so a small balance can
 *     open a position, and the close-out sits close above where you sold;
 *   - but because the close-out is close, the loss before it arrives is small.
 *     At 200x a naked short risks the room to the close-out and no more, which
 *     is a fraction of what the same trade risks at 10x.
 *
 * The ticket shows the close-out price on the bar as you drag, so the tightness
 * is visible rather than implied.
 */
export const DEFAULT_LEVERAGE = 200;

/**
 * Four concessions rather than one.
 *
 * Enough that a maker willing to meet you part of the way gets the chance, few
 * enough that the whole walk is over inside the window and each step is a
 * visible move rather than a rounding error on a tick.
 */
export const CHASE_STEPS = 4;
/**
 * The exits, as percentages of the premium.
 *
 * A short option is sold for a credit and bought back for less, so the two
 * exits are read off the entry price in opposite directions:
 *
 *   target  -- the option has decayed by this much.  price = entry x (1 - pct)
 *   stop    -- the option has run against you by this much. price = entry x (1 + pct)
 *
 * Zero means off. Neither is derived behind your back: a trade that runs
 * without a stop says so on the ticket, in the position row, and in the
 * journal, and it is a decision rather than a malfunction.
 */
export const targetPriceFor = (entry: number, pct: number): number | null =>
  pct > 0 ? round1(entry * (1 - Math.min(0.99, pct))) : null;

export const stopPriceFor = (entry: number, pct: number): number | null =>
  pct > 0 ? round1(entry * (1 + pct)) : null;

export type PlaceInput = {
  symbol: string;
  optionSide: 'CE' | 'PE';
  /** Set when a saved strategy placed this, so its exit can find it again. */
  strategyId?: string;
  strike: number;
  expiryTs: number;
  lots: number;
  /** 1 to 200. Sets the margin, and how close the close-out sits. */
  leverage?: number;
  /**
   * Seconds over which to walk the price from the offer to the bid.
   * Zero leaves the order where it was put, to fill or not.
   */
  chaseSeconds?: number;
  /** Absent means take what the book offers. */
  limitPrice?: number;
  /** 0 to 0.99. Zero means no target. */
  takeProfitPct?: number;
  /** 0 upwards. Zero means no stop. */
  stopLossPct?: number;
  /** Overrides the percentage, when a caller wants an exact price. */
  takeProfitPrice?: number | null;
  stopPrice?: number | null;
  timeoutMs?: number;
  marketFallback?: boolean;
  /** Sell into the bid only while the spread is at most this. Null walks to the bid regardless. */
  maxCrossSpreadPct?: number | null;
};

export function orderPlan(input: PlaceInput, tradeId: string): TradePlan {
  const price = input.limitPrice;
  // A market entry has no price yet, so a percentage cannot be turned into
  // one; the exits are placed from the actual fill on the first poll instead.
  const basis = price ?? null;
  const plan: TradePlan = {
    tradeId,
    symbol: input.symbol,
    strategyId: input.strategyId,
    optionSide: input.optionSide,
    lots: input.lots,
    leverage: clampLeverage(input.leverage ?? DEFAULT_LEVERAGE),
    entry: price === undefined
      ? { type: 'market', timeoutMs: 0, marketFallback: false, chase: null }
      : {
          type: 'limit', limitPrice: price,
          /*
           * A limit rests until something ends it, and a chase is the better
           * ending: the last step is the bid, which is marketable, so the walk
           * always finishes in a fill without a timer forcing one.
           *
           * The timeout is honoured whenever a caller asks for one; with a
           * chase it only ever cancels what is left. These two were hardcoded to 0/false while the signature went
           * on accepting them, so the scheduler's "cross after 5 seconds"
           * reached this function and was thrown away -- an entry rested at the
           * offer all morning, half filled, and nothing crossed. A parameter
           * that is accepted and ignored is worse than one that is absent.
           */
          // The scheduler uses it to end an entry at the close of its window.
          timeoutMs: Math.max(0, Math.round(input.timeoutMs ?? 0)),
          marketFallback: input.chaseSeconds && input.chaseSeconds > 0
            ? false
            : (input.marketFallback ?? false),
          chase: input.chaseSeconds && input.chaseSeconds > 0
            ? {
                steps: CHASE_STEPS,
                everyMs: Math.round((input.chaseSeconds * 1_000) / CHASE_STEPS),
                maxCrossSpreadPct: input.maxCrossSpreadPct ?? null,
              }
            : null,
        },
    takeProfitPrice:
      input.takeProfitPrice !== undefined
        ? input.takeProfitPrice
        : basis !== null ? targetPriceFor(basis, input.takeProfitPct ?? 0) : null,
    stopPrice:
      input.stopPrice !== undefined
        ? input.stopPrice
        : basis !== null ? stopPriceFor(basis, input.stopLossPct ?? 0) : null,
    expect: {
      underlying: 'BTC',
      optionSide: input.optionSide,
      strike: input.strike,
      expiryTs: input.expiryTs,
    },
  };
  return plan;
}

const round1 = (n: number) => Math.round(n * 10) / 10;
