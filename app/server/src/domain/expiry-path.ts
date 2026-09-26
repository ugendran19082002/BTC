import type { HorizonRow } from './forecast.js';
import { pExpireWorthless, pTouch } from './probability.js';
import type { Ladder } from './hierarchy.js';

/**
 * Where BTC can be between now and the 17:30 IST settlement -- as a band, not
 * as a number.
 *
 * `docs/New.md` asks for a path: "Next 5m ↓ -45 pts … Expiry ↓ -550 pts", and
 * immediately adds the condition that makes it honest:
 *
 *   > இந்த numbers historical calibration/model-லிருந்து வர வேண்டும்;
 *   > timeframe-ஐ பார்த்து fixed-ஆக assume பண்ணக்கூடாது.
 *
 * So it is built from the calibration, and the calibration says something the
 * arrow shape cannot survive. `chain.db.horizons` holds 105,000+ windows over
 * 364 days at eight horizons, and at **every one of them** the measured share
 * that closed higher is between 0.494 and 0.506. Conditioning on the trend
 * (`pUpTrend`) does not improve it -- it is slightly *worse*, 0.489 to 0.502.
 *
 * A signed arrow drawn from that is a coin flip wearing a decimal point. What
 * the same table does measure, tightly and stably, is **how far** price
 * travels in a given time: the median, the 68th and the 95th percentile of
 * |move|. That is the number an option seller actually needs, because it is
 * the number that says whether a strike is far enough away.
 *
 * Hence the shape here: every row is a *cone* around the current price, with
 * the measured lean reported beside it as the near-nothing it is. `lean` is
 * never scaled up by the hierarchy's conviction; the ladder tilts which edge
 * of the cone is worth watching, and the screen says so in words, but it does
 * not get to invent a drift the data does not show.
 *
 * Pure: no clock, no I/O. `nowMs` and the horizon table arrive as arguments.
 */

export type PathRow = {
  label: string;
  minutes: number;
  /** True when this horizon was interpolated between two measured ones rather than measured itself. */
  interpolated: boolean;
  /** How many measured windows stand behind it. 0 when interpolated from neighbours. */
  windows: number;
  /** Half-width of the cone, in dollars, at each measured percentile. */
  medianUsd: number;
  p68Usd: number;
  p95Usd: number;
  /** The same as prices: spot ± the half-width. */
  low68: number;
  high68: number;
  low95: number;
  high95: number;
  /** The option market's own one-sigma move over this horizon, from ATM IV. Null without an IV. */
  impliedUsd: number | null;
  /**
   * The measured share of these windows that closed higher. Reported, never
   * used to size the cone. Expect ~0.50.
   */
  pUp: number;
  /** `pUp` restated as points of edge against a coin flip: (pUp - 0.5) x 2 x median. Expect ~0. */
  leanUsd: number;
};

export type ExpiryPath = {
  spot: number;
  hoursToExpiry: number;
  rows: PathRow[];
  /** The row that lands on settlement, i.e. the last one. Null when expiry has passed. */
  settlement: PathRow | null;
  /**
   * The largest |pUp - 0.5| anywhere in the measured table, in percentage
   * points. The honesty number: if this is 0.6, no directional claim on this
   * screen can be worth more than 0.6 points of edge.
   */
  directionEdgePct: number;
  /** Total measured windows behind the table. */
  sampleWindows: number;
  sampleDays: number;
  /** Which edge of the cone the hierarchy says to watch. Never widens or shifts the cone itself. */
  watch: 'UPPER' | 'LOWER' | 'BOTH';
  /** One sentence, for the screen, that cannot be read as a forecast. */
  note: string;
};

/** The horizons the Live screen draws, in order. 30m is interpolated; the rest are measured. */
export const PATH_MINUTES: readonly number[] = [5, 15, 30, 60, 120];

/**
 * The measured |move| percentiles at `minutes`, by square-root-of-time
 * interpolation between the two nearest measured horizons.
 *
 * Diffusion scales with √t, so interpolating linearly in √t between two
 * measured anchors is the right shape and keeps every value tied to something
 * counted. Beyond the last anchor it extrapolates from that anchor by the same
 * rule -- necessary for a settlement 14 hours out when the table stops at 12 --
 * and says so through `interpolated`.
 */
export function scaleTo(
  rows: readonly HorizonRow[],
  minutes: number,
): { medianPct: number; p68Pct: number; p95Pct: number; pUp: number; windows: number; interpolated: boolean } | null {
  if (!rows.length || !(minutes > 0)) return null;
  const exact = rows.find((r) => r.minutes === minutes);
  if (exact) {
    return {
      medianPct: exact.moveMedian, p68Pct: exact.moveP68, p95Pct: exact.moveP95,
      pUp: exact.pUp, windows: exact.windows, interpolated: false,
    };
  }

  const sorted = [...rows].sort((a, b) => a.minutes - b.minutes);
  const below = [...sorted].reverse().find((r) => r.minutes < minutes) ?? null;
  const above = sorted.find((r) => r.minutes > minutes) ?? null;

  if (below && above) {
    // Linear in √t between the two anchors.
    const s = Math.sqrt(minutes), a = Math.sqrt(below.minutes), b = Math.sqrt(above.minutes);
    const f = (s - a) / (b - a);
    const mix = (x: number, y: number) => x + (y - x) * f;
    return {
      medianPct: mix(below.moveMedian, above.moveMedian),
      p68Pct: mix(below.moveP68, above.moveP68),
      p95Pct: mix(below.moveP95, above.moveP95),
      pUp: mix(below.pUp, above.pUp),
      windows: 0,
      interpolated: true,
    };
  }

  // Outside the table: scale the nearest anchor by √(t/anchor).
  const anchor = above ?? below;
  if (!anchor) return null;
  const k = Math.sqrt(minutes / anchor.minutes);
  return {
    medianPct: anchor.moveMedian * k,
    p68Pct: anchor.moveP68 * k,
    p95Pct: anchor.moveP95 * k,
    pUp: anchor.pUp,
    windows: 0,
    interpolated: true,
  };
}

function rowAt(
  rows: readonly HorizonRow[],
  spot: number,
  minutes: number,
  label: string,
  atmIv: number | null,
): PathRow | null {
  const s = scaleTo(rows, minutes);
  if (!s) return null;
  const medianUsd = (s.medianPct / 100) * spot;
  const p68Usd = (s.p68Pct / 100) * spot;
  const p95Usd = (s.p95Pct / 100) * spot;
  // IV is annualised; a year of trading for a 24/7 instrument is 365 days.
  const years = minutes / (60 * 24 * 365);
  const impliedUsd = atmIv !== null && atmIv > 0 ? spot * atmIv * Math.sqrt(years) : null;
  return {
    label,
    minutes,
    interpolated: s.interpolated,
    windows: s.windows,
    medianUsd,
    p68Usd,
    p95Usd,
    low68: spot - p68Usd,
    high68: spot + p68Usd,
    low95: spot - p95Usd,
    high95: spot + p95Usd,
    impliedUsd,
    pUp: s.pUp,
    leanUsd: (s.pUp - 0.5) * 2 * medianUsd,
  };
}

export function expiryPath(input: {
  spot: number;
  hoursToExpiry: number;
  atmIv: number | null;
  horizons: readonly HorizonRow[];
  ladder: Ladder | null;
}): ExpiryPath | null {
  const { spot, hoursToExpiry, atmIv, horizons, ladder } = input;
  if (!(spot > 0) || !horizons.length) return null;

  const rows: PathRow[] = [];
  for (const m of PATH_MINUTES) {
    // A horizon past settlement is not a horizon this contract has.
    if (m / 60 >= hoursToExpiry) break;
    const r = rowAt(horizons, spot, m, m < 60 ? `${m}m` : `${m / 60}h`, atmIv);
    if (r) rows.push(r);
  }

  const settleMinutes = Math.round(hoursToExpiry * 60);
  const settlement = settleMinutes > 0 ? rowAt(horizons, spot, settleMinutes, 'expiry', atmIv) : null;
  if (settlement) rows.push(settlement);

  const directionEdgePct = horizons.reduce((a, r) => Math.max(a, Math.abs(r.pUp - 0.5) * 100), 0);
  const sampleWindows = horizons.reduce((a, r) => Math.max(a, r.windows), 0);
  const sampleDays = horizons.reduce((a, r) => Math.max(a, r.sampleDays), 0);

  const watch = ladder === null || ladder.bias === 'SIDE' ? 'BOTH' : ladder.bias === 'UP' ? 'UPPER' : 'LOWER';
  const note = `Measured over ${sampleWindows.toLocaleString('en-IN')} windows across ${sampleDays} days, `
    + `the share closing higher never leaves ${(50 - directionEdgePct).toFixed(1)}–${(50 + directionEdgePct).toFixed(1)}%. `
    + 'The band is measured; the direction is not.';

  return { spot, hoursToExpiry, rows, settlement, directionEdgePct, sampleWindows, sampleDays, watch, note };
}

/**
 * How safe one strike is to sell, to settlement.
 *
 * Three numbers a seller needs and nothing else: the chance it settles
 * worthless, the chance price ever touches it on the way (a strike that is
 * touched is a strike that has already cost you sleep, even if it settles
 * out), and how far away it sits in units of the measured 95th-percentile
 * move -- which is the one that answers "is this far enough" without a model.
 */
export type StrikeSafety = {
  strike: number;
  cp: 'C' | 'P';
  distanceUsd: number;
  /** Distance as a multiple of the measured P95 move to settlement. Above 1 is outside it. */
  distanceInP95: number | null;
  pExpireWorthless: number | null;
  pTouch: number | null;
  /** True when the strike sits outside the measured 95% cone at settlement. */
  outsideMeasured95: boolean;
  why: string;
};

export function strikeSafety(input: {
  cp: 'C' | 'P';
  strike: number;
  spot: number;
  hoursToExpiry: number;
  atmIv: number | null;
  path: ExpiryPath | null;
}): StrikeSafety | null {
  const { cp, strike, spot, hoursToExpiry, atmIv, path } = input;
  if (!(spot > 0) || !(strike > 0)) return null;
  const years = hoursToExpiry / (24 * 365);
  const worthless = atmIv !== null ? pExpireWorthless(cp, spot, strike, years, atmIv) : null;
  const touch = atmIv !== null ? pTouch(spot, strike, years, atmIv) : null;
  const distanceUsd = Math.abs(strike - spot);
  const p95 = path?.settlement?.p95Usd ?? null;
  const distanceInP95 = p95 !== null && p95 > 0 ? distanceUsd / p95 : null;
  const outsideMeasured95 = distanceInP95 !== null && distanceInP95 >= 1;

  const why = distanceInP95 === null
    ? 'No measured move for this horizon yet.'
    : outsideMeasured95
      ? `${distanceUsd.toFixed(0)} away — ${distanceInP95.toFixed(2)}x the measured 95% move to settlement.`
      : `${distanceUsd.toFixed(0)} away — only ${distanceInP95.toFixed(2)}x the measured 95% move; inside the band that has been reached.`;

  return { strike, cp, distanceUsd, distanceInP95, pExpireWorthless: worthless, pTouch: touch, outsideMeasured95, why };
}
