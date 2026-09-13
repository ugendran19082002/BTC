import type { ScoredLeg } from './score.js';
import { LOT_BTC } from './score.js';
import { fillChargesUsd } from '../trading/charges.js';
import { fundsRequiredPerContract } from '../trading/margin.js';

/**
 * The leverage the desk sells at -- the order ticket's default, and what the
 * margin model was pinned to against a real Delta ticket.
 *
 * Declared here rather than imported from `recommend.ts`, which imports this
 * file: the two would be a cycle.
 */
const DESK_LEVERAGE = 200;
import type { Check } from './score.js';

/**
 * What one short leg is worth on average, and whether it clears the eligibility
 * rules -- per strike, for the whole board.
 *
 * The recommendation already answers "what should I sell" from rules that were
 * measured across 2024, 2025 and 2026 separately. This file answers a different
 * and weaker question: "what does the arithmetic say about *this* strike". It is
 * description, like `structure.ts`, and nothing here is allowed to change the
 * recommendation -- see the note on `signal` below.
 *
 * ## One expected-payout model, not two
 *
 * The payout model lives here and `recommend.ts` calls it. That direction
 * matters: a second EV model computed independently for the board would sooner
 * or later disagree with the card above it about the same strike, and a screen
 * that shows two different expected values for one option is worse than a screen
 * that shows none. `ev.test.ts` pins the two together.
 */

/**
 * The average payout of a short option at settlement, in USD per BTC.
 *
 * The model's own expected payout is simply the option's price -- that is what a
 * fair price means -- so pricing against the model says every trade is worth
 * minus the slippage, which is true and useless. The edge lives in the gap
 * between how often the model expects a breach and how often one happened, so
 * the payout is scaled by exactly that ratio.
 *
 * Two wrong versions preceded this one. Treating a breach as always costing the
 * maximum made every hedged spread look negative. Averaging the payoff over the
 * measured distribution of 12-hour moves was worse: that distribution is
 * unconditional, and applying it to a strike chosen for a calm day's volatility
 * overstated the payout threefold. Checked against 1,466 real legs, this version
 * puts the average payout at $15.44 against an actual $14.33.
 *
 * @param model the maths alone -- N(d2), the chance it finishes worthless
 * @param real what really happened to strikes like it; falls back to `model`
 */
export function expectedPayoutPerBtc(i: {
  mark: number | null;
  model: number | null;
  real: number | null;
}): number | null {
  const real = i.real ?? i.model;
  if (i.mark === null || i.model === null || real === null || i.model >= 1) return null;
  return i.mark * ((1 - real) / (1 - i.model));
}

/** The eligibility bars, in the units they are read in. */
export const EV_RULES = {
  /** How far out of the money, as a share of spot. */
  minOtmPct: 3,
  /** Chance it expires worthless, corrected by what really happened. */
  minZero: 0.95,
  /** How much the premium moves per dollar of BTC. */
  maxAbsDelta: 0.05,
  /** Traded today against open interest. */
  minVolumeToOi: 0.1,
  /** Widest spread worth crossing, as a share of the mid. */
  maxSpreadPct: 0.1,
  /** A last trade older than this is not a price you can sell at. */
  maxAgeMin: 30,
} as const;

/**
 * How the 0-100 sell score is weighted.
 *
 * One place, and exported, because the only honest thing to say about these
 * numbers is that they are a starting point. Nothing here has been through the
 * cross-period screen that the premium floor and the RSI gate went through, so
 * the score ranks strikes against each other on one board -- it does not say a
 * board is worth trading.
 */
export const SCORE_WEIGHTS = {
  /** How far out of the money. The single biggest driver of a seller's win rate. */
  distance: 0.25,
  /** Chance it expires worthless, corrected by what really happened. */
  probability: 0.20,
  /** Open interest, against the heaviest strike on this board. */
  openInterest: 0.15,
  /** Traded today, against the busiest strike on this board. */
  volume: 0.10,
  /** Priced richer than the money, which is what a seller is paid for. */
  impliedVol: 0.10,
  /** The credit itself, against the floor asked for. */
  premium: 0.10,
  /** Expected value as a share of the credit. */
  expectedValue: 0.10,
} as const;

/** What the score is called once it has a number. */
export type Tier = 'strong' | 'candidate' | 'watch' | 'avoid';

export const TIER_AT = { strong: 80, candidate: 65, watch: 50 } as const;

/** How busy a strike is against what is open on it. */
export type LiquidityBand = 'low' | 'normal' | 'high';

/**
 * The arithmetic behind one expected value, in the order it is worked out.
 *
 * The board shows the answer; this is what a reader needs to argue with it.
 * `expectedLossPerBtc` is the average cost *given a breach*, which is the only
 * figure here that is not simply read off the book -- it is the payout model
 * divided by the chance of the breach it is conditioned on.
 */
export type EvBreakdown = {
  /** Chance it expires worthless, corrected by history. */
  pWin: number;
  /** What is received, USD per BTC. */
  premiumPerBtc: number;
  pLoss: number;
  /** Average cost of a breach, USD per BTC, given one happens. */
  expectedLossPerBtc: number;
  feesUsd: number;
  evUsd: number;
};

export type LegEv = {
  /** Average settlement cost of the short, USD per BTC. */
  payoutPerBtc: number | null;
  /** Credit less that payout, USD per BTC. */
  evPerBtc: number | null;
  /** The same for `lots`, after Delta's charges to open. Null when unpriced. */
  evUsd: number | null;
  chargesUsd: number;
  /** Delta traded today divided by open interest. */
  volumeToOi: number | null;
  /** Where the short stops making money. */
  breakeven: number | null;
  /** The credit, which is all a naked short can ever make. */
  maxProfitUsd: number | null;
  /** Null means unbounded -- a naked short has no worst case. */
  maxLossUsd: number | null;
  /** Traded today over open interest, banded: under 5%, 5-15%, over 15%. */
  liquidity: LiquidityBand | null;
  /** The credit as a share of the margin it ties up, and of the expected move. */
  premiumYieldPct: number | null;
  premiumPerExpectedMove: number | null;
  /** 0-100, from SCORE_WEIGHTS. Null when the strike is not priced. */
  score: number | null;
  /** The score's name, floored at `avoid` whenever a hard rule fails. */
  tier: Tier;
  /** Where the expected value came from, for a reader who wants to argue. */
  breakdown: EvBreakdown | null;
  checks: Check[];
  /**
   * `sell` every rule clear, `watch` only soft rules failing, `avoid` a hard one.
   *
   * **This is not the desk's recommendation.** It is arithmetic on one strike,
   * and the EV rule behind it has never been tested across 2024, 2025 and 2026
   * the way the premium floor and the RSI gate were. The screen labels it for
   * information, and no gate reads it.
   */
  signal: 'sell' | 'watch' | 'avoid';
};

/**
 * The eligibility rules, in the repo's own `Check` shape so the board, the
 * strike panel and the tooltip all read one list rather than three copies.
 *
 * `block` is a rule that makes the strike a bad sell on its own; `warn` is one
 * that makes it a worse fill rather than a worse bet. Liquidity is deliberately
 * a warning: at the distance this strategy sells, a daily option's volume is
 * routinely a fraction of a percent of its open interest, so blocking on it
 * would mark the entire far half of the board unsellable -- including the
 * strikes the tested engine picks.
 */
function eligibility(leg: ScoredLeg, spot: number, evPerBtc: number | null, minPremium: number): Check[] {
  const checks: Check[] = [];
  const px = leg.sellPrice;
  const zero = leg.zero?.adjusted ?? leg.pOtm;

  if (leg.moneyness === 'ITM') {
    checks.push({ ok: false, severity: 'block', text: 'In the money — the short starts underwater.' });
  }

  const otmPct = spot > 0 ? (Math.abs(leg.strike - spot) / spot) * 100 : null;
  if (otmPct !== null) {
    const ok = otmPct >= EV_RULES.minOtmPct;
    checks.push({
      ok,
      severity: 'block',
      text: ok
        ? `${otmPct.toFixed(2)}% out of the money, past the ${EV_RULES.minOtmPct}% bar.`
        : `Only ${otmPct.toFixed(2)}% out of the money — under the ${EV_RULES.minOtmPct}% bar, BTC reaches this in an ordinary session.`,
    });
  }

  if (zero !== null) {
    const ok = zero >= EV_RULES.minZero;
    checks.push({
      ok,
      severity: 'block',
      text: ok
        ? `${(zero * 100).toFixed(1)}% chance it expires worthless.`
        : `${(zero * 100).toFixed(1)}% chance it expires worthless — under the ${(EV_RULES.minZero * 100).toFixed(0)}% bar.`,
    });
  }

  if (evPerBtc !== null) {
    const ok = evPerBtc > 0;
    checks.push({
      ok,
      severity: 'block',
      text: ok
        ? `Positive expected value: $${evPerBtc.toFixed(2)} per BTC above the average payout.`
        : `Negative expected value: the average payout is $${(-evPerBtc).toFixed(2)} per BTC more than the credit.`,
    });
  } else {
    checks.push({ ok: false, severity: 'block', text: 'No expected value — the strike is not priced.' });
  }

  if (px !== null) {
    const ok = px >= minPremium;
    checks.push({
      ok,
      severity: 'block',
      text: ok
        ? `Pays $${px.toFixed(2)}, at or above the $${minPremium} floor.`
        : `Pays only $${px.toFixed(2)}, under the $${minPremium} floor.`,
    });
  }

  if (leg.delta !== null) {
    const ok = Math.abs(leg.delta) <= EV_RULES.maxAbsDelta;
    checks.push({
      ok,
      severity: 'warn',
      text: ok
        ? `Delta ${leg.delta.toFixed(3)} — barely moves with BTC.`
        : `Delta ${leg.delta.toFixed(3)} is above ${EV_RULES.maxAbsDelta}, so the premium tracks BTC closely.`,
    });
  }

  const vOi = leg.oi !== null && leg.oi > 0 && leg.volume !== null ? leg.volume / leg.oi : null;
  if (vOi !== null) {
    const ok = vOi >= EV_RULES.minVolumeToOi;
    checks.push({
      ok,
      severity: 'warn',
      text: ok
        ? `Traded ${(vOi * 100).toFixed(1)}% of its open interest today.`
        : `Traded only ${(vOi * 100).toFixed(1)}% of its open interest today — getting out may be slow.`,
    });
  }

  if (leg.bid !== null && leg.ask !== null && leg.ask > leg.bid) {
    const mid = (leg.bid + leg.ask) / 2;
    const spread = mid > 0 ? (leg.ask - leg.bid) / mid : null;
    if (spread !== null) {
      const ok = spread <= EV_RULES.maxSpreadPct;
      checks.push({
        ok,
        severity: 'warn',
        text: ok
          ? `Spread ${(spread * 100).toFixed(1)}% of the mid.`
          : `Spread is ${(spread * 100).toFixed(1)}% of the mid — wide enough to cost more than a day's decay.`,
      });
    }
  }

  if (leg.ageMin !== null && leg.ageMin > EV_RULES.maxAgeMin) {
    checks.push({
      ok: false,
      severity: 'warn',
      text: `Last trade was ${leg.ageMin}m ago — that price may not be there.`,
    });
  }

  return checks;
}

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

/**
 * What a strike has to be ranked *against*: the board it is on.
 *
 * Open interest and volume mean nothing in absolute terms -- 425,600 is heavy
 * on one expiry and ordinary on another -- so both are scored against the
 * heaviest strike currently listed rather than against a constant.
 */
export type Board = {
  maxOi: number;
  maxVolume: number;
  /** At-the-money implied volatility, to price the skew against. */
  atmIv: number | null;
  /** Expected move by settlement, USD. */
  expectedMove: number | null;
};

export function boardOf(legs: ScoredLeg[], snap: { atmIv: number | null; expectedMove: number | null }): Board {
  return {
    maxOi: Math.max(1, ...legs.map((l) => l.oi ?? 0)),
    maxVolume: Math.max(1, ...legs.map((l) => l.volume ?? 0)),
    atmIv: snap.atmIv,
    expectedMove: snap.expectedMove,
  };
}

/**
 * A 0-100 ranking of one strike against the rest of its board.
 *
 * It ranks; it does not recommend. Seven normalised parts under
 * `SCORE_WEIGHTS`, and every one of them is a description of the present chain
 * -- none has been measured across 2024, 2025 and 2026 the way the premium
 * floor and the RSI gate were. A board where every strike scores 40 is not a
 * board to stand aside from on this number's say-so; it is a number saying the
 * strikes are alike.
 *
 * Logs for open interest and volume: the heaviest strike is routinely two
 * orders of magnitude above the median, and on a linear scale that flattens
 * every other strike to zero.
 */
function sellScore(
  leg: ScoredLeg,
  o: { spot: number; minPremium: number; evPerBtc: number | null },
  board: Board,
): number | null {
  const px = leg.sellPrice;
  if (px === null || o.evPerBtc === null) return null;

  const otmPct = o.spot > 0 ? (Math.abs(leg.strike - o.spot) / o.spot) * 100 : 0;
  const zero = leg.zero?.adjusted ?? leg.pOtm;

  const parts: [number, number][] = [
    // 6% out is full marks: at a ~12 hour expiry that is several expected moves.
    [SCORE_WEIGHTS.distance, clamp01(otmPct / 6)],
    // 90% is the floor of interesting and 99% the top of it; below 90 it is 0.
    [SCORE_WEIGHTS.probability, zero === null ? 0 : clamp01((zero - 0.9) / 0.09)],
    [SCORE_WEIGHTS.openInterest, Math.log1p(leg.oi ?? 0) / Math.log1p(board.maxOi)],
    [SCORE_WEIGHTS.volume, Math.log1p(leg.volume ?? 0) / Math.log1p(board.maxVolume)],
    // Priced above the money is what a seller is paid for; 1.3x at-the-money
    // volatility is full marks, at-the-money itself is half.
    [
      SCORE_WEIGHTS.impliedVol,
      leg.iv === null || board.atmIv === null || board.atmIv <= 0
        ? 0.5
        : clamp01((leg.iv / board.atmIv - 0.7) / 0.6),
    ],
    // Twice the floor asked for is full marks.
    [SCORE_WEIGHTS.premium, o.minPremium > 0 ? clamp01(px / (2 * o.minPremium)) : clamp01(px / 30)],
    // The edge as a share of the credit: keeping a third of it is full marks.
    [SCORE_WEIGHTS.expectedValue, px > 0 ? clamp01(o.evPerBtc / px / 0.33) : 0],
  ];

  const total = parts.reduce((a, [w, v]) => a + w * v, 0);
  const weights = parts.reduce((a, [w]) => a + w, 0) || 1;
  return Math.round((total / weights) * 100);
}

/**
 * Expected value and eligibility for one strike, sold naked at `lots`.
 *
 * Naked because that is what the tested strategy does: Delta lists nothing
 * further out to buy on roughly three days in four, so a bounded worst case is
 * not usually on offer. `maxLossUsd` is null rather than a large number,
 * because a number would invite someone to size against it.
 */
export function legEv(
  leg: ScoredLeg,
  o: { spot: number; lots: number; minPremium: number },
  board: Board = { maxOi: 1, maxVolume: 1, atmIv: null, expectedMove: null },
): LegEv {
  const px = leg.sellPrice;
  const payoutPerBtc = expectedPayoutPerBtc({
    mark: leg.mark,
    model: leg.pOtm,
    real: leg.zero?.adjusted ?? null,
  });
  const evPerBtc = px !== null && payoutPerBtc !== null ? px - payoutPerBtc : null;

  // Charged on the way in only, which is what `recommend.ts` subtracts from its
  // own expected profit. The two figures describe the same trade and must agree.
  const chargesUsd = px === null
    ? 0
    : fillChargesUsd({ price: px, contracts: o.lots, contractValue: LOT_BTC, spot: o.spot }).totalUsd;

  const evUsd = evPerBtc === null ? null : evPerBtc * o.lots * LOT_BTC - chargesUsd;
  const volumeToOi = leg.oi !== null && leg.oi > 0 && leg.volume !== null ? leg.volume / leg.oi : null;

  const checks = eligibility(leg, o.spot, evPerBtc, o.minPremium);
  const blocked = checks.some((c) => c.severity === 'block' && !c.ok);
  const warned = checks.some((c) => c.severity === 'warn' && !c.ok);

  const score = sellScore(leg, { spot: o.spot, minPremium: o.minPremium, evPerBtc }, board);

  /*
   * The rules floor the tier, in both directions.
   *
   * A hard rule failing is `avoid` however well the strike scores: the score
   * ranks strikes against each other and the rules say whether a strike
   * belongs on the list at all, so letting an 84 out-rank a failing gate would
   * be the ranking quietly overruling it.
   *
   * A *soft* rule failing caps the strike at `watch`. Without that cap a thin
   * strike paying twice as much scores its way above a strike that clears
   * everything, and the card recommends the one you cannot get out of. The
   * score decides the order inside a tier; it does not promote across one.
   */
  const tier: Tier = blocked || score === null
    ? 'avoid'
    : warned
      ? 'watch'
      : score >= TIER_AT.strong ? 'strong'
        : score >= TIER_AT.candidate ? 'candidate'
          : 'watch';

  // The margin Delta ties up for this short, so the credit can be read as a
  // return on it rather than as a bare number of dollars.
  const marginUsd = px === null
    ? null
    : fundsRequiredPerContract({
        spot: o.spot, premium: px, leverage: DESK_LEVERAGE, contractValue: LOT_BTC,
      }) * o.lots;

  const pWin = leg.zero?.adjusted ?? leg.pOtm;
  const breakdown: EvBreakdown | null =
    px === null || pWin === null || payoutPerBtc === null || evUsd === null
      ? null
      : {
          pWin,
          premiumPerBtc: px,
          pLoss: 1 - pWin,
          // The payout model is already the average over *all* outcomes, so the
          // cost of a breach alone is that average divided by how often one
          // happens. At pLoss 0 there is no breach to cost anything.
          expectedLossPerBtc: pWin >= 1 ? 0 : payoutPerBtc / (1 - pWin),
          feesUsd: chargesUsd,
          evUsd,
        };

  return {
    payoutPerBtc,
    evPerBtc,
    evUsd,
    chargesUsd,
    volumeToOi,
    liquidity: volumeToOi === null
      ? null
      : volumeToOi < 0.05 ? 'low' : volumeToOi > 0.15 ? 'high' : 'normal',
    premiumYieldPct:
      px === null || marginUsd === null || marginUsd <= 0
        ? null
        : ((px * o.lots * LOT_BTC) / marginUsd) * 100,
    premiumPerExpectedMove:
      px === null || !board.expectedMove || board.expectedMove <= 0
        ? null
        : px / board.expectedMove,
    score,
    tier,
    breakdown,
    breakeven: px === null ? null : leg.cp === 'C' ? leg.strike + px : leg.strike - px,
    maxProfitUsd: px === null ? null : px * o.lots * LOT_BTC - chargesUsd,
    maxLossUsd: null,
    checks,
    signal: blocked ? 'avoid' : warned ? 'watch' : 'sell',
  };
}

export type EvLeg = ScoredLeg & { ev: LegEv };

/** The whole board, each strike carrying its own arithmetic. */
export function attachEv(
  scored: ScoredLeg[],
  o: { spot: number; lots: number; minPremium: number; atmIv?: number | null; expectedMove?: number | null },
): EvLeg[] {
  const board = boardOf(scored, {
    atmIv: o.atmIv ?? null,
    expectedMove: o.expectedMove ?? null,
  });
  return scored.map((leg) => ({ ...leg, ev: legEv(leg, o, board) }));
}

/**
 * The strikes the arithmetic likes best, richest expected value first, with
 * everything clear ranked above everything merely warned about.
 *
 * Ordered by tier first, then by score, then by the expected value itself. A
 * `watch` strike with a bigger number does not out-rank a `candidate`: the tier
 * is the rules' answer and the score only sorts within it.
 *
 * `avoid` never appears -- a hard rule is failing there. Everything else does,
 * because at the distance this strategy sells the liquidity rule fails on
 * almost every real candidate almost every day: ranking the clear ones alone
 * produced an empty list that read as "nothing qualifies", which is not the
 * same statement as "these qualify, and here is what is thin about them".
 */
export function topByEv(legs: EvLeg[], limit = 5): EvLeg[] {
  const rank: Record<Tier, number> = { strong: 0, candidate: 1, watch: 2, avoid: 3 };
  return legs
    .filter((l) => l.ev.tier !== 'avoid' && l.ev.evUsd !== null)
    .sort((a, b) =>
      rank[a.ev.tier] - rank[b.ev.tier]
      || (b.ev.score ?? 0) - (a.ev.score ?? 0)
      || b.ev.evUsd! - a.ev.evUsd!)
    .slice(0, limit);
}
