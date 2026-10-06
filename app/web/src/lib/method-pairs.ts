import type { StatsGroup } from '@/api/phone';
import type { EntryMode, MethodReportResponse } from '@/types/entry';

/**
 * Which entry method works on which timeframe, and which does not (owner, 6 Oct 2026): a method on a timeframe is
 * a pair, and the pairs are split into those in profit and those in loss. Two sources, one shape:
 *
 *  - the closed trades of the P&L range (`pairsOfStats`), ranked on the money they made after charges;
 *  - the signal history (`pairsOfReport`), every signal the methods gave whether or not the desk traded it,
 *    ranked on BTC perp points from fill to exit -- with the timeframe chain, or without it.
 *
 * Every trade is in exactly one pair and every pair in at most one list, so the two lists add up to the whole.
 * A pair that made exactly nothing is in neither, and is counted as `flat`.
 */

export type PairStat = {
  key: string;
  name: string;
  /** The timeframe as the trade lists say it: `15m`, or `5m + TF chain`. */
  tf: string;
  trades: number; wins: number; losses: number;
  /** Wins over trades, 0-1; null with no trade. */
  winRate: number | null;
  /** Won over lost; null where nothing was lost. */
  profitFactor: number | null;
  /** What the pair is ranked on: dollars for trades, perp points for signals. */
  net: number;
};

/** A signal-history pair: also how many signals it gave, and its net in R (points over the risk to the stop). */
export type SignalPair = PairStat & { signals: number; netR: number };

export type PairSplit<T extends PairStat = PairStat> = {
  /** In profit, the most first. */
  best: T[];
  /** In loss, the worst first. */
  worst: T[];
  flat: number;
  /** Trades across every pair. */
  trades: number;
};

export function splitPairs<T extends PairStat>(pairs: readonly T[]): PairSplit<T> {
  // Level on what they made, the pair with more trades behind it is the one to read first.
  const best = pairs.filter((p) => p.net > 0).sort((a, b) => b.net - a.net || b.trades - a.trades);
  const worst = pairs.filter((p) => p.net < 0).sort((a, b) => a.net - b.net || b.trades - a.trades);
  return { best, worst, flat: pairs.length - best.length - worst.length, trades: pairs.reduce((n, p) => n + p.trades, 0) };
}

/** The closed trades' pairs, as `/api/report/stats` gives them (`byPair`). */
export const pairsOfStats = (byPair: readonly (StatsGroup & { tf: string })[]): PairStat[] =>
  byPair.map((g) => ({
    key: g.key, name: g.name ?? g.key, tf: g.tf, trades: g.trades, wins: g.wins, losses: g.losses,
    winRate: g.winRate, profitFactor: g.profitFactor, net: g.netUsd,
  }));

export const CHAIN_TF = '5m + TF chain';

/**
 * The signal history's pairs, from the Methods report (`/api/entry/report`): with the timeframe chain a method is
 * one pair (its entry is on 5m); without it, one pair for each timeframe it gave a trade on. A method that gave
 * signals and no trade has nothing to be ranked on and is left out; its signals are still counted in `signals`.
 */
export function pairsOfReport(report: MethodReportResponse, way: EntryMode): { pairs: SignalPair[]; signals: number } {
  const sections = way === 'mtf'
    ? report.sections.filter((s) => s.mode === 'mtf').map((s) => ({ tf: CHAIN_TF, rows: s.rows }))
    : Object.entries(report.singleByTf ?? {}).map(([tf, s]) => ({ tf, rows: s?.rows ?? [] }));
  const pairs: SignalPair[] = [];
  let signals = 0;
  for (const { tf, rows } of sections) {
    for (const r of rows) {
      signals += r.signals;
      if (r.trades <= 0) continue;
      pairs.push({
        key: `${r.method}|${way}|${tf}`, name: r.n === null ? r.name : `#${r.n} ${r.name}`, tf,
        trades: r.trades, wins: r.wins, losses: r.losses, winRate: r.winPct === null ? null : r.winPct / 100,
        profitFactor: r.lossPts > 0 ? r.profitPts / r.lossPts : null, net: r.netPts, signals: r.signals, netR: r.netR,
      });
    }
  }
  return { pairs, signals };
}
