import type { MarketRead, TimeframeRead } from '../market/moves.js';
import type { Snapshot } from '../market/chain.js';
import { loadHorizons, type HorizonRow } from './forecast.js';
import { momentumScore, stackScore, vwapScore } from './direction.js';

/**
 * Where BTC could be at each horizon, and how much of that is knowable.
 *
 * ## The three questions, kept apart
 *
 * This file answers exactly one of them:
 *
 *   **Prediction**      where BTC may move        — here
 *   **Options risk**    touch / expiry / near-zero — `probability.ts`
 *   **Eligibility**     will the desk take it      — `precheck.ts`, `best-trade.ts`
 *
 * Mixing them into one number is how "the market looks bullish" becomes "sell
 * this put", and the two statements have different evidence behind them.
 *
 * ## How far — knowable
 *
 * Two answers per horizon, and showing both is the point:
 *
 *   implied   EM = S × IV × √(t / 365d)  — what the option market charges
 *   measured  the 68th and 95th percentile of what BTC actually did over
 *             105,119 windows spanning a year (`forecast.ts`)
 *
 * When the implied band is wider than the measured one, the market is paying
 * more than the move it usually gets — which is the seller's whole business,
 * stated per horizon instead of felt.
 *
 * ## Which way — mostly not knowable, and the card says so
 *
 * The desk measured it: the chance BTC finishes higher is 49.4% at five minutes
 * and 50.6% at twelve hours, and **never leaves 48–52%** at any horizon. So
 * there is no "DOWN 52%" here, because that number would be invented.
 *
 * What is real is a **score**: where this timeframe's own EMAs, RSI, VWAP and
 * swing structure are pointing, −1…+1. That is a reading of the tape, not a
 * probability, and it is labelled as one. It exists for the same reason the
 * measured 50% is printed beside it: a page that shows only a range invites
 * somebody to add a forecast later on a hunch.
 *
 * Only horizons the desk actually fetches bars for can be scored — 5m, 15m, 1h,
 * 4h, 1d. The rest carry the bands and say plainly that there is no reading.
 */

/** The horizons, and the weight each gets in the consensus. */
export const OUTLOOK_HORIZONS = [
  { label: '5m', minutes: 5, weight: 0.05, tf: '5m' },
  { label: '15m', minutes: 15, weight: 0.10, tf: '15m' },
  { label: '30m', minutes: 30, weight: 0.10, tf: null },
  { label: '1h', minutes: 60, weight: 0.15, tf: '1h' },
  { label: '2h', minutes: 120, weight: 0.10, tf: null },
  { label: '4h', minutes: 240, weight: 0.15, tf: '4h' },
  { label: '6h', minutes: 360, weight: 0.10, tf: null },
  { label: '12h', minutes: 720, weight: 0.15, tf: null },
  { label: '24h', minutes: 1440, weight: 0.10, tf: '1d' },
] as const;

/** Past this a timeframe is called bullish or bearish rather than flat. */
export const LEAN_AT = 0.3;

const YEAR_MINUTES = 365 * 24 * 60;

export type OutlookRow = {
  label: string;
  minutes: number;
  /** Where it is now. There is no drift term: the measured drift is nil. */
  spot: number;
  /** S × IV × √(t/365d) — the option market's price of this horizon. */
  impliedUsd: number | null;
  /** spot ∓ implied. */
  low: number | null;
  high: number | null;
  /** The measured 68% and 95% moves over this horizon, as a share of spot. */
  measured68Pct: number | null;
  measured95Pct: number | null;
  /** Measured band in dollars, for the same horizon. */
  measuredLow: number | null;
  measuredHigh: number | null;
  /**
   * Against the implied band, from the measured distribution: how often BTC
   * finished below it, inside it, above it. `inside` above 68% means the market
   * is pricing more move than it usually gets.
   */
  below: number | null;
  inside: number | null;
  above: number | null;
  /** Measured share of windows that closed higher. Always near a half. */
  pUp: number | null;
  /**
   * The implied band over the measured one: what the market charges for this
   * horizon, against what the horizon usually delivers.
   *
   * **The one figure on the card that actually varies.** Below/inside/above
   * barely move across the row -- both bands scale with √t, so their ratio is
   * near-constant by construction, and nine cards reading "16 / 69 / 15" say
   * nothing. This does move: measured on 16 September it was 1.00 out to two
   * hours and 0.88 at twelve, which is the market charging *less* than history
   * delivers at the long end. For a seller that is the whole question.
   */
  richness: number | null;
  /** `rich` over 1.05, `cheap` under 0.95, `fair` between. */
  priced: 'rich' | 'fair' | 'cheap' | null;
  /** This timeframe's own reading, −1…+1. Null where the desk has no bars for it. */
  score: number | null;
  lean: 'bullish' | 'bearish' | 'flat' | null;
  /** Why the score is what it is, in words. */
  why: string;
  /** True for the row that matches what is left on this contract. */
  isExpiry: boolean;
};

export type Outlook = {
  rows: OutlookRow[];
  /** Σ weight × score over the horizons that could be read, renormalised. */
  consensus: number | null;
  /** How the readable horizons split. */
  bullish: number;
  bearish: number;
  flat: number;
  scored: number;
  /** "5 of 7 bullish", or what there is. */
  agreement: string;
  /** How far the measured direction ever gets from a coin flip, in points. */
  directionEdgePts: number | null;
  sampleWindows: number | null;
};

const clamp = (v: number, lo = -1, hi = 1) => Math.max(lo, Math.min(hi, v));

/**
 * Where a return of `pct` sits in the measured distribution, 0..1.
 *
 * The table carries 101 percentiles of the signed return; this walks them and
 * interpolates, which is the whole of it. Returns the share of windows that
 * finished at or below that return.
 */
export function quantileShare(quantiles: readonly number[], pct: number): number | null {
  if (quantiles.length < 2) return null;
  if (pct <= quantiles[0]!) return 0;
  if (pct >= quantiles[quantiles.length - 1]!) return 1;
  for (let i = 1; i < quantiles.length; i++) {
    const lo = quantiles[i - 1]!;
    const hi = quantiles[i]!;
    if (pct <= hi) {
      const step = 1 / (quantiles.length - 1);
      const within = hi === lo ? 0 : (pct - lo) / (hi - lo);
      return (i - 1) * step + within * step;
    }
  }
  return 1;
}

/** The measured row for a horizon, stretched by √t when the table has no exact one. */
export function rowAt(rows: readonly HorizonRow[], minutes: number): HorizonRow | null {
  if (!rows.length) return null;
  const exact = rows.find((r) => Math.abs(r.minutes - minutes) < 1);
  if (exact) return exact;
  const nearest = rows.reduce((a, b) =>
    Math.abs(b.minutes - minutes) < Math.abs(a.minutes - minutes) ? b : a,
  );
  const k = Math.sqrt(minutes / nearest.minutes);
  return {
    ...nearest,
    minutes,
    moveMedian: nearest.moveMedian * k,
    moveP68: nearest.moveP68 * k,
    moveP95: nearest.moveP95 * k,
    moveWorst: nearest.moveWorst * k,
    rangeMedian: nearest.rangeMedian * k,
    rangeP68: nearest.rangeP68 * k,
    rangeP95: nearest.rangeP95 * k,
    quantiles: nearest.quantiles.map((q) => q * k),
  };
}

/**
 * One timeframe's own reading, from the indicators that timeframe carries.
 *
 * The same parts as the whole-board direction score and in the same proportions
 * -- trend, momentum, structure, VWAP -- so a 1h card and the 1h input of the
 * side verdict cannot disagree about the 1h.
 */
export function timeframeScore(t: TimeframeRead | undefined): { score: number | null; why: string } {
  if (!t) return { score: null, why: 'no bars at this timeframe' };
  const parts: [number, number][] = [];
  const stack = stackScore(t);
  if (stack !== null) parts.push([0.5, stack]);
  const mom = momentumScore(t, undefined);
  if (mom !== null) parts.push([0.2, mom]);
  parts.push([0.2, t.structure]);
  const vwap = vwapScore(t);
  if (vwap !== null) parts.push([0.1, vwap]);

  const weight = parts.reduce((a, [w]) => a + w, 0);
  if (weight === 0) return { score: null, why: 'nothing to read at this timeframe' };
  const score = clamp(parts.reduce((a, [w, v]) => a + w * v, 0) / weight);

  const words = [
    stack === null ? null : stack > 0 ? 'EMAs rising' : stack < 0 ? 'EMAs falling' : 'EMAs crossed',
    t.rsi14 === null ? null : `RSI ${t.rsi14.toFixed(0)}`,
    t.structure === 1 ? 'higher highs' : t.structure === -1 ? 'lower lows' : null,
    t.adx14 === null ? null : `ADX ${t.adx14.toFixed(0)}`,
  ].filter((x): x is string => x !== null);
  return { score, why: words.join(', ') || 'nothing decisive' };
}

export function outlook(i: {
  snap: Pick<Snapshot, 'spot' | 'atmIv' | 'hoursToExpiry'>;
  market: MarketRead | null;
  /** Injectable so the whole thing can be tested without a database. */
  horizons?: readonly HorizonRow[];
}): Outlook {
  const rows = i.horizons ?? loadHorizons();
  const spot = i.snap.spot;
  const iv = i.snap.atmIv;
  const tfOf = (tf: string | null) => (tf === null ? undefined : i.market?.timeframes.find((t) => t.tf === tf));

  const build = (label: string, minutes: number, tf: string | null, isExpiry: boolean): OutlookRow => {
    const implied = iv === null ? null : spot * iv * Math.sqrt(minutes / YEAR_MINUTES);
    const m = rowAt(rows, minutes);
    const impliedPct = implied === null ? null : (implied / spot) * 100;

    // Where the implied band's two edges sit in the measured distribution.
    const below = m && impliedPct !== null ? quantileShare(m.quantiles, -impliedPct) : null;
    const aboveShare = m && impliedPct !== null ? quantileShare(m.quantiles, impliedPct) : null;
    const above = aboveShare === null ? null : 1 - aboveShare;
    const inside = below === null || above === null ? null : Math.max(0, 1 - below - above);

    const { score, why } = tf === null
      ? { score: null, why: 'no bars at this horizon — the band is measured, the direction is not read' }
      : timeframeScore(tfOf(tf));

    const richness = implied === null || m === null || !(m.moveP68 > 0)
      ? null
      : impliedPct! / m.moveP68;

    return {
      label,
      minutes,
      spot,
      richness,
      priced: richness === null ? null : richness > 1.05 ? 'rich' : richness < 0.95 ? 'cheap' : 'fair',
      impliedUsd: implied,
      low: implied === null ? null : spot - implied,
      high: implied === null ? null : spot + implied,
      measured68Pct: m?.moveP68 ?? null,
      measured95Pct: m?.moveP95 ?? null,
      measuredLow: m ? spot * (1 - m.moveP68 / 100) : null,
      measuredHigh: m ? spot * (1 + m.moveP68 / 100) : null,
      below,
      inside,
      above,
      pUp: m?.pUp ?? null,
      score,
      lean: score === null ? null : score >= LEAN_AT ? 'bullish' : score <= -LEAN_AT ? 'bearish' : 'flat',
      why,
      isExpiry,
    };
  };

  const out = OUTLOOK_HORIZONS.map((h) => build(h.label, h.minutes, h.tf, false));

  // And the horizon that actually matters: what is left on this contract.
  const leftMin = Math.round(i.snap.hoursToExpiry * 60);
  if (leftMin > 0) {
    out.push(build(`to settlement · ${i.snap.hoursToExpiry.toFixed(1)}h`, leftMin, null, true));
  }

  // The consensus, over the horizons that could be read at all.
  let sum = 0;
  let weight = 0;
  for (const h of OUTLOOK_HORIZONS) {
    const row = out.find((r) => r.label === h.label);
    if (!row || row.score === null) continue;
    sum += h.weight * row.score;
    weight += h.weight;
  }
  const scoredRows = out.filter((r) => !r.isExpiry && r.score !== null);
  const bullish = scoredRows.filter((r) => r.lean === 'bullish').length;
  const bearish = scoredRows.filter((r) => r.lean === 'bearish').length;
  const flat = scoredRows.filter((r) => r.lean === 'flat').length;

  const edge = rows.length ? Math.max(...rows.map((r) => Math.abs(r.pUp - 0.5))) * 100 : null;

  return {
    rows: out,
    consensus: weight === 0 ? null : clamp(sum / weight),
    bullish,
    bearish,
    flat,
    scored: scoredRows.length,
    agreement: scoredRows.length === 0
      ? 'no timeframe could be read'
      : `${Math.max(bullish, bearish)} of ${scoredRows.length} ${bullish >= bearish ? 'bullish' : 'bearish'}`
        + (flat ? `, ${flat} flat` : ''),
    directionEdgePts: edge,
    sampleWindows: rows[0]?.windows ?? null,
  };
}
