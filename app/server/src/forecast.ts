import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { DB_PATH } from './backtest.js';
import type { Snapshot } from './chain.js';

/**
 * How far BTC could move over the next few hours, and which way.
 *
 * The two halves are not equally knowable, and the card says so:
 *
 *   How far  — measured over 105,120 five-minute windows spanning a year, and
 *              cross-checked against what the option market is pricing right
 *              now. Stable and genuinely useful.
 *
 *   Which way — measured the same way and it is a coin flip at every horizon:
 *              49.4% up at five minutes, 50.6% at twelve hours, and nothing in
 *              between escapes 48-52%. Conditioning on the trend or on the last
 *              bar moves it by less than a percentage point.
 *
 * The direction number is here precisely because it is uninteresting. A page
 * that shows only the range invites someone to add a forecast later on a hunch;
 * a page that shows the measured 50% makes the case against it every time it
 * loads.
 */

export type HorizonRow = {
  minutes: number;
  label: string;
  windows: number;
  moveMedian: number;
  moveP68: number;
  moveP95: number;
  moveWorst: number;
  rangeMedian: number;
  rangeP68: number;
  rangeP95: number;
  pUp: number;
  pUpTrend: number;
  sampleDays: number;
};

let cache: HorizonRow[] | null = null;

export function loadHorizons(): HorizonRow[] {
  if (cache) return cache;
  if (!existsSync(DB_PATH)) return (cache = []);
  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  try {
    const rows = db
      .prepare('SELECT * FROM horizons ORDER BY minutes')
      .all() as unknown as Record<string, number | string>[];
    cache = rows.map((r) => ({
      minutes: r.minutes as number,
      label: r.label as string,
      windows: r.windows as number,
      moveMedian: r.move_median as number,
      moveP68: r.move_p68 as number,
      moveP95: r.move_p95 as number,
      moveWorst: r.move_worst as number,
      rangeMedian: r.range_median as number,
      rangeP68: r.range_p68 as number,
      rangeP95: r.range_p95 as number,
      pUp: r.p_up as number,
      pUpTrend: r.p_up_trend as number,
      sampleDays: r.sample_days as number,
    }));
    return cache;
  } catch {
    return (cache = []);
  } finally {
    db.close();
  }
}

export function reloadHorizons(): number {
  cache = null;
  return loadHorizons().length;
}

export type ForecastRow = {
  label: string;
  hours: number;
  /** the option market's one-standard-deviation move, in dollars and percent */
  impliedUsd: number | null;
  impliedPct: number | null;
  /** measured: half of all past windows moved less than this */
  typicalPct: number;
  /** measured: two thirds stayed inside this */
  likelyPct: number;
  /** measured: nineteen in twenty stayed inside this */
  outerPct: number;
  /** measured: the largest move seen in the sample */
  worstPct: number;
  /** measured: how far it travelled inside the window, not just where it ended */
  rangePct: number;
  /** measured share of windows that closed higher */
  pUp: number;
  /** dollar levels for the likely band, from spot */
  low: number;
  high: number;
  /** true for the row that matches this contract's remaining life */
  isExpiry: boolean;
};

export type Forecast = {
  spot: number;
  sampleWindows: number;
  sampleDays: number;
  rows: ForecastRow[];
  /** how far from a coin flip the measured direction ever gets, in points */
  directionEdgePts: number;
};

const YEAR_HOURS = 365 * 24;

/** Interpolate the measured table to an arbitrary horizon, scaling by √time. */
function atHours(rows: HorizonRow[], hours: number): HorizonRow | null {
  if (!rows.length) return null;
  const mins = hours * 60;
  const exact = rows.find((r) => Math.abs(r.minutes - mins) < 1);
  if (exact) return exact;
  const nearest = rows.reduce((a, b) =>
    Math.abs(b.minutes - mins) < Math.abs(a.minutes - mins) ? b : a,
  );
  // volatility grows with the square root of time, so stretch the nearest row
  const k = Math.sqrt(mins / nearest.minutes);
  return {
    ...nearest,
    minutes: mins,
    label: `${hours.toFixed(1)}h`,
    moveMedian: nearest.moveMedian * k,
    moveP68: nearest.moveP68 * k,
    moveP95: nearest.moveP95 * k,
    moveWorst: nearest.moveWorst * k,
    rangeMedian: nearest.rangeMedian * k,
    rangeP68: nearest.rangeP68 * k,
    rangeP95: nearest.rangeP95 * k,
  };
}

export function forecast(snap: Snapshot): Forecast | null {
  const rows = loadHorizons();
  if (!rows.length) return null;

  const build = (r: HorizonRow, hours: number, isExpiry: boolean): ForecastRow => {
    const implied =
      snap.atmIv === null ? null : snap.spot * snap.atmIv * Math.sqrt(hours / YEAR_HOURS);
    const band = (snap.spot * r.moveP68) / 100;
    return {
      label: isExpiry ? 'to settlement' : r.label,
      hours,
      impliedUsd: implied,
      impliedPct: implied === null ? null : (implied / snap.spot) * 100,
      typicalPct: r.moveMedian,
      likelyPct: r.moveP68,
      outerPct: r.moveP95,
      worstPct: r.moveWorst,
      rangePct: r.rangeP68,
      pUp: r.pUp,
      low: snap.spot - band,
      high: snap.spot + band,
      isExpiry,
    };
  };

  const out = rows.map((r) => build(r, r.minutes / 60, false));

  // and the horizon that actually matters: whatever is left on this contract
  const left = snap.hoursToExpiry;
  const atExpiry = atHours(rows, left);
  if (atExpiry && left > 0) out.push(build(atExpiry, left, true));

  const edge = Math.max(...rows.map((r) => Math.abs(r.pUp - 0.5))) * 100;
  return {
    spot: snap.spot,
    sampleWindows: rows[0]!.windows,
    sampleDays: rows[0]!.sampleDays,
    rows: out,
    directionEdgePts: edge,
  };
}
