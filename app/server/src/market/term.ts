import type { Ticker } from './delta.js';
import { expiryTsOf } from './chain.js';

/**
 * At-the-money implied volatility across every listed expiry: the IV term
 * structure, now.
 *
 * Only the present is known. Delta keeps no IV history and the desk records
 * none per expiry yet (docs/Data.md §4), so there is no "a week ago" line to
 * draw beside it, and nothing here pretends otherwise.
 *
 * ATM is the listed strike nearest spot that has an IV on at least one side;
 * the figure is the mean of the call's and the put's mark IV where both exist.
 */
export type TermPoint = {
  expiry: string;
  expiryTs: number;
  hoursAway: number;
  strike: number;
  atmIv: number;
  /** How many of the two sides the figure is from. */
  sides: 1 | 2;
};

const num = (v: string | number | null | undefined): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

export function termStructure(tickers: readonly Ticker[], nowSec: number): TermPoint[] {
  type Side = { c: number | null; p: number | null };
  const byExpiry = new Map<string, { spot: number | null; strikes: Map<number, Side> }>();

  for (const t of tickers) {
    const code = t.symbol.split('-').pop() ?? '';
    if (!/^\d{6}$/.test(code)) continue;
    const strike = num(t.strike_price);
    const iv = num(t.quotes?.mark_iv ?? null);
    if (strike === null || iv === null || !(iv > 0)) continue;
    const e = byExpiry.get(code) ?? { spot: null, strikes: new Map<number, Side>() };
    e.spot ??= num(t.spot_price);
    const s = e.strikes.get(strike) ?? { c: null, p: null };
    if (t.contract_type === 'call_options') s.c = iv; else s.p = iv;
    e.strikes.set(strike, s);
    byExpiry.set(code, e);
  }

  const out: TermPoint[] = [];
  for (const [expiry, e] of byExpiry) {
    const expiryTs = expiryTsOf(expiry);
    const hoursAway = (expiryTs - nowSec) / 3600;
    if (!(hoursAway > 0) || e.spot === null || e.strikes.size === 0) continue;
    const spot = e.spot;
    const [strike, side] = [...e.strikes.entries()]
      .sort((a, b) => Math.abs(a[0] - spot) - Math.abs(b[0] - spot))[0]!;
    const both = side.c !== null && side.p !== null;
    out.push({
      expiry, expiryTs, hoursAway, strike,
      atmIv: both ? (side.c! + side.p!) / 2 : (side.c ?? side.p)!,
      sides: both ? 2 : 1,
    });
  }
  return out.sort((a, b) => a.expiryTs - b.expiryTs);
}
