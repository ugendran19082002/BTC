/**
 * The methods that won a share of their trades, on enough of them (16 Oct 2026, `auto-methods.ts`): a module of its
 * own so the backtest's thread can pick as the daily update does (20 Oct 2026, the win % sweep) without loading the
 * update, which loads the backtest.
 */

/** The methods that won `winPct`% or more of `minTrades` trades or more, best net first. */
export function pickMethods(records: readonly { method: string; trades: number; wins: number; net: number }[], a: { winPct: number; minTrades: number }): string[] {
  return records
    .filter((r) => r.trades >= a.minTrades && (r.wins / r.trades) * 100 >= a.winPct - 1e-9)
    .sort((x, y) => y.net - x.net)
    .map((r) => r.method);
}
