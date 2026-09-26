import type { Candle } from '../market/delta.js';
import { atr } from './indicators.js';
import { marketState, type Side } from './market-state.js';

/**
 * The hour after a break: how big, not which way (26 Sep 2026).
 *
 * Replayed over two and a half years (research/MOMENTUM-MEASURED.txt), a
 * confirmed breakout or breakdown is a coin flip for direction -- 45-46% kept
 * going an hour later, on every timeframe, every year -- and trading it lost
 * money after fees. What it does predict is size: the hour after a 15m break
 * moves about a quarter more than a usual hour, after a 1h break close to half
 * as much again. To somebody short options that is the number that matters.
 *
 * This file is the rule, once, for both sides of that claim: the backtest
 * finds its breaks with `confirmedBreaks`, and so does the live card. If the
 * two used different code, the card would be quoting a measurement of
 * something else.
 */

export type Tf = '5m' | '15m' | '30m' | '1h';
export const TF_BARS_OF_5M: Record<Tf, number> = { '5m': 1, '15m': 3, '30m': 6, '1h': 12 };

/** Five-minute bars into `n`-bar bars, aligned to the clock, incomplete buckets dropped. */
export function resample(bars: readonly Candle[], n: number): Candle[] {
  if (n === 1) return [...bars];
  const span = n * 300;
  const out: Candle[] = [];
  let bucket: Candle[] = [];
  let start = -1;
  const flush = () => {
    if (bucket.length === n) {
      out.push({
        time: start,
        open: bucket[0]!.open,
        high: Math.max(...bucket.map((b) => b.high)),
        low: Math.min(...bucket.map((b) => b.low)),
        close: bucket[bucket.length - 1]!.close,
        volume: bucket.reduce((a, b) => a + b.volume, 0),
      });
    }
    bucket = [];
  };
  for (const b of bars) {
    const s = b.time - (b.time % span);
    if (s !== start) { flush(); start = s; }
    bucket.push(b);
  }
  flush();
  return out;
}

/** The bars `marketState` reads each break from. */
export const BREAK_WINDOW = 60;
/** A same-way break within this many bars of the last is the same move. */
export const BREAK_COOLDOWN = 3;

export type Break = {
  /** Index into the bars given. */
  i: number;
  side: Side;
  level: number;
  /** The signal bar's close: where the measurement starts. */
  entry: number;
  atr: number;
  volumeRatio: number | null;
  plan: { trigger: number; target1: number; invalidation: number };
};

/**
 * Every confirmed breakout and breakdown in `bars`, at each bar's close.
 *
 * The levels are the last twenty bars' range and the ATR is fourteen bars,
 * both from `marketState` itself. A second break the same way within the
 * cooldown is dropped, and still resets it, so one long push counts once.
 * `from` skips the bars nobody is asking about; the cooldown is still
 * honoured across it.
 */
export function confirmedBreaks(bars: readonly Candle[], from = 0): Break[] {
  const out: Break[] = [];
  const lastAt: Record<Side, number> = { UP: -Infinity, DOWN: -Infinity };
  // Started early: a run of breaks each inside the last one's cooldown carries it further back than one cooldown.
  const start = Math.max(BREAK_WINDOW, from - 30);
  for (let i = start; i < bars.length; i++) {
    const window = bars.slice(i - BREAK_WINDOW + 1, i + 1);
    const a = atr(window, 14);
    if (!a || a <= 0) continue;
    const s = marketState({ bars: window, level: { resistance: null, support: null }, atr: a });
    if (s.stage !== 'CONFIRMED' || !s.side || s.against === null) continue;
    if (s.event !== 'BREAKOUT_CONFIRMED' && s.event !== 'BREAKDOWN_CONFIRMED') continue;
    const repeat = i - lastAt[s.side] <= BREAK_COOLDOWN;
    lastAt[s.side] = i;
    if (repeat || i < from) continue;
    const plan = s.plans[s.side === 'UP' ? 'up' : 'down'];
    if (!plan) continue;
    out.push({
      i, side: s.side, level: s.against, entry: bars[i]!.close, atr: a, volumeRatio: s.volumeRatio,
      plan: { trigger: plan.trigger, target1: plan.target1, invalidation: plan.invalidation },
    });
  }
  return out;
}

export type CarryStats = {
  tf: Tf;
  n: number;
  from: string;
  to: string;
  /** Share of breaks whose price an hour later was further the break's way than the entry. */
  keptGoing: number;
  keptGoingByYear: Record<string, { n: number; keptGoing: number }>;
  /** The hour after the break, in the timeframe's ATR at the break: quantiles p50, p75, p90, p95. */
  withAtr: [number, number, number, number];
  againstAtr: [number, number, number, number];
  /** Biggest move either way in the hour, after a break and after any bar -- the "bigger than usual". */
  eitherAtr: [number, number];
  baselineEitherAtr: [number, number];
  /** P(the hour reaches k ATR the break's way / the other way), for each k in REACH_STEPS_ATR. */
  reachWith: number[];
  reachAgainst: number[];
};

// ------------------------------------------------------------------ live

/** The timeframes the card watches, biggest first. 5m is measured but left out: its hour was only ~11% bigger than usual. */
export const RISK_TFS = ['1h', '30m', '15m'] as const satisfies readonly Tf[];
export type RiskTf = (typeof RISK_TFS)[number];
/** The measurement's window: the hour after the break bar closed. */
export const RISK_WINDOW_SEC = 3600;

export type BreakRisk = {
  tf: RiskTf;
  side: Side;
  level: number;
  /** When the break bar closed, and when its measured hour ends, ms. */
  at: number;
  until: number;
  entry: number;
  atr: number;
  /** In BTC points from the entry: the table's ATR multiples times this break's ATR. */
  withPts: [number, number, number, number];
  againstPts: [number, number, number, number];
  eitherPts: [number, number];
  baselinePts: [number, number];
  /** The either-way median against a usual hour's: 0.27 is 27% bigger. */
  bigger: number;
  keptGoing: number;
  keptGoingByYear: CarryStats['keptGoingByYear'];
  n: number;
  from: string;
  to: string;
  /** The reach curves, for pricing any strike on the screen. */
  reach: { stepsAtr: readonly number[]; with: number[]; against: number[] };
};

const round = (v: number) => Math.round(v);

/**
 * The break whose measured hour is still running, if any.
 *
 * Only closed bars count: the bar still forming is dropped, because the
 * measurement was made at bar closes and a bar that has not closed can still
 * un-break. Where more than one timeframe has broken within the hour the
 * biggest wins -- its hour was measured bigger.
 */
export function breakRisk(
  bars5m: readonly Candle[],
  nowSec: number,
  table: readonly CarryStats[],
  steps: readonly number[],
): BreakRisk | null {
  const closed = bars5m.filter((b) => b.time + 300 <= nowSec);
  for (const tf of RISK_TFS) {
    const stats = table.find((t) => t.tf === tf);
    if (!stats) continue;
    const span = TF_BARS_OF_5M[tf] * 300;
    const bars = resample(closed, TF_BARS_OF_5M[tf]);
    // Only bars whose close falls inside the last hour can still be in their window.
    const first = bars.findIndex((b) => b.time + span > nowSec - RISK_WINDOW_SEC);
    if (first < 0) continue;
    const found = confirmedBreaks(bars, first);
    const last = found[found.length - 1];
    if (!last) continue;
    const closeSec = bars[last.i]!.time + span;
    const pts = <T extends number[]>(xs: T) => xs.map((k) => round(k * last.atr)) as T;
    return {
      tf,
      side: last.side,
      level: last.level,
      at: closeSec * 1000,
      until: (closeSec + RISK_WINDOW_SEC) * 1000,
      entry: last.entry,
      atr: last.atr,
      withPts: pts([...stats.withAtr] as [number, number, number, number]),
      againstPts: pts([...stats.againstAtr] as [number, number, number, number]),
      eitherPts: pts([...stats.eitherAtr] as [number, number]),
      baselinePts: pts([...stats.baselineEitherAtr] as [number, number]),
      bigger: stats.baselineEitherAtr[0] > 0 ? stats.eitherAtr[0] / stats.baselineEitherAtr[0] - 1 : 0,
      keptGoing: stats.keptGoing,
      keptGoingByYear: stats.keptGoingByYear,
      n: stats.n,
      from: stats.from,
      to: stats.to,
      reach: { stepsAtr: steps, with: stats.reachWith, against: stats.reachAgainst },
    };
  }
  return null;
}
