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
 *   Split — even, unless BTC has moved more than 2% in the last 24 hours, in
 *   which case 70% goes on the side that continues the move. Across the whole
 *   period that lifted the profit factor from 1.92 to 2.27 and cut the worst
 *   day from -$8.97 to -$7.30, and it improved 2024, 2025 and 2026 separately.
 *
 * Everything else the desk shows is context. It is not allowed to change the
 * recommendation, because nothing else has been tested.
 */

export const SKEW_THRESHOLD_PCT = 2;
export const SKEW_WEIGHT = 0.7;

export type Side = 'CE' | 'PE';

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
  order: string;
};

export type Recommendation = {
  ok: boolean;
  why: string | null;
  sides: SideRecommendation[];
  split: { ce: number; pe: number };
  splitReason: string;
  totalCreditUsd: number;
  totalCreditInr: number;
  /** the chance BOTH legs expire worthless, if they were independent */
  bothZeroChance: number | null;
  marginUsd: number;
};

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
    const az = a.zero?.historical ?? a.pOtm ?? 0;
    const bz = b.zero?.historical ?? b.pOtm ?? 0;
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
): Recommendation {
  const r24 = market?.return24h ?? null;
  let ce = 0.5;
  let pe = 0.5;
  let splitReason =
    'Even. Over 733 days the call leg lost on 8 and the put leg on 9, and never both ' +
    'on the same day, so splitting halves the worst day.';

  if (r24 !== null && Math.abs(r24) > SKEW_THRESHOLD_PCT) {
    if (r24 > 0) {
      ce = 1 - SKEW_WEIGHT;
      pe = SKEW_WEIGHT;
    } else {
      ce = SKEW_WEIGHT;
      pe = 1 - SKEW_WEIGHT;
    }
    splitReason =
      `BTC is ${r24 > 0 ? 'up' : 'down'} ${Math.abs(r24).toFixed(1)}% over 24 hours, past the ` +
      `${SKEW_THRESHOLD_PCT}% mark, so ${(SKEW_WEIGHT * 100).toFixed(0)}% goes on the ` +
      `${r24 > 0 ? 'put' : 'call'} side — the one that keeps paying if the move continues. ` +
      'Tested: profit factor 1.92 → 2.27, worst day −$8.97 → −$7.30, and better in each year separately.';
  }

  const picks: SideRecommendation[] = [];
  for (const [side, weight] of [['CE', ce], ['PE', pe]] as const) {
    const leg = bestLeg(scored, side, minPremium);
    if (!leg || leg.sellPrice === null) continue;
    const lots = Math.max(1, Math.round(totalLots * weight));
    const credit = leg.sellPrice * lots * LOT_BTC;
    picks.push({
      side,
      leg,
      lots,
      price: leg.sellPrice,
      creditUsd: credit,
      creditInr: credit * USDINR,
      zeroChance: leg.zero?.historical ?? null,
      modelChance: leg.pOtm,
      sample: leg.zero?.sample ?? null,
      order: `SELL ${lots} × ${side === 'CE' ? 'C' : 'P'}-BTC-${leg.strike}-${snap.expiry} @ ${leg.sellPrice.toFixed(2)}`,
    });
  }

  if (picks.length < 2) {
    return {
      ok: false,
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
    };
  }

  const zs = picks.map((p) => p.zeroChance).filter((z): z is number => z !== null);
  return {
    ok: true,
    why: null,
    sides: picks,
    split: { ce, pe },
    splitReason,
    totalCreditUsd: picks.reduce((a, p) => a + p.creditUsd, 0),
    totalCreditInr: picks.reduce((a, p) => a + p.creditInr, 0),
    bothZeroChance: zs.length === 2 ? zs[0]! * zs[1]! : null,
    marginUsd: totalLots * 0.5,
  };
}
