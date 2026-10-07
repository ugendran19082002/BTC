import type { ChainResponse, Leg } from '@/types/desk';
import { bestLeg } from '@/lib/overview';

/**
 * The phone's Pressure screen (owner, 7 Oct 2026): the small readings its two cards share with the desk's
 * "Option flow · CE / PE" and "Big move catch" -- which strike the early warning reads, an option's top of book,
 * and contracts said short.
 */

/**
 * The strike the early warning reads its premium and IV changes from, when nobody has picked one: the server's
 * own pick, the put first -- the side the desk sells most -- as the Live screen does (Overview `deskPick`).
 */
export function deskLeg(data: Pick<ChainResponse, 'recommendation' | 'legs' | 'best'>): Leg | null {
  const legOf = (cp: 'C' | 'P') => data.recommendation.sides.find((x) => x.side === (cp === 'C' ? 'CE' : 'PE'))?.leg ?? bestLeg(data.legs, cp);
  const s = legOf('P') ?? legOf('C');
  if (s) return s;
  const p = data.best.pick && !data.best.bestOfNone ? data.best.pick : null;
  return p ? data.legs.find((l) => l.cp === p.cp && l.strike === p.strike) ?? null : null;
}

/** The at-the-money option of a side: the nearest thing an option side has to a book of its own. */
export const atmLeg = (legs: readonly Leg[], cp: 'C' | 'P', atm: number | null | undefined): Leg | null =>
  legs.find((l) => l.cp === cp && l.strike === atm) ?? null;

/** Top of book: (bid size − ask size) ÷ (bid + ask), −1 to 1; null where it has no sizes. */
export function bookOf(l: Leg | null): number | null {
  if (!l || l.bidSize == null || l.askSize == null || l.bidSize + l.askSize === 0) return null;
  return (l.bidSize - l.askSize) / (l.bidSize + l.askSize);
}

/** The bid-ask spread as a share of the mid; null without both. */
export const spreadOf = (l: Leg | null): number | null =>
  (l && l.bid !== null && l.ask !== null && l.bid + l.ask > 0 ? (l.ask - l.bid) / ((l.bid + l.ask) / 2) : null);

/** Contracts, short: "1,606.5K" from a thousand up, whole below. */
export const kct = (v: number): string =>
  (Math.abs(v) >= 1000 ? `${(v / 1000).toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}K` : Math.round(v).toLocaleString('en-US'));

/** Buy against sell as two shares of one bar, 0-1 each; an empty tape is no bar. */
export function buySellShare(buy: number, sell: number): { buy: number; sell: number } {
  const total = buy + sell;
  return total > 0 ? { buy: buy / total, sell: sell / total } : { buy: 0, sell: 0 };
}
