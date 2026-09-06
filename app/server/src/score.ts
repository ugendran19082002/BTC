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

/**
 * The one thing the desk exists to answer: enter now, or not?
 *
 * The rules are the ones the backtest actually measured, not a feel. Anything
 * that was not measured is a warning, never a blocker.
 */
export type Check = { ok: boolean; severity: 'block' | 'warn' | 'info'; text: string };
export type Verdict = {
  action: 'ENTER' | 'WAIT' | 'STAND_ASIDE';
  headline: string;
  detail: string;
  checks: Check[];
  orders: string[];
  nextWindow: string | null;
};

/** 05:30 IST is 00:00 UTC. The backtest enters there and nowhere else. */
const ENTRY_UTC_HOUR = 0;
const WINDOW_MINUTES = 30;

function istParts(ts: number) {
  const d = new Date((ts + 5.5 * 3600) * 1000);
  return {
    hh: d.getUTCHours(),
    mm: d.getUTCMinutes(),
    weekday: d.getUTCDay(), // 0 Sun .. 6 Sat, in IST
    label: `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')} IST`,
  };
}

const DAY = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export function verdict(
  snap: { ts: number; live: boolean; hoursToExpiry: number; expiry: string; spot: number; isDaily: boolean },
  picks: SellPick[],
  minPremium: number,
  lots: number,
): Verdict {
  const ist = istParts(snap.ts);
  const checks: Check[] = [];

  // 1. The entry window. Everything measured assumes roughly 12 hours of decay
  //    ahead; entering late is a different trade with different odds.
  const minutesFromOpen = (ist.hh - ENTRY_UTC_HOUR - 5) * 60 + (ist.mm - 30);
  const inWindow = minutesFromOpen >= 0 && minutesFromOpen <= WINDOW_MINUTES;
  checks.push({
    ok: inWindow,
    severity: 'block',
    text: inWindow
      ? `In the entry window — ${ist.label}, ${snap.hoursToExpiry.toFixed(1)}h to settlement`
      : `Outside the entry window. It is ${ist.label}; entry is 05:30–06:00 IST. ` +
        `Only ${snap.hoursToExpiry.toFixed(1)}h of decay is left, not the ~12h every number here was measured over.`,
  });

  // 1b. Which contract. Everything measured is the same-day daily.
  if (!snap.isDaily) {
    checks.push({
      ok: false,
      severity: 'block',
      text:
        `Expiry ${snap.expiry} is ${(snap.hoursToExpiry / 24).toFixed(1)} days out, not today. ` +
        'Nothing in the backtest applies to it -- those numbers are all same-day, ~12 hour trades. ' +
        'You can look at this chain, but the desk cannot tell you whether to trade it.',
    });
  }

  // 2. Day of week. The largest effect in two years of data, and the only one
  //    that is about when rather than what.
  const weekend = ist.weekday === 0 || ist.weekday === 6;
  checks.push({
    ok: !weekend,
    severity: 'warn',
    text: weekend
      ? `${DAY[ist.weekday]} — the weekend holds all six of the largest losses in two years ` +
        `(worst weekday loss $0.95, worst weekend loss $8.48). Size down or stand aside.`
      : `${DAY[ist.weekday]} — a weekday. 3 losing days in 461, worst $0.95.`,
  });

  // 3. Is there anything worth selling?
  const haveBoth = picks.length === 2;
  checks.push({
    ok: haveBoth,
    severity: 'block',
    text: haveBoth
      ? `Both legs available at $${minPremium} or better`
      : picks.length === 1
        ? `Only the ${picks[0]!.side} leg is quoted at $${minPremium} or more. A one-sided short is a directional bet, not this strategy.`
        : `No out-of-the-money strike is quoted at $${minPremium} or more. The market is paying too little for the risk.`,
  });

  // 4. Protection, when it exists.
  if (picks.length) {
    const naked = picks.filter((p) => p.naked);
    checks.push({
      ok: naked.length === 0,
      severity: 'warn',
      text: naked.length
        ? `${naked.map((p) => p.side).join(' and ')} could not be hedged — no strike listed at that distance. ` +
          `The loss on that leg is bounded only by how far BTC travels.`
        : `Both legs hedged. Worst case is known before you enter.`,
    });
  }

  const blocked = checks.some((c) => c.severity === 'block' && !c.ok);
  const warned = checks.some((c) => c.severity === 'warn' && !c.ok);

  const orders = picks.map((p) => {
    const hedge = p.hedge
      ? `  +  BUY ${lots} × ${p.side === 'CE' ? 'C' : 'P'}-BTC-${p.hedge.strike}-${snap.expiry}`
      : '  (no hedge available)';
    return `SELL ${lots} × ${p.side === 'CE' ? 'C' : 'P'}-BTC-${p.leg.strike}-${snap.expiry} @ ${p.leg.sellPrice?.toFixed(2)}${hedge}`;
  });

  // The next 05:30 IST, expressed in the reader's terms.
  const next = new Date(((Math.floor(snap.ts / 86400) + (minutesFromOpen > WINDOW_MINUTES ? 1 : 0)) * 86400) * 1000);
  const nextDay = DAY[next.getUTCDay()]!;

  if (blocked) {
    const why = checks.find((c) => c.severity === 'block' && !c.ok)!;
    return {
      action: inWindow ? 'STAND_ASIDE' : 'WAIT',
      headline: inWindow ? 'Stand aside' : 'Not now',
      detail: why.text,
      checks,
      orders: [],
      nextWindow: inWindow ? null : `next window 05:30 IST, ${nextDay}`,
    };
  }

  return {
    action: 'ENTER',
    headline: warned ? 'Enter, with a caveat' : 'Enter',
    detail: warned
      ? 'Every blocking condition is clear, but read the warning before you size this.'
      : 'Every condition the backtest measured is satisfied.',
    checks,
    orders,
    nextWindow: null,
  };
}
