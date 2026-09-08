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
