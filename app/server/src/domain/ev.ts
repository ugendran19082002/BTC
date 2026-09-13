import type { ScoredLeg } from './score.js';
import { LOT_BTC } from './score.js';
import { fillChargesUsd } from '../trading/charges.js';
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

  return {
    payoutPerBtc,
    evPerBtc,
    evUsd,
    chargesUsd,
    volumeToOi,
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
  o: { spot: number; lots: number; minPremium: number },
): EvLeg[] {
  return scored.map((leg) => ({ ...leg, ev: legEv(leg, o) }));
}

/**
 * The strikes the arithmetic likes best, richest expected value first, with
 * everything clear ranked above everything merely warned about.
 *
 * `avoid` never appears -- a hard rule is failing. `watch` does, because at the
 * distance this strategy sells the liquidity rule fails on almost every real
 * candidate almost every day: ranking `sell` alone produced an empty list that
 * read as "nothing qualifies", which is not the same statement as "these
 * qualify, and here is what is thin about them".
 */
export function topByEv(legs: EvLeg[], limit = 5): EvLeg[] {
  const rank = (l: EvLeg) => (l.ev.signal === 'sell' ? 0 : 1);
  return legs
    .filter((l) => l.ev.signal !== 'avoid' && l.ev.evUsd !== null)
    .sort((a, b) => rank(a) - rank(b) || b.ev.evUsd! - a.ev.evUsd!)
    .slice(0, limit);
}
