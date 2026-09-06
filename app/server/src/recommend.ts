import type { Snapshot } from './chain.js';
import type { ScoredLeg } from './score.js';
import { LOT_BTC, USDINR } from './score.js';
import type { MarketRead } from './market.js';

/**
 * What to sell, on which side, and how many lots.
 *
 * Two rules decide this, and both were measured on the 733 settled days in
 * chain.db rather than chosen because they sound right:
 *
 *   Strike — take the furthest strike that still pays the premium floor, and
 *   rank by how often strikes like it actually expired worthless, not by what
 *   Black-Scholes says.
 *
 *   Split — even, unless the 24-hour move and the daily trend point the same
 *   way, in which case 70% goes on the side that keeps paying if the move
 *   continues. Across the whole period that lifted the profit factor from 1.93
 *   to 2.38, cut the worst day from -$8.97 to -$7.08 and raised return per unit
 *   of drawdown from 7.0 to 9.5. It improved 2024, 2025 and 2026 separately,
 *   which is the only reason it is here rather than in a notebook.
 *
 * Two rules that were tested and rejected: leaning toward whichever side the
 * model calls safer (weaker than momentum, profit factor 2.10), and leaning
 * toward the riskier side (worse than doing nothing, 1.80 against 1.93).
 *
 * Everything else the desk shows is context. It is not allowed to change the
 * recommendation, because nothing else has been tested.
 */

export const SKEW_THRESHOLD_PCT = 2;
export const SKEW_WEIGHT = 0.7;

/**
 * Which way the next twelve hours are leaning, from the two inputs that were
 * measured. Returns 0 when they disagree, which is most days.
 */
export function directionalLean(market: MarketRead | null): {
  lean: -1 | 0 | 1;
  reason: string;
} {
  const r24 = market?.return24h ?? null;
  if (r24 === null) return { lean: 0, reason: 'no 24-hour return available' };

  const daily = market?.timeframes.find((t) => t.tf === '1d');
  const trendUp = daily?.ema9 != null && daily?.ema21 != null && daily.ema9 > daily.ema21;
  const trendDown = daily?.ema9 != null && daily?.ema21 != null && daily.ema9 < daily.ema21;

  const strong = Math.abs(r24) > SKEW_THRESHOLD_PCT;
  const up = r24 > SKEW_THRESHOLD_PCT || (r24 > 0 && trendUp);
  const down = r24 < -SKEW_THRESHOLD_PCT || (r24 < 0 && trendDown);

  if (up) {
    return {
      lean: 1,
      reason: strong
        ? `BTC is up ${r24.toFixed(1)}% in 24 hours, past the ${SKEW_THRESHOLD_PCT}% mark`
        : `BTC is up ${r24.toFixed(1)}% in 24 hours and the daily EMA stack is rising`,
    };
  }
  if (down) {
    return {
      lean: -1,
      reason: strong
        ? `BTC is down ${Math.abs(r24).toFixed(1)}% in 24 hours, past the ${SKEW_THRESHOLD_PCT}% mark`
        : `BTC is down ${Math.abs(r24).toFixed(1)}% in 24 hours and the daily EMA stack is falling`,
    };
  }
  return {
    lean: 0,
    reason: `BTC is ${r24 >= 0 ? 'up' : 'down'} ${Math.abs(r24).toFixed(1)}% in 24 hours, ` +
      'which the daily trend does not confirm',
  };
}

export type Side = 'CE' | 'PE';

export type Hedge = {
  strike: number;
  /** what you pay to buy it: the ask */
  price: number;
  gapStrikes: number;
  widthUsd: number;
};

export type SideRecommendation = {
  side: Side;
  leg: ScoredLeg;
  lots: number;
  /** the price you would actually receive: the bid */
  price: number;
  creditUsd: number;
  creditInr: number;
  /** how often strikes like this actually expired worthless, 0..1 */
  zeroChance: number | null;
  modelChance: number | null;
  sample: number | null;
  /** the model's own three answers, which are three different questions */
  pExpireWorthless: number | null;
  pTouch: number | null;
  pNearZero: number | null;
  hedge: Hedge | null;
  hedgeRequested: boolean;
  /** per lot, in dollars */
  maxProfit: number;
  maxLoss: number | null;
  breakeven: number;
  order: string;
  hedgeOrder: string | null;
};

export type Recommendation = {
  ok: boolean;
  why: string | null;
  /** true when a hedge was asked for and at least one side could not get one */
  hedgeMissing: boolean;
  sides: SideRecommendation[];
  split: { ce: number; pe: number };
  splitReason: string;
  totalCreditUsd: number;
  totalCreditInr: number;
  /** the chance BOTH legs expire worthless, if they were independent */
  bothZeroChance: number | null;
  marginUsd: number;
  totalMaxLossUsd: number | null;
  rewardToRisk: number | null;
};

/** Never let one side carry the whole book, however strong the signal looks. */
export const MIN_LOTS_PER_SIDE = 2;
export const MAX_LOTS_PER_SIDE = 8;

/**
 * Split `total` lots between two sides so they add up to exactly `total`.
 *
 * Rounding each side on its own does not: 7 lots at 30/70 rounds to 2 and 5,
 * and with the per-side floor applied it can round to 2 and 6, which is 8 lots
 * of margin for a 7 lot decision. Largest remainder gives the extra lot to
 * whichever side was closest to earning it, and the caps are applied by moving
 * a lot across rather than by inventing one.
 */
export function allocateLots(
  total: number,
  ceWeight: number,
  peWeight: number,
): { ce: number; pe: number } {
  const t = Math.max(0, Math.floor(total));
  if (t === 0) return { ce: 0, pe: 0 };
  if (t === 1) return ceWeight >= peWeight ? { ce: 1, pe: 0 } : { ce: 0, pe: 1 };

  const rawCe = (t * ceWeight) / (ceWeight + peWeight);
  let ce = Math.floor(rawCe);
  let pe = t - ce;
  // hand the remaining lot to the side with the larger fractional claim
  if (ce + pe < t) ce += t - (ce + pe);
  if (rawCe - ce > 0.5 && pe > 0) {
    ce += 1;
    pe -= 1;
  }

  // Caps, applied by transfer so the total never changes. With few lots the cap
  // may be unreachable; an even split is the honest fallback.
  const lo = Math.min(MIN_LOTS_PER_SIDE, Math.floor(t / 2));
  const hi = Math.max(MAX_LOTS_PER_SIDE, t - lo);
  const move = (from: 'ce' | 'pe', n: number) => {
    if (from === 'ce') { ce -= n; pe += n; } else { pe -= n; ce += n; }
  };
  if (ce < lo) move('pe', lo - ce);
  if (pe < lo) move('ce', lo - pe);
  if (ce > hi) move('ce', ce - hi);
  if (pe > hi) move('pe', pe - hi);

  return { ce, pe };
}

/**
 * The nearest listed strike further out than the short, at or inside the
 * requested gap. Walking inward rather than giving up means a missing strike
 * degrades the protection instead of silently removing it.
 *
 * `step` comes from the chain rather than a constant, so a gap of 3 means three
 * actual strikes even when Delta changes its spacing.
 */
function findHedge(
  scored: ScoredLeg[],
  side: Side,
  shortStrike: number,
  gap: number,
  step: number,
): Hedge | null {
  if (gap <= 0) return null;
  const cp = side === 'CE' ? 'C' : 'P';
  for (let g = gap; g > 0; g--) {
    const k = side === 'CE' ? shortStrike + g * step : shortStrike - g * step;
    const leg = scored.find((l) => l.cp === cp && l.strike === k);
    const cost = leg?.ask ?? leg?.mark ?? null;
    if (leg && cost !== null) {
      return { strike: k, price: cost, gapStrikes: g, widthUsd: Math.abs(k - shortStrike) };
    }
  }
  return null;
}

/** The furthest strike that still pays the floor, ranked by observed outcome. */
function bestLeg(scored: ScoredLeg[], side: Side, minPremium: number): ScoredLeg | null {
  const cp = side === 'CE' ? 'C' : 'P';
  const eligible = scored.filter(
    (l) =>
      l.cp === cp &&
      l.moneyness === 'OTM' &&
      l.sellPrice !== null &&
      l.sellPrice >= minPremium,
  );
  if (!eligible.length) return null;
  // highest observed zero-rate first; where the data cannot separate two
  // strikes, take the one further out, which is the cheaper mistake
  return eligible.reduce((a, b) => {
    const az = a.zero?.adjusted ?? a.probs.expireWorthless ?? 0;
    const bz = b.zero?.adjusted ?? b.probs.expireWorthless ?? 0;
    if (Math.abs(az - bz) > 0.0005) return bz > az ? b : a;
    return (b.emDistance ?? 0) > (a.emDistance ?? 0) ? b : a;
  });
}

export function recommend(
  snap: Snapshot,
  scored: ScoredLeg[],
  market: MarketRead | null,
  minPremium: number,
  totalLots: number,
  hedgeGap = 0,
): Recommendation {
  const { lean, reason } = directionalLean(market);
  // Kept as whole percentages and divided at the end: 1 - 0.7 is
  // 0.30000000000000004 in binary floating point, and that reached the screen.
  let ce = 0.5;
  let pe = 0.5;
  let splitReason =
    `Even, because ${reason}. Over 733 days the call leg lost on 8 days and the put leg ` +
    'on 9, and never both on the same day, so an even split halves the worst day.';

  if (lean !== 0) {
    const light = Math.round((1 - SKEW_WEIGHT) * 100) / 100;
    ce = lean > 0 ? light : SKEW_WEIGHT;
    pe = lean > 0 ? SKEW_WEIGHT : light;
    splitReason =
      `${reason}, so ${(SKEW_WEIGHT * 100).toFixed(0)}% goes on the ` +
      `${lean > 0 ? 'put' : 'call'} side — the one that keeps paying if the move continues. ` +
      'Tested over 733 days: profit factor 1.93 → 2.38, worst day −$8.97 → −$7.08, ' +
      'and better in 2024, 2025 and 2026 taken separately.';
  }

  const picks: SideRecommendation[] = [];
  let hedgeMissing = false;
  const allocation = allocateLots(totalLots, ce, pe);
  for (const [side, lots] of [['CE', allocation.ce], ['PE', allocation.pe]] as const) {
    if (lots <= 0) continue;
    const leg = bestLeg(scored, side, minPremium);
    if (!leg || leg.sellPrice === null) continue;

    const hedge = findHedge(scored, side, leg.strike, hedgeGap, snap.step);
    if (hedgeGap > 0 && hedge === null) hedgeMissing = true;

    const netPerBtc = leg.sellPrice - (hedge?.price ?? 0);
    const credit = netPerBtc * lots * LOT_BTC;
    const sym = side === 'CE' ? 'C' : 'P';

    picks.push({
      side,
      leg,
      lots,
      price: leg.sellPrice,
      creditUsd: credit,
      creditInr: credit * USDINR,
      zeroChance: leg.zero?.adjusted ?? null,
      modelChance: leg.pOtm,
      sample: leg.zero?.sample ?? null,
      pExpireWorthless: leg.probs.expireWorthless,
      pTouch: leg.probs.touch,
      pNearZero: leg.probs.nearZero,
      hedge,
      hedgeRequested: hedgeGap > 0,
      maxProfit: netPerBtc * lots * LOT_BTC,
      maxLoss: hedge ? (hedge.widthUsd - netPerBtc) * lots * LOT_BTC : null,
      breakeven: side === 'CE' ? leg.strike + netPerBtc : leg.strike - netPerBtc,
      order: `SELL ${lots} × ${sym}-BTC-${leg.strike}-${snap.expiry} @ ${leg.sellPrice.toFixed(2)}`,
      hedgeOrder: hedge
        ? `BUY  ${lots} × ${sym}-BTC-${hedge.strike}-${snap.expiry} @ ${hedge.price.toFixed(2)}`
        : null,
    });
  }

  if (picks.length < 2) {
    return {
      ok: false,
      hedgeMissing,
      why:
        picks.length === 0
          ? `Nothing out of the money is bid at $${minPremium} or more. The market is not paying enough for the risk today.`
          : `Only the ${picks[0]!.side} side is bid at $${minPremium} or more. One leg alone is a directional bet, not this strategy.`,
      sides: picks,
      split: { ce, pe },
      splitReason,
      totalCreditUsd: picks.reduce((a, p) => a + p.creditUsd, 0),
      totalCreditInr: picks.reduce((a, p) => a + p.creditInr, 0),
      bothZeroChance: null,
      marginUsd: totalLots * 0.5,
      totalMaxLossUsd: null,
      rewardToRisk: null,
    };
  }

  const zs = picks.map((p) => p.zeroChance).filter((z): z is number => z !== null);
  const anyUnbounded = picks.some((p) => p.maxLoss === null);
  const totalMaxLossUsd = anyUnbounded
    ? null
    : picks.reduce((a, p) => a + (p.maxLoss ?? 0), 0);
  const totalCredit = picks.reduce((a, p) => a + p.creditUsd, 0);
  return {
    ok: true,
    hedgeMissing,
    why: null,
    sides: picks,
    split: { ce, pe },
    splitReason,
    totalCreditUsd: picks.reduce((a, p) => a + p.creditUsd, 0),
    totalCreditInr: picks.reduce((a, p) => a + p.creditInr, 0),
    bothZeroChance: zs.length === 2 ? zs[0]! * zs[1]! : null,
    marginUsd: totalLots * 0.5,
    totalMaxLossUsd,
    rewardToRisk:
      totalMaxLossUsd && totalMaxLossUsd > 0 ? totalCredit / totalMaxLossUsd : null,
  };
}
