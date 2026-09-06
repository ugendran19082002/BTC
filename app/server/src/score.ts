import type { Leg, Snapshot } from './chain.js';

/**
 * Ranking and sizing helpers.
 *
 * None of this predicts direction with certainty. `sellScore` ranks which
 * strike is the better one to sell *given* you have decided to sell; `bias`
 * reads what the option market is currently pricing. Both are descriptions of
 * the present chain, not forecasts.
 */

export const LOT_BTC = 0.001;
export const MARGIN_PER_LOT_USD = 0.5;
export const USDINR = 85;

export type ScoredLeg = Leg & {
  /** BS probability the option finishes worthless, i.e. the seller keeps it all */
  pOtm: number | null;
  /** price received divided by the model's fair value; >1 means you sold rich */
  edge: number | null;
  /** distance to the strike measured in expected moves */
  emDistance: number | null;
  score: number | null;
  reasons: string[];
};

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

export function scoreLegs(snap: Snapshot): ScoredLeg[] {
  const vols = snap.legs.map((l) => l.volume ?? 0).filter((v) => v > 0);
  const maxLogVol = vols.length ? Math.log1p(Math.max(...vols)) : 1;
  const ois = snap.legs.map((l) => l.oi ?? 0).filter((v) => v > 0);
  const maxLogOi = ois.length ? Math.log1p(Math.max(...ois)) : 1;

  return snap.legs.map((leg) => {
    const reasons: string[] = [];
    const px = leg.sellPrice;
    const pOtm = leg.delta === null ? null : clamp01(1 - Math.abs(leg.delta));
    const edge = px !== null && leg.mark ? px / leg.mark : null;
    const emDistance =
      snap.expectedMove && snap.expectedMove > 0
        ? Math.abs(leg.strike - snap.spot) / snap.expectedMove
        : null;

    if (px === null || pOtm === null) {
      return { ...leg, pOtm, edge, emDistance, score: null, reasons: ['no price'] };
    }

    // Safety dominates: for a seller the single biggest driver of the win rate
    // is how likely the strike is to stay out of the money.
    const safety = pOtm;
    // Selling above fair value is the only structural edge available; cap the
    // credit at 1.5x fair so one stale print cannot dominate the ranking.
    const edgeN = edge === null ? 0.5 : clamp01((edge - 0.7) / 0.8);
    const distN = emDistance === null ? 0.5 : clamp01(emDistance / 2);
    const liqN = clamp01(
      0.5 * (Math.log1p(leg.volume ?? 0) / maxLogVol) + 0.5 * (Math.log1p(leg.oi ?? 0) / maxLogOi),
    );

    let score = 0.4 * safety + 0.2 * edgeN + 0.2 * distN + 0.2 * liqN;

    // A price nobody has traded in an hour is not a price you can sell at.
    if (leg.ageMin !== null && leg.ageMin > 30) {
      score *= 0.6;
      reasons.push(`stale ${leg.ageMin}m`);
    }
    if (leg.moneyness === 'ITM') {
      score *= 0.3;
      reasons.push('in the money');
    }
    if (pOtm > 0.9) reasons.push(`${(pOtm * 100).toFixed(0)}% finish OTM`);
    if (edge !== null && edge > 1.05) reasons.push(`${((edge - 1) * 100).toFixed(0)}% above fair`);
    if (emDistance !== null && emDistance >= 1) reasons.push(`${emDistance.toFixed(2)} expected moves out`);

    return { ...leg, pOtm, edge, emDistance, score, reasons };
  });
}

export type SellPick = {
  side: 'CE' | 'PE';
  leg: ScoredLeg;
  hedge: ScoredLeg | null;
  /** true when no protective long could be placed, so the loss is unbounded */
  naked: boolean;
  /** strikes between the short and the long that was actually available */
  hedgeGapUsed: number | null;
  /** credit per lot in USD, after buying the hedge */
  netCreditUsd: number;
  /** worst case per lot in USD; null when the short is naked (unbounded) */
  maxLossUsd: number | null;
  breakeven: number;
};

/**
 * Choose one strike per side to sell, subject to a minimum premium, and pair it
 * with a further-out long so the loss is bounded.
 *
 * @param minPremium premium floor in USD per BTC (the quoted unit)
 * @param hedgeGap how many strikes beyond the short to buy; 0 leaves it naked
 */
export function pickSells(
  snap: Snapshot,
  scored: ScoredLeg[],
  minPremium = 15,
  hedgeGap = 3,
): SellPick[] {
  const out: SellPick[] = [];
  for (const [side, cp] of [
    ['CE', 'C'],
    ['PE', 'P'],
  ] as const) {
    const candidates = scored
      .filter((l) => l.cp === cp && l.moneyness === 'OTM' && l.sellPrice !== null)
      .filter((l) => l.sellPrice! >= minPremium && l.score !== null);
    if (!candidates.length) continue;
    const best = candidates.reduce((a, b) => (b.score! > a.score! ? b : a));

    // Walk outward from the requested gap and take the first strike that is
    // actually listed and priced, so a missing strike degrades the protection
    // rather than silently dropping it.
    let hedge: ScoredLeg | null = null;
    let hedgeCost: number | null = null;
    let hedgeGapUsed: number | null = null;
    for (let g = hedgeGap; g > 0 && hedge === null; g--) {
      const hk = cp === 'C' ? best.strike + g * 200 : best.strike - g * 200;
      const cand = scored.find((l) => l.cp === cp && l.strike === hk) ?? null;
      const cost = cand?.ask ?? cand?.mark ?? cand?.ltp ?? null;
      if (cand && cost !== null) {
        hedge = cand;
        hedgeCost = cost;
        hedgeGapUsed = g;
      }
    }

    const credit = best.sellPrice! - (hedgeCost ?? 0);
    const naked = hedge === null;
    out.push({
      side,
      leg: best,
      hedge,
      naked,
      hedgeGapUsed,
      netCreditUsd: credit * LOT_BTC,
      maxLossUsd: naked ? null : (Math.abs(hedge!.strike - best.strike) - credit) * LOT_BTC,
      breakeven: cp === 'C' ? best.strike + credit : best.strike - credit,
    });
  }
  return out;
}

export type Bias = {
  /** -1 fully bearish .. +1 fully bullish */
  score: number;
  label: string;
  pcr: number | null;
  ivSkew: number | null;
  components: { name: string; value: number; weight: number; note: string }[];
};

/**
 * What the option market is currently pricing, read from three independent
 * structural signals. This is a description of positioning, not a forecast --
 * over a 12-hour horizon its edge is small and it should never be the only
 * input to a trade.
 */
export function bias(snap: Snapshot, scored: ScoredLeg[]): Bias {
  const ce = scored.filter((l) => l.cp === 'C');
  const pe = scored.filter((l) => l.cp === 'P');
  const sum = (xs: ScoredLeg[], f: (l: ScoredLeg) => number) => xs.reduce((a, l) => a + f(l), 0);

  const ceOi = sum(ce, (l) => l.oi ?? 0);
  const peOi = sum(pe, (l) => l.oi ?? 0);
  const pcr = ceOi > 0 ? peOi / ceOi : null;

  const ceVol = sum(ce, (l) => l.volume ?? 0);
  const peVol = sum(pe, (l) => l.volume ?? 0);

  // 25-delta risk reversal: puts priced above calls is the market paying up for
  // downside protection.
  const near = (target: number, xs: ScoredLeg[]) => {
    const withIv = xs.filter((l) => l.iv !== null && l.delta !== null);
    if (!withIv.length) return null;
    return withIv.reduce((a, b) =>
      Math.abs(Math.abs(b.delta!) - target) < Math.abs(Math.abs(a.delta!) - target) ? b : a,
    );
  };
  const c25 = near(0.25, ce);
  const p25 = near(0.25, pe);
  const ivSkew = c25?.iv != null && p25?.iv != null ? p25.iv - c25.iv : null;

  const components: Bias['components'] = [];
  // A high put/call OI ratio is crowded downside positioning -> mildly bullish.
  if (pcr !== null) {
    const v = Math.max(-1, Math.min(1, (pcr - 1) / 1.5));
    components.push({ name: 'Put/Call OI', value: v, weight: 0.3, note: `PCR ${pcr.toFixed(2)}` });
  }
  if (ivSkew !== null) {
    const v = Math.max(-1, Math.min(1, -ivSkew / 0.1));
    components.push({
      name: 'IV skew (25d)',
      value: v,
      weight: 0.4,
      note: `put IV ${(ivSkew * 100).toFixed(1)}pt ${ivSkew >= 0 ? 'over' : 'under'} call`,
    });
  }
  if (ceVol + peVol > 0) {
    const v = (ceVol - peVol) / (ceVol + peVol);
    components.push({ name: 'Volume tilt', value: v, weight: 0.3, note: `CE ${Math.round(ceVol)} / PE ${Math.round(peVol)}` });
  }

  const wsum = components.reduce((a, c) => a + c.weight, 0) || 1;
  const score = components.reduce((a, c) => a + c.value * c.weight, 0) / wsum;
  const label =
    score > 0.4 ? 'bullish' : score > 0.15 ? 'mildly bullish'
    : score < -0.4 ? 'bearish' : score < -0.15 ? 'mildly bearish' : 'no clear tilt';

  return { score, label, pcr, ivSkew, components };
}

/** test.md sizing model: lots are capped by margin, not by conviction. */
export function maxLots(availableUsd: number): number {
  return Math.floor(availableUsd / MARGIN_PER_LOT_USD);
}
