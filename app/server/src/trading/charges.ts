import { FEE_CAP_FRACTION_OF_PREMIUM, TAKER_FEE_RATE } from './margin.js';
import type { TradeState } from './types.js';

/**
 * What Delta charges on an options fill, the way Delta charges it.
 *
 *   fee   = min(fee rate x notional, 3.5% x premium)
 *   total = fee + 18% GST on the fee
 *
 *   premium  = price x contracts x contract value     (what changed hands)
 *   notional = spot  x contracts x contract value
 *
 * Source: Delta's "Fees on Options and Futures Trading" and "Settlement fee"
 * articles -- and, more to the point, the account's own trade-history export for
 * 10 September 2026: all 72 fills' "Fees paid" come out of this formula to the
 * last digit. On options this cheap the 3.5% cap is always the smaller half, so
 * the notional rate never decides anything and spot barely matters.
 *
 * The margin model's `feePerContract` is left as it is: it is pinned to the
 * "Funds req." figure on a real ticket, which is a different question.
 */

export const GST_RATE = 0.18;

export type FillCharges = { feeUsd: number; gstUsd: number; totalUsd: number };

export function fillChargesUsd(i: {
  /** Quoted price, USD per BTC. At settlement, what the option settled at. */
  price: number;
  contracts: number;
  contractValue: number;
  /** BTC spot. Null prices the fee from the cap alone -- which is what binds here anyway. */
  spot: number | null;
  feeRate?: number;
}): FillCharges {
  const contracts = Math.abs(i.contracts);
  const premium = Math.max(0, i.price) * contracts * i.contractValue;
  const onNotional = i.spot === null ? Number.POSITIVE_INFINITY : (i.feeRate ?? TAKER_FEE_RATE) * i.spot * contracts * i.contractValue;
  // An option that expires worthless has a premium of zero, so its settlement
  // costs nothing: the cap is what makes that true, not a special case.
  const fee = Math.min(onNotional, FEE_CAP_FRACTION_OF_PREMIUM * premium);
  const gst = fee * GST_RATE;
  return { feeUsd: fee, gstUsd: gst, totalUsd: fee + gst };
}

export type TradeCharges = { entryUsd: number; exitUsd: number; totalUsd: number };

/** Every fill on a trade, charged. `since` keeps only fills from that moment on -- for "today". */
export function tradeCharges(s: TradeState, o: { spot: number | null; since?: number }): TradeCharges {
  let entryUsd = 0;
  let exitUsd = 0;
  for (const f of s.fills) {
    if (o.since !== undefined && f.ts < o.since) continue;
    const c = fillChargesUsd({ price: f.price, contracts: f.size, contractValue: s.contractValue, spot: o.spot }).totalUsd;
    if (f.role === 'entry') entryUsd += c; else exitUsd += c;
  }
  return { entryUsd, exitUsd, totalUsd: entryUsd + exitUsd };
}
