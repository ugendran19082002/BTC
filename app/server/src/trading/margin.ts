/**
 * What leverage actually does to a sold option.
 *
 * It does not change what you can lose. A put sold at $506 that goes to $3,000
 * costs you $2,494 a contract at 10x and $2,494 a contract at 200x. What
 * leverage changes is two things, and only these two:
 *
 *   1. how much margin is locked per lot -- so how many lots you can open;
 *   2. how far the option can move before the exchange closes you out.
 *
 * The second is the one that gets people.
 *
 * ---------------------------------------------------------------------------
 * Calibration
 *
 * These formulas are fitted to Delta's own ticket rather than derived from
 * their documentation, because the documentation and the app disagree about
 * whether the premium enters the margin. The app is the one that takes the
 * money. Observed, on a BTC call:
 *
 *     index $78,405.5 · 10 lots · 200x  ->  "Funds req.  3.93 USD"
 *
 *     spot x contract / leverage          = 78405.5 x 0.001 / 200 x 10 = 3.9203
 *     + fee, min(0.01% notional, 3.5% premium)                         = 0.0056
 *                                                                       ------
 *                                                                       3.9259
 *
 * which is 3.93 to the cent. Adding the premium to the margin, as the obvious
 * reading of the docs suggests, overstates it by about 4%. It is left out.
 *
 * Everything here is still an estimate. Delta's "Funds req." and its own
 * liquidation price are the authority; when the two disagree, the exchange is
 * right and this file is wrong.
 * ---------------------------------------------------------------------------
 */

/** BTC per contract on Delta's daily options. */
export const CONTRACT_BTC = 0.001;

/**
 * Turn a quoted option price into the dollars that actually change hands.
 *
 * Delta quotes an option in USD *per BTC of underlying*, and a contract is
 * 0.001 BTC. So a call shown at 19.00 pays 1.9 cents a contract, not $19 --
 * a factor of a thousand, and the direction that flatters you.
 *
 * The check that settles it: at 200x the margin on one contract is
 * spot x 0.001 / 200, which is the $0.39 Delta's own ticket shows. The 0.001 is
 * in the margin, so it is in the premium too.
 */
export const premiumUsd = (quoted: number, contracts: number, contractValue = CONTRACT_BTC) =>
  quoted * contracts * contractValue;

/**
 * What a short option is up or down right now, in USD.
 *
 * You sold it for `entry` and it is worth `mark`; the difference, over the
 * contracts held, is the money. A short gains when the option gets *cheaper*,
 * so the subtraction is that way round and not the other.
 *
 * This is arithmetic rather than a field read off the exchange, and
 * deliberately. Delta's `unrealized_pnl` reported +0.022 on a position that was
 * down $0.0016 -- wrong sign and wrong size, against a convention this desk
 * cannot verify. A number nobody can check is worse than one anybody can:
 * everything here comes from the fill price, the mark and the contract size,
 * and it is tested against the decay percentage shown beside it, which must
 * always agree with it about which way the trade is going.
 */
export function unrealisedPnlUsd(i: {
  /** The price the position was opened at. */
  entryPrice: number | null;
  /** What it is worth now, by the exchange's mark. */
  markPrice: number | null;
  /** Contracts held. Sign is ignored: a short is assumed. */
  size: number;
  contractValue?: number;
}): number | null {
  const { entryPrice, markPrice, size, contractValue = CONTRACT_BTC } = i;
  if (entryPrice === null || markPrice === null || !Number.isFinite(size) || size === 0) return null;
  return (entryPrice - markPrice) * Math.abs(size) * contractValue;
}

/**
 * Delta holds maintenance margin at roughly half of initial for short options.
 * The gap between the two is the entire cushion the position has: initial is
 * what is taken, maintenance is where it is closed.
 */
const MAINTENANCE_FRACTION = 0.5;

/** Taker fee on the notional, and the cap that almost always binds instead. */
export const TAKER_FEE_RATE = 0.0001;
export const FEE_CAP_FRACTION_OF_PREMIUM = 0.035;

export type MarginInputs = {
  /** BTC spot, in USD. */
  spot: number;
  /** Premium received per contract, in USD. */
  premium: number;
  /** 1 to 200. */
  leverage: number;
  /** BTC per contract. */
  contractValue?: number;
};

/**
 * Initial margin for one short option contract, in USD.
 *
 * A flat slice of spot, set by the leverage. The premium does not enter it --
 * see the calibration note above.
 */
export function initialMarginPerContract({ spot, leverage, contractValue = CONTRACT_BTC }: MarginInputs): number {
  return (spot / clampLeverage(leverage)) * contractValue;
}

export const maintenanceMarginPerContract = (i: MarginInputs): number =>
  initialMarginPerContract(i) * MAINTENANCE_FRACTION;

/**
 * Trading fee for one contract.
 *
 * The cap is what matters: 0.01% of an $78k notional is 7.8 cents, but 3.5% of
 * a $16 premium is half a cent, and Delta charges the smaller. On cheap options
 * -- which is all this desk sells -- the fee is effectively a percentage of the
 * premium, not of the notional.
 */
export function feePerContract({ spot, premium, contractValue = CONTRACT_BTC }: MarginInputs): number {
  const onNotional = TAKER_FEE_RATE * spot * contractValue;
  const cap = FEE_CAP_FRACTION_OF_PREMIUM * Math.max(0, premium) * contractValue;
  return Math.min(onNotional, cap);
}

/** What Delta's ticket calls "Funds req." -- margin plus the fee to get in. */
export const fundsRequiredPerContract = (i: MarginInputs): number =>
  initialMarginPerContract(i) + feePerContract(i);

/**
 * The option price at which the position is closed out by the exchange.
 *
 * Solving for where equity meets maintenance:
 *
 *     equity(X)   = IM + (P0 - X) x cv      margin posted, less the loss so far
 *     maintenance = f x IM                  a fixed fraction, since IM is fixed
 *
 *     =>  X = P0 + spot x (1 - f) / leverage
 *
 * The room is a flat number of dollars set by spot and leverage -- which is why
 * a dear option is in far more danger than a cheap one at the same leverage.
 * At 200x the room is about $196 whatever you sold: on a $16 call that is a
 * thirteen-fold move away, on a $506 put it is under 40%.
 *
 * Returns `null` when there is no meaningful answer, rather than a number that
 * looks like one.
 */
export function liquidationPrice(i: MarginInputs): number | null {
  const cv = i.contractValue ?? CONTRACT_BTC;
  if (!(cv > 0) || !(i.spot > 0)) return null;
  return Math.max(0, i.premium) + liquidationRoomOf(i);
}

const liquidationRoomOf = (i: MarginInputs) =>
  (i.spot * (1 - MAINTENANCE_FRACTION)) / clampLeverage(i.leverage);

/**
 * How far the option can rise before the close-out, in dollars.
 *
 * This is the number that actually answers "can a normal day reach it".
 */
export function liquidationRoom(i: MarginInputs): number | null {
  return i.spot > 0 && (i.contractValue ?? CONTRACT_BTC) > 0 ? liquidationRoomOf(i) : null;
}

/**
 * How far the option can move, as a multiple of what it was sold for.
 *
 * "1.4x" reads better than "$196 of room" when the question is whether a normal
 * day can reach it.
 */
export function liquidationMultiple(i: MarginInputs): number | null {
  const liq = liquidationPrice(i);
  if (liq === null || !(i.premium > 0)) return null;
  return liq / i.premium;
}

/** Lots the account can carry at this leverage. Floors, never rounds. */
export function maxLotsAt(availableUsd: number, i: MarginInputs, lotSize = 1): number {
  const per = fundsRequiredPerContract(i) * lotSize;
  if (!(per > 0)) return 0;
  return Math.max(0, Math.floor(availableUsd / per));
}

/** Delta accepts whole leverage from 1x to 200x on daily options. */
export const MIN_LEVERAGE = 1;
export const MAX_LEVERAGE = 200;

export const clampLeverage = (n: number): number =>
  Math.min(MAX_LEVERAGE, Math.max(MIN_LEVERAGE, Math.floor(Number.isFinite(n) ? n : MIN_LEVERAGE)));

/** The rungs Delta's own app offers, so the desk does not invent its own. */
export const LEVERAGE_STEPS = [1, 2, 3, 5, 10, 15, 20, 25, 50, 75, 100, 150, 200] as const;
