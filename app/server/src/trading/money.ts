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
 * So the stop is a limit priced well through its trigger: far enough that it
 * still fills like a stop, near enough that it is not a blank cheque. Half
 * again for a buy-back, and never less than five ticks away, because on a
 * penny option a percentage is nothing.
 *
 * What it costs: a limit can be jumped in a violent gap. The desk's own stop
 * watch closes at the market in that case, so the two cover each other.
 */
export const STOP_LIMIT_SLACK = 0.5;
export const STOP_LIMIT_MIN_TICKS = 5;

export function stopFillLimit(side: 'buy' | 'sell', trigger: number, tick: number): number {
  const slack = Math.max(trigger * STOP_LIMIT_SLACK, tick * STOP_LIMIT_MIN_TICKS);
  const through = side === 'buy' ? trigger + slack : Math.max(tick, trigger - slack);
  return stopPriceFor(side, through, tick);
}

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
