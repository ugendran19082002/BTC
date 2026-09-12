/**
 * A saved strategy: everything the desk needs to place a day's trade without
 * being asked twice.
 *
 * All data, no behaviour, the same way `trading/types.ts` is. The scheduler
 * decides *when* one of these runs and `strategy/run.ts` turns it into orders;
 * neither of them keeps state that is not in here or in the database.
 */

/** Which way the premium rule reads. The two are opposites and both are real. */
export type PremiumMode =
  /**
   * At least this much. Takes the FURTHEST strike still paying it -- richer
   * premium, nearer strike. This is what `precheck.ts` calls minPremiumUsd and
   * what the 733-day record in chain.db was measured on.
   */
  | 'atLeast'
  /**
   * At most this much. Takes the RICHEST strike at or below it -- cheaper
   * premium, further strike. AlgoTest's `Premium <= 15`, and the rule the
   * README describes.
   */
  | 'atMost';

export type LegConfig = 'CE' | 'PE' | 'both';

/**
 * How the entry is priced. The same three the order ticket offers, because a
 * strategy that prices its entry differently from the ticket is a strategy
 * nobody can check by hand.
 */
export type EntryPrice =
  /** Cross now, at the market. Certain fill, pays the spread. */
  | 'now'
  /** Rest at the offer and earn the spread if somebody takes it. */
  | 'offer'
  /** A price you name. */
  | 'set';

export type StrategyConfig = {
  /** IST, 24h, "HH:MM". The daily contract opens at 05:30. */
  entryTime: string;
  /**
   * IST, "HH:MM". Anything still open is closed at this time.
   *
   * 17:29 rather than 17:30: settlement is at 17:30, and an order sent at the
   * settlement is an order sent into an expired contract.
   *
   * May be earlier on the clock than `entryTime`, which means the next morning:
   * enter 11:30 PM, exit 5:30 AM. The window is always read forwards from the
   * entry, and it has to end before the settlement that ends the contract.
   */
  exitTime: string;
  /** How much premium a leg must pay, and which way to read it. */
  premium: { mode: PremiumMode; usd: number };
  /**
   * How the entry is priced.
   *
   * `offer` is the default and it is not a preference: resting at the offer
   * earns the spread instead of paying it, which on this board is worth several
   * per cent of the credit. The record was measured on the bid, so crossing is
   * the conservative case and resting is upside.
   */
  entryPrice: EntryPrice;
  /** The price to work, when `entryPrice` is `set`. Ignored otherwise. */
  entryLimit: number | null;
  /**
   * Seconds to wait at the offer before crossing to the bid.
   *
   * **Zero means rest until it fills**, which is a real choice and not a
   * mistake -- but it is the choice that once left an order showing "short 0"
   * all day. Five seconds is the default: long enough for a maker who will meet
   * you to do so, short enough that the day is not spent waiting.
   *
   * Only applies to `offer`. `now` has already crossed and `set` is a price the
   * person chose to wait at.
   */
  crossAfterSec: number;
  /**
   * Sell into the bid only while the spread is at most this, as a fraction of
   * the mid (0.15 = 15%, the same line the order gate uses).
   *
   * While the spread is wider, the entry waits at the mid instead of walking
   * to the bid, and if it is still unfilled when the entry window closes the
   * rest is cancelled. Only applies to `offer` with a cross-after above zero.
   * Older saved strategies without it read the default.
   */
  maxCrossSpreadPct: number;
  /**
   * Buy back once the mark has fallen this far, as a fraction of the credit.
   * 0.95 is the 95% decay target. Zero means hold to settlement.
   */
  takeProfitPct: number;
  /** Buy back if the mark rises this far above entry. Zero means no stop. */
  stopLossPct: number;
  /** Contracts per leg. */
  lots: number;
  legs: LegConfig;
  /**
   * Refuse a leg the model puts below this to expire worthless. `null` is off.
   *
   * 0.95 is the measured line: legs scoring 95%+ settled at zero 98.85% of the
   * time across the record, and the gate holds in both halves of it.
   */
  probGate: number | null;
  /**
   * When the gate refuses one leg, sell two lots of the one that survived.
   *
   * Worth +36% on the record for no more drawdown, because a leg that passes
   * alone is the safer trade -- profit factor 11.73 against 2.46 for a leg
   * sold beside a partner. Only meaningful with `legs: 'both'` and a gate on.
   */
  doubleWhenOneSided: boolean;
  /**
   * When one leg's target buys contracts back, sell as many more of the other
   * leg -- while that leg is still paying enough, and has not run away. `null`
   * is off, and every strategy saved before this existed reads as off.
   *
   * Sold 425 CE and 425 PE at 15; the CE target buys 425 back at 1 while the
   * PE is at 7: sell 425 more PE at 7, with the PE's own target and stop. The
   * premium the CE has finished earning goes back to work on the PE.
   *
   * Only on a day with both legs. A one-sided day -- the doubled CE 850 -- has
   * no other leg to add to, so nothing happens.
   */
  addToOpposite: AddToOpposite | null;
  /** Days it may run. 0 = Sunday … 6 = Saturday. Empty means never. */
  weekdays: number[];
};

export type AddToOpposite = {
  /**
   * The other leg's bid must be at least this, in dollars. The bid, because it
   * is the least a sell there can get: a mark of 7 over a bid of 2 is not 7.
   */
  minPriceUsd: number;
  /**
   * ...and its mark below this multiple of what it was sold for. 2 means not
   * once it has doubled: a leg that has gone from 15 to 30 is a leg losing
   * money, and adding to it is adding to the loss.
   */
  maxMultiple: number;
  /**
   * The latest IST time an add may be made, "HH:MM". Must fall between the
   * entry and exit times.
   *
   * An add late in the day pays to get in and again to be closed minutes later
   * at the exit, for premium that has almost nothing left to decay. The default
   * is half an hour before the exit.
   */
  addUntil: string;
};

/** A 24-hour "HH:MM". Defined before anything below uses it at load. */
const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;
const DEFAULT_EXIT = '17:29';

/** How long before the exit the default latest-add time sits. */
export const DEFAULT_ADD_CUTOFF_MIN = 30;

/** Half an hour before the exit -- or a minute before, on a strategy shorter than that. */
export function defaultAddUntil(exitTime: string): string {
  const exit = HHMM.test(exitTime) ? minutesOf(exitTime) : minutesOf(DEFAULT_EXIT);
  return hhmmOf(exit - DEFAULT_ADD_CUTOFF_MIN > 0 ? exit - DEFAULT_ADD_CUTOFF_MIN : Math.max(0, exit - 1));
}

export const DEFAULT_ADD_TO_OPPOSITE: AddToOpposite = { minPriceUsd: 3, maxMultiple: 2, addUntil: defaultAddUntil(DEFAULT_EXIT) };

export type Strategy = {
  id: string;
  name: string;
  /** Off by default. A saved strategy that has never been armed does nothing. */
  enabled: boolean;
  config: StrategyConfig;
  createdAt: number;
  updatedAt: number;
};

/** One attempt to run one strategy on one IST day. The audit trail. */
export type StrategyRun = {
  id: number;
  strategyId: string;
  /** IST calendar day, `YYYY-MM-DD`. Unique per strategy: a day runs once. */
  runDate: string;
  status: 'placed' | 'refused' | 'failed' | 'skipped';
  /** Human-readable, and the reason when it did not trade. */
  detail: string;
  at: number;
};

export const DEFAULT_CONFIG: StrategyConfig = {
  entryTime: '05:30',
  exitTime: '17:29',
  premium: { mode: 'atLeast', usd: 15 },
  entryPrice: 'offer',
  entryLimit: null,
  crossAfterSec: 5,
  maxCrossSpreadPct: 0.15,
  takeProfitPct: 0.95,
  stopLossPct: 0,
  lots: 10,
  legs: 'both',
  probGate: 0.95,
  doubleWhenOneSided: true,
  addToOpposite: null,
  weekdays: [0, 1, 2, 3, 4, 5, 6],
};

/** True for a 24-hour "HH:MM", the one form times are stored and sent in. */
export const isHhmm = (v: unknown): v is string => typeof v === 'string' && HHMM.test(v);

/**
 * The daily contract settles at 17:30 IST.
 *
 * A strategy that enters before it holds today's contract, so its exit has to
 * come before it too: an exit at 18:00 closes a position Delta already settled.
 * One that enters at or after it holds tomorrow's contract, so it may run
 * through the night to any time before the next day's 17:30.
 */
export const SETTLEMENT = '17:30';

/**
 * Check a config before it is stored, and say what is wrong in words.
 *
 * Returns the problems rather than throwing, because the screen shows all of
 * them at once and a form that reveals its objections one at a time is a form
 * people give up on.
 */
export function validateConfig(c: Partial<StrategyConfig>): string[] {
  const bad: string[] = [];
  const entryOk = isHhmm(c.entryTime);
  const exitOk = isHhmm(c.exitTime);
  if (!entryOk) bad.push('Entry time must be a time of day, like 5:30 AM.');
  if (!exitOk) bad.push('Exit time must be a time of day, like 5:29 PM.');
  if (entryOk && exitOk) {
    /*
     * Measured forward from the entry, not against the clock, so that an exit
     * earlier in the day than the entry means "tomorrow morning" rather than
     * "impossible". What actually bounds the window is the settlement: whatever
     * was sold has to be bought back before the contract expires.
     */
    const entry = minutesOf(c.entryTime!);
    const span = minutesForward(entry, minutesOf(c.exitTime!));
    if (span === 0) {
      bad.push(`Exit (${time12(c.exitTime!)}) cannot be the same time as entry.`);
    } else if (span >= minutesToSettlement(entry)) {
      bad.push(`Exit (${time12(c.exitTime!)}) comes after the 5:30 PM settlement that ends the contract `
        + `entered at ${time12(c.entryTime!)}. The last exit is 5:29 PM.`);
    }
  }
  const p = c.premium;
  if (!p || (p.mode !== 'atLeast' && p.mode !== 'atMost')) {
    bad.push('Premium rule must be "at least" or "at most".');
  } else if (!(p.usd > 0) || p.usd > 10_000) {
    bad.push('Premium must be a positive number of dollars.');
  }
  if (!(typeof c.takeProfitPct === 'number') || c.takeProfitPct < 0 || c.takeProfitPct > 0.99) {
    bad.push('Take profit must be between 0 and 99% of the credit.');
  }
  if (!(typeof c.stopLossPct === 'number') || c.stopLossPct < 0 || c.stopLossPct > 20) {
    bad.push('Stop loss must be between 0 and 2000% of the credit.');
  }
  if (!Number.isInteger(c.lots) || (c.lots ?? 0) < 1) bad.push('Lots must be a whole number, at least 1.');
  if (c.entryPrice !== 'now' && c.entryPrice !== 'offer' && c.entryPrice !== 'set') {
    bad.push('Entry price must be "now", "offer" or "set".');
  }
  if (c.entryPrice === 'set' && !((c.entryLimit ?? 0) > 0)) {
    bad.push('A set entry needs a price above zero.');
  }
  if (!Number.isInteger(c.crossAfterSec) || (c.crossAfterSec ?? -1) < 0 || (c.crossAfterSec ?? 0) > 600) {
    bad.push('Cross-after must be a whole number of seconds from 0 to 600.');
  }
  if (c.maxCrossSpreadPct !== undefined
      && (!(typeof c.maxCrossSpreadPct === 'number') || !(c.maxCrossSpreadPct > 0) || c.maxCrossSpreadPct > 1)) {
    bad.push('The spread limit for selling at the bid must be between 1% and 100%.');
  }
  if (c.legs !== 'CE' && c.legs !== 'PE' && c.legs !== 'both') bad.push('Legs must be CE, PE or both.');
  if (c.probGate !== null && c.probGate !== undefined
      && (!(c.probGate > 0) || c.probGate >= 1)) {
    bad.push('The probability gate must be between 0 and 1, or off.');
  }
  if (!Array.isArray(c.weekdays) || c.weekdays.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) {
    bad.push('Days must be whole numbers from 0 (Sunday) to 6 (Saturday).');
  } else if (c.weekdays.length === 0) {
    bad.push('Pick at least one day, or the strategy can never run.');
  }
  // Not an error, but the combination does nothing and saying so beats silence.
  if (c.doubleWhenOneSided && c.legs !== 'both') {
    bad.push('Doubling the surviving leg needs both legs selected.');
  }
  if (c.doubleWhenOneSided && (c.probGate === null || c.probGate === undefined)) {
    bad.push('Doubling the surviving leg needs the probability gate on -- without it no leg is ever refused.');
  }
  const add = c.addToOpposite;
  if (add !== null && add !== undefined) {
    if (!(typeof add.minPriceUsd === 'number') || !(add.minPriceUsd > 0) || add.minPriceUsd > 10_000) {
      bad.push('Adding to the other leg needs a minimum price above $0.');
    }
    if (!(typeof add.maxMultiple === 'number') || !(add.maxMultiple > 0) || add.maxMultiple > 20) {
      bad.push('The "not once it has risen to" limit must be between 0 and 20 times the sale price.');
    }
    if (!isHhmm(add.addUntil)) {
      bad.push('The latest time to add must be a time of day, like 4:59 PM.');
    } else if (entryOk && exitOk) {
      // Also measured forward from the entry, so it lands inside an overnight
      // window the same way it lands inside a daytime one.
      const entry = minutesOf(c.entryTime!);
      const toUntil = minutesForward(entry, minutesOf(add.addUntil));
      if (toUntil === 0 || toUntil >= minutesForward(entry, minutesOf(c.exitTime!))) {
        bad.push(`The latest time to add (${time12(add.addUntil)}) must be after entry (${time12(c.entryTime!)}) `
          + `and before exit (${time12(c.exitTime!)}).`);
      }
    }
    if (c.legs !== 'both') bad.push('Adding to the other leg needs both legs selected.');
    if (!((c.takeProfitPct ?? 0) > 0)) bad.push('Adding to the other leg needs a target -- it runs when a target fills.');
  }
  return bad;
}

/** "05:30" -> 330. Times are IST throughout; the desk never uses another one. */
export function minutesOf(hhmm: string): number {
  const [h, m] = hhmm.split(':');
  return Number(h) * 60 + Number(m);
}

/**
 * Minutes forward from one time of day to another, round midnight if it has to.
 * Zero when they are the same time.
 *
 * Every rule about a strategy's day is measured this way, from the entry
 * onwards, so that a window running past midnight -- enter 11:30 PM, exit
 * 5:30 AM -- is the same arithmetic as one inside a single day rather than a
 * special case some checks remember and others forget.
 */
export function minutesForward(fromMinute: number, toMinute: number): number {
  return (((toMinute - fromMinute) % 1440) + 1440) % 1440;
}

/**
 * Minutes from an entry to the settlement that ends the contract it holds.
 *
 * An entry exactly at 17:30 is selling the next day's contract, so its
 * settlement is a full day away rather than zero minutes away.
 */
export function minutesToSettlement(entryMinute: number): number {
  return minutesForward(entryMinute, minutesOf(SETTLEMENT)) || 1440;
}

/** 330 -> "05:30". */
export function hhmmOf(minutes: number): string {
  const m = ((Math.round(minutes) % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

/**
 * "17:29" -> "5:29 PM", for anything a person reads.
 *
 * Stored and sent as 24-hour, because "5:30" alone is two different moments;
 * shown as 12-hour with AM or PM, because that is how the time is read.
 */
export function time12(hhmm: string): string {
  if (!HHMM.test(hhmm)) return hhmm;
  const [h, m] = hhmm.split(':').map(Number) as [number, number];
  return `${h % 12 === 0 ? 12 : h % 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}
