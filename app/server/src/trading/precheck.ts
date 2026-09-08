import type { OrderSide, OptionSide, ProductSpec, Quote } from './types.js';
import { isWholeLots, spreadPct } from './money.js';
import { clampLeverage, fundsRequiredPerContract, liquidationPrice } from './margin.js';

/**
 * The gates a trade passes before a single byte goes to the exchange.
 *
 * Each one exists because of a specific way money is lost: a stale quote, a
 * spread nobody would cross, a second short on top of the first, a day that is
 * already down to its limit. They are cheap, they are local, and they are the
 * difference between a rejected order and a filled one you did not mean.
 */

export type PrecheckCode =
  | 'NO_PRODUCT' | 'WRONG_UNDERLYING' | 'WRONG_OPTION_SIDE' | 'WRONG_STRIKE'
  | 'WRONG_EXPIRY' | 'NOT_TRADABLE' | 'EXPIRED'
  | 'FEED_DOWN' | 'NO_QUOTE' | 'STALE_QUOTE'
  | 'SPREAD_TOO_WIDE' | 'THIN_BOOK'
  | 'MIN_SIZE' | 'LOT_SIZE'
  | 'PREMIUM_TOO_LOW'
  | 'INSUFFICIENT_MARGIN' | 'DUPLICATE_POSITION' | 'MAX_POSITION' | 'DAILY_LOSS_LIMIT'
  | 'WRONG_EXIT_SIDE' | 'KILL_SWITCH'
  | 'LEVERAGE_TOO_HIGH' | 'STOP_BEYOND_LIQUIDATION';

export type Failure = { code: PrecheckCode; message: string };
export type PrecheckResult = { ok: true } | { ok: false; failures: Failure[] };

export type RiskLimits = {
  /** A quote older than this is not a quote. */
  maxQuoteAgeMs: number;
  /**
   * Widest bid/ask, as a fraction of the mid, that an order may cross.
   *
   * Measured rather than guessed. Across 136 two-sided quotes on one daily
   * expiry: median 4.3%, 75th percentile 9.5%, 90th 22%, worst 62%. A 4% limit
   * — an equity-options intuition — blocked half the board, including strikes
   * whose spread was entirely ordinary for this instrument.
   *
   * 15% blocks the 16% of quotes that are genuinely wide and lets the working
   * range through. It only ever applies to an order that crosses; resting at
   * the offer is unaffected, because a wide book is the reason to rest.
   */
  maxSpreadPct: number;
  /** Top-of-book size must cover at least this share of ours. */
  minBookCoverage: number;
  /** Total short contracts allowed across the book. */
  maxShortContracts: number;
  /**
   * Stop the day once losses reach this, in USD.
   *
   * A number, not a percentage, because it is compared against a worst case in
   * dollars. But it has to be *set* from the balance: five thousand dollars on
   * an account holding fifty-nine cents is not a risk limit, it is decoration,
   * and a gate that can never fire is worse than no gate because it reads as
   * protection. See dailyLossLimitFor().
   */
  maxDailyLossUsd: number;
  /** Do not sell an option for less than this. */
  minPremiumUsd: number;
  /** Off by default: a second short on the same contract is normally a bug. */
  allowPyramiding: boolean;
  /**
   * The most leverage this desk will use.
   *
   * Not a cap on what Delta allows -- Delta allows 200x -- but on what this
   * desk will send without being told. Leverage does not change what a short
   * option can lose; it changes how close the exchange is to closing you out,
   * and 200x puts that close enough that an ordinary afternoon reaches it.
   */
  maxLeverage: number;
};

/**
 * Half the account, or a dollar, whichever is more.
 *
 * Half is a judgement: enough room that an ordinary losing day does not stop
 * you, tight enough that a bad one does. The floor exists so a nearly empty
 * account still has a limit rather than an unreachable one.
 */
export const dailyLossLimitFor = (balanceUsd: number | null): number =>
  Math.max(1, (balanceUsd ?? 0) * 0.5);

export const DEFAULT_LIMITS: RiskLimits = {
  maxQuoteAgeMs: 3_000,
  maxSpreadPct: 0.15,
  minBookCoverage: 0.5,
  maxShortContracts: 500,
  maxDailyLossUsd: 25,
  minPremiumUsd: 5,
  allowPyramiding: false,
  maxLeverage: 200,
};

export type PrecheckInput = {
  now: number;
  intent: {
    side: OrderSide;
    /** Contracts, already converted from lots. */
    size: number;
    /** What the signal believes it is trading. Compared against the product. */
    expect: { underlying: string; optionSide: OptionSide; strike: number; expiryTs: number };
    /** The price we mean to work. Used for the premium floor and margin. */
    price: number | null;
    /** An exit may only reduce. */
    reduceOnly: boolean;
    /** 1 to 200. Sets the margin, and with it the liquidation distance. */
    leverage: number;
    /**
     * Whether this order pays the spread.
     *
     * A market sell, or a limit at or below the bid, crosses and pays it. A
     * limit resting above the bid does not -- it *is* the offer, and a wide
     * book is the reason to rest rather than a reason not to trade.
     */
    crossing: boolean;
    /** Where the stop buys back, if there is one. */
    stopPrice?: number | null;
  };
  /** BTC spot, for the margin model. */
  spot: number | null;
  product: ProductSpec | null;
  quote: Quote | null;
  /** False when the price feed is disconnected or the order API is down. */
  feedHealthy: boolean;
  tradingEnabled: boolean;
  account: { availableUsd: number };
  /** Signed contracts already held on this symbol. Short is negative. */
  existingPosition: number;
  /** Signed contracts short across every symbol, as a positive number. */
  totalShortContracts: number;
  /** Today's realised P&L in USD. Negative is a loss. */
  dayPnlUsd: number;
  /** The most this trade could lose, in USD, if the stop is hit. */
  worstCaseLossUsd: number;
  limits: RiskLimits;
};

export function precheck(input: PrecheckInput): PrecheckResult {
  const f: Failure[] = [];
  const add = (code: PrecheckCode, message: string) => f.push({ code, message });
  const { intent, product, quote, limits } = input;

  if (!input.tradingEnabled) add('KILL_SWITCH', 'Trading is switched off.');

  // --- the contract is the one the signal meant -------------------------
  if (!product) {
    add('NO_PRODUCT', 'No such contract on the exchange.');
  } else {
    if (product.underlying !== intent.expect.underlying) {
      add('WRONG_UNDERLYING', `Signal is ${intent.expect.underlying}, contract is ${product.underlying}.`);
    }
    if (product.optionSide !== intent.expect.optionSide) {
      add('WRONG_OPTION_SIDE', `Signal is ${intent.expect.optionSide}, contract is ${product.optionSide}.`);
    }
    if (product.strike !== intent.expect.strike) {
      add('WRONG_STRIKE', `Signal is ${intent.expect.strike}, contract is ${product.strike}.`);
    }
    if (product.expiryTs !== intent.expect.expiryTs) {
      add('WRONG_EXPIRY', 'Contract expiry does not match the signal.');
    }
    if (product.state === 'expired' || product.expiryTs * 1000 <= input.now) {
      add('EXPIRED', 'Contract has expired.');
    } else if (product.state !== 'live') {
      add('NOT_TRADABLE', `Contract is ${product.state}.`);
    }
  }

  // --- an exit may only ever reduce -------------------------------------
  if (intent.reduceOnly) {
    const reduces =
      (input.existingPosition < 0 && intent.side === 'buy') ||
      (input.existingPosition > 0 && intent.side === 'sell');
    if (!reduces) {
      add('WRONG_EXIT_SIDE', `Cannot ${intent.side} to close a position of ${input.existingPosition}.`);
    }
    if (Math.abs(intent.size) > Math.abs(input.existingPosition)) {
      add('MAX_POSITION', `Exit of ${intent.size} is larger than the position of ${input.existingPosition}.`);
    }
  }

  // --- the market is one we can see -------------------------------------
  if (!input.feedHealthy) add('FEED_DOWN', 'Price feed is not connected.');
  if (!quote) {
    add('NO_QUOTE', 'No quote for this contract.');
  } else {
    const age = input.now - quote.ts;
    if (age > limits.maxQuoteAgeMs) {
      add('STALE_QUOTE', `Last quote is ${(age / 1000).toFixed(1)}s old.`);
    }
    const spread = spreadPct(quote.bid, quote.ask);
    if (spread === null) {
      add('NO_QUOTE', 'Book is one-sided.');
    } else if (intent.crossing && spread > limits.maxSpreadPct) {
      // Only when it crosses. A daily BTC option quoted 17 bid / 19 offered is
      // an 11% spread and perfectly normal; refusing to *rest* at the offer
      // there refuses the trade for the exact reason you wanted to rest.
      add(
        'SPREAD_TOO_WIDE',
        `Spread is ${(spread * 100).toFixed(1)}%, limit is ${(limits.maxSpreadPct * 100).toFixed(0)}% for an order that crosses it.`,
      );
    }
    // Depth only matters for an order that has to be filled now. A resting one
    // is waiting for someone to arrive, and nobody is there yet by definition.
    if (intent.crossing) {
      const top = intent.side === 'sell' ? quote.bidSize : quote.askSize;
      if (top !== null && top < intent.size * limits.minBookCoverage) {
        add('THIN_BOOK', `Only ${top} on the ${intent.side === 'sell' ? 'bid' : 'ask'} against ${intent.size} wanted.`);
      }
    }
  }

  // --- the size is one the exchange takes -------------------------------
  if (!(intent.size > 0)) {
    add('MIN_SIZE', 'Size must be greater than zero.');
  } else if (product && !isWholeLots(intent.size, product.lotSize)) {
    add('LOT_SIZE', `Size ${intent.size} is not a whole number of ${product.lotSize}-contract lots.`);
  }

  // --- leverage, and what it puts the position next to --------------------
  const leverage = clampLeverage(intent.leverage);
  if (!intent.reduceOnly && leverage > limits.maxLeverage) {
    add('LEVERAGE_TOO_HIGH', `${leverage}x is over this desk's ${limits.maxLeverage}x limit.`);
  }

  const marginInputs =
    input.spot !== null && intent.price !== null
      ? { spot: input.spot, premium: intent.price, leverage, contractValue: product?.contractValue }
      : null;

  if (!intent.reduceOnly && marginInputs && intent.stopPrice != null) {
    const liq = liquidationPrice(marginInputs);
    // A stop the exchange will never reach is not a stop. At high leverage the
    // close-out sits below where the stop was placed, so the position is gone
    // before the order that was meant to save it ever triggers.
    if (liq !== null && intent.stopPrice >= liq) {
      add(
        'STOP_BEYOND_LIQUIDATION',
        `Stop at ${intent.stopPrice.toFixed(2)} is past the ${liq.toFixed(2)} close-out at ${leverage}x — ` +
          'you would be liquidated before it fired.',
      );
    }
  }

  // --- opening trades only ----------------------------------------------
  if (!intent.reduceOnly) {
    if (intent.price !== null && intent.price < limits.minPremiumUsd) {
      add('PREMIUM_TOO_LOW', `Premium ${intent.price} is under the ${limits.minPremiumUsd} floor.`);
    }
    if (input.existingPosition !== 0 && !limits.allowPyramiding) {
      add('DUPLICATE_POSITION', `Already holding ${input.existingPosition} on this contract.`);
    }
    // Margin is a function of leverage, so it cannot be a constant. At 200x a
    // lot costs cents; at 10x it costs dollars. Using one number for both is
    // how a desk decides it can afford ten times the position it can survive.
    // The fee is part of what has to be there, so it is part of the check.
    const marginNeeded = marginInputs ? fundsRequiredPerContract(marginInputs) * intent.size : null;
    if (marginNeeded !== null && marginNeeded > input.account.availableUsd) {
      add(
        'INSUFFICIENT_MARGIN',
        `Needs $${marginNeeded.toFixed(2)} at ${leverage}x, have $${input.account.availableUsd.toFixed(2)}.`,
      );
    }
    if (input.totalShortContracts + intent.size > limits.maxShortContracts) {
      add('MAX_POSITION', `Would take total short to ${input.totalShortContracts + intent.size}, limit is ${limits.maxShortContracts}.`);
    }
    const room = limits.maxDailyLossUsd + Math.min(0, input.dayPnlUsd);
    if (input.worstCaseLossUsd > room) {
      add('DAILY_LOSS_LIMIT', `Worst case $${input.worstCaseLossUsd.toFixed(0)} exceeds the $${room.toFixed(0)} left in today's loss budget.`);
    }
  }

  return f.length === 0 ? { ok: true } : { ok: false, failures: f };
}

export const failureCodes = (r: PrecheckResult): PrecheckCode[] =>
  r.ok ? [] : r.failures.map((x) => x.code);
