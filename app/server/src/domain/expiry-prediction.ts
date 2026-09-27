import { pBetween, pTouch } from './probability.js';
import type { ExpiryPath } from './expiry-path.js';

/**
 * Where this contract most probably settles, and what it would have to reach on
 * the way.
 *
 * The desk screen wants a headline — "84,300 – 85,600 (78% probability)" — and a
 * ladder of targets with odds beside each. Both are easy to draw and easy to
 * fabricate, so both are built the only way they are worth anything:
 *
 *  - **The band is measured.** Its edges come from `chain.db.horizons`, the
 *    95th-percentile move actually observed over this many hours across 364
 *    days. Not an ATR multiple, not a round number somebody liked.
 *  - **The probability is modelled, and labelled as such.** `pBetween` under
 *    Black–Scholes with the board's own ATM IV. It answers "given this IV, how
 *    often does it finish inside" — which is a different question from the
 *    measured band, and the two are kept apart on the screen rather than
 *    averaged into one number nobody can source.
 *  - **The targets are the measured percentiles**, not invented rungs. T1 is the
 *    typical move, T2 the 68th, T3 the 95th. Each carries its chance of being
 *    *touched* — the number that matters to somebody short, and always at least
 *    as large as the chance of finishing through.
 *
 * What is deliberately absent is a direction. `expiry-path.ts` documents why at
 * length: across 105,119 windows the share closing higher never leaves
 * 49.4–50.6%. So this predicts a *range*, and the up and down ladders are
 * symmetric by construction. A screen that drew one arrow here would be
 * inventing the only thing the data refuses to give.
 *
 * Pure: no clock, no I/O.
 */

export type Band = {
  low: number;
  high: number;
  /** How wide, in percent of spot. */
  widthPct: number;
  /** Modelled chance of settling inside, below and above. Null without an IV. */
  pInside: number | null;
  pBelow: number | null;
  pAbove: number | null;
};

export type Target = {
  label: 'T1' | 'T2' | 'T3';
  side: 'UP' | 'DOWN';
  price: number;
  /** Distance from spot, signed, in percent. */
  movePct: number;
  /** Modelled chance price touches it at any point before settlement. */
  pTouch: number | null;
  /** Which measured percentile this rung is. */
  from: 'typical' | '68%' | '95%';
};

export type ExpiryPrediction = {
  spot: number;
  hoursToExpiry: number;
  band: Band;
  targets: Target[];
  /** True when the band's edges came from measured windows rather than the model. */
  bandMeasured: boolean;
  note: string;
};

/**
 * Round a *distance* to the board's strike step.
 *
 * The distance, not the edge. Rounding both edges to the grid looked tidier and
 * quietly broke the one guarantee this file makes: with spot at 84,595 and a
 * 200-point grid, `round(spot − half)` and `round(spot + half)` land different
 * distances from spot, so the "range" acquired a lean the data does not support.
 * Rounding the half-width keeps the band symmetric about spot by construction.
 */
const stepUsd = (usd: number, step: number) => (step > 0 ? Math.round(usd / step) * step : Math.round(usd));

export function expiryPrediction(input: {
  spot: number;
  hoursToExpiry: number;
  atmIv: number | null;
  /** The measured band, from `expiryPath`. Without it nothing here can be measured. */
  path: ExpiryPath | null;
  /** The chain's strike step, so the headline lands on strikes that exist. */
  strikeStep?: number;
}): ExpiryPrediction | null {
  const { spot, hoursToExpiry, atmIv, path, strikeStep = 200 } = input;
  if (!(spot > 0) || !(hoursToExpiry > 0)) return null;

  const settle = path?.settlement ?? null;
  const years = hoursToExpiry / (24 * 365);

  /*
   * The band: the measured 68% move, not the 95%.
   *
   * 95% is the right band for "is this strike far enough away" — it is the one
   * `strikeSafety` uses. It is the wrong band for "where does it most probably
   * settle", because a range that contains nineteen days in twenty is so wide it
   * says nothing. 68% is the one a reader means by "most probable".
   */
  const half = settle?.p68Usd ?? (atmIv !== null ? spot * atmIv * Math.sqrt(years) : null);
  if (half === null || !(half > 0)) return null;

  const halfStepped = Math.max(strikeStep, stepUsd(half, strikeStep));
  const low = spot - halfStepped;
  const high = spot + halfStepped;

  const pInside = atmIv !== null ? pBetween(spot, low, high, years, atmIv) : null;
  // Below and above split what is left. They are not independently modelled:
  // deriving them keeps the three adding to one, which a reader will check.
  const outside = pInside === null ? null : Math.max(0, 1 - pInside);
  const pBelow = outside === null ? null : outside / 2;
  const pAbove = outside === null ? null : outside / 2;

  const rungs: { label: Target['label']; usd: number; from: Target['from'] }[] = settle
    ? [
      { label: 'T1', usd: settle.medianUsd, from: 'typical' },
      { label: 'T2', usd: settle.p68Usd, from: '68%' },
      { label: 'T3', usd: settle.p95Usd, from: '95%' },
    ]
    : [];

  const targets: Target[] = [];
  for (const side of ['UP', 'DOWN'] as const) {
    for (const r of rungs) {
      const away = Math.max(strikeStep, stepUsd(r.usd, strikeStep));
      const price = side === 'UP' ? spot + away : spot - away;
      targets.push({
        label: r.label,
        side,
        price,
        movePct: ((price - spot) / spot) * 100,
        pTouch: atmIv !== null ? pTouch(spot, price, years, atmIv) : null,
        from: r.from,
      });
    }
  }

  const note = settle
    ? `Range from ${path!.sampleWindows.toLocaleString('en-IN')} measured windows; the percentage is Black–Scholes at `
      + `${atmIv === null ? 'no IV' : `${(atmIv * 100).toFixed(1)}% IV`}. Measured and modelled are shown apart on purpose.`
    : 'No measured horizons: the band is the option market\'s own one-sigma move, and nothing here is measured.';

  return { spot, hoursToExpiry, band: { low, high, widthPct: ((high - low) / spot) * 100, pInside, pBelow, pAbove }, targets, bandMeasured: settle !== null, note };
}
