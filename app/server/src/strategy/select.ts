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
import type { DeltaRule, DistanceRule, StrategyConfig } from './types.js';
import { distanceNeeded, elseOtmOf, strikeLabel, type Strategy } from './types.js';

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
  /** The option's delta, negative for a put. Read only by the delta rule; null where the board could not work it out. */
  delta?: number | null;
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
  /**
   * Set when the premium's own pick sat nearer the money than `minOtm`, or there
   * was none, and the rule's else strike was sold instead: the condition it
   * failed, and the strike the else named.
   */
  minOtm?: number;
  elseOtm?: number;
  /** With them: the strike the premium did pick, nearer the money than the rule allows -- or null when it picked none. */
  premiumPick?: { strike: number; price: number } | null;
  /** Set when a delta rule chose it: the strike's delta, as a size. */
  delta?: number;
  /** Set when a distance rule chose it: how far the strike sits from BTC, and how far the rule asked for, in percent. */
  distancePct?: number;
  distanceNeedPct?: number;
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

export type SelectOptions = {
  /** The desk's level band, for the open-interest rule. Absent takes the default. */
  wallWithinEm?: number | null;
  /** BTC now. Without it the strike nearest the money is never sold under a premium rule, and a distance rule picks nothing. */
  spot?: number | null;
  /** Hours to the settlement. Read only by a distance rule that shrinks with the time left. */
  hoursToExpiry?: number | null;
};

/**
 * Worth nothing if it expired now.
 *
 * `moneyness` calls the strike nearest spot ATM whichever side of spot it
 * sits, and the premium rules used to skip it. On 29 Sep 2026 at 17:01, spot
 * just under 84,200, that sent the call leg to 84,400 at 0.80 -- under the
 * desk's floor -- while AlgoTest sold the 84,200 at 7.58. A call above spot
 * and a put below it have no intrinsic value, so they are out of the money
 * whatever the label says; a strike exactly at spot is not.
 */
export function outOfTheMoney(l: Candidate, spot: number | null | undefined): boolean {
  if (l.moneyness === 'OTM') return true;
  if (l.moneyness !== 'ATM' || spot === null || spot === undefined || !Number.isFinite(spot)) return false;
  return l.cp === 'C' ? l.strike > spot : l.strike < spot;
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
  opts: SelectOptions = {},
): Candidate | null {
  return pickStrikeHow(candidates, cp, cfg, opts).pick;
}

/** The pick, and whether a premium rule's else chose it rather than the premium. */
function pickStrikeHow(
  candidates: readonly Candidate[],
  cp: 'C' | 'P',
  cfg: StrategyConfig,
  opts: SelectOptions,
): { pick: Candidate | null; viaElse: boolean; premiumPick: Candidate | null } {
  const own = (pick: Candidate | null) => ({ pick, viaElse: false, premiumPick: pick });
  const priced = candidates.filter((l) => l.cp === cp && (l.sellPrice ?? 0) > 0);
  if (cfg.strikeRule === 'strict') return own(pickByPosition(priced, cp, cfg.strikeStep ?? 0));

  const otm = priced.filter((l) => outOfTheMoney(l, opts.spot));
  if (otm.length === 0) return own(null);

  // By delta and by distance: each a single question asked of the board, out of the money only, with no else.
  if (cfg.strikeRule === 'delta') return own(pickByDelta(otm, cp, cfg.delta));
  if (cfg.strikeRule === 'distance') return own(pickByDistance(otm, cp, cfg.distance, opts));

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
    if (readable.length === 0) return own(null);
    return own(readable.reduce((a, b) => (b.oi! > a.oi! ? b : a)));
  }

  /*
   * The number first, and the fallback only when the number finds nothing at
   * all -- never because the fallback's strike looks better. "At most $20, else
   * at most $50" is a rule about a board with nothing under $20, not a second
   * opinion on a board that has one.
   */
  const fallback = cfg.premium.fallbackUsd;
  const byPremium = pickByPremium(otm, cfg.premium.mode, cfg.premium.usd)
    ?? (fallback !== null && fallback !== undefined ? pickByPremium(otm, cfg.premium.mode, fallback) : null);

  /*
   * The condition on distance, and its else (4 Oct 2026). The premium picks as
   * it always did; at `minOtm` or further out its pick stands -- OTM 7 under
   * "at least OTM 6" is sold as OTM 7. Nearer than that, or with no pick at
   * all, the else strike is sold instead: `elseOtm`, a strike named the way a
   * by-strike rule names one, which may be the condition's own strike or a
   * different one. What that strike pays is then for the desk's premium floor
   * to judge, like any other order.
   */
  const min = cfg.premium.minOtm;
  if (min === null || min === undefined) return own(byPremium);
  if (byPremium && otmStepOf(priced, cp, byPremium) >= min) return own(byPremium);
  return { pick: pickByPosition(priced, cp, elseOtmOf(cfg.premium)!), viaElse: true, premiumPick: byPremium };
}

/**
 * How far out a strike sits, counted the way `pickByPosition` counts: OTM 1 is
 * 1, and the strike at the money -- which a premium rule may sell when it has
 * no intrinsic value -- is 0.
 */
export function otmStepOf(priced: readonly Candidate[], cp: 'C' | 'P', c: Candidate): number {
  const outward = priced.filter((l) => l.cp === cp && l.moneyness === 'OTM')
    .sort((a, b) => (cp === 'C' ? a.strike - b.strike : b.strike - a.strike));
  return outward.findIndex((l) => l.strike === c.strike) + 1;
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

/** One side's strikes, nearest the money first: up the board for a call, down it for a put. */
const outwardOf = (legs: readonly Candidate[], cp: 'C' | 'P'): Candidate[] =>
  [...legs].sort((a, b) => (cp === 'C' ? a.strike - b.strike : b.strike - a.strike));

/** How far a strike sits from BTC, as a percentage of BTC. */
export const distancePctOf = (strike: number, spot: number): number => (Math.abs(strike - spot) / spot) * 100;

/**
 * The strike nearest the money whose delta is at or under the rule's.
 *
 * Delta falls as a strike moves out, so the first one outward that meets the
 * number is the richest that does. A strike whose delta the board could not
 * work out -- no mark, no volatility -- is not "zero delta", it is unreadable,
 * and is passed over rather than sold as if it were far away.
 */
export function pickByDelta(
  otm: readonly Candidate[],
  cp: 'C' | 'P',
  rule: DeltaRule | null | undefined,
): Candidate | null {
  if (!rule || !(rule.max > 0)) return null;
  return outwardOf(otm, cp).find((l) => {
    const d = Math.abs(l.delta ?? NaN);
    return d > 0 && d <= rule.max;
  }) ?? null;
}

/**
 * The strike nearest the money that sits at least the rule's distance from BTC.
 *
 * Nothing without BTC's price, and nothing when the distance shrinks with the
 * time left and the time left is not known: a strike picked on a guessed
 * distance is a strike nobody asked for.
 */
export function pickByDistance(
  otm: readonly Candidate[],
  cp: 'C' | 'P',
  rule: DistanceRule | null | undefined,
  opts: SelectOptions,
): Candidate | null {
  const spot = opts.spot;
  const need = rule ? distanceNeeded(rule, opts.hoursToExpiry) : null;
  if (need === null || !(need > 0) || spot === null || spot === undefined || !(spot > 0)) return null;
  return outwardOf(otm, cp).find((l) => distancePctOf(l.strike, spot) >= need) ?? null;
}

/** Why a leg found no strike, for the rules that have no else: one line for the run's record. */
function noStrikeWords(leg: 'CE' | 'PE', cfg: StrategyConfig, opts: SelectOptions): string {
  if (cfg.strikeRule === 'strict') return `${leg}: no ${strikeLabel(cfg.strikeStep)} strike listed with a price`;
  if (cfg.strikeRule === 'oiWall') {
    return `${leg}: no wall within ${opts.wallWithinEm ?? DEFAULT_WALL_WITHIN_EM} expected moves that pays $${cfg.premium.usd}`;
  }
  if (cfg.strikeRule === 'delta') {
    return cfg.delta
      ? `${leg}: no strike out of the money with a delta at or under ${cfg.delta.max}`
      : `${leg}: the delta rule has no number set`;
  }
  if (cfg.strikeRule === 'distance') {
    if (!cfg.distance) return `${leg}: the distance rule has no number set`;
    const need = distanceNeeded(cfg.distance, opts.hoursToExpiry);
    if (need === null) return `${leg}: the time left to the settlement is not known, so the distance from BTC cannot be worked out`;
    if (!(Number(opts.spot) > 0)) return `${leg}: no BTC price to measure the distance from`;
    return `${leg}: no strike listed with a price at least ${need.toFixed(2)}% from BTC`;
  }
  return `${leg}: nothing out of the money ${cfg.premium.mode === 'atLeast' ? 'paying' : 'at or below'} $${cfg.premium.usd}`
    + (cfg.premium.fallbackUsd != null ? `, nor $${cfg.premium.fallbackUsd}` : '');
}

/**
 * The whole day's decision: which legs, at what size.
 *
 * A leg is refused when there is no strike the rule can take. Refusals are returned rather than swallowed, because
 * "sold nothing today" and "sold nothing today because nothing paid $15" are
 * different facts and only one of them needs looking at.
 */
export function selectLegs(
  s: Strategy,
  candidates: readonly Candidate[],
  opts: SelectOptions = {},
): Selection {
  const cfg = s.config;
  const wanted: ('CE' | 'PE')[] = cfg.legs === 'both' ? ['CE', 'PE'] : [cfg.legs];
  const refusals: string[] = [];
  const picked = new Map<'CE' | 'PE', Candidate>();
  const viaElse = new Map<'CE' | 'PE', Candidate | null>();

  for (const leg of wanted) {
    const how = pickStrikeHow(candidates, SIDE[leg], cfg, opts);
    const chosen = how.pick;
    if (how.viaElse) viaElse.set(leg, how.premiumPick);
    if (!chosen && how.viaElse) {
      // The rule failed and its else could not be sold either: both halves said, so the row explains itself.
      const near = how.premiumPick;
      refusals.push(
        `${leg}: rule failed — `
        + (near
          ? `the premium's strike ${near.strike} @ ${near.sellPrice} is nearer than ${strikeLabel(cfg.premium.minOtm!)}`
          : `nothing out of the money ${cfg.premium.mode === 'atLeast' ? 'paying' : 'at or below'} $${cfg.premium.usd}`
            + (cfg.premium.fallbackUsd != null ? `, nor $${cfg.premium.fallbackUsd}` : ''))
        + ` — and the else strike ${strikeLabel(elseOtmOf(cfg.premium)!)} is not listed with a price`,
      );
      continue;
    }
    if (!chosen) {
      refusals.push(noStrikeWords(leg, cfg, opts));
      continue;
    }
    picked.set(leg, chosen);
  }

  return {
    legs: [...picked.entries()].map(([leg, c]) => {
      const floored = viaElse.has(leg);
      const near = viaElse.get(leg) ?? null;
      return {
        cp: c.cp,
        strike: c.strike,
        price: c.sellPrice!,
        pOtm: c.pOtm,
        lots: cfg.lots,
        ask: c.ask ?? null,
        // The else strike was not found by a premium number at all, so it is not "the fallback" either.
        ...(!floored && viaFallback(cfg, c) ? { fallbackUsd: cfg.premium.fallbackUsd! } : {}),
        ...(floored ? {
          minOtm: cfg.premium.minOtm!, elseOtm: elseOtmOf(cfg.premium)!,
          premiumPick: near ? { strike: near.strike, price: near.sellPrice! } : null,
        } : {}),
        // What the rule read at the strike it chose, for the run's line.
        ...(cfg.strikeRule === 'delta' && c.delta != null ? { delta: Math.abs(c.delta) } : {}),
        ...(cfg.strikeRule === 'distance' && cfg.distance && Number(opts.spot) > 0 ? {
          distancePct: distancePctOf(c.strike, opts.spot!),
          distanceNeedPct: distanceNeeded(cfg.distance, opts.hoursToExpiry) ?? undefined,
        } : {}),
      };
    }),
    refusals,
  };
}

/**
 * For a leg the else chose, why: " (rule failed: the premium's strike 84400 @ 51
 * is nearer than OTM 6 — went to the else strike OTM 8)", or "no strike met the
 * premium" when it picked none. Nothing for a leg the premium chose.
 *
 * Written into the run's own line, which is what the trade history shows: a
 * strike other than the one the premium would have sold must say so where the
 * trade is read, not only where the rule is set.
 */
export function elseWords(l: Pick<Chosen, 'minOtm' | 'elseOtm' | 'premiumPick'>): string {
  if (l.minOtm === undefined || l.elseOtm === undefined) return '';
  const why = l.premiumPick
    ? `the premium's strike ${l.premiumPick.strike} @ ${l.premiumPick.price} is nearer than ${strikeLabel(l.minOtm)}`
    : 'no strike met the premium';
  return ` (rule failed: ${why} — went to the else strike ${strikeLabel(l.elseOtm)})`;
}

/**
 * For a leg a delta or a distance rule chose, what it read there: " (delta 0.09)",
 * " (1.92% from BTC, rule 1.85%)". Nothing for any other leg. Written into the
 * run's line beside the strike, as the else's words are.
 */
export function ruleWords(l: Pick<Chosen, 'delta' | 'distancePct' | 'distanceNeedPct'>): string {
  if (l.delta !== undefined) return ` (delta ${l.delta.toFixed(2)})`;
  if (l.distancePct !== undefined) {
    return ` (${l.distancePct.toFixed(2)}% from BTC${l.distanceNeedPct !== undefined ? `, rule ${l.distanceNeedPct.toFixed(2)}%` : ''})`;
  }
  return '';
}

/** True when this strike was found by the premium fallback rather than the rule's own number. */
function viaFallback(cfg: StrategyConfig, c: Candidate): boolean {
  return cfg.strikeRule === 'premium'
    && cfg.premium.fallbackUsd !== null && cfg.premium.fallbackUsd !== undefined
    && !meetsPremium(c.sellPrice!, cfg.premium.mode, cfg.premium.usd);
}

/**
 * A one-line account of what a run did, for the journal and the screen.
 *
 * Each leg carries the offer beside the bid it was chosen on (30 Sep 2026), so
 * the spread every scheduled entry sold into is on the record -- which is what
 * `maxCrossSpreadPct` has to be measured against, rather than guessed.
 */
export function describeSelection(sel: Selection): string {
  const sold = sel.legs.map((l) => `${l.cp === 'C' ? 'CE' : 'PE'} ${l.strike} x${l.lots} @ ${l.price}`
    + (l.fallbackUsd !== undefined ? ` (fallback $${l.fallbackUsd})` : '')
    + elseWords(l)
    + ruleWords(l)
    + (l.ask !== null && l.ask > 0 ? `, ask ${l.ask}` : ''));
  if (sold.length === 0) return sel.refusals.join('; ') || 'nothing to sell';
  return sold.join(', ') + (sel.refusals.length ? ` (${sel.refusals.join('; ')})` : '');
}
