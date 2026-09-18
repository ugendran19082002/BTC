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
  | 'name' | 'entryTime' | 'exitTime' | 'weekdays' | 'graceMin'
  | 'legs' | 'strikeRule' | 'strikeStep' | 'premium' | 'lots'
  | 'entryLimit' | 'crossAfterSec' | 'maxCrossSpreadPct' | 'takeProfitPct' | 'stopLossPct'
  | 'probGate' | 'doubleWhenOneSided' | 'minSellScore' | 'maxShockScore'
  | 'addMinPrice' | 'addMultiple' | 'addUntil' | 'addCrossAfterSec' | 'add'
  | 'rebalance' | 'rebalanceLots' | 'rebalanceSteps' | 'rebalanceUp' | 'rebalanceDown'
  | 'rebalanceIncrement' | 'rebalanceConfirm' | 'rebalanceCap' | 'rebalanceEnd';

export type Problem = { field: FormField; tab: FormTab; message: string };

const TAB: Record<FormField, FormTab> = {
  name: 'when', entryTime: 'when', exitTime: 'when', weekdays: 'when', graceMin: 'when',
  legs: 'sell', strikeRule: 'sell', strikeStep: 'sell', premium: 'sell', lots: 'sell',
  entryLimit: 'trade', crossAfterSec: 'trade', maxCrossSpreadPct: 'trade', takeProfitPct: 'trade', stopLossPct: 'trade',
  probGate: 'extras', doubleWhenOneSided: 'extras', minSellScore: 'extras', maxShockScore: 'extras',
  addMinPrice: 'extras', addMultiple: 'extras', addUntil: 'extras', addCrossAfterSec: 'extras', add: 'extras',
  rebalance: 'extras', rebalanceLots: 'extras', rebalanceSteps: 'extras', rebalanceUp: 'extras',
  rebalanceDown: 'extras', rebalanceIncrement: 'extras', rebalanceConfirm: 'extras',
  rebalanceCap: 'extras', rebalanceEnd: 'extras',
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

  if (!Number.isInteger(c.graceMin) || c.graceMin < 1 || c.graceMin > 240) {
    say('graceMin', 'The late-entry window must be a whole number of minutes from 1 to 240.');
  }
  if (c.probGate !== null && (!(c.probGate > 0) || c.probGate >= 1)) say('probGate', 'The probability gate must be between 0 and 1, or off.');
  if (c.doubleWhenOneSided && c.legs !== 'both') say('doubleWhenOneSided', 'Doubling the surviving leg needs both legs selected.');

  const whole = (v: number) => Number.isInteger(v) && v >= 1 && v <= 100;
  if (c.minSellScore !== null && c.minSellScore !== undefined && !whole(c.minSellScore)) {
    say('minSellScore', 'The sell-score bar must be a whole number from 1 to 100, or off.');
  }
  if (c.maxShockScore !== null && c.maxShockScore !== undefined && !whole(c.maxShockScore)) {
    say('maxShockScore', 'The sudden-move risk limit must be a whole number from 1 to 100, or off.');
  }

  const add = c.addToOpposite;
  if (add) {
    if (!(add.minPriceUsd > 0) || add.minPriceUsd > 10_000) say('addMinPrice', 'Adding to the other leg needs a minimum price above $0.');
    if (!(add.maxMultiple > 0) || add.maxMultiple > 20) {
      say('addMultiple', 'The "not once it has risen to" limit must be between 0 and 20 times the sale price.');
    }
    const cross = add.crossAfterSec;
    if (cross !== null && cross !== undefined && (!Number.isInteger(cross) || cross < 0 || cross > 600)) {
      say('addCrossAfterSec', 'Seconds before the add sells at the bid must be a whole number from 0 to 600.');
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

  /*
   * The rebalance, checked in the browser so the form can point at the box
   * rather than showing a server message after a save. The same checks run
   * again on the server, which is the one that counts.
   */
  const reb = c.rebalance;
  if (reb && reb.enabled) {
    if (c.legs !== 'both') say('rebalance', 'Rebalancing needs both legs selected — there is nothing to rebalance between.');
    if (!Number.isInteger(reb.steps) || reb.steps < 1) say('rebalanceSteps', 'At least one stage.');
    if (!Number.isInteger(reb.lotsPerStep) || reb.lotsPerStep < 1) say('rebalanceLots', 'Lots must be a whole number above zero.');
    if (!(reb.upStartPct > 0)) say('rebalanceUp', 'The first up move must be above 0%.');
    if (!(reb.downStartPct > 0) || reb.downStartPct >= 100) {
      say('rebalanceDown', 'The first down move must be above 0% and under 100% — a premium cannot fall by more than all of itself.');
    }
    if (!(reb.incrementPct >= 0)) say('rebalanceIncrement', 'The step cannot be negative.');
    const lastDown = reb.downStartPct + reb.incrementPct * (reb.steps - 1);
    if (reb.steps >= 1 && lastDown >= 100) {
      say('rebalanceSteps', `Stage ${reb.steps} would need the price to fall ${lastDown}%, which cannot happen. `
        + 'Use fewer stages, a smaller step, or a smaller first down move.');
    }
    if (!Number.isInteger(reb.confirmTicks) || reb.confirmTicks < 1) {
      say('rebalanceConfirm', 'At least one confirming reading.');
    }
    if (reb.maxLotsPerSide !== null && reb.maxLotsPerSide < c.lots) {
      say('rebalanceCap', `The cap (${reb.maxLotsPerSide}) is under the ${c.lots} lots the strategy opens with.`);
    }
    if (!isHhmm(reb.endTime)) {
      say('rebalanceEnd', 'The latest time to rebalance must be a time of day, like 1:30 PM.');
    } else if (entryOk && exitOk) {
      const entry = minutesOf(c.entryTime);
      const until = minutesForward(entry, minutesOf(reb.endTime));
      if (until === 0 || until >= minutesForward(entry, minutesOf(c.exitTime))) {
        say('rebalanceEnd', `The latest time to rebalance (${time12(reb.endTime)}) must be after entry `
          + `(${time12(c.entryTime)}) and before exit (${time12(c.exitTime)}).`);
      }
    }
  }
  return out;
}

/** The problems for one field, joined, or null. */
export const problemFor = (ps: Problem[], field: FormField): string | null => {
  const mine = ps.filter((p) => p.field === field).map((p) => p.message);
  return mine.length ? mine.join(' ') : null;
};
