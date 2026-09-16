import type { EvLeg } from './ev.js';
import type { Snapshot } from '../market/chain.js';
import { LOT_BTC } from './score.js';

/**
 * One trade, for this expiry, with everything the decision needs beside it.
 *
 * The board ranks strikes five ways at once -- score, EV, the odds, the
 * distance, the book -- and leaves the last step to a person at half past five
 * in the morning. This does that step: it names one strike, shows the six
 * numbers it was chosen on, and says what would have to be true for a different
 * one to win.
 *
 * ## What it is not
 *
 * **It is not the tested engine.** `recommend.ts` splits the lots by a rule
 * with 733 days behind it, and where the two disagree that one is right. This
 * ranks on arithmetic that has never been through the cross-period screen --
 * the same caveat the sell score carries, said again because a card that names
 * one trade reads like an instruction whatever the small print says.
 *
 * **It sends nothing.** The pick is handed to the order ticket, which runs
 * every gate again.
 *
 * ## How the ranking works
 *
 * Eligibility first: a strike failing a hard rule never outranks one that
 * clears them, however well it scores. `ev.ts` decides that -- a `tier` of
 * `avoid` means a rule that matters is failing.
 *
 * On a morning when **nothing** clears, the board is ranked anyway and the card
 * says so. An empty card cannot tell you which strike came closest or what it
 * was failing, and those are the two things worth knowing on that morning.
 *
 * Then four parts, each 0..1, weighted. They are stated here rather than buried
 * because the only honest thing to say about the weights is that they are a
 * starting point:
 *
 *   credit against risk   0.35   what the trade is paid, against what it can lose
 *   settlement odds       0.30   the calibrated chance it expires worthless
 *   distance              0.20   how far the strike is, in expected moves
 *   liquidity             0.15   spread, turnover and how fresh the print is
 *
 * Touch does **not** vote. A touch is a drawdown, not a loss -- a day that
 * reaches the strike and comes back settles worthless like any other -- so it
 * is shown on the card and kept out of the ranking. Ranking on it would refuse
 * the strike that pays for exactly the risk a seller is in business to take.
 */

/** The weights, in one place, so they can be argued with and measured. */
export const BEST_TRADE_WEIGHTS = {
  creditRisk: 0.35,
  settlement: 0.30,
  distance: 0.20,
  liquidity: 0.15,
} as const;

/** A credit worth this much of the risk taken scores full marks. */
export const CREDIT_RISK_FULL = 0.5;
/** A strike this many expected moves away scores full marks on distance. */
export const DISTANCE_FULL = 2;

export type BestTradeLeg = {
  cp: 'C' | 'P';
  side: 'CE' | 'PE';
  strike: number;
  /** What a seller receives: the bid. */
  premiumUsd: number;
  /** Calibrated chance it expires worthless. */
  expiryOtm: number | null;
  /** Chance BTC reaches the strike at any point first. Shown, never ranked on. */
  touch: number | null;
  /** Chance the premium itself collapses to near nothing. */
  nearZero: number | null;
  /** Distance in expected moves. */
  emBuffer: number | null;
  delta: number | null;
  /** 0-100 from the book: spread, turnover, freshness. */
  liquidity: number;
  /** Credit for the lots asked for, after Delta's charges to open. */
  creditUsd: number;
  /** Worst case with the hedge this plan would buy. Null when nothing caps it. */
  maxLossUsd: number | null;
  /** `credit ÷ max loss`. Null without a hedge, because the denominator is not a number. */
  creditRisk: number | null;
  /** The hedge that caps it, when there is one. */
  hedge: { strike: number; askUsd: number; widthUsd: number } | null;
  /** 0-100, the ranking itself. */
  rank: number;
  /** Why this one, in the order the parts were weighed. */
  reasons: string[];
  /** Hard rules this strike is failing. Empty on an eligible one. */
  failing: string[];
};

export type BestTrade = {
  /** Null only when there is no board at all. */
  pick: BestTradeLeg | null;
  /** The next two, so "why not that one" is answerable without re-reading the board. */
  runnersUp: BestTradeLeg[];
  /** How many strikes were eligible at all. */
  eligible: number;
  /** Said out loud when there is no pick. */
  why: string | null;
  /** True when this is also what the tested engine picked. */
  agreesWithEngine: boolean;
  /**
   * True when nothing cleared the hard rules and the pick is the best of a bad
   * board. The card says so loudly; it is not a recommendation.
   */
  bestOfNone: boolean;
};

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

/**
 * How easily this strike could be got into and out of, 0-100.
 *
 * Four things, because any one of them alone is misleading: a tight spread on a
 * strike nobody has traded since yesterday is a quote, not a market.
 */
export function liquidityScore(leg: {
  bid: number | null;
  ask: number | null;
  oi: number | null;
  volume: number | null;
  ageMin: number | null;
}): number {
  const mid = leg.bid !== null && leg.ask !== null ? (leg.bid + leg.ask) / 2 : null;
  const spreadPct = mid !== null && mid > 0 && leg.ask !== null && leg.bid !== null
    ? (leg.ask - leg.bid) / mid
    : null;
  // A 2% spread is as good as it gets here; 20% is unusable.
  const spread = spreadPct === null ? 0.4 : clamp01((0.2 - spreadPct) / 0.18);
  // Turnover: a tenth of the open interest changing hands is a busy strike.
  const turnover = leg.oi !== null && leg.oi > 0 && leg.volume !== null
    ? clamp01(leg.volume / leg.oi / 0.1)
    : 0.3;
  // Depth: 50,000 contracts open is deep for a daily BTC option.
  const depth = leg.oi === null ? 0.3 : clamp01(leg.oi / 50_000);
  // Freshness: a print in the last five minutes is live, half an hour is stale.
  const fresh = leg.ageMin === null ? 0.3 : clamp01((30 - leg.ageMin) / 25);
  return Math.round((spread * 0.4 + turnover * 0.25 + depth * 0.2 + fresh * 0.15) * 100);
}

/** The ranking, 0-100, from the four parts. */
export function rankOf(p: {
  creditRisk: number | null;
  expiryOtm: number | null;
  emBuffer: number | null;
  liquidity: number;
}): number {
  const w = BEST_TRADE_WEIGHTS;
  // A trade with no hedge has no credit-to-risk number. It is not scored zero
  // on it -- that would rank every naked short below every spread on a board
  // where hedging is optional -- it simply does not carry that part, and the
  // rest is renormalised over what can be read.
  const parts: [number, number][] = [
    [w.settlement, p.expiryOtm === null ? NaN : clamp01((p.expiryOtm - 0.85) / 0.14)],
    [w.distance, p.emBuffer === null ? NaN : clamp01(p.emBuffer / DISTANCE_FULL)],
    [w.liquidity, clamp01(p.liquidity / 100)],
  ];
  if (p.creditRisk !== null) parts.unshift([w.creditRisk, clamp01(p.creditRisk / CREDIT_RISK_FULL)]);

  let sum = 0;
  let weight = 0;
  for (const [wt, v] of parts) {
    if (Number.isNaN(v)) continue;
    sum += wt * v;
    weight += wt;
  }
  return weight === 0 ? 0 : Math.round((sum / weight) * 100);
}

/**
 * The best trade on this board, and the two behind it.
 *
 * `hedgeFor` is asked for a hedge the same way `recommend.ts` buys one -- so
 * far away in listed strikes, not in dollars -- and returns null where there is
 * none. Without it the pick is a naked short and says so: no cap, no
 * credit-to-risk number.
 */
export function bestTrade(i: {
  legs: readonly EvLeg[];
  snap: Pick<Snapshot, 'spot' | 'expectedMove'>;
  lots: number;
  /** The strikes the tested engine picked, for the agreement flag. */
  enginePicks?: readonly { side: 'CE' | 'PE'; strike: number }[];
  hedgeFor?: (leg: EvLeg) => { strike: number; askUsd: number; widthUsd: number } | null;
}): BestTrade {
  const sellable = i.legs.filter((l) => (l.sellPrice ?? 0) > 0);
  const eligible = sellable.filter((l) => l.ev.tier !== 'avoid');
  /*
   * When nothing clears, rank what there is anyway -- and say so.
   *
   * The hard rules are strict on purpose: 3% out of the money, 95% calibrated,
   * delta under 0.05, a tenth of the open interest traded today, a spread
   * inside 10%, a print in the last half hour. On a quiet morning no strike
   * clears all six, and an empty card teaches nothing -- it cannot say which
   * strike came closest or what it was failing. So the board is ranked either
   * way, and a pick that failed something carries the failures with it.
   */
  const bestOfNone = eligible.length === 0 && sellable.length > 0;
  const pool = eligible.length > 0 ? eligible : sellable;

  const built = pool.map((leg): BestTradeLeg => {
    const premium = leg.sellPrice!;
    const creditUsd = premium * i.lots * LOT_BTC - (leg.ev.chargesUsd ?? 0);
    const hedge = i.hedgeFor?.(leg) ?? null;
    // Width less what is kept, times the size: the spread's own worst case.
    const maxLossUsd = hedge === null
      ? null
      : Math.max(0, hedge.widthUsd * i.lots * LOT_BTC - (creditUsd - hedge.askUsd * i.lots * LOT_BTC));
    const creditRisk = maxLossUsd === null || maxLossUsd <= 0 ? null : creditUsd / maxLossUsd;
    const liquidity = liquidityScore(leg);
    const expiryOtm = leg.zero?.adjusted ?? leg.pOtm;
    const rank = rankOf({ creditRisk, expiryOtm, emBuffer: leg.emBuffer ?? null, liquidity });

    const reasons: string[] = [];
    if (creditRisk !== null) reasons.push(`pays ${(creditRisk * 100).toFixed(0)}% of what it can lose`);
    if (expiryOtm !== null) reasons.push(`${(expiryOtm * 100).toFixed(1)}% to expire worthless`);
    if (leg.emBuffer != null) reasons.push(`${leg.emBuffer.toFixed(2)}× the expected move away`);
    reasons.push(`liquidity ${liquidity}/100`);

    return {
      failing: leg.ev.checks
        .filter((c) => c.severity === 'block' && !c.ok)
        .map((c) => c.text),
      cp: leg.cp,
      side: leg.cp === 'C' ? 'CE' : 'PE',
      strike: leg.strike,
      premiumUsd: premium,
      expiryOtm,
      touch: leg.probs?.touch ?? null,
      nearZero: leg.probs?.nearZero ?? null,
      emBuffer: leg.emBuffer ?? null,
      delta: leg.delta,
      liquidity,
      creditUsd,
      maxLossUsd,
      creditRisk,
      hedge,
      rank,
      reasons,
    };
  });

  built.sort((a, b) => b.rank - a.rank || (b.expiryOtm ?? 0) - (a.expiryOtm ?? 0));
  const pick = built[0] ?? null;
  const agrees = pick !== null && (i.enginePicks ?? []).some(
    (p) => p.side === pick.side && p.strike === pick.strike,
  );

  return {
    pick,
    runnersUp: built.slice(1, 3),
    eligible: eligible.length,
    why: pick === null
      ? 'Nothing on this board can be sold: no strike has a bid.'
      : bestOfNone
        ? 'No strike clears the hard rules today. This is the one that came closest — what it is failing is below.'
        : null,
    agreesWithEngine: agrees,
    bestOfNone,
  };
}
