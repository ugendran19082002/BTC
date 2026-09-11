import type { AddToOpposite, StrategyConfig } from '@/types/strategy';

/**
 * What a strategy will actually do, in words and in money.
 *
 * Pure, and separate from the form, for two reasons. It is the text somebody
 * reads before arming something that spends money, so it is worth testing; and
 * the form and the list must not describe the same config two different ways.
 */

const DAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** "every day", "weekdays", "Mon Wed Fri" -- whichever is shortest to read. */
export function describeDays(weekdays: number[]): string {
  const s = [...new Set(weekdays)].sort();
  if (s.length === 0) return 'never — no days picked';
  if (s.length === 7) return 'every day';
  if (s.join() === '1,2,3,4,5') return 'weekdays';
  if (s.join() === '0,6') return 'weekends';
  return s.map((d) => DAY_SHORT[d]).join(' ');
}

/**
 * The premium rule in the words the chain uses.
 *
 * The two rules are opposites and the difference is not obvious from a symbol,
 * which is how a desk ends up running the one it did not mean to. Both halves
 * are spelled out: which strike it takes, and which way that moves the risk.
 */
export function describePremium(c: StrategyConfig): string {
  return c.premium.mode === 'atLeast'
    ? `at least $${c.premium.usd} — takes the furthest strike still paying it`
    : `at most $${c.premium.usd} — takes the richest strike under it`;
}

export function describeEntry(c: StrategyConfig): string {
  if (c.entryPrice === 'now') return 'crosses immediately at the market';
  if (c.entryPrice === 'set') return `rests at ${c.entryLimit ?? '—'}`;
  return c.crossAfterSec > 0
    ? `rests at the offer, crosses after ${c.crossAfterSec}s if the spread is at most ${Math.round((c.maxCrossSpreadPct ?? 0.15) * 100)}%`
    : 'rests at the offer until it fills';
}

export function describeExit(c: StrategyConfig): string {
  const tp = c.takeProfitPct > 0
    ? `buys back at ${Math.round(c.takeProfitPct * 100)}% decay`
    : 'holds to settlement';
  return c.stopLossPct > 0
    ? `${tp}, stop at +${Math.round(c.stopLossPct * 100)}%`
    : `${tp}, no stop`;
}

/** One sentence covering the whole rule, for the list and the form header. */
export function describeStrategy(c: StrategyConfig): string {
  const legs = c.legs === 'both' ? 'a call and a put' : `a ${c.legs === 'CE' ? 'call' : 'put'}`;
  const gate = c.probGate === null
    ? 'no probability gate'
    : `skips a leg below ${Math.round(c.probGate * 1000) / 10}% to expire worthless`;
  const dbl = c.doubleWhenOneSided && c.probGate !== null && c.legs === 'both'
    ? ', and doubles the one that survives alone'
    : '';
  return `At ${c.entryTime} IST on ${describeDays(c.weekdays)}, sells ${legs} `
    + `paying ${describePremium(c)}, ${c.lots} lot${c.lots === 1 ? '' : 's'} each. `
    + `It ${describeEntry(c)}, then ${describeExit(c)} or closes at ${c.exitTime}. `
    + `It ${gate}${dbl}.`
    + (describeAdd(c) ? ` ${describeAdd(c)}` : '');
}

/**
 * The add to the other leg, as one sentence with its own numbers in it -- so
 * "$3" and "2x" are read back while they are being typed, not found out later.
 */
export function describeAdd(c: StrategyConfig): string | null {
  const a = c.addToOpposite;
  if (!a || c.legs !== 'both') return null;
  const min = `$${fmtNum(a.minPriceUsd)}`;
  return `When one leg's target buys contracts back, it sells that many more of the other leg `
    + `while its bid is ${min} or more and it is under ${fmtNum(a.maxMultiple)}x what it was sold for, `
    + `appended to that leg with the same target and stop. Not on a one-sided day, `
    + `and not in the last 30 minutes before ${c.exitTime}.`;
}

/**
 * The rule tried on a few prices, so the numbers can be checked by eye.
 * `sold` is what the other leg was sold at; each row is its bid now.
 */
export function addExamples(a: AddToOpposite, sold = 15, bought = 425): { bid: number; adds: boolean; why: string }[] {
  const cap = sold * a.maxMultiple;
  return [7, a.minPriceUsd, Math.max(0.05, a.minPriceUsd - 1), cap]
    .filter((bid, i, all) => all.indexOf(bid) === i)
    .map((bid) => {
      if (bid < a.minPriceUsd) return { bid, adds: false, why: `below $${fmtNum(a.minPriceUsd)}` };
      if (bid >= cap) return { bid, adds: false, why: `${fmtNum(a.maxMultiple)}x its $${fmtNum(sold)} sale or more` };
      return { bid, adds: true, why: `sells ${bought} more` };
    });
}

const fmtNum = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/0+$/, '').replace(/\.$/, ''));

export type Sizing = {
  /** Contracts on the book at once, in the worst case this config allows. */
  maxContracts: number;
  /** Margin that needs, in USD, at 200x. */
  marginUsd: number;
  marginInr: number;
  /** Share of the account it would tie up, 0-1, or null with no balance yet. */
  shareOfAccount: number | null;
  /** Said out loud when the size is beyond what the account can carry. */
  warnings: string[];
};

/** Margin for one short contract at 200x -- margin.ts's model, spot-driven. */
const MARGIN_PER_CONTRACT = (spot: number) => (spot / 200) * 0.001;

/**
 * What this config would put at risk, in the numbers on the account card.
 *
 * The worst case rather than the typical one: doubling means a one-sided day
 * carries twice the lots, and that is the day the margin has to be there for.
 * A form that quotes the typical size is a form that runs out of margin on the
 * day it matters.
 */
export function sizingOf(
  c: StrategyConfig,
  balanceUsd: number | null,
  spot: number | null,
  usdInr = 85,
): Sizing {
  const legsOn = c.legs === 'both' ? 2 : 1;
  const doubling = c.doubleWhenOneSided && c.probGate !== null && c.legs === 'both';
  // Both legs at one lot, or one leg at two: the same number of contracts.
  // What changes is that doubling can also reach two legs on separate days, so
  // the peak is the larger of the two shapes.
  const maxContracts = Math.max(c.lots * legsOn, doubling ? c.lots * 2 : 0);
  const per = spot && spot > 0 ? MARGIN_PER_CONTRACT(spot) : 0;
  const marginUsd = per * maxContracts;
  const share = balanceUsd && balanceUsd > 0 ? marginUsd / balanceUsd : null;

  const warnings: string[] = [];
  if (share !== null && share > 1) {
    warnings.push(`Needs about $${marginUsd.toFixed(0)} of margin against $${balanceUsd!.toFixed(0)} free — this cannot be funded.`);
  } else if (share !== null && share > 0.5) {
    warnings.push(`Would tie up ${Math.round(share * 100)}% of the account on a single day.`);
  }
  if (c.probGate === null && c.doubleWhenOneSided) {
    warnings.push('Doubling does nothing without the probability gate — no leg is ever refused.');
  }
  if (c.legs !== 'both' && c.doubleWhenOneSided) {
    warnings.push('Doubling needs both legs; a single-leg strategy never has a survivor.');
  }
  if (c.takeProfitPct === 0 && c.stopLossPct === 0) {
    warnings.push('No target and no stop — the position runs to settlement whatever happens.');
  }
  if (c.weekdays.length === 0) warnings.push('No days picked, so this can never run.');
  return {
    maxContracts,
    marginUsd,
    marginInr: marginUsd * usdInr,
    shareOfAccount: share,
    warnings,
  };
}
