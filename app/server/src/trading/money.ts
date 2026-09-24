/**
 * Prices and sizes the exchange will actually accept.
 *
 * Everything works in whole ticks, because 100.07 rounded in floating point is
 * how an order gets rejected for "invalid price" at the worst possible moment.
 */

export type RoundDirection = 'up' | 'down' | 'nearest';

export function roundToTick(price: number, tick: number, dir: RoundDirection = 'nearest'): number {
  if (!(tick > 0)) return price;
  const ticks = price / tick;
  const n =
    dir === 'up' ? Math.ceil(ticks - 1e-9)
    : dir === 'down' ? Math.floor(ticks + 1e-9)
    : Math.round(ticks);
  // back through the tick, then trim the float noise the division introduced
  return Number((n * tick).toFixed(tickDecimals(tick)));
}

export function tickDecimals(tick: number): number {
  const s = tick.toString();
  const dot = s.indexOf('.');
  return dot === -1 ? 0 : s.length - dot - 1;
}

/**
 * A seller rounds up and a buyer rounds down, so rounding never quietly moves
 * the price against the side placing it.
 */
export const priceFor = (side: 'buy' | 'sell', price: number, tick: number) =>
  roundToTick(price, tick, side === 'sell' ? 'up' : 'down');

/**
 * A stop is the exception: it exists to get out, so it rounds towards getting
 * filled rather than towards a better price.
 */
export const stopPriceFor = (side: 'buy' | 'sell', price: number, tick: number) =>
  roundToTick(price, tick, side === 'buy' ? 'up' : 'down');

/**
 * The limit price a protective stop carries, through its own trigger.
 *
 * A stop used to go to Delta as a market order, and on 12 September 2026 Delta
 * refused six of them with `unsupported`: "Market order couldn't be validated
 * for price impact as orderbook data isn't available." An option with an empty
 * book cannot take a market order at all, which is exactly the moment a stop
 * matters. A limit order needs no book to be accepted.
 *
 * So the stop is a limit priced through its trigger: far enough that it still
 * fills like a stop, near enough that it is not a blank cheque.
 *
 * **The slack was 50% until 24 September 2026, and it cost real money.** A
 * stop at 70 went to the exchange as a buy limit at 105, which is a market
 * order wearing a hat: when the trigger hit, the order swept every offer up to
 * 105 and filled at 79 -- nine points, 13% of the stop, paid for nothing. The
 * owner found it on the day's trades, not on the screen, because nothing
 * measured it.
 *
 * It is 15% now, which still clears a normal book by a wide margin (five ticks
 * at the floor, for a penny option where a percentage is nothing). What it
 * gives up is the violent gap, where the limit is jumped -- and `stopIfReached`
 * already closes at the market in that case, so the two cover each other. The
 * difference is that the sweep is now bounded by default and unbounded only
 * where a human-shaped gap actually happened.
 */
export const STOP_LIMIT_SLACK = 0.15;
export const STOP_LIMIT_MIN_TICKS = 5;

export function stopFillLimit(side: 'buy' | 'sell', trigger: number, tick: number): number {
  const slack = Math.max(trigger * STOP_LIMIT_SLACK, tick * STOP_LIMIT_MIN_TICKS);
  const through = side === 'buy' ? trigger + slack : Math.max(tick, trigger - slack);
  return stopPriceFor(side, through, tick);
}

/**
 * What the exit actually cost against the price that was asked for.
 *
 * Positive is money lost to the fill: a stop at 70 filled at 79 is +9, +12.9%.
 * A stop is a buy-back, so paying more is worse; a target is a sell, so
 * receiving less is worse. Both are reported the same way -- the sign says
 * "against you" rather than "up" -- because the one question is how much the
 * exit cost, and a reader should not have to remember which side they were on.
 *
 * `null` where there was nothing to compare against, which is not the same as
 * zero and must not be shown as it.
 */
export function slippageOf(
  role: 'stop_loss' | 'take_profit', wanted: number | null, filled: number | null,
): { points: number; pct: number } | null {
  if (wanted === null || filled === null || !(wanted > 0) || !(filled > 0)) return null;
  const points = role === 'stop_loss' ? filled - wanted : wanted - filled;
  return { points: Math.round(points * 100) / 100, pct: Math.round((points / wanted) * 1000) / 10 };
}

/**
 * Slippage worth telling somebody about.
 *
 * A tick or two on a thin option is the cost of doing business. A tenth of the
 * stop is the desk paying for its own haste, and it went unnoticed for weeks
 * because nothing added it up.
 */
export const SLIPPAGE_ALERT_PCT = 5;

export const lotsToContracts = (lots: number, lotSize: number) => Math.floor(lots) * lotSize;

export const isWholeLots = (contracts: number, lotSize: number) =>
  lotSize > 0 && contracts > 0 && contracts % lotSize === 0;

/** Mid, when both sides are quoted. `null` when the book is one-sided. */
export const midOf = (bid: number | null, ask: number | null) =>
  bid !== null && ask !== null ? (bid + ask) / 2 : null;

/** Spread as a fraction of the mid. `null` when it cannot be measured. */
export function spreadPct(bid: number | null, ask: number | null): number | null {
  const mid = midOf(bid, ask);
  if (mid === null || mid <= 0 || bid === null || ask === null) return null;
  return (ask - bid) / mid;
}
