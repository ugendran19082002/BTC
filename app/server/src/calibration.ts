import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { DB_PATH } from './backtest.js';

/**
 * What the model says, against what actually happened.
 *
 * Black-Scholes hands out a probability that an option finishes out of the
 * money. Two years of Delta settlements hand out a frequency. The desk shows
 * the frequency, because that is the number a seller is actually exposed to,
 * and shows the model beside it so the gap is visible rather than hidden.
 */
/**
 * Correct one model probability using the buckets around it.
 *
 * The correction is the bucket's (observed - model-at-centre) difference,
 * interpolated linearly between the two nearest bucket centres so a strike does
 * not jump when it crosses a boundary. Outside the table the nearest edge's
 * correction is used unchanged, which is the most that can honestly be said.
 */
function adjust(model: number, buckets: Bucket[]): number | null {
  if (!buckets.length) return null;
  const points = buckets
    .map((b) => ({ centre: (b.lo + b.hi) / 2, correction: b.rate - (b.lo + b.hi) / 2 }))
    .sort((a, b) => a.centre - b.centre);

  const first = points[0]!;
  const last = points[points.length - 1]!;
  let correction: number;
  if (model <= first.centre) correction = first.correction;
  else if (model >= last.centre) correction = last.correction;
  else {
    let i = 0;
    while (i < points.length - 2 && points[i + 1]!.centre < model) i++;
    const a = points[i]!;
    const b = points[i + 1]!;
    const w = (model - a.centre) / (b.centre - a.centre);
    correction = a.correction + w * (b.correction - a.correction);
  }
  return Math.max(0, Math.min(1, model + correction));
}

export type Bucket = {
  kind: 'model_potm' | 'em_distance';
  lo: number;
  hi: number;
  legs: number;
  expired0: number;
  rate: number;
  avgMark: number;
};

let cache: Bucket[] | null = null;

export function loadCalibration(): Bucket[] {
  if (cache) return cache;
  if (!existsSync(DB_PATH)) return (cache = []);
  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  try {
    const rows = db
      .prepare(
        'SELECT kind, bucket_lo, bucket_hi, legs, expired_0, rate, avg_mark' +
          ' FROM calibration ORDER BY kind, bucket_lo',
      )
      .all() as unknown as {
      kind: Bucket['kind'];
      bucket_lo: number;
      bucket_hi: number;
      legs: number;
      expired_0: number;
      rate: number;
      avg_mark: number;
    }[];
    cache = rows.map((r) => ({
      kind: r.kind,
      lo: r.bucket_lo,
      hi: r.bucket_hi,
      legs: r.legs,
      expired0: r.expired_0,
      rate: r.rate,
      avgMark: r.avg_mark,
    }));
    return cache;
  } catch {
    // the table is only there once calibrate.py has run
    return (cache = []);
  } finally {
    db.close();
  }
}

export function reloadCalibration(): number {
  cache = null;
  return loadCalibration().length;
}

export type ZeroChance = {
  /** Black-Scholes probability the option finishes out of the money */
  model: number;
  /**
   * The model corrected by what actually happened.
   *
   * Not the bucket rate itself. Buckets are five points wide, so reading them
   * straight off gives every strike in a bucket the same number -- which looks
   * broken next to a model column that moves strike by strike, and hides the
   * difference between a strike at the edge of a bucket and one in the middle.
   *
   * Instead the bucket supplies a *correction*: how far reality sat from the
   * model for strikes like this, interpolated between neighbouring buckets and
   * added to this strike's own model probability. Every strike keeps its own
   * number, and the number carries the measured bias.
   */
  adjusted: number | null;
  /** how often strikes in this band actually expired worthless */
  historical: number | null;
  /** how many settled legs that frequency rests on */
  sample: number | null;
  /** historical minus model, in percentage points */
  gap: number | null;
  /**
   * True when the model probability falls outside every bucket the table has,
   * so the rate shown is the nearest edge rather than a measurement of strikes
   * like this one. Deep in-the-money strikes land here.
   */
  outsideTable: boolean;
  /**
   * False when the snapshot's horizon is not the ~12 hours the table was built
   * from. The mapping still applies loosely -- it says what happened when the
   * model claimed a given probability -- but it was measured on same-session
   * trades and should not be read as exact anywhere else.
   */
  comparableHorizon: boolean;
};

/** The table was built from 05:30 entries settling at 12:00 UTC. */
export const CALIBRATED_HOURS = 12;
export function horizonComparable(hoursToExpiry: number): boolean {
  return hoursToExpiry >= 8 && hoursToExpiry <= 16;
}

/**
 * Map a model probability onto the frequency observed for strikes like it.
 *
 * Buckets are wide on purpose. A finer grid would put a handful of legs in each
 * one and dress up noise as precision.
 */
export function zeroChance(
  modelPotm: number | null,
  hoursToExpiry: number,
): ZeroChance | null {
  if (modelPotm === null || !Number.isFinite(modelPotm)) return null;
  const buckets = loadCalibration().filter((b) => b.kind === 'model_potm');
  const exact = buckets.find((b) => modelPotm >= b.lo && modelPotm < b.hi);
  const edge =
    modelPotm >= 0.95 ? buckets[buckets.length - 1]
    : modelPotm < (buckets[0]?.lo ?? 0) ? buckets[0]
    : undefined;
  const hit = exact ?? edge;
  const outsideTable = exact === undefined && edge !== undefined && modelPotm < 0.95;

  return {
    model: modelPotm,
    adjusted: adjust(modelPotm, buckets),
    historical: hit?.rate ?? null,
    sample: hit?.legs ?? null,
    gap: hit ? (hit.rate - modelPotm) * 100 : null,
    comparableHorizon: horizonComparable(hoursToExpiry),
    outsideTable,
  };
}

/** The same question asked of distance rather than delta. */
export function zeroChanceByDistance(
  emDistance: number | null,
  hoursToExpiry: number,
): ZeroChance | null {
  if (emDistance === null || !Number.isFinite(emDistance)) return null;
  const buckets = loadCalibration().filter((b) => b.kind === 'em_distance');
  const hit = buckets.find((b) => emDistance >= b.lo && emDistance < b.hi)
    ?? buckets[buckets.length - 1];
  return hit
    ? {
        model: emDistance,
        adjusted: hit.rate,
        historical: hit.rate,
        sample: hit.legs,
        gap: null,
        comparableHorizon: horizonComparable(hoursToExpiry),
        outsideTable: false,
      }
    : null;
}
