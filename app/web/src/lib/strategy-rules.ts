import { MAX_STRIKE_STEP, type StrategyConfig } from '@/types/strategy';
import { isHhmm, minutesForward, minutesOf, minutesToSettlement, time12 } from '@/lib/time';

/**
 * What is wrong with a strategy before it is saved, and where on the form.
 *
 * The same rules, and the same words, as `validateConfig` on the server --
 * which stays the authority and answers a save it will not take. These run as
 * the form is edited so the problem is shown beside the field that has it, on
 * the tab it is on, and Save says what is left rather than failing afterwards.
 */

export type FormTab = 'when' | 'sell' | 'trade' | 'extras';

export type FormField =
  | 'name' | 'entryTime' | 'exitTime' | 'weekdays'
  | 'legs' | 'strikeRule' | 'strikeStep' | 'premium' | 'lots'
  | 'entryLimit' | 'crossAfterSec' | 'maxCrossSpreadPct' | 'takeProfitPct' | 'stopLossPct'
  | 'probGate' | 'doubleWhenOneSided' | 'addMinPrice' | 'addMultiple' | 'addUntil' | 'add';

export type Problem = { field: FormField; tab: FormTab; message: string };

const TAB: Record<FormField, FormTab> = {
  name: 'when', entryTime: 'when', exitTime: 'when', weekdays: 'when',
  legs: 'sell', strikeRule: 'sell', strikeStep: 'sell', premium: 'sell', lots: 'sell',
  entryLimit: 'trade', crossAfterSec: 'trade', maxCrossSpreadPct: 'trade', takeProfitPct: 'trade', stopLossPct: 'trade',
  probGate: 'extras', doubleWhenOneSided: 'extras', addMinPrice: 'extras', addMultiple: 'extras', addUntil: 'extras', add: 'extras',
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
  if (!(c.premium.usd > 0) || c.premium.usd > 10_000) say('premium', 'Premium must be a positive number of dollars.');
  if (!Number.isInteger(c.lots) || c.lots < 1) say('lots', 'Lots must be a whole number, at least 1.');

  if (c.entryPrice === 'set' && !((c.entryLimit ?? 0) > 0)) say('entryLimit', 'A set entry needs a price above zero.');
  if (!Number.isInteger(c.crossAfterSec) || c.crossAfterSec < 0 || c.crossAfterSec > 600) {
    say('crossAfterSec', 'Cross-after must be a whole number of seconds from 0 to 600.');
  }
  if (c.maxCrossSpreadPct !== undefined && (!(c.maxCrossSpreadPct > 0) || c.maxCrossSpreadPct > 1)) {
    say('maxCrossSpreadPct', 'The spread limit for selling at the bid must be between 1% and 100%.');
  }
  if (!(c.takeProfitPct >= 0) || c.takeProfitPct > 0.99) say('takeProfitPct', 'Take profit must be between 0 and 99% of the credit.');
  if (!(c.stopLossPct >= 0) || c.stopLossPct > 20) say('stopLossPct', 'Stop loss must be between 0 and 2000% of the credit.');

  if (c.probGate !== null && (!(c.probGate > 0) || c.probGate >= 1)) say('probGate', 'The probability gate must be between 0 and 1, or off.');
  if (c.doubleWhenOneSided && c.legs !== 'both') say('doubleWhenOneSided', 'Doubling the surviving leg needs both legs selected.');
  if (c.doubleWhenOneSided && c.probGate === null) {
    say('doubleWhenOneSided', 'Doubling the surviving leg needs the probability gate on -- without it no leg is ever refused.');
  }

  const add = c.addToOpposite;
  if (add) {
    if (!(add.minPriceUsd > 0) || add.minPriceUsd > 10_000) say('addMinPrice', 'Adding to the other leg needs a minimum price above $0.');
    if (!(add.maxMultiple > 0) || add.maxMultiple > 20) {
      say('addMultiple', 'The "not once it has risen to" limit must be between 0 and 20 times the sale price.');
    }
    if (!isHhmm(add.addUntil)) {
      say('addUntil', 'The latest time to add must be a time of day, like 4:59 PM.');
    } else if (entryOk && exitOk) {
      const entry = minutesOf(c.entryTime);
      const until = minutesForward(entry, minutesOf(add.addUntil));
      if (until === 0 || until >= minutesForward(entry, minutesOf(c.exitTime))) {
        say('addUntil', `The latest time to add (${time12(add.addUntil)}) must be after entry (${time12(c.entryTime)}) `
          + `and before exit (${time12(c.exitTime)}).`);
      }
    }
    if (c.legs !== 'both') say('add', 'Adding to the other leg needs both legs selected.');
    if (!(c.takeProfitPct > 0)) say('add', 'Adding to the other leg needs a target -- it runs when a target fills.');
  }
  return out;
}

/** The problems for one field, joined, or null. */
export const problemFor = (ps: Problem[], field: FormField): string | null => {
  const mine = ps.filter((p) => p.field === field).map((p) => p.message);
  return mine.length ? mine.join(' ') : null;
};
