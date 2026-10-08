import type { StatsGroup } from '@/api/phone';
import type { EntryMode, MethodReportResponse } from '@/types/entry';
import { ruleTfs, type SignalRule, type SignalTf } from '@/types/strategy';

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

/**
 * A signal-history pair: also how many signals it gave, its net in R (points over the risk to the stop), and the
 * points its winners made and its losers gave back, each a positive number: `net = wonPts − lostPts`.
 */
export type SignalPair = PairStat & { signals: number; netR: number; wonPts: number; lostPts: number };

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
export function pairsOfReport(
  report: MethodReportResponse, way: EntryMode,
  /** Without the chain, only these timeframes; none named (or none of them in the report) is every timeframe. */
  only: readonly string[] = [],
  /** Only the methods-on-timeframes this says yes to (`takenBy`: the strategies chosen); absent is every one. */
  takes?: (method: string, tf: string) => boolean,
): { pairs: SignalPair[]; signals: number } {
  const kept = chosenTfs(report, only);
  const sections = way === 'mtf'
    ? report.sections.filter((s) => s.mode === 'mtf').map((s) => ({ tf: CHAIN_TF, rows: s.rows }))
    : Object.entries(report.singleByTf ?? {}).filter(([tf]) => kept.length === 0 || kept.includes(tf)).map(([tf, s]) => ({ tf, rows: s?.rows ?? [] }));
  const pairs: SignalPair[] = [];
  let signals = 0;
  for (const { tf, rows } of sections) {
    for (const r of rows) {
      if (takes && !takes(r.method, tf)) continue;
      signals += r.signals;
      if (r.trades <= 0) continue;
      pairs.push({
        key: `${r.method}|${way}|${tf}`, name: r.n === null ? r.name : `#${r.n} ${r.name}`, tf,
        trades: r.trades, wins: r.wins, losses: r.losses, winRate: r.winPct === null ? null : r.winPct / 100,
        profitFactor: r.lossPts > 0 ? r.profitPts / r.lossPts : null, net: r.netPts, signals: r.signals, netR: r.netR, wonPts: r.profitPts, lostPts: r.lossPts,
      });
    }
  }
  return { pairs, signals };
}

/**
 * Which signals a set of strategies takes, read one way (8 Oct 2026, the strategy filter on the signal history's
 * pairs): a method on a timeframe is taken when any of the strategies' signal rules takes it -- the same reading as
 * the server's `signalMatches`. With the timeframe chain a rule has no timeframe of its own, so the method alone
 * decides; without it, the rule's timeframes do too. A rule read the other way takes nothing here.
 */
export const takenBy = (rules: readonly Pick<SignalRule, 'mode' | 'tf' | 'tfs' | 'methods'>[], way: EntryMode) =>
  (method: string, tf: string): boolean => rules.some((r) =>
    r.mode === way && (way === 'mtf' || ruleTfs(r).includes(tf as SignalTf)) && r.methods.includes(method));

const TF_ORDER = ['1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h'];

/** The timeframes the report has without the chain, shortest first: the filter's chips. */
export const timeframesOf = (report: MethodReportResponse): string[] =>
  Object.keys(report.singleByTf ?? {}).sort((a, b) => TF_ORDER.indexOf(a) - TF_ORDER.indexOf(b));

/** Of the timeframes picked, those the report has, in its order: a pick remembered from another day may name one it has not. */
export const chosenTfs = (report: MethodReportResponse, picked: readonly string[]): string[] =>
  timeframesOf(report).filter((t) => picked.includes(t));

/**
 * A tap on the timeframe filter (owner, 6 Oct 2026: "single select and multiple select"). `tf` null is "All",
 * which clears the pick. Picking one at a time, a tap chooses that timeframe alone; picking many, a tap adds it
 * or takes it away, and taking the last away is "All" again.
 */
export function pickTf(picked: readonly string[], tf: string | null, how: 'one' | 'many'): string[] {
  if (tf === null) return [];
  if (how === 'one') return [tf];
  return picked.includes(tf) ? picked.filter((t) => t !== tf) : [...picked, tf];
}
