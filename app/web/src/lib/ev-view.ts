import type { Leg } from '@/types/desk';

/**
 * Reading the server's per-strike arithmetic onto the screen.
 *
 * Nothing here decides anything. The signal on a leg was assigned in
 * `domain/ev.ts`; this file only orders, labels and colours it. A second
 * eligibility rule written on this side would be a rule the tests cannot see.
 */

export type Signal = Leg['ev']['signal'];
export type Tier = Leg['ev']['tier'];

/**
 * Four names, not three.
 *
 * "Sell / Watch / Avoid" put every strike that cleared the rules into one
 * bucket, and on a real board that is most of the far half — a column that says
 * the same word twenty times tells a reader nothing about which of the twenty
 * to take. The score separates them; the rules still decide whether a strike is
 * in the list at all.
 */
export const TIER_LABEL: Record<Tier, string> = {
  strong: 'Strong',
  candidate: 'Candidate',
  watch: 'Watch',
  avoid: 'Avoid',
};

export const TIER_TONE: Record<Tier, 'ok' | 'warn' | 'danger'> = {
  strong: 'ok',
  candidate: 'ok',
  watch: 'warn',
  avoid: 'danger',
};

export const SIGNAL_LABEL: Record<Signal, string> = {
  sell: 'Sell',
  watch: 'Watch',
  avoid: 'Avoid',
};

export const SIGNAL_TONE: Record<Signal, 'ok' | 'warn' | 'danger'> = {
  sell: 'ok',
  watch: 'warn',
  avoid: 'danger',
};

/**
 * The richest expected values, best first, with everything clear ranked above
 * everything merely warned about.
 *
 * Tier first, then score, then the expected value itself: a `watch` strike with
 * a bigger number does not out-rank a `candidate`, because the tier is the
 * rules' answer and the score only sorts within it.
 *
 * `avoid` never appears: a hard rule is failing and a list headed "best to
 * sell" containing one would disagree with its own Signal column.
 *
 * `watch` does appear, and the first version of this card was wrong to drop it.
 * At the distance this strategy sells, a daily option routinely trades a
 * fraction of a percent of its open interest — the strike the tested engine
 * picked on 12 September traded 0.17% of it — so the liquidity rule is failing
 * on almost every genuine candidate almost every day. Ranking `sell` alone left
 * the card empty and reading as "nothing qualifies", which is a different and
 * untrue statement from "these qualify, and here is what is thin about them".
 */
export function topByEv(legs: Leg[], limit = 5): Leg[] {
  const rank: Record<Tier, number> = { strong: 0, candidate: 1, watch: 2, avoid: 3 };
  return legs
    .filter((l) => l.ev.tier !== 'avoid' && l.ev.evUsd !== null)
    .sort((a, b) =>
      rank[a.ev.tier] - rank[b.ev.tier]
      || (b.ev.score ?? 0) - (a.ev.score ?? 0)
      || b.ev.evUsd! - a.ev.evUsd!)
    .slice(0, limit);
}

/** How far this strike sits from spot, as a percentage. */
export const otmPct = (strike: number, spot: number): number | null =>
  spot > 0 ? (Math.abs(strike - spot) / spot) * 100 : null;

/** The rules that are actually failing, worst first — what a tooltip should say. */
export const failing = (leg: Leg) =>
  (leg.ev?.checks ?? [])
    .filter((c) => !c.ok)
    .sort((a, b) => (a.severity === 'block' ? -1 : 1) - (b.severity === 'block' ? -1 : 1));

/** One line saying why a strike is marked the way it is. */
export function signalReason(leg: Leg): string {
  const bad = failing(leg);
  if (!bad.length) return 'Every eligibility rule is clear.';
  return bad.map((c) => c.text).join(' ');
}
