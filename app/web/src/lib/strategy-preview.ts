import { elseOtmOf, strikeLabel, type StrategyConfig } from '@/types/strategy';
import { ruleTfWords, slFilters, tgtFilters } from '@/types/strategy';
import { time12, wrapsMidnight } from '@/lib/time';
import { exitRules, exitWords, type ExitRule } from '@/lib/strategy-exits';
import { blocksWords } from '@/lib/strategy-blocks';

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
  const f = c.premium.fallbackUsd;
  const fallback = f === null || f === undefined
    ? ''
    : c.premium.mode === 'atLeast'
      ? ` (none? then at least $${f})`
      : ` (none? then the last strike at or below $${f})`;
  const m = c.premium.minOtm;
  // The condition on distance and its else: the pick stands from OTM n outward; nearer, the else strike is sold.
  const floor = m === null || m === undefined ? '' : `, only at ${strikeLabel(m)} or further — else sells ${strikeLabel(elseOtmOf(c.premium)!)}`;
  return (c.premium.mode === 'atLeast'
    ? `at least $${c.premium.usd} — takes the furthest strike still paying it`
    : `at most $${c.premium.usd} — takes the richest strike under it`) + fallback + floor;
}

/**
 * How the strike is chosen, whichever way that is.
 *
 * The rules answer different questions -- what does it pay, where does it sit,
 * where is the open interest -- so the sentence has to say which was asked.
 * Read the whole board: the wall is the heaviest strike Delta lists for the
 * expiry, not the heaviest one the chain table happens to be showing.
 */
export function describeStrike(c: StrategyConfig): string {
  if (c.strikeRule === 'strict') return `at ${strikeLabel(c.strikeStep)}, whatever it pays`;
  if (c.strikeRule === 'oiWall') return 'at the open-interest wall, whatever it pays';
  return `paying ${describePremium(c)}`;
}

export function describeEntry(c: StrategyConfig): string {
  if (c.entryPrice === 'now') return 'crosses immediately at the market';
  if (c.entryPrice === 'set') return `rests at ${c.entryLimit ?? '—'}`;
  return c.crossAfterSec > 0
    ? `rests at the offer, crosses after ${c.crossAfterSec}s if the spread is at most ${Math.round((c.maxCrossSpreadPct ?? 0.15) * 100)}%`
    : 'rests at the offer until it fills';
}

export function describeExit(c: StrategyConfig): string {
  const { target, stop } = exitRules(c);
  // A bought option's exits are sales: the target over the entry, the stop under it.
  if (c.trigger === 'signal' && c.signal?.action === 'buy') {
    const up = target.value > 0
      ? target.mode === 'points' ? `sells ${target.value} pts over the entry`
        : target.mode === 'price' ? `sells at ${target.value}`
          : `sells once up ${Math.round(target.value * 100)}%`
      : 'holds to settlement';
    const down = stop.value > 0
      ? stop.mode === 'points' ? `stop at entry − ${stop.value} pts`
        : stop.mode === 'price' ? `stop at ${stop.value}`
          : `stop at −${Math.round(stop.value * 100)}%`
      : 'no stop';
    return `${up}${ladderWords(target)}, ${down}${ladderWords(stop)}`;
  }
  const tp = target.value > 0
    ? target.mode === 'points'
      ? `buys back ${target.value} pts under the entry`
      : target.mode === 'price'
        ? `buys back at ${target.value}`
        : `buys back at ${Math.round(target.value * 100)}% decay`
    : 'holds to settlement';
  const sl = stop.value > 0
    ? stop.mode === 'points' ? `stop at entry + ${stop.value} pts`
      : stop.mode === 'price' ? `stop at ${stop.value}`
        : `stop at +${Math.round(stop.value * 100)}%`
    : 'no stop';
  return `${tp}${ladderWords(target)}, ${sl}${ladderWords(stop)}`;
}

/** " → 85% at 7:30 AM → 90% at 9:30 AM", or nothing when the exit holds all day. */
function ladderWords(r: ExitRule): string {
  return r.steps.map((st) => ` → ${exitWords(r.mode, st.value)} at ${time12(st.at)}`).join('');
}

/** One sentence covering the whole rule, for the list and the form header. */
/** Whether any option exit is set -- now or by a time step. Off is nothing placed at Delta. */
const hasOptionExit = (c: StrategyConfig) => {
  const { target, stop } = exitRules(c);
  return [target, stop].some((r) => r.value > 0 || r.steps.some((st) => st.value > 0));
};

/** "TGT1", "TGT2 (else TGT1)". */
export const signalTargetLabel = (t: 'tp1' | 'tp2' | 'tp3') => (t === 'tp1' ? 'TGT1' : `TGT${t.slice(2)} (else TGT1)`);

export function describeStrategy(c: StrategyConfig): string {
  if (c.trigger === 'signal' && c.signal) {
    const r = c.signal;
    const n = r.methods.length;
    // The distance filters, where set: "(only with the SL 150+ pts from the entry on 5m, 300 to 900 on 15m; the TGT up to 400 pts from the entry on 5m)".
    const span = (x: { pts: number; max: number }) => (x.pts > 0 && x.max > 0 ? `${x.pts} to ${x.max}` : x.pts > 0 ? `${x.pts}+` : `up to ${x.max}`);
    const side = (name: string, xs: { tf: string; pts: number; max: number }[]) =>
      (xs.length ? `the ${name} ${xs.map((x, i) => `${span(x)} ${i === 0 ? 'pts from the entry ' : ''}on ${x.tf}`).join(', ')}` : null);
    const sides = [side('SL', slFilters(r)), side('TGT', tgtFilters(r))].filter(Boolean);
    const far = sides.length ? ` (only with ${sides.join('; ')})` : '';
    const way = r.mode === 'mtf' ? 'with the timeframe chain' : `without the chain, ${ruleTfWords(r)}${far}`;
    return `From ${time12(c.entryTime)} to ${time12(c.exitTime)} IST on ${describeDays(c.weekdays)}, takes the TRADE signals of `
      + `${n === 0 ? 'no method yet' : `${n} method${n === 1 ? '' : 's'}`} ${way}: ${r.action === 'buy' ? 'a BUY buys a call, a SELL a put' : 'a BUY sells a put, a SELL a call'}, `
      + `${describeStrike(c)}${blocksWords(c)}, ${c.lots} lot${c.lots === 1 ? '' : 's'}, at most ${r.maxOpen} open at once. `
      + `When ${(r.enterOn ?? 'zone') === 'zone' ? 'the BTC perp trades into the signal\'s entry zone' : 'the signal is written'} it ${describeEntry(c)}, then exits when the BTC perp reaches the signal's SL or ${signalTargetLabel(r.target)}; `
      + (hasOptionExit(c) ? `on the option itself it ${describeExit(c)}; ` : 'no option target or stop is placed; ')
      + `whatever is open closes at ${time12(c.exitTime)}. `
      + (c.liveOrders ? 'Live orders ON: it places real orders.' : `Live orders off: it only writes down what it would ${r.action === 'buy' ? 'buy' : 'sell'}.`);
  }
  const legs = c.legs === 'both' ? 'a call and a put' : `a ${c.legs === 'CE' ? 'call' : 'put'}`;
  return `At ${time12(c.entryTime)} IST on ${describeDays(c.weekdays)}, sells ${legs} `
    + `${describeStrike(c)}, ${c.lots} lot${c.lots === 1 ? '' : 's'} each. `
    + `It ${describeEntry(c)}, then ${describeExit(c)} or closes at ${time12(c.exitTime)}`
    + `${wrapsMidnight(c.entryTime, c.exitTime) ? ' the next day' : ''}.`;
}

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
export const MARGIN_PER_CONTRACT = (spot: number) => (spot / 200) * 0.001;

/**
 * What this config would put at risk, in the numbers on the account card.
 *
 * Every leg the strategy sells, at its lots: what is on the book at once.
 */
export function sizingOf(
  c: StrategyConfig,
  balanceUsd: number | null,
  spot: number | null,
  usdInr = 85,
): Sizing {
  // A signal strategy sells one leg per signal, up to `maxOpen` of them at once.
  const legsOn = c.trigger === 'signal' ? (c.signal?.maxOpen ?? 1) : c.legs === 'both' ? 2 : 1;
  const maxContracts = c.lots * legsOn;
  const per = spot && spot > 0 ? MARGIN_PER_CONTRACT(spot) : 0;
  const marginUsd = per * maxContracts;
  const share = balanceUsd && balanceUsd > 0 ? marginUsd / balanceUsd : null;

  const warnings: string[] = [];
  if (share !== null && share > 1) {
    warnings.push(`Needs about $${marginUsd.toFixed(0)} of margin against $${balanceUsd!.toFixed(0)} free — this cannot be funded.`);
  } else if (share !== null && share > 0.5) {
    warnings.push(`Would tie up ${Math.round(share * 100)}% of the account on a single day.`);
  }
  const ex = exitRules(c);
  const anyExit = [ex.target, ex.stop].some((r) => r.value > 0 || r.steps.some((st) => st.value > 0));
  if (!anyExit) {
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
