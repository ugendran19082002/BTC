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

/**
 * How the strike is chosen at all.
 *
 * Two different questions, and the desk should not pretend they are one:
 * `premium` asks *what does it pay* and takes whichever strike answers; `strict`
 * asks *where does it sit* and takes that one whatever it pays.
 */
export type StrikeRule =
  /** By premium, at least or at most. The rule the 733-day record was measured on. */
  | 'premium'
  /** By position on the board: ATM, OTM 1..n, ITM 1..n. */
  | 'strict'
  /**
   * At the open-interest wall: the heaviest put strike for a PE, the heaviest
   * call strike for a CE, out of the money only.
   *
   * **Untested, and differently untested from the other two.** The premium rule
   * carries a 733-day record. `strict` carries none but is only a way of naming
   * a strike a person already chose. This one is a *claim* -- that the strike
   * carrying the most open interest is a better one to sell -- and open
   * interest is the thing `feature_screen.py` tested as a trading rule and
   * rejected: it did not hold up across 2024, 2025 and 2026 together.
   *
   * It is here because it was asked for and because the desk shows the walls
   * anyway, so selling at one is a thing a person will want to try. The
   * strategy form says what it rests on.
   */
  | 'oiWall';

/** How far from the money a strict rule may reach, either way. */
export const MAX_STRIKE_STEP = 20;

/** 0 -> "ATM", 2 -> "OTM 2", -1 -> "ITM 1". */
export function strikeLabel(step: number): string {
  if (!Number.isFinite(step) || step === 0) return 'ATM';
  return step > 0 ? `OTM ${step}` : `ITM ${-step}`;
}

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
  /**
   * How the strike is chosen: by what it pays (`premium`), or by where it sits
   * on the board (`strict`). A strategy saved before this existed reads as
   * `premium`, which is what it was doing.
   */
  strikeRule: StrikeRule;
  /**
   * Which strike, counted from the money, when `strikeRule` is `strict`.
   *
   *    0   at the money
   *   +n   the nth strike out of the money -- OTM 1, OTM 2, ...
   *   -n   the nth strike in the money     -- ITM 1, ITM 2, ...
   *
   * Counted over the strikes Delta has actually **listed** on that side,
   * nearest the money first. Not over the strike grid: Delta lists $200 apart
   * near the money and $400 further out, so counting in grid steps would name
   * strikes that do not exist.
   *
   * Selling in the money is allowed here because it was asked for, and it is a
   * different trade -- it starts with intrinsic value against it, and the
   * safety gate will refuse it on almost any day it is switched on.
   */
  strikeStep: number;
  /**
   * How much premium a leg must pay, and which way to read it. Read when
   * `strikeRule` is `premium`.
   *
   * `fallbackUsd` is a second number on the same rule, tried only when the
   * first finds no strike at all: "at most $20, and if nothing is at or under
   * $20, the richest strike at or under $50". So it sits above `usd` for
   * `atMost` and below it for `atLeast` -- the direction that finds more
   * strikes. Null or absent is no fallback, which is every strategy saved
   * before it existed.
   */
  premium: { mode: PremiumMode; usd: number; fallbackUsd?: number | null };
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
   * Read when `targetMode` is `pct`, which is every strategy saved before it existed.
   */
  takeProfitPct: number;
  /**
   * Buy back if the mark rises this far above entry, as a fraction of it. Zero
   * means no stop. Above 1 is allowed and normal for a short option: a premium
   * of 5 that triples is a 200% stop. Read when `stopMode` is `pct`.
   */
  stopLossPct: number;
  /** How the target is read: a share of the credit, or points under the entry. Absent is `pct`. */
  targetMode?: ExitMode;
  /** The target as points under the entry price: sold at 15, 10 points buys back at 5. Absent is 0. */
  takeProfitPoints?: number;
  /**
   * The target over the day: from each step's time it becomes that step's
   * value, in `targetMode`'s units, until the next step. Before the first step
   * the plain value above is in force. Absent or empty is one value all day.
   */
  targetSteps?: ExitStep[];
  /** How the stop is read: a share of the entry, or points over it. Absent is `pct`. */
  stopMode?: ExitMode;
  /** The stop as points over the entry price: sold at 15, 10 points buys back at 25. Absent is 0. */
  stopLossPoints?: number;
  /** The stop over the day, the same way `targetSteps` moves the target. */
  stopSteps?: ExitStep[];
  /** Contracts per leg. */
  lots: number;
  legs: LegConfig;
  /**
   * How late an entry may still be taken, in minutes after its time.
   *
   * A desk that was down at 05:30 and comes up at 05:34 should still trade; one
   * that comes up at 09:00 should not, because the record was measured entering
   * at 05:30 and a five-hour-late entry is a different trade wearing its name.
   * How long "still fine" lasts is the strategy's own business: an hour into a
   * twelve-hour contract is nothing, ten minutes into a signal is everything.
   * Absent on strategies written before this existed, which read as 60.
   */
  graceMin: number;
  /** Days it may run. 0 = Sunday … 6 = Saturday. Empty means never. */
  weekdays: number[];
};

/**
 * An exit is read one of two ways.
 *
 *   pct     a fraction: of the credit for a target (0.8 = keep 80%), of the
 *           entry for a stop (1.5 = buy back at 2.5x the entry)
 *   points  a distance in the option's own price: the stop at entry + points,
 *           the target at entry - points
 */
export type ExitMode = 'pct' | 'points';

/** From `at` (IST "HH:MM"), the exit becomes `value`, in its rule's units. Zero turns it off. */
export type ExitStep = { at: string; value: number };

/** One exit, whole: how it is read, where it starts, and how it moves through the day. */
export type ExitRule = { mode: ExitMode; value: number; steps: ExitStep[] };

/** A target can keep at most 99% of the premium: 100% is a buy at zero, which no limit rests at. */
export const MAX_TARGET_PCT = 0.99;
/** A stop may sit far above 100% -- a short option can multiply -- but 2000% is a typo, not a stop. */
export const MAX_STOP_PCT = 20;
/** The most a fixed exit may sit from the entry, in the option's own price. */
export const MAX_EXIT_POINTS = 10_000;
/** More steps than there are hours in a contract is a mistake, not a schedule. */
export const MAX_EXIT_STEPS = 24;

/**
 * The two exits of a config, read the one way everything reads them.
 *
 * A strategy saved before modes and steps existed has neither, and reads as
 * what it was doing: a percentage, the same all day.
 */
export function exitRules(c: StrategyConfig): { target: ExitRule; stop: ExitRule } {
  const targetMode: ExitMode = c.targetMode === 'points' ? 'points' : 'pct';
  const stopMode: ExitMode = c.stopMode === 'points' ? 'points' : 'pct';
  return {
    target: {
      mode: targetMode,
      value: targetMode === 'points' ? (c.takeProfitPoints ?? 0) : c.takeProfitPct,
      steps: c.targetSteps ?? [],
    },
    stop: {
      mode: stopMode,
      value: stopMode === 'points' ? (c.stopLossPoints ?? 0) : c.stopLossPct,
      steps: c.stopSteps ?? [],
    },
  };
}

/**
 * The value of one exit in force at an IST minute of the day, and which stage
 * that is: 0 for the starting value, n for the nth step.
 *
 * Measured forward from the entry, like every other time in a strategy, so a
 * schedule that runs past midnight is the same arithmetic as one that does
 * not. Steps are taken in order; a step whose time has not come is not in
 * force, and nor is anything after it.
 */
export function exitValueAt(
  rule: ExitRule,
  entryTime: string,
  istMinute: number,
): { value: number; stage: number } {
  const entry = minutesOf(entryTime);
  const since = minutesForward(entry, istMinute);
  let value = rule.value;
  let stage = 0;
  rule.steps.forEach((st, i) => {
    if (isHhmm(st.at) && minutesForward(entry, minutesOf(st.at)) <= since) {
      value = st.value;
      stage = i + 1;
    }
  });
  return { value, stage };
}

/** An exit rule's value, as the place and protection calls take it. */
export function exitAsk(rule: ExitRule, value: number, leg: 'target' | 'stop') {
  if (leg === 'target') {
    return rule.mode === 'points' ? { takeProfitPct: 0, takeProfitPoints: value } : { takeProfitPct: value, takeProfitPoints: 0 };
  }
  return rule.mode === 'points' ? { stopLossPct: 0, stopLossPoints: value } : { stopLossPct: value, stopLossPoints: 0 };
}

/** Why one exit value is not usable, in words; null when it is. */
function exitValueProblem(leg: 'target' | 'stop', mode: ExitMode, v: unknown): string | null {
  const Leg = leg === 'target' ? 'Take profit' : 'Stop loss';
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return `${Leg} cannot be negative or blank.`;
  if (mode === 'points') {
    return v > MAX_EXIT_POINTS ? `${Leg} must be at most ${MAX_EXIT_POINTS.toLocaleString('en-US')} points from the entry.` : null;
  }
  if (leg === 'target') return v > MAX_TARGET_PCT ? 'Take profit must be between 0 and 99% of the credit.' : null;
  return v > MAX_STOP_PCT ? 'Stop loss must be between 0 and 2000% of the credit.' : null;
}

/**
 * What is wrong with one exit, start and steps, in words.
 *
 * Every step must fall after the entry and before the exit -- the position is
 * gone by then, and a step it never reaches is a promise the desk cannot keep
 * -- and each after the one before, so the schedule reads top to bottom the
 * way it runs.
 */
export function exitRuleProblems(
  leg: 'target' | 'stop', rule: { mode?: unknown; value: unknown; steps?: unknown },
  entryTime: string | undefined, exitTime: string | undefined,
): string[] {
  const bad: string[] = [];
  const Leg = leg === 'target' ? 'Take profit' : 'Stop loss';
  if (rule.mode !== undefined && rule.mode !== 'pct' && rule.mode !== 'points') {
    bad.push(`${Leg} must be a percentage or points.`);
    return bad;
  }
  const mode: ExitMode = rule.mode === 'points' ? 'points' : 'pct';
  const first = exitValueProblem(leg, mode, rule.value);
  if (first) bad.push(first);
  const steps = rule.steps;
  if (steps === undefined || steps === null) return bad;
  if (!Array.isArray(steps)) { bad.push(`${Leg} steps must be a list.`); return bad; }
  if (steps.length > MAX_EXIT_STEPS) bad.push(`${Leg} can change at most ${MAX_EXIT_STEPS} times a day.`);
  const windowOk = isHhmm(entryTime) && isHhmm(exitTime);
  const entry = windowOk ? minutesOf(entryTime) : 0;
  const span = windowOk ? minutesForward(entry, minutesOf(exitTime)) : 0;
  let last = 0;
  steps.forEach((raw, i) => {
    const st = (raw ?? {}) as Partial<ExitStep>;
    const n = i + 1;
    if (!isHhmm(st.at)) {
      bad.push(`${Leg} step ${n} needs a time of day, like 7:30 AM.`);
    } else if (windowOk) {
      const at = minutesForward(entry, minutesOf(st.at));
      if (at === 0 || at >= span) {
        bad.push(`${Leg} step ${n} (${time12(st.at)}) must be after entry (${time12(entryTime!)}) `
          + `and before exit (${time12(exitTime!)}).`);
      } else if (at <= last) {
        bad.push(`${Leg} step ${n} (${time12(st.at)}) must come after step ${n - 1}.`);
      }
      last = Math.max(last, at);
    }
    const p = exitValueProblem(leg, mode, st.value);
    if (p) bad.push(`Step ${n}: ${p}`);
  });
  return bad;
}

/** A 24-hour "HH:MM". Defined before anything below uses it at load. */
const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

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
  strikeRule: 'premium',
  strikeStep: 0,
  premium: { mode: 'atLeast', usd: 15, fallbackUsd: null },
  entryPrice: 'offer',
  entryLimit: null,
  crossAfterSec: 5,
  maxCrossSpreadPct: 0.15,
  takeProfitPct: 0.95,
  stopLossPct: 0,
  targetMode: 'pct',
  takeProfitPoints: 0,
  targetSteps: [],
  stopMode: 'pct',
  stopLossPoints: 0,
  stopSteps: [],
  lots: 10,
  legs: 'both',
  graceMin: 60,
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
  if (c.strikeRule !== undefined
      && c.strikeRule !== 'premium' && c.strikeRule !== 'strict' && c.strikeRule !== 'oiWall') {
    bad.push('The strike rule must be "premium" or "strict".');
  }
  if (c.strikeRule === 'strict'
      && (!Number.isInteger(c.strikeStep) || Math.abs(c.strikeStep ?? Infinity) > MAX_STRIKE_STEP)) {
    bad.push(`Pick a strike between ITM ${MAX_STRIKE_STEP} and OTM ${MAX_STRIKE_STEP}, or at the money.`);
  }
  const p = c.premium;
  if (!p || (p.mode !== 'atLeast' && p.mode !== 'atMost')) {
    bad.push('Premium rule must be "at least" or "at most".');
  } else if (!(p.usd > 0) || p.usd > 10_000) {
    bad.push('Premium must be a positive number of dollars.');
  } else {
    const f = premiumFallbackProblem(p);
    if (f) bad.push(f);
  }
  // Both fields are always kept, whichever mode reads them, so both are checked.
  if (!(typeof c.takeProfitPct === 'number') || c.takeProfitPct < 0 || c.takeProfitPct > MAX_TARGET_PCT) {
    bad.push('Take profit must be between 0 and 99% of the credit.');
  }
  if (!(typeof c.stopLossPct === 'number') || c.stopLossPct < 0 || c.stopLossPct > MAX_STOP_PCT) {
    bad.push('Stop loss must be between 0 and 2000% of the credit.');
  }
  for (const leg of ['target', 'stop'] as const) {
    const mode = leg === 'target' ? c.targetMode : c.stopMode;
    const points = leg === 'target' ? c.takeProfitPoints : c.stopLossPoints;
    const steps = leg === 'target' ? c.targetSteps : c.stopSteps;
    const value = mode === 'points' ? points : (leg === 'target' ? c.takeProfitPct : c.stopLossPct);
    // The percentage itself was checked just above; only a mode, points and steps are new here.
    const found = exitRuleProblems(leg, { mode, value: value ?? 0, steps }, c.entryTime, c.exitTime)
      .filter((m) => !/^(Take profit|Stop loss) must be between/.test(m));
    bad.push(...found);
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
  if (c.graceMin !== undefined
    && (!Number.isInteger(c.graceMin) || c.graceMin < 1 || c.graceMin > 240)) {
    bad.push('The late-entry window must be a whole number of minutes from 1 to 240.');
  }
  if (!Array.isArray(c.weekdays) || c.weekdays.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) {
    bad.push('Days must be whole numbers from 0 (Sunday) to 6 (Saturday).');
  } else if (c.weekdays.length === 0) {
    bad.push('Pick at least one day, or the strategy can never run.');
  }
  return bad;
}

/**
 * Why a premium fallback is not usable, or null. Shared with the form, word
 * for word, through the browser's copy of this rule.
 */
export function premiumFallbackProblem(p: { mode: PremiumMode; usd: number; fallbackUsd?: number | null }): string | null {
  const f = p.fallbackUsd;
  if (f === null || f === undefined) return null;
  if (typeof f !== 'number' || !(f > 0) || f > 10_000) return 'The fallback premium must be a positive number of dollars.';
  if (p.mode === 'atMost' && !(f > p.usd)) {
    return `The fallback must be above $${p.usd}: it is tried when nothing is at or below $${p.usd}.`;
  }
  if (p.mode === 'atLeast' && !(f < p.usd)) {
    return `The fallback must be below $${p.usd}: it is tried when nothing pays $${p.usd}.`;
  }
  return null;
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
