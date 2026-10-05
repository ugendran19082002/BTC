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
  | 'LEVERAGE_TOO_HIGH' | 'STOP_BEYOND_LIQUIDATION' | 'EXIT_WRONG_SIDE_OF_ENTRY' | 'STOP_INSIDE_SPREAD';

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
  /** Total contracts allowed held bought, across the book: the long limit (5 Oct 2026), the short limit's mirror. */
  maxLongContracts: number;
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
  /**
   * The least an option may be sold for, in the exchange's quoted units.
   *
   * A floor rather than a preference. Selling a very cheap option puts the same
   * margin at risk for less credit -- the loss if it goes wrong is unchanged
   * and the pay for taking it is smaller. The 733-day sweep is unambiguous:
   * over the same days, a $0 floor returned $72 and a $15 floor returned $173,
   * from the same strikes selected the same way.
   *
   * Quoted units, not dollars-in-hand: a price of 5 is 5 USD per BTC, which on
   * a 0.001 BTC contract is half a cent. The number is small because the unit
   * is, and the refusal says so.
   */
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
  maxLongContracts: 500,
  maxDailyLossUsd: 25,
  minPremiumUsd: 5,
  allowPyramiding: false,
  maxLeverage: 200,
};

/**
 * The most contracts the desk may be short across the whole book.
 *
 * Two numbers meet here. The *ceiling* is what the account's margin can
 * actually carry; the *choice* is what the desk has been told to allow. The
 * choice may lower the ceiling and can never raise it, for the same reason
 * `maxDailyLossUsd` is set from the balance: a cap larger than the margin
 * behind it cannot ever fire, and a gate that cannot fire is worse than no
 * gate, because it reads as protection.
 *
 * So the browser is allowed to ask for less risk and never for more. With no
 * ceiling known yet -- no spot, or no balance read -- the fixed default stands
 * rather than an unbounded one.
 */
export function maxShortContractsFor(
  marginCeiling: number | null,
  chosen: number | null,
): number {
  const floored =
    marginCeiling !== null && Number.isFinite(marginCeiling) ? Math.floor(marginCeiling) : 0;
  // A ceiling that floors below one contract -- an account too small to carry
  // even one, or no reading yet -- falls back to the fixed default. Taking it
  // literally would mean a cap of zero, which refuses every order on the desk:
  // a far worse failure than the one this is guarding against.
  const ceiling = floored >= 1 ? floored : DEFAULT_LIMITS.maxShortContracts;
  const want = chosen !== null && Number.isFinite(chosen) ? Math.floor(chosen) : 0;
  if (want < 1) return ceiling;
  return Math.min(want, ceiling);
}

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
    /** Where the target buys back, if there is one. */
    takeProfitPrice?: number | null;
    /** The desk judges the stop on the offer (not on a closed bar): a stop inside the spread is then reached at once. */
    stopOnOffer?: boolean;
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
  /*
   * A short makes money as the option gets cheaper: its target sits under the
   * entry and its stop over it. The other way round, each fires the moment it
   * lands -- a short sold at 7.00 bought itself back at 7.00 that way on
   * 9 September. A level typed as a price is the case this catches; one worked
   * out from a percentage or points is always on the right side.
   */
  if (!intent.reduceOnly && intent.price !== null) {
    if (intent.stopPrice != null && !(intent.stopPrice > intent.price)) {
      add('EXIT_WRONG_SIDE_OF_ENTRY', `A stop of ${intent.stopPrice} must be over the ${intent.price} entry: at or under it, it fires at once.`);
    }
    if (intent.takeProfitPrice != null && !(intent.takeProfitPrice < intent.price)) {
      add('EXIT_WRONG_SIDE_OF_ENTRY', `A target of ${intent.takeProfitPrice} must be under the ${intent.price} entry: a short makes money as the price falls.`);
    }
    /*
     * A stop no wider than the spread is reached the moment the entry fills.
     *
     * A short sold at the bid has the offer above it by the spread, and the
     * desk judges the stop on the offer (`stopIfReached`). A stop 10% over a
     * 5.00 sale is 5.50; with the offer at 5.80 it is already "reached", and
     * fifteen seconds later the desk buys back for the spread and two fees --
     * a certain loss that looks like a stop doing its job. The distance is
     * measured the way the stop will be once it follows the fill: from the
     * bid, as a percentage of the price asked (30 Sep 2026 audit).
     */
    const bid = quote?.bid ?? null;
    const ask = quote?.ask ?? null;
    if (intent.stopOnOffer && intent.stopPrice != null && intent.stopPrice > intent.price
      && bid !== null && ask !== null && ask > bid && intent.price > 0) {
      const room = Math.min(intent.stopPrice - intent.price, ((intent.stopPrice - intent.price) / intent.price) * bid);
      if (room <= ask - bid) {
        add('STOP_INSIDE_SPREAD',
          `The stop is ${room.toFixed(2)} over a fill at the ${bid} bid, inside the ${(ask - bid).toFixed(2)} spread: `
          + `the ${ask} offer is already there, and the desk would buy back seconds after selling. Widen the stop, or wait for a tighter book.`);
      }
    }
  }
  if (!intent.reduceOnly) {
    if (intent.price !== null && intent.price < limits.minPremiumUsd) {
      add(
        'PREMIUM_TOO_LOW',
        `This one pays ${intent.price.toFixed(2)} and the desk will not sell below ` +
          `${limits.minPremiumUsd.toFixed(2)} — the same margin is at risk either way, ` +
          `so a cheaper option is the same risk for less pay.`,
      );
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
      add('DAILY_LOSS_LIMIT', Number.isFinite(input.worstCaseLossUsd)
        ? `Worst case $${input.worstCaseLossUsd.toFixed(0)} exceeds the $${room.toFixed(0)} left in today's loss budget.`
        // No option stop, and no BTC price yet to work out where Delta would close it: refused, not guessed.
        : 'The worst case cannot be priced yet: no option stop, and no BTC price to work out the close-out. Set a stop, or wait for the price.');
    }
  }

  return f.length === 0 ? { ok: true } : { ok: false, failures: f };
}

/**
 * The gate for buying an option to open (5 Oct 2026).
 *
 * A bought option is not a short with the sign changed, so it has a gate of its own rather than the seller's
 * with exceptions: there is no margin, no close-out and no cap on lots short, and the most it can lose is what
 * was paid. What is the same is checked the same way and in the same words -- the contract is the one meant,
 * the market can be seen, the book is not too wide to cross (a buy at the market always crosses), the size is
 * whole lots, the day's loss budget -- and two things are a buyer's: the premium and its fee must be in the
 * free balance, and the account must not be short this contract, where a buy would close that position
 * instead of opening one.
 */
export type PrecheckBuyInput = {
  now: number;
  size: number;
  expect: PrecheckInput['intent']['expect'];
  product: ProductSpec | null;
  quote: Quote | null;
  feedHealthy: boolean;
  tradingEnabled: boolean;
  availableUsd: number;
  /** What the premium and its fee come to, in USD, at the offer. Null when there is no offer to price it at. */
  costUsd: number | null;
  /** Signed contracts the account holds on this contract at the exchange. */
  existingPosition: number;
  /** Contracts held bought across every contract, as a positive number. Absent: not checked. */
  totalLongContracts?: number;
  dayPnlUsd: number;
  limits: RiskLimits;
};

export function precheckBuy(input: PrecheckBuyInput): PrecheckResult {
  const f: Failure[] = [];
  const add = (code: PrecheckCode, message: string) => f.push({ code, message });
  const { product, quote, limits, expect } = input;

  if (!input.tradingEnabled) add('KILL_SWITCH', 'Trading is switched off.');

  if (!product) {
    add('NO_PRODUCT', 'No such contract on the exchange.');
  } else {
    if (product.underlying !== expect.underlying) add('WRONG_UNDERLYING', `Signal is ${expect.underlying}, contract is ${product.underlying}.`);
    if (product.optionSide !== expect.optionSide) add('WRONG_OPTION_SIDE', `Signal is ${expect.optionSide}, contract is ${product.optionSide}.`);
    if (product.strike !== expect.strike) add('WRONG_STRIKE', `Signal is ${expect.strike}, contract is ${product.strike}.`);
    if (product.expiryTs !== expect.expiryTs) add('WRONG_EXPIRY', 'Contract expiry does not match the signal.');
    if (product.state === 'expired' || product.expiryTs * 1000 <= input.now) add('EXPIRED', 'Contract has expired.');
    else if (product.state !== 'live') add('NOT_TRADABLE', `Contract is ${product.state}.`);
  }

  if (!input.feedHealthy) add('FEED_DOWN', 'Price feed is not connected.');
  if (!quote) {
    add('NO_QUOTE', 'No quote for this contract.');
  } else {
    const age = input.now - quote.ts;
    if (age > limits.maxQuoteAgeMs) add('STALE_QUOTE', `Last quote is ${(age / 1000).toFixed(1)}s old.`);
    const spread = spreadPct(quote.bid, quote.ask);
    if (spread === null || !(quote.ask !== null && quote.ask > 0)) {
      add('NO_QUOTE', 'No offer to buy at.');
    } else if (spread > limits.maxSpreadPct) {
      add('SPREAD_TOO_WIDE', `Spread is ${(spread * 100).toFixed(1)}%, limit is ${(limits.maxSpreadPct * 100).toFixed(0)}% for an order that crosses it.`);
    }
    if (quote.askSize !== null && quote.askSize < input.size * limits.minBookCoverage) {
      add('THIN_BOOK', `Only ${quote.askSize} on the ask against ${input.size} wanted.`);
    }
  }

  if (!(input.size > 0)) add('MIN_SIZE', 'Size must be greater than zero.');
  else if (product && !isWholeLots(input.size, product.lotSize)) add('LOT_SIZE', `Size ${input.size} is not a whole number of ${product.lotSize}-contract lots.`);

  if (input.existingPosition < 0) {
    add('DUPLICATE_POSITION', `This account is short ${-input.existingPosition} on this contract: a buy would close that position, not open one.`);
  }
  // The long limit: the buyer's mirror of the short limit's MAX_POSITION.
  if (input.totalLongContracts !== undefined && input.totalLongContracts + input.size > limits.maxLongContracts) {
    add('MAX_POSITION', `Would take total long to ${input.totalLongContracts + input.size}, limit is ${limits.maxLongContracts}.`);
  }
  if (input.costUsd !== null && input.costUsd > input.availableUsd) {
    add('INSUFFICIENT_MARGIN', `Costs $${input.costUsd.toFixed(2)} to buy, have $${input.availableUsd.toFixed(2)} free.`);
  }
  // The most a bought option can lose is what was paid for it: that is its worst case against the day's budget.
  const room = limits.maxDailyLossUsd + Math.min(0, input.dayPnlUsd);
  if (input.costUsd !== null && input.costUsd > room) {
    add('DAILY_LOSS_LIMIT', `Worst case $${input.costUsd.toFixed(2)} (the premium paid) exceeds the $${room.toFixed(2)} left in today's loss budget.`);
  }
  return f.length === 0 ? { ok: true } : { ok: false, failures: f };
}

export const failureCodes = (r: PrecheckResult): PrecheckCode[] =>
  r.ok ? [] : r.failures.map((x) => x.code);
