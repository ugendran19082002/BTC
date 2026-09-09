import type { Trade } from '@/types/trade';

/**
 * The strikes you are currently short, keyed the way the board looks them up.
 *
 * The board and the positions card were two separate readings of the same
 * account: a strike could be open in one and anonymous in the other, and the
 * only way to connect them was to match a number in a card against a column of
 * two dozen. Marking the row is the connection.
 *
 * A key rather than a list because the table asks the question once per strike
 * per side, which is fifty-odd times a render.
 */
export type HeldLeg = {
  cp: 'C' | 'P';
  strike: number;
  /** Contracts held, always positive here — every position on this desk is short. */
  size: number;
  /** The exchange's own unrealised P&L in USD, or null while it is unknown. */
  pnlUsd: number | null;
};

export const heldKey = (cp: 'C' | 'P', strike: number) => `${cp}-${strike}`;

/**
 * A symbol looks like `C-BTC-79600-090926`. Parsed rather than carried
 * separately so the board reads the same field the exchange keys on, and a
 * symbol it cannot parse is skipped rather than guessed at.
 */
function legOf(symbol: string): { cp: 'C' | 'P'; strike: number } | null {
  const parts = symbol.split('-');
  const cp = parts[0] === 'C' ? 'C' : parts[0] === 'P' ? 'P' : null;
  const strike = Number(parts[2]);
  return cp && Number.isFinite(strike) ? { cp, strike } : null;
}

export function heldLegs(trades: Trade[] | undefined): Map<string, HeldLeg> {
  const out = new Map<string, HeldLeg>();
  for (const t of trades ?? []) {
    // Only what is actually on. A working order is not a position, and marking
    // the row for one would say you are short when you are not.
    if (!t.position) continue;
    const leg = legOf(t.symbol);
    if (!leg) continue;

    const key = heldKey(leg.cp, leg.strike);
    const prev = out.get(key);
    const size = Math.abs(t.position);
    const pnl = t.live?.unrealisedPnl ?? null;

    // Two trades on one strike are one position to look at. Sizes add; the
    // P&Ls add only when both are known, because a total that quietly drops a
    // missing half is worse than no total.
    out.set(key, prev
      ? {
          ...prev,
          size: prev.size + size,
          pnlUsd: prev.pnlUsd === null || pnl === null ? null : prev.pnlUsd + pnl,
        }
      : { cp: leg.cp, strike: leg.strike, size, pnlUsd: pnl });
  }
  return out;
}
