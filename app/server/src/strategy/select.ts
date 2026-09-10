/**
 * Which legs a strategy sells today, and how many lots each.
 *
 * Pure. The board goes in, a decision comes out, and nothing here touches an
 * exchange or a clock -- the same rule `machine.ts` and `schedule.ts` keep, and
 * for the same reason: this decides what gets sold, so every case has to be
 * constructible by hand.
 *
 * The two premium rules are opposites and both are here because both are real:
 *
 *   atLeast   the FURTHEST strike still paying the number. Richer premium,
 *             nearer strike, more risk.
 *   atMost    the RICHEST strike at or below it. Cheaper premium, further
 *             strike, less risk.
 *
 * Measured over 735 days at $15: atLeast returns Rs +14,275 at a worst day of
 * Rs -1,241, atMost Rs +9,881 at Rs -721. Neither is the right answer in
 * general, which is why it is a setting.
 */
import type { StrategyConfig } from './types.js';
import { lotsPerLeg } from './schedule.js';
import type { Strategy } from './types.js';

/** Only the parts of a scored leg this decision needs. */
export type Candidate = {
  cp: 'C' | 'P';
  strike: number;
  /** What a seller can realistically expect to receive. */
  sellPrice: number | null;
  /** The model's probability it finishes worthless. Null when unknowable. */
  pOtm: number | null;
  moneyness: 'ITM' | 'ATM' | 'OTM';
  /** Top of the offer, for an entry that rests rather than crosses. */
  ask?: number | null;
};

export type Chosen = {
  cp: 'C' | 'P';
  strike: number;
  price: number;
  pOtm: number | null;
  lots: number;
  ask: number | null;
};

export type Selection = {
  legs: Chosen[];
  /** One line per leg the strategy wanted and did not get, and why. */
  refusals: string[];
};

const SIDE = { CE: 'C', PE: 'P' } as const;

/**
 * Pick one side's strike under a premium rule.
 *
 * Out of the money only. A short that starts in the money is not this strategy
 * -- it is a directional bet with a worse payoff than the underlying.
 */
export function pickStrike(
  candidates: readonly Candidate[],
  cp: 'C' | 'P',
  cfg: StrategyConfig,
): Candidate | null {
  const otm = candidates.filter(
    (l) => l.cp === cp && l.moneyness === 'OTM' && (l.sellPrice ?? 0) > 0,
  );
  if (otm.length === 0) return null;

  if (cfg.premium.mode === 'atLeast') {
    const paying = otm.filter((l) => l.sellPrice! >= cfg.premium.usd);
    if (paying.length === 0) return null;
    // Furthest from the money is the cheapest of those that still pay it.
    return paying.reduce((a, b) => (b.sellPrice! < a.sellPrice! ? b : a));
  }
  const under = otm.filter((l) => l.sellPrice! <= cfg.premium.usd);
  if (under.length === 0) return null;
  // Richest at or below the cap.
  return under.reduce((a, b) => (b.sellPrice! > a.sellPrice! ? b : a));
}

/**
 * The whole day's decision: which legs, at what size.
 *
 * A leg is refused when there is no strike the rule can take, or when the gate
 * puts it below the bar. Refusals are returned rather than swallowed, because
 * "sold nothing today" and "sold nothing today because nothing paid $15" are
 * different facts and only one of them needs looking at.
 */
export function selectLegs(s: Strategy, candidates: readonly Candidate[]): Selection {
  const cfg = s.config;
  const wanted: ('CE' | 'PE')[] = cfg.legs === 'both' ? ['CE', 'PE'] : [cfg.legs];
  const refusals: string[] = [];
  const picked = new Map<'CE' | 'PE', Candidate>();

  for (const leg of wanted) {
    const chosen = pickStrike(candidates, SIDE[leg], cfg);
    if (!chosen) {
      refusals.push(
        `${leg}: nothing out of the money ${cfg.premium.mode === 'atLeast' ? 'paying' : 'at or below'} $${cfg.premium.usd}`,
      );
      continue;
    }
    if (cfg.probGate !== null) {
      if (chosen.pOtm === null) {
        // No probability means the gate cannot be applied, and a gate that
        // silently passes is not a gate.
        refusals.push(`${leg}: ${chosen.strike} has no probability to check against the gate`);
        continue;
      }
      if (chosen.pOtm < cfg.probGate) {
        refusals.push(
          `${leg}: ${chosen.strike} is ${(chosen.pOtm * 100).toFixed(1)}% to expire worthless, below the ${(cfg.probGate * 100).toFixed(1)}% bar`,
        );
        continue;
      }
    }
    picked.set(leg, chosen);
  }

  // Doubling is decided by how many legs survived, so it happens after the
  // gate rather than beside it.
  const lots = lotsPerLeg(s, [...picked.keys()]);
  return {
    legs: [...picked.entries()].map(([leg, c]) => ({
      cp: c.cp,
      strike: c.strike,
      price: c.sellPrice!,
      pOtm: c.pOtm,
      lots: lots[leg],
      ask: c.ask ?? null,
    })),
    refusals,
  };
}

/** A one-line account of what a run did, for the journal and the screen. */
export function describeSelection(sel: Selection): string {
  const sold = sel.legs.map((l) => `${l.cp === 'C' ? 'CE' : 'PE'} ${l.strike} x${l.lots} @ ${l.price}`);
  if (sold.length === 0) return sel.refusals.join('; ') || 'nothing to sell';
  return sold.join(', ') + (sel.refusals.length ? ` (${sel.refusals.join('; ')})` : '');
}
