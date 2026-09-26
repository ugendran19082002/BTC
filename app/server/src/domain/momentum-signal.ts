import type { Candle } from '../market/delta.js';
import { confirmedBreaks, resample, TF_BARS_OF_5M, type Tf } from './break-risk.js';
import type { Side } from './market-state.js';
import { atr as atrOf } from './indicators.js';
import { MOMENTUM_MEASURED, MEASURED_FROM, MEASURED_TO, type MeasuredPolicy } from './momentum-measured.data.js';

/**
 * "A big move is coming -- here is the stop and the target."
 *
 * Two states, and the difference between them is the whole design:
 *
 *  - **COILED.** Range has contracted; an expansion usually follows one. This
 *    is a *warning*, it has a level but no entry, and it carries no measured
 *    record because none has been taken. It says so.
 *  - **CONFIRMED.** A level has broken on a closed bar. This has an entry, a
 *    stop, a target -- and a measured record, because the replay in
 *    `src/backtest/momentum-study.ts` has graded every one of these that ever
 *    fired, after fees, with 2026 held out.
 *
 * The record is the point. `docs/FULL-STUDY.md` §7.5 is about this card: the
 * live screen was showing an 80% hit rate for the confirmed call with no cost
 * beside it, while the replay said every policy at every timeframe was net
 * negative after fees. A hit rate without its net R is the number that gets
 * traded.
 *
 * So every signal here carries `measured`, and a signal whose measured net R
 * is not positive is returned with `verdict: 'INFORMATIONAL'`. It is still
 * shown -- knowing the market just broke 84,000 is worth knowing -- but the
 * card may not present it as a trade, and the screen has no way to ask for it
 * without the verdict attached.
 *
 * Pure. Bars and a clock arrive as arguments.
 */

export type SignalState = 'COILED' | 'CONFIRMED' | 'NONE';

/** Not a trade unless the replay says the shape paid for itself after fees. */
export type Verdict = 'TRADEABLE' | 'INFORMATIONAL';

export type Plan = {
  /** Where the call was made: the breaking bar's close. */
  entry: number;
  stop: number;
  target: number;
  /** target − entry over entry − stop, unsigned. Below 1 is risking more than it seeks. */
  rr: number;
  /** What one unit of risk is worth, in points. */
  riskPts: number;
  rewardPts: number;
  /** The policy these levels came from -- the same string the measured table is keyed by. */
  policy: string;
};

export type Measured = {
  policy: string;
  tf: string;
  n: number;
  hitRate: number;
  netR: number;
  avgR: number;
  /** 2026 held out of the choice: the only year that says whether the shape was real. */
  outOfSample: { year: string; n: number; hitRate: number; netR: number } | null;
  from: string;
  to: string;
};

export type MomentumSignal = {
  state: SignalState;
  tf: Tf | null;
  side: Side | null;
  /** The level that broke, or the edge of the coil. */
  level: number | null;
  /** The coil's other edge; null when confirmed. */
  levelLow?: number | null;
  atr: number | null;
  /** When the deciding bar closed, ms. Null when nothing has. */
  at: number | null;
  plan: Plan | null;
  measured: Measured | null;
  verdict: Verdict;
  /** How tight the range is against its own recent average. Below COILED_RATIO is coiled. */
  compression: number | null;
  /** One sentence naming the state, and -- when there is one -- what it actually paid. */
  headline: string;
  /** Everything a person should know before acting, worst first. Empty is not the same as good. */
  warnings: string[];
};

/**
 * The stop/target policy the live card places.
 *
 * `entry 1.5 ATR : 3 ATR` and not the card's historical `live (level ± 1 ATR)`:
 * across all four timeframes the replay put the wide-stop policy least
 * negative, and at 30m and 1h it was the only one whose average R before fees
 * was positive at all. It is still not a profitable rule -- see the verdict --
 * but if the screen is going to draw a stop and a target, it should draw the
 * best-measured pair rather than the first one somebody wrote.
 */
export const LIVE_POLICY = 'entry 1.5 ATR : 3 ATR';
const STOP_ATR = 1.5;
const TARGET_ATR = 3;

/** ATR against its own 100-bar average. Under this the range has contracted. */
export const COILED_RATIO = 0.8;

/** A coil is only interesting while it is still coiled: this many bars of it, at most. */
export const COIL_LOOKBACK = 100;

/** Only a break whose bar closed inside this window is still "now". */
export const FRESH_SEC = 3_600;

const round = (v: number) => Math.round(v * 10) / 10;

/** The measured row for a (timeframe, policy) pair, or null when the study has never graded it. */
export function measuredFor(tf: string, policy: string): Measured | null {
  const row: MeasuredPolicy | undefined = MOMENTUM_MEASURED.find((m) => m.tf === tf && m.policy === policy);
  if (!row || row.n === 0) return null;
  // The last year in the table is the held-out one.
  const years = Object.keys(row.byYear).sort();
  const oosYear = years[years.length - 1] ?? null;
  const oos = oosYear ? row.byYear[oosYear] : undefined;
  return {
    policy: row.policy,
    tf: row.tf,
    n: row.n,
    hitRate: row.hitRate,
    netR: row.netR,
    avgR: row.avgR,
    outOfSample: oosYear && oos ? { year: oosYear, n: oos.n, hitRate: oos.hitRate, netR: oos.netR } : null,
    from: MEASURED_FROM,
    to: MEASURED_TO,
  };
}

function planFrom(side: Side, entry: number, atr: number): Plan {
  const dir = side === 'UP' ? 1 : -1;
  const stop = entry - dir * STOP_ATR * atr;
  const target = entry + dir * TARGET_ATR * atr;
  const riskPts = Math.abs(entry - stop);
  const rewardPts = Math.abs(target - entry);
  return {
    entry: round(entry),
    stop: round(stop),
    target: round(target),
    rr: riskPts > 0 ? rewardPts / riskPts : 0,
    riskPts: round(riskPts),
    rewardPts: round(rewardPts),
    policy: LIVE_POLICY,
  };
}

/** ATR over the last 14 bars against its average over the 100 before that. Under 1 is contracting. */
export function compressionOf(bars: readonly Candle[]): number | null {
  if (bars.length < COIL_LOOKBACK + 15) return null;
  const now = atrOf(bars.slice(-15), 14);
  const prior = atrOf(bars.slice(-(COIL_LOOKBACK + 15), -15), 14);
  if (now === null || prior === null || !(prior > 0)) return null;
  return now / prior;
}

const NO_SIGNAL: MomentumSignal = {
  state: 'NONE', tf: null, side: null, level: null, atr: null, at: null, plan: null,
  measured: null, verdict: 'INFORMATIONAL', compression: null,
  headline: 'No break and no coil — the range is ordinary.',
  warnings: [],
};

/**
 * Read the live tape for a momentum signal.
 *
 * `tfs` is searched biggest first: a break on the 1-hour bar is a bigger event
 * than the same break on the 15-minute one, and the measured hour after it was
 * bigger too.
 */
export function momentumSignal(input: {
  bars5m: readonly Candle[];
  nowSec: number;
  tfs?: readonly Tf[];
}): MomentumSignal {
  const { bars5m, nowSec, tfs = ['1h', '30m', '15m', '5m'] as const } = input;
  // Only closed bars. A bar still forming can un-break, and the measurement
  // was taken at closes.
  const closed = bars5m.filter((b) => b.time + 300 <= nowSec);
  if (closed.length < 120) return NO_SIGNAL;

  for (const tf of tfs) {
    const n = TF_BARS_OF_5M[tf];
    const bars = resample(closed, n);
    if (bars.length < 40) continue;
    const span = n * 300;

    // A break is "now" only while its bar closed inside the fresh window.
    const firstFresh = bars.findIndex((b) => b.time + span > nowSec - FRESH_SEC);
    if (firstFresh < 0) continue;
    const found = confirmedBreaks(bars, firstFresh);
    const last = found[found.length - 1];
    if (!last) continue;

    const bar = bars[last.i]!;
    const at = (bar.time + span) * 1000;
    const plan = planFrom(last.side, last.entry, last.atr);
    const measured = measuredFor(tf, LIVE_POLICY);
    const compression = compressionOf(bars);

    const warnings: string[] = [];
    if (measured === null) {
      warnings.push(`No measured record for ${tf} on this stop/target pair — the shape has never been graded.`);
    } else {
      if (measured.netR <= 0) {
        warnings.push(
          `Measured net ${measured.netR >= 0 ? '+' : ''}${measured.netR.toFixed(3)}R after fees over ${measured.n.toLocaleString('en-IN')} of these `
          + `(${measured.from} → ${measured.to}). This shape has not paid for itself.`,
        );
      }
      if (measured.outOfSample && measured.outOfSample.netR <= 0) {
        warnings.push(`It also lost in ${measured.outOfSample.year}, the year held out of the choice: ${measured.outOfSample.netR.toFixed(3)}R over ${measured.outOfSample.n}.`);
      }
    }
    if (plan.rr < 1) warnings.push(`Risking ${plan.riskPts} to seek ${plan.rewardPts} — under 1:1.`);

    const verdict: Verdict = measured !== null && measured.netR > 0 ? 'TRADEABLE' : 'INFORMATIONAL';
    const headline = measured === null
      ? `${tf} ${last.side === 'UP' ? 'breakout' : 'breakdown'} through ${round(last.level)} — never graded, so no claim is made about it.`
      : `${tf} ${last.side === 'UP' ? 'breakout' : 'breakdown'} through ${round(last.level)} · hit ${(measured.hitRate * 100).toFixed(0)}% `
        + `but ${measured.netR >= 0 ? '+' : ''}${measured.netR.toFixed(3)}R net after fees over ${measured.n.toLocaleString('en-IN')}.`;

    return {
      state: 'CONFIRMED',
      tf,
      side: last.side,
      level: round(last.level),
      atr: round(last.atr),
      at,
      plan,
      measured,
      verdict,
      compression,
      headline,
      warnings,
    };
  }

  /*
   * Nothing has broken. Is anything coiled?
   *
   * Measured on the 15-minute bars, which is where a contraction is visible
   * without being noise. There is no measured record for this state and the
   * signal says so rather than borrowing the confirmed one's -- borrowing a
   * neighbouring measurement is how a number nobody took ends up on a screen.
   */
  const bars15 = resample(closed, TF_BARS_OF_5M['15m']);
  const compression = compressionOf(bars15);
  if (compression !== null && compression < COILED_RATIO && bars15.length >= 20) {
    const recent = bars15.slice(-20);
    const high = Math.max(...recent.map((b) => b.high));
    const low = Math.min(...recent.map((b) => b.low));
    const a = atrOf(bars15, 14);
    return {
      state: 'COILED',
      tf: '15m',
      side: null,
      level: round(high),
      levelLow: round(low),
      atr: a === null ? null : round(a),
      at: (bars15[bars15.length - 1]!.time + 900) * 1000,
      plan: null,
      measured: null,
      verdict: 'INFORMATIONAL',
      compression,
      headline: `Range has contracted to ${(compression * 100).toFixed(0)}% of its recent average, between ${round(low)} and ${round(high)}. `
        + 'An expansion usually follows — which way is not forecast.',
      warnings: [
        'The coiled state has never been graded. It is a warning to watch the edges, not a trade.',
        'No side: a contraction says a move is likely, not which way it breaks.',
      ],
    };
  }

  return { ...NO_SIGNAL, compression };
}
