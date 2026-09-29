// GENERATED from app/web/src/lib/trend/breakout.ts by `npm run sync:trend` -- edit that file, not this one.
/**
 * The trend plan: a close beyond the 20-candle channel, a stop 2 ATR(14) from
 * the entry, then a chandelier -- 3 ATR from the best price since entry, never
 * loosened -- and no target. One position at a time. Measured over 2024-26 in
 * app/web/scripts/momentum-study.ts (research/MOMENTUM-STUDY.txt): on 1H and 4H
 * candles it was positive in both halves after fees, not significantly, and it
 * was positioned for 38-49% of the 2%-in-four-hours moves.
 *
 * Pure and dependency-free on purpose: the study, the chart and the server's
 * paper log (a checked copy, app/server/src/strategy/trend-breakout.ts) all run
 * this one file, so the record, the plan on screen and the log cannot differ.
 *
 * No lookahead: candle j is read at its close. The channel at j is the 20
 * candles before it; the stop checked against candle j is the one in force at
 * the close of j - 1; a gap through it fills at the open. A candle that closes
 * a position does not also open one.
 */

export type TrendBar = { time: number; open: number; high: number; low: number; close: number };

export type TrendOptions = { lookback: number; stopAtr: number; trailAtr: number; atrLen: number };
export const TREND_OPTIONS: TrendOptions = { lookback: 20, stopAtr: 2, trailAtr: 3, atrLen: 14 };

export type TrendTrade = {
  dir: 1 | -1;
  /** The candle whose close made the signal (index), and its open time. */
  at: number;
  time: number;
  entry: number;
  /** The initial stop, and the risk it sets: every R is measured against it. */
  stop0: number;
  risk: number;
  /** The stop in force after each close, from the entry candle on. Only ever tighter. */
  trail: { at: number; stop: number }[];
  /** The best price reached since entry. */
  best: number;
  /** Null while open. */
  exitAt: number | null;
  exit: number | null;
};

export type TrendState = {
  atr: number[];
  /** The channel in force at each candle's close: the high / low of the candles before it. */
  upper: (number | null)[];
  lower: (number | null)[];
  trades: TrendTrade[];
  /** The trade still open at the last close, or null. */
  open: TrendTrade | null;
};

/** Replay the plan over closed candles, oldest first. */
export function runTrend(bars: readonly TrendBar[], o: TrendOptions = TREND_OPTIONS): TrendState {
  const atr: number[] = [];
  const upper: (number | null)[] = [];
  const lower: (number | null)[] = [];
  const trades: TrendTrade[] = [];
  let open: TrendTrade | null = null;
  let a = 0;
  for (let j = 0; j < bars.length; j++) {
    const b = bars[j]!;
    const tr = j === 0 ? b.high - b.low : Math.max(b.high - b.low, Math.abs(b.high - bars[j - 1]!.close), Math.abs(b.low - bars[j - 1]!.close));
    a = j < o.atrLen ? (a * j + tr) / (j + 1) : (a * (o.atrLen - 1) + tr) / o.atrLen;
    atr.push(a);
    let hi: number | null = null;
    let lo: number | null = null;
    if (j >= o.lookback) {
      hi = -Infinity; lo = Infinity;
      for (let k = j - o.lookback; k < j; k++) { hi = Math.max(hi, bars[k]!.high); lo = Math.min(lo, bars[k]!.low); }
    }
    upper.push(hi);
    lower.push(lo);

    if (open) {
      const stop = open.trail[open.trail.length - 1]!.stop;
      if (open.dir === 1 ? b.low <= stop : b.high >= stop) {
        open.exitAt = j;
        open.exit = open.dir === 1 ? Math.min(stop, b.open) : Math.max(stop, b.open);
        open = null;
        continue;
      }
      open.best = open.dir === 1 ? Math.max(open.best, b.high) : Math.min(open.best, b.low);
      const chandelier = open.best - open.dir * o.trailAtr * a;
      open.trail.push({ at: j, stop: open.dir === 1 ? Math.max(stop, chandelier) : Math.min(stop, chandelier) });
      continue;
    }
    if (hi === null || lo === null) continue;
    const dir: 1 | -1 | 0 = b.close > hi ? 1 : b.close < lo ? -1 : 0;
    if (dir === 0) continue;
    const stop0 = b.close - dir * o.stopAtr * a;
    open = { dir, at: j, time: b.time, entry: b.close, stop0, risk: Math.abs(b.close - stop0), trail: [{ at: j, stop: stop0 }], best: b.close, exitAt: null, exit: null };
    trades.push(open);
  }
  return { atr, upper, lower, trades, open };
}

/** A trade's result in R before costs; an open one at `mark`. */
export const trendR = (t: TrendTrade, mark?: number): number | null => {
  const px = t.exit ?? mark;
  return px === undefined ? null : (t.dir * (px - t.entry)) / t.risk;
};

/** The round trip's cost in R: `feePerSide` on the entry and on the exit (or `mark`). */
export const trendFeeR = (t: TrendTrade, feePerSide: number, mark?: number): number => {
  const px = t.exit ?? mark ?? t.entry;
  return ((t.entry + px) * feePerSide) / t.risk;
};

/** The stop in force now: the last trail step. */
export const trendStop = (t: TrendTrade): number => t.trail[t.trail.length - 1]!.stop;
