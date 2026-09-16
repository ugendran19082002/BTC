import { fillChargesUsd } from './charges.js';
import type { Quote, TradeState } from './types.js';

/**
 * Whether this many contracts may be bought back by hand, and why not.
 *
 * Shared by the preview and the close itself, so the sheet can only ever offer
 * a size the desk will take. It lives here rather than beside `addEligibility`
 * in the engine because the preview needs it and the engine imports the
 * preview; a rule this small is not worth an import cycle.
 *
 * `held` is the position as the exchange last said it was -- the close re-reads
 * it before sending, and a size that was legal a second ago may not be now.
 */
export function closeEligibility(s: TradeState, size: number, held = Math.abs(s.position)): string | null {
  if (held === 0) return 'nothing is held';
  if (!Number.isInteger(size) || size < 1) return 'lots must be a whole number, at least 1';
  if (size > held) return `only ${held} contract${held === 1 ? ' is' : 's are'} held`;
  return null;
}

/**
 * What buying back this many contracts would book, before anything is sent.
 *
 * The close sheet used to show one number -- what closing *everything* would
 * leave -- because closing everything was the only thing on offer. Once a size
 * can be chosen, that number is wrong for every size but one, and a screen
 * that is wrong about money is worse than a screen that says nothing.
 *
 * Pure, and separate from the engine for the usual reason: the arithmetic is
 * the part that can be wrong, and arithmetic that needs a live exchange to
 * exercise it is arithmetic that goes untested.
 *
 * Three figures, and they are deliberately about *this close*, not about the
 * trade:
 *
 *   booked   (entry avg − what the buy pays) × contracts × contract value
 *   charges  Delta's fee plus 18% GST on the buy-back, by the statement's formula
 *   net      booked − charges
 *
 * What is already banked and already paid stays out of them. "This close books
 * ₹4,300" answers the question a person asking to close 500 of 1,500 is
 * actually asking; adding the trade's history into it answers a different one.
 * `trade.netRealisedUsd` on the card is still there for that.
 *
 * The price is the **ask**, because closing a short is a buy and a buy crosses
 * to the offer. Falling back to the mark when there is no offer is deliberate
 * -- a preview that says "—" on a thin book helps nobody -- and `atMark` says
 * which of the two it used, so the screen can say so too.
 */
export type ClosePreview = {
  /** False when this size cannot be closed; `reason` says why. */
  ok: boolean;
  reason: string | null;
  /** Contracts held right now. */
  held: number;
  /** Contracts this close would buy back. Defaults to all of them. */
  lots: number;
  /** What would still be short afterwards. */
  remaining: number;
  closesAll: boolean;
  /** The price the buy is expected to pay. Null when the book says nothing. */
  buysBackAt: number | null;
  /** True when `buysBackAt` is the mark rather than a real offer. */
  atMark: boolean;
  /** P&L this close books, before charges. Null without a price. */
  bookedUsd: number | null;
  /** Delta's fee plus GST on the buy-back. Null without a price. */
  chargesUsd: number | null;
  /** `bookedUsd − chargesUsd`. The number the decision turns on. */
  netUsd: number | null;
};

/**
 * What the position is worth if it is closed at `price`, all in.
 *
 * Everything the trade has already booked and already paid, plus what buying
 * the rest back at that price books, less the charges on that fill. The same
 * arithmetic behind "If closed now" -- with the mark in it -- so a target's
 * outcome and a close-now outcome are the same number differently priced, and
 * the screen can put them side by side without them disagreeing.
 *
 * Null when there is nothing to work it out from: no entry price, no position,
 * or no price to close at. A missing number is not a zero.
 */
export function netIfClosedAt(i: {
  state: TradeState;
  /** The price the buy-back would happen at: the mark, a resting target, a stop. */
  price: number | null | undefined;
  spot: number | null;
  /** Charges already paid on this trade, from `tradeCharges`. */
  paidUsd: number;
}): number | null {
  const s = i.state;
  const size = Math.abs(s.position);
  if (i.price === null || i.price === undefined || size === 0 || s.entryAvgPrice === null) return null;
  const books = (s.entryAvgPrice - i.price) * size * s.contractValue;
  const toClose = fillChargesUsd({ price: i.price, contracts: size, contractValue: s.contractValue, spot: i.spot }).totalUsd;
  return s.realisedPnl + books - i.paidUsd - toClose;
}

export function closePreview(i: {
  state: TradeState;
  /** Undefined means the whole position, which is what the sheet opens on. */
  size?: number;
  quote: Quote | null;
  spot: number | null;
}): ClosePreview {
  const s = i.state;
  const held = Math.abs(s.position);
  // A size that has not been typed yet is the whole position, not zero: the
  // sheet opens on "close all" and the preview must agree with it. Taken as
  // given rather than rounded -- "2.5 lots" is a mistake to report, not one to
  // quietly turn into 2 and price.
  const lots = i.size === undefined ? held : i.size;
  const reason = closeEligibility(s, lots, held);

  const ask = i.quote?.ask ?? null;
  const mark = i.quote?.mark ?? null;
  const buysBackAt = ask !== null && ask > 0 ? ask : mark;
  const atMark = (ask === null || !(ask > 0)) && mark !== null;

  const priced = reason === null && buysBackAt !== null && s.entryAvgPrice !== null;
  const bookedUsd = priced ? (s.entryAvgPrice! - buysBackAt!) * lots * s.contractValue : null;
  const chargesUsd = priced
    ? fillChargesUsd({ price: buysBackAt!, contracts: lots, contractValue: s.contractValue, spot: i.spot }).totalUsd
    : null;

  return {
    ok: reason === null,
    reason,
    held,
    lots,
    remaining: Math.max(0, held - Math.max(0, lots)),
    closesAll: reason === null && lots >= held,
    buysBackAt,
    atMark,
    bookedUsd,
    chargesUsd,
    netUsd: bookedUsd === null || chargesUsd === null ? null : bookedUsd - chargesUsd,
  };
}
