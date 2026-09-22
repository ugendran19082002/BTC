import { DEFAULT_WALL_WITHIN_EM } from '../domain/structure.js';
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
import type { Tier } from '../domain/ev.js';
import type { StrategyConfig } from './types.js';
import { lotsPerLeg } from './schedule.js';
import { strikeLabel, type Strategy } from './types.js';

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
  /** Contracts open at this strike. Read only by the open-interest rule. */
  oi?: number | null;
  /** How far the strike sits from spot, in expected moves. Read only by the open-interest rule. */
  emBuffer?: number | null;
  /** `domain/ev.ts`'s 0-100 sell score. Read only by the sell-score bar. */
  sellScore?: number | null;
  /** What the score is called once hard rules have had their say. */
  tier?: Tier | null;
};

export type Chosen = {
  cp: 'C' | 'P';
  strike: number;
  price: number;
  pOtm: number | null;
  lots: number;
  ask: number | null;
  /** Set when the premium rule's own number found nothing and its fallback found this. */
  fallbackUsd?: number;
};

export type Selection = {
  legs: Chosen[];
  /** One line per leg the strategy wanted and did not get, and why. */
  refusals: string[];
};

const SIDE = { CE: 'C', PE: 'P' } as const;

/**
 * The nth strike from the money on one side, counted over what is listed.
 *
 * Counted over the strikes that are actually there rather than over the strike
 * grid, because Delta lists $200 apart near the money and $400 further out: the
 * fifth listed strike out and the fifth grid step out are different contracts,
 * and only one of them can be sold.
 *
 * Outward means up the board for a call and down it for a put, so both sides
 * read the same way: [most ITM ... ITM 1, ATM, OTM 1 ... furthest OTM].
 */
export function pickByPosition(
  priced: readonly Candidate[],
  cp: 'C' | 'P',
  step: number,
): Candidate | null {
  const outward = [...priced].sort((a, b) => (cp === 'C' ? a.strike - b.strike : b.strike - a.strike));
  if (step === 0) return outward.find((l) => l.moneyness === 'ATM') ?? null;
  if (step > 0) return outward.filter((l) => l.moneyness === 'OTM')[step - 1] ?? null;
  // Counting inward from the money, so the nearest in-the-money strike is ITM 1.
  return outward.filter((l) => l.moneyness === 'ITM').reverse()[-step - 1] ?? null;
}

/**
 * Pick one side's strike, under whichever rule the strategy uses.
 *
 * Under a premium rule: out of the money only. A short that starts in the money
 * is not that strategy -- it is a directional bet with a worse payoff than the
 * underlying. A strict rule may name an in-the-money strike, because naming the
 * strike is the whole point of it; the safety gate still has its say afterwards.
 */
export function pickStrike(
  candidates: readonly Candidate[],
  cp: 'C' | 'P',
  cfg: StrategyConfig,
  /** The desk's level band, for the open-interest rule. Absent takes the default. */
  opts: { wallWithinEm?: number | null } = {},
): Candidate | null {
  const priced = candidates.filter((l) => l.cp === cp && (l.sellPrice ?? 0) > 0);
  if (cfg.strikeRule === 'strict') return pickByPosition(priced, cp, cfg.strikeStep ?? 0);

  const otm = priced.filter((l) => l.moneyness === 'OTM');
  if (otm.length === 0) return null;

  /*
   * The wall: the strike on this side with the most open interest.
   *
   * Out of the money only, like the premium rule -- a wall in the money is a
   * different trade, not a heavier version of this one. Strikes with no open
   * interest to read are not "zero open interest", they are unreadable, so they
   * are left out rather than ranked last.
   */
  /*
   * The wall within reach, and one that still pays.
   *
   * Asked on 18 September which pair this takes, 71,000 – 89,000 or 76,000 –
   * 77,800: it took the first, the heaviest anywhere on the board, and those
   * strikes paid $0.20 and $0.10. The heaviest open interest on a Delta chain
   * sits at far round numbers that nobody should sell for nothing. So the wall
   * is looked for inside the same band the screens draw levels in, and it has
   * to clear the premium floor like any other strike -- a wall that pays under
   * the floor is a level, not a trade.
   */
  if (cfg.strikeRule === 'oiWall') {
    const within = opts.wallWithinEm ?? DEFAULT_WALL_WITHIN_EM;
    const readable = otm.filter((l) =>
      l.oi !== null && l.oi !== undefined && Number.isFinite(l.oi)
      && (l.sellPrice ?? 0) >= cfg.premium.usd
      && (l.emBuffer === null || l.emBuffer === undefined || l.emBuffer <= within));
    if (readable.length === 0) return null;
    return readable.reduce((a, b) => (b.oi! > a.oi! ? b : a));
  }

  /*
   * The number first, and the fallback only when the number finds nothing at
   * all -- never because the fallback's strike looks better. "At most $20, else
   * at most $50" is a rule about a board with nothing under $20, not a second
   * opinion on a board that has one.
   */
  const fallback = cfg.premium.fallbackUsd;
  return pickByPremium(otm, cfg.premium.mode, cfg.premium.usd)
    ?? (fallback !== null && fallback !== undefined ? pickByPremium(otm, cfg.premium.mode, fallback) : null);
}

/** Whether a price meets a premium rule. */
export const meetsPremium = (price: number, mode: StrategyConfig['premium']['mode'], usd: number): boolean =>
  mode === 'atLeast' ? price >= usd : price <= usd;

/**
 * One premium rule over out-of-the-money strikes.
 *
 *   atLeast   furthest from the money still paying it: the cheapest that pays
 *   atMost    the richest at or below it: the last strike before the cap
 */
export function pickByPremium(
  otm: readonly Candidate[],
  mode: StrategyConfig['premium']['mode'],
  usd: number,
): Candidate | null {
  const ok = otm.filter((l) => meetsPremium(l.sellPrice!, mode, usd));
  if (ok.length === 0) return null;
  return mode === 'atLeast'
    ? ok.reduce((a, b) => (b.sellPrice! < a.sellPrice! ? b : a))
    : ok.reduce((a, b) => (b.sellPrice! > a.sellPrice! ? b : a));
}

/**
 * The whole day's decision: which legs, at what size.
 *
 * A leg is refused when there is no strike the rule can take, or when the gate
 * puts it below the bar. Refusals are returned rather than swallowed, because
 * "sold nothing today" and "sold nothing today because nothing paid $15" are
 * different facts and only one of them needs looking at.
 */
export function selectLegs(
  s: Strategy,
  candidates: readonly Candidate[],
  opts: { wallWithinEm?: number | null } = {},
): Selection {
  const cfg = s.config;
  const wanted: ('CE' | 'PE')[] = cfg.legs === 'both' ? ['CE', 'PE'] : [cfg.legs];
  const refusals: string[] = [];
  const picked = new Map<'CE' | 'PE', Candidate>();

  for (const leg of wanted) {
    const chosen = pickStrike(candidates, SIDE[leg], cfg, opts);
    if (!chosen) {
      refusals.push(
        cfg.strikeRule === 'strict'
          ? `${leg}: no ${strikeLabel(cfg.strikeStep)} strike listed with a price`
          : cfg.strikeRule === 'oiWall'
            ? `${leg}: no wall within ${opts.wallWithinEm ?? DEFAULT_WALL_WITHIN_EM} expected moves that pays $${cfg.premium.usd}`
            : `${leg}: nothing out of the money ${cfg.premium.mode === 'atLeast' ? 'paying' : 'at or below'} $${cfg.premium.usd}`
              + (cfg.premium.fallbackUsd != null ? `, nor $${cfg.premium.fallbackUsd}` : ''),
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
    /*
     * The sell-score bar, after the probability gate and for the same reasons.
     *
     * Refused rather than held: the strike is what it is, and asking again in
     * twenty seconds gets the same answer. A strike with no score is refused
     * too -- an unscored strike is an unpriced one, and a bar that passes
     * whatever it cannot read is not a bar.
     */
    if (cfg.minSellScore !== null && cfg.minSellScore !== undefined) {
      const score = chosen.sellScore;
      if (score === null || score === undefined) {
        refusals.push(`${leg}: ${chosen.strike} has no sell score to check against the bar`);
        continue;
      }
      if (score < cfg.minSellScore) {
        refusals.push(
          `${leg}: ${chosen.strike} scores ${Math.round(score)}/100`
          + `${chosen.tier ? ` (${chosen.tier})` : ''}, below the ${cfg.minSellScore} bar`,
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
      ...(viaFallback(cfg, c) ? { fallbackUsd: cfg.premium.fallbackUsd! } : {}),
    })),
    refusals,
  };
}

/** True when this strike was found by the premium fallback rather than the rule's own number. */
function viaFallback(cfg: StrategyConfig, c: Candidate): boolean {
  return cfg.strikeRule === 'premium'
    && cfg.premium.fallbackUsd !== null && cfg.premium.fallbackUsd !== undefined
    && !meetsPremium(c.sellPrice!, cfg.premium.mode, cfg.premium.usd);
}

/**
 * What the desk said about each selected leg, before anything was sent.
 *
 * `refusedBy` is the trading gate's own words -- the premium floor, the spread,
 * the margin -- or null when it would take the order.
 */
export type Verdict = { leg: Chosen; refusedBy: string | null };

/**
 * The legs to actually send, once the desk has had its say on all of them.
 *
 * This exists because doubling and the desk's own gate used to be blind to
 * each other. The gate refuses a leg when the order is sent, one leg at a
 * time, and by then the other leg is already on the book at single size --
 * so a strategy set to double on a one-sided day sold one lot on the only
 * side that went. On 16 September the open-interest rule picked the 80,000
 * call, the desk refused it at $1 against its $5 floor, and the put went on
 * alone at ten lots instead of twenty.
 *
 * So the legs are asked about first and sized afterwards. A refusal here is
 * exactly a refusal in `selectLegs`: one side is not being sold today, and the
 * setting says what that means for the other one.
 */
export function afterDeskCheck(s: Strategy, asked: readonly Verdict[]): Selection {
  const survivors = asked.filter((a) => a.refusedBy === null).map((a) => a.leg);
  const refusals = asked
    .filter((a) => a.refusedBy !== null)
    .map((a) => `${a.leg.cp === 'C' ? 'CE' : 'PE'} ${a.leg.strike}: ${a.refusedBy}`);

  const sides = survivors.map((l) => (l.cp === 'C' ? 'CE' : 'PE') as 'CE' | 'PE');
  const lots = lotsPerLeg(s, sides);
  return {
    legs: survivors.map((l, i) => ({ ...l, lots: lots[sides[i]!] })),
    refusals,
  };
}

/** A one-line account of what a run did, for the journal and the screen. */
export function describeSelection(sel: Selection): string {
  const sold = sel.legs.map((l) => `${l.cp === 'C' ? 'CE' : 'PE'} ${l.strike} x${l.lots} @ ${l.price}`
    + (l.fallbackUsd !== undefined ? ` (fallback $${l.fallbackUsd})` : ''));
  if (sold.length === 0) return sel.refusals.join('; ') || 'nothing to sell';
  return sold.join(', ') + (sel.refusals.length ? ` (${sel.refusals.join('; ')})` : '');
}
