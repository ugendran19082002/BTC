import { MAX_STRIKE_STEP, type StrategyConfig } from '@/types/strategy';
import { isHhmm, minutesForward, minutesOf, minutesToSettlement, time12 } from '@/lib/time';
import { exitRuleProblems, exitRules, premiumFallbackProblem } from '@/lib/strategy-exits';

/**
 * What is wrong with a strategy before it is saved, and where on the form.
 *
 * The same rules, and the same words, as `validateConfig` on the server --
 * which stays the authority and answers a save it will not take. These run as
 * the form is edited so the problem is shown beside the field that has it, on
 * the tab it is on, and Save says what is left rather than failing afterwards.
 */

export type FormTab = 'when' | 'sell' | 'trade';

export type FormField =
  | 'name' | 'entryTime' | 'exitTime' | 'weekdays' | 'graceMin'
  | 'legs' | 'strikeRule' | 'strikeStep' | 'premium' | 'premiumFallback' | 'lots'
  | 'entryLimit' | 'crossAfterSec' | 'maxCrossSpreadPct' | 'takeProfitPct' | 'stopLossPct';

export type Problem = { field: FormField; tab: FormTab; message: string };

const TAB: Record<FormField, FormTab> = {
  name: 'when', entryTime: 'when', exitTime: 'when', weekdays: 'when', graceMin: 'when',
  legs: 'sell', strikeRule: 'sell', strikeStep: 'sell', premium: 'sell', premiumFallback: 'sell', lots: 'sell',
  entryLimit: 'trade', crossAfterSec: 'trade', maxCrossSpreadPct: 'trade', takeProfitPct: 'trade', stopLossPct: 'trade',
};

export function strategyProblems(c: StrategyConfig, name: string): Problem[] {
  const out: Problem[] = [];
  const say = (field: FormField, message: string) => out.push({ field, tab: TAB[field], message });

  if (!name.trim()) say('name', 'Give the strategy a name.');

  const entryOk = isHhmm(c.entryTime);
  const exitOk = isHhmm(c.exitTime);
  if (!entryOk) say('entryTime', 'Entry time must be a time of day, like 5:30 AM.');
  if (!exitOk) say('exitTime', 'Exit time must be a time of day, like 5:29 PM.');
  if (entryOk && exitOk) {
    // Measured forward from the entry, so an exit earlier on the clock means
    // the next morning. What bounds the window is the settlement.
    const entry = minutesOf(c.entryTime);
    const span = minutesForward(entry, minutesOf(c.exitTime));
    if (span === 0) {
      say('exitTime', `Exit (${time12(c.exitTime)}) cannot be the same time as entry.`);
    } else if (span >= minutesToSettlement(entry)) {
      say('exitTime', `Exit (${time12(c.exitTime)}) comes after the 5:30 PM settlement that ends the contract `
        + `entered at ${time12(c.entryTime)}. The last exit is 5:29 PM.`);
    }
  }
  if (!Array.isArray(c.weekdays) || c.weekdays.length === 0) say('weekdays', 'Pick at least one day, or the strategy can never run.');

  if (c.strikeRule === 'strict' && (!Number.isInteger(c.strikeStep) || Math.abs(c.strikeStep) > MAX_STRIKE_STEP)) {
    say('strikeStep', `Pick a strike between ITM ${MAX_STRIKE_STEP} and OTM ${MAX_STRIKE_STEP}, or at the money.`);
  }
  if (!(c.premium.usd > 0) || c.premium.usd > 10_000) {
    say('premium', 'Premium must be a positive number of dollars.');
  } else if (c.strikeRule === 'premium') {
    const f = premiumFallbackProblem(c.premium);
    if (f) say('premiumFallback', f);
  }
  if (!Number.isInteger(c.lots) || c.lots < 1) say('lots', 'Lots must be a whole number, at least 1.');

  if (c.entryPrice === 'set' && !((c.entryLimit ?? 0) > 0)) say('entryLimit', 'A set entry needs a price above zero.');
  if (!Number.isInteger(c.crossAfterSec) || c.crossAfterSec < 0 || c.crossAfterSec > 600) {
    say('crossAfterSec', 'Cross-after must be a whole number of seconds from 0 to 600.');
  }
  if (c.maxCrossSpreadPct !== undefined && (!(c.maxCrossSpreadPct > 0) || c.maxCrossSpreadPct > 1)) {
    say('maxCrossSpreadPct', 'The spread limit for selling at the bid must be between 1% and 100%.');
  }
  // Each exit, start and time steps, in whichever mode it is read -- said under its own box.
  const rules = exitRules(c);
  for (const m of exitRuleProblems('target', rules.target, c.entryTime, c.exitTime)) say('takeProfitPct', m);
  for (const m of exitRuleProblems('stop', rules.stop, c.entryTime, c.exitTime)) say('stopLossPct', m);

  if (!Number.isInteger(c.graceMin) || c.graceMin < 1 || c.graceMin > 240) {
    say('graceMin', 'The late-entry window must be a whole number of minutes from 1 to 240.');
  }
  return out;
}

/** The problems for one field, joined, or null. */
export const problemFor = (ps: Problem[], field: FormField): string | null => {
  const mine = ps.filter((p) => p.field === field).map((p) => p.message);
  return mine.length ? mine.join(' ') : null;
};
