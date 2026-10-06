import type { StatsGroup } from '@/api/phone';

/**
 * Which entry method works on which timeframe, and which does not (owner, 6 Oct 2026): the closed trades of the
 * range chosen, paired by method and timeframe, split into the pairs that made money and the pairs that lost it.
 *
 * Every signal trade in the range is in exactly one pair and every pair is in at most one list, so the two lists
 * add up to what the signal trades made. A pair that made exactly nothing is in neither, and is counted as `flat`.
 */

export type Pair = StatsGroup & {
  /** The timeframe as the trade lists say it: `15m`, or `5m + TF chain`. */
  tf: string;
};

export type PairSplit = {
  /** In profit, the most first. */
  best: Pair[];
  /** In loss, the worst first. */
  worst: Pair[];
  flat: number;
  /** Trades across every pair: the signal trades of the range. */
  trades: number;
};

export function splitPairs(pairs: readonly Pair[]): PairSplit {
  // Level on money, the pair with more trades behind it is the one to read first.
  const best = pairs.filter((p) => p.netUsd > 0).sort((a, b) => b.netUsd - a.netUsd || b.trades - a.trades);
  const worst = pairs.filter((p) => p.netUsd < 0).sort((a, b) => a.netUsd - b.netUsd || b.trades - a.trades);
  return { best, worst, flat: pairs.length - best.length - worst.length, trades: pairs.reduce((n, p) => n + p.trades, 0) };
}
