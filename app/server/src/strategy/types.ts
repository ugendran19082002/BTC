/**
 * A saved strategy: everything the desk needs to place a day's trade without
 * being asked twice.
 *
 * All data, no behaviour, the same way `trading/types.ts` is. The scheduler
 * decides *when* one of these runs and `strategy/run.ts` turns it into orders;
 * neither of them keeps state that is not in here or in the database.
 */

import { METHODS } from '../entry/methods.js';

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
 * A premium rule, whole: the number, which way it reads, its fallback, and the
 * nearest strike it may sell.
 *
 * `minOtm` (4 Oct 2026) is a condition on distance, counted the way a by-strike
 * rule counts: 6 is OTM 6. The premium picks as it always did; a pick at OTM 6
 * or further out stands (OTM 7 is sold as OTM 7). A pick nearer the money than
 * that -- or no pick at all -- is the "else": the strike named by `elseOtm` is
 * sold instead. The two are separate numbers, and may be equal or different:
 * "at least OTM 6, else OTM 8" steps further out when the board is rich, and
 * "else OTM 6" sells the condition's own strike. `elseOtm` absent reads as
 * `minOtm`, which is what the rule did before the else had a strike of its own.
 *
 * A premium number says what a strike pays, not how far it sits, and on a day
 * the board is rich "at most $50" can land two strikes from the money. `minOtm`
 * absent or null is no condition, which is every strategy saved before it
 * existed -- and then `elseOtm` is not read.
 */
export type PremiumRule = {
  mode: PremiumMode; usd: number; fallbackUsd?: number | null;
  minOtm?: number | null; elseOtm?: number | null;
};

/** The strike a premium rule's else sells: its own, or the condition's when none was named. Null when there is no condition. */
export const elseOtmOf = (p: Pick<PremiumRule, 'minOtm' | 'elseOtm'>): number | null =>
  (p.minOtm === null || p.minOtm === undefined ? null : (p.elseOtm ?? p.minOtm));

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
  premium: PremiumRule;
  /**
   * The strike rule over the window (4 Oct 2026), for a signal strategy: from
   * each block's time the strike is picked by that block's rule, until the next
   * block. Before the first block the rule above is in force, the same way
   * `targetSteps` reads. Absent or empty is one rule for the whole window,
   * which is every strategy saved before it existed.
   *
   * A signal strategy takes signals for up to a day, and what a strike pays at
   * 6 PM, with the whole contract ahead of it, is not what it pays an hour
   * before the settlement: one premium number cannot be right at both ends.
   */
  strikeBlocks?: StrikeBlock[];
  /**
   * The lowest premium this strategy may sell, in dollars -- its own floor in
   * place of the desk's ($5, `minPremiumUsd` in the precheck).
   *
   * Absent or null is the desk's floor, which is every strategy saved before
   * this existed (30 Sep 2026). It exists for the late entry: 29 minutes before
   * settlement most strikes pay under $5, and a strategy built to sell them has
   * to say so rather than be refused every day. At least one tick, $0.10.
   */
  minPremiumUsd?: number | null;
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
  /** The target as the price itself, when `targetMode` is `price`. Absent is 0. */
  takeProfitAt?: number;
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
  /** The stop as the price itself, when `stopMode` is `price`: 70 is 70, whatever the entry. Absent is 0. */
  stopLossAt?: number;
  /** The stop over the day, the same way `targetSteps` moves the target. */
  stopSteps?: ExitStep[];
  /**
   * What the stop and the target are watched on.
   *
   * `ltp` fires the moment the mark touches the level, which is what a resting
   * stop at the exchange does and what most desks mean by a stop. `close`
   * waits for the bar to finish: a wick through the level is not a break, and
   * a thin option's mark can print a level nothing traded at.
   *
   * The difference is real money in both directions -- `ltp` exits on noise
   * that a close would have ridden out, `close` gives back the distance
   * between the wick and the close when the move is real -- so it is a choice
   * the operator makes per strategy rather than one the desk makes for them.
   * Absent is `ltp`, which is what the desk did before this existed.
   */
  monitorOn?: MonitorOn;
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
  /**
   * What starts an entry (2 Oct 2026): the clock -- `entryTime`, once a day --
   * or a signal from the desk's entry methods. Absent: the clock, which is what
   * every strategy saved before this did.
   *
   * A signal strategy sells one leg per signal: a BUY is a short put, a SELL a
   * short call (`legOfSignal`), so `legs` is not read. Its `entryTime` to
   * `exitTime` is the window it takes signals in, and anything it holds is
   * closed at `exitTime`, as for the clock.
   */
  trigger?: 'time' | 'signal';
  /** Which signals a signal strategy takes. Read only when `trigger` is 'signal'. */
  signal?: SignalRule;
  /**
   * A signal strategy places real orders only with this on. Off -- the default --
   * it writes down what it would have placed, gates and all, and sends nothing:
   * the entry setups are measured before they are trusted (decision 0013).
   */
  liveOrders?: boolean;
};

/** A signal strategy's rule: which way of reading, which methods, which target, how many at once. */
export type SignalRule = {
  /** With the timeframe chain (entry on 5m), or without it on `tf`. */
  mode: 'mtf' | 'single';
  /** The timeframe of a read without the chain, as first saved; `tfs` is read when present. With the chain, the entry is always 5m. */
  tf: SignalTf;
  /** Without the chain, every timeframe it takes signals on (2 Oct 2026: more than one). Absent: `[tf]`. */
  tfs?: SignalTf[];
  /** The method ids (entry/methods.ts) whose TRADE signals it takes. At least one. */
  methods: string[];
  /** Which of the signal's targets the trade exits at: TGT1, or TGT2 / TGT3 where the signal has them (else TGT1). */
  target: 'tp1' | 'tp2' | 'tp3';
  /** At most this many of its trades open at once; a signal past it is written down and not taken. */
  maxOpen: number;
  /**
   * When the option is sold (2 Oct 2026):
   *
   *   zone    when the perp trades into the signal's entry zone -- the moment
   *           the signal history says "in the trade". Signals that never fill
   *           are never traded, so the strategy takes exactly the trades the
   *           record counts. The default, and absent reads as it.
   *   signal  the moment the signal is written, before the perp reaches the
   *           zone -- sooner, but it also trades the ones that never fill.
   */
  enterOn?: SignalEntry;
  /**
   * Without the chain, per timeframe: the least distance, in BTC points, from
   * the perp entry to the signal's SL for the signal to be taken (4 Oct 2026).
   * `{ '5m': 150 }`: a 5m signal whose stop sits 149 points from the entry is
   * not taken, and written down as skipped with both numbers.
   *
   * A stop a few points from the entry is one the perp's own noise reaches, and
   * the option bought back there has paid the spread twice for nothing; how
   * tight is too tight differs by timeframe, so each has its own number. A
   * timeframe absent, or at 0, has no such filter -- every strategy saved
   * before it. Not read with the chain.
   */
  minSlPts?: Partial<Record<SignalTf, number>>;
  /**
   * The same filter on the other side (4 Oct 2026): per timeframe, the least
   * distance in BTC points from the perp entry to the target the trade exits
   * at -- the rule's `target`, TGT1 where the signal has no TGT2 / TGT3. A
   * target a few points away pays less than the option's spread costs to
   * cross twice. Absent or 0 for a timeframe: no filter. Not read with the chain.
   */
  minTgtPts?: Partial<Record<SignalTf, number>>;
  /**
   * The other end of each (owner, 5 Oct 2026): per timeframe, the most distance in BTC points from the perp
   * entry to the signal's SL, and to its target, for the signal to be taken. A stop a long way off is a loss
   * larger than the option's premium is paid for; a target a long way off is one the day rarely reaches. A
   * signal further than the number is skipped and the history says so. Absent or 0 for a timeframe: no
   * maximum -- every strategy saved before it. Not read with the chain. Where a timeframe has both, the
   * maximum is not under the minimum.
   */
  maxSlPts?: Partial<Record<SignalTf, number>>;
  maxTgtPts?: Partial<Record<SignalTf, number>>;
  /**
   * What is done with the option (owner, 5 Oct 2026): `sell` -- a BUY signal sells the put, a SELL the call,
   * what every signal strategy did before this -- or `buy` -- a BUY signal buys the call, a SELL the put.
   * Absent reads as `sell`.
   *
   * With live orders on, a `buy` strategy buys the option at the offer (engine.ts: bought to open, sold to
   * close, the buyer's gate `precheckBuy`), exits on the signal's perp levels and on its own option target and
   * stop, judged by the desk on the bid; off, each signal is written down as the order it would be.
   */
  action?: SignalAction;
};
export type SignalAction = 'sell' | 'buy';
export const actionOf = (rule: Pick<SignalRule, 'action'> | null | undefined): SignalAction => (rule?.action === 'buy' ? 'buy' : 'sell');
/** A bought option's exits hold one level each: a timetable of them is not built for buying. */
export const BUY_NO_STEPS = 'A BUY strategy\'s option target and stop hold one level each: remove the time steps.';
export type SignalEntry = 'zone' | 'signal';
/** The most an SL-distance filter may ask for: beyond this is a typo, not a filter. */
export const MAX_SL_PTS = 100_000;

/** The least SL distance a rule asks of a signal on this timeframe; 0 is no filter. */
export function minSlPtsFor(rule: Pick<SignalRule, 'mode' | 'minSlPts'>, tf: string): number {
  return ptsFor(rule.mode, rule.minSlPts, tf);
}

/** The least TGT distance a rule asks of a signal on this timeframe; 0 is no filter. */
export function minTgtPtsFor(rule: Pick<SignalRule, 'mode' | 'minTgtPts'>, tf: string): number {
  return ptsFor(rule.mode, rule.minTgtPts, tf);
}

/** The most SL distance a rule allows a signal on this timeframe; 0 is no maximum. */
export function maxSlPtsFor(rule: Pick<SignalRule, 'mode' | 'maxSlPts'>, tf: string): number {
  return ptsFor(rule.mode, rule.maxSlPts, tf);
}

/** The most TGT distance a rule allows a signal on this timeframe; 0 is no maximum. */
export function maxTgtPtsFor(rule: Pick<SignalRule, 'mode' | 'maxTgtPts'>, tf: string): number {
  return ptsFor(rule.mode, rule.maxTgtPts, tf);
}

function ptsFor(mode: SignalRule['mode'], by: Partial<Record<SignalTf, number>> | undefined, tf: string): number {
  if (mode !== 'single') return 0;
  const v = by?.[tf as SignalTf];
  return typeof v === 'number' && v > 0 ? v : 0;
}
/** The default: enter "in the trade". */
export const entersOn = (rule: Pick<SignalRule, 'enterOn'>): SignalEntry => rule.enterOn ?? 'zone';
export type SignalTf = '3m' | '5m' | '15m' | '30m' | '1h' | '2h' | '4h';
export const SIGNAL_TFS: readonly SignalTf[] = ['3m', '5m', '15m', '30m', '1h', '2h', '4h'];
/** "At most open at once" is typed, 1 to this. */
export const MAX_SIGNAL_OPEN = 100;

/**
 * The desk-wide cap on open trades (4 Oct 2026): the setting `signal_max_open`.
 *
 * Each signal strategy has its own "at most open at once", and five strategies
 * each allowed ten is fifty positions on an account whose margin carries a
 * handful -- the order the margin cannot cover is refused by Delta, and a
 * refusal there is a penalty. This is one number over all of them: a signal is
 * not taken while the desk already holds that many open trades, positions and
 * working orders alike, whichever strategy or hand opened them. Zero, or
 * nothing set, is no cap -- the desk as it was before this existed.
 */
export const GLOBAL_MAX_OPEN_KEY = 'signal_max_open';
/** The most the desk-wide cap may be set to. */
export const MAX_GLOBAL_OPEN = 500;
/** The setting as stored, read as a number: 0 when absent or unreadable, which is no cap. */
export function globalMaxOpenOf(raw: string | null | undefined): number {
  const n = Number(raw);
  return raw !== null && raw !== undefined && raw !== '' && Number.isInteger(n) && n > 0 && n <= MAX_GLOBAL_OPEN ? n : 0;
}
/**
 * Why a desk-wide cap cannot be saved, in words; null when it can.
 *
 * `allowed` is what the signal strategies switched on allow between them -- the
 * sum of each one's own "at most open". A cap above that sum can never be
 * reached, and a limit that cannot bind reads as protection it does not give;
 * so it is refused, with the sum, rather than stored. With none switched on
 * there is no sum to hold it to.
 */
export function globalMaxOpenProblem(v: unknown, allowed = 0): string | null {
  if (!(typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= MAX_GLOBAL_OPEN)) {
    return `At most open at once, across all strategies, must be a whole number from 0 (no limit) to ${MAX_GLOBAL_OPEN}.`;
  }
  if (allowed > 0 && v > allowed) {
    return `The strategies switched on allow ${allowed} entr${allowed === 1 ? 'y' : 'ies'} between them, so a limit above ${allowed} changes nothing. Enter ${allowed} or less.`;
  }
  return null;
}

/** What the switched-on signal strategies allow between them: the sum of each one's own "at most open". */
export function signalEntriesAllowed(strategies: readonly Pick<Strategy, 'enabled' | 'config'>[]): number {
  return strategies
    .filter((s) => s.enabled && s.config.trigger === 'signal' && s.config.signal)
    .reduce((n, s) => n + (s.config.signal!.maxOpen ?? 0), 0);
}

/**
 * The leg a signal is traded as -- each wins as the signal goes right. Selling: a BUY sells the put, a SELL
 * the call. Buying: a BUY buys the call, a SELL the put.
 */
export const legOfSignal = (dir: 'long' | 'short' | 1 | -1, action: SignalAction = 'sell'): 'CE' | 'PE' => {
  const up = dir === 'long' || dir === 1;
  return action === 'buy' ? (up ? 'CE' : 'PE') : (up ? 'PE' : 'CE');
};

/** The timeframes a rule without the chain takes: `tfs`, or the one `tf` it was saved with before there could be several. */
export const ruleTfs = (rule: Pick<SignalRule, 'tf' | 'tfs'>): SignalTf[] => (rule.tfs?.length ? rule.tfs : [rule.tf]);

/** Whether a signal strategy takes this read: its way, one of its timeframes, one of its methods. */
export function signalMatches(rule: SignalRule, r: { id: string; mode: string; tf: string }): boolean {
  if (r.mode !== rule.mode) return false;
  if (rule.mode === 'single' && !ruleTfs(rule).includes(r.tf as SignalTf)) return false;
  return rule.methods.includes(r.id);
}

/** How a strike is picked, whole: the three fields of a config that say it. */
export type StrikePick = Pick<StrategyConfig, 'strikeRule' | 'strikeStep' | 'premium'>;

/**
 * From `at` (IST "HH:MM"), strikes are picked by this rule instead of the
 * strategy's own, until the next block. By premium or by strike: the
 * open-interest wall is not offered to a signal strategy, so not here either.
 */
export type StrikeBlock = {
  at: string;
  strikeRule: 'premium' | 'strict';
  strikeStep: number;
  premium: PremiumRule;
};

/** A block for every hour of a contract; more is a mistake, not a schedule. */
export const MAX_STRIKE_BLOCKS = 24;

/**
 * The strike rule in force at an IST minute of the day, and which block that
 * is: 0 for the strategy's own rule, n for the nth block.
 *
 * Measured forward from the entry and taken in order, exactly as `exitValueAt`
 * reads a target's steps, so a window that runs past midnight needs no case of
 * its own.
 */
export function strikePickAt(c: StrategyConfig, istMinute: number): { pick: StrikePick; block: number; from: string } {
  const entry = minutesOf(c.entryTime);
  const since = minutesForward(entry, istMinute);
  let pick: StrikePick = { strikeRule: c.strikeRule, strikeStep: c.strikeStep, premium: c.premium };
  let block = 0;
  let from = c.entryTime;
  (c.strikeBlocks ?? []).forEach((b, i) => {
    if (isHhmm(b.at) && minutesForward(entry, minutesOf(b.at)) <= since) {
      pick = { strikeRule: b.strikeRule, strikeStep: b.strikeStep, premium: b.premium };
      block = i + 1;
      from = b.at;
    }
  });
  return { pick, block, from };
}

/**
 * What is wrong with the strike blocks, in words.
 *
 * Each block starts after the entry and before the exit, and after the block
 * before it -- the same three rules a target's steps keep -- and each carries a
 * rule that would be accepted as the strategy's own.
 */
export function strikeBlockProblems(
  blocks: unknown, entryTime: string | undefined, exitTime: string | undefined,
): string[] {
  if (blocks === undefined || blocks === null) return [];
  if (!Array.isArray(blocks)) return ['The strike blocks must be a list.'];
  const bad: string[] = [];
  if (blocks.length > MAX_STRIKE_BLOCKS) bad.push(`The strike rule can change at most ${MAX_STRIKE_BLOCKS} times in a window.`);
  const windowOk = isHhmm(entryTime) && isHhmm(exitTime);
  const entry = windowOk ? minutesOf(entryTime) : 0;
  const span = windowOk ? minutesForward(entry, minutesOf(exitTime)) : 0;
  let last = 0;
  blocks.forEach((raw, i) => {
    const b = (raw ?? {}) as Partial<StrikeBlock>;
    // The strategy's own rule is block 1 on the screen, so the first of these is block 2.
    const n = i + 2;
    if (!isHhmm(b.at)) {
      bad.push(`Block ${n} needs a time of day, like 9:35 PM.`);
    } else if (windowOk) {
      const at = minutesForward(entry, minutesOf(b.at));
      if (at === 0 || at >= span) {
        bad.push(`Block ${n} (${time12(b.at)}) must start after entry (${time12(entryTime!)}) and before exit (${time12(exitTime!)}).`);
      } else if (at <= last) {
        bad.push(`Block ${n} (${time12(b.at)}) must start after block ${n - 1}.`);
      }
      last = Math.max(last, at);
    }
    if (b.strikeRule !== 'premium' && b.strikeRule !== 'strict') {
      bad.push(`Block ${n}: pick the strike by premium or by strike.`);
    } else if (b.strikeRule === 'strict') {
      if (!Number.isInteger(b.strikeStep) || Math.abs(b.strikeStep ?? Infinity) > MAX_STRIKE_STEP) {
        bad.push(`Block ${n}: pick a strike between ITM ${MAX_STRIKE_STEP} and OTM ${MAX_STRIKE_STEP}, or at the money.`);
      }
    } else {
      const p = b.premium;
      if (!p || (p.mode !== 'atLeast' && p.mode !== 'atMost')) {
        bad.push(`Block ${n}: the premium rule must be "at least" or "at most".`);
      } else if (!(p.usd > 0) || p.usd > 10_000) {
        bad.push(`Block ${n}: the premium must be a positive number of dollars.`);
      } else {
        const f = premiumFallbackProblem(p);
        if (f) bad.push(`Block ${n}: ${f}`);
        for (const m of minOtmProblems(p)) bad.push(`Block ${n}: ${m}`);
      }
    }
  });
  return bad;
}

/**
 * An exit is read one of two ways.
 *
 *   pct     a fraction: of the credit for a target (0.8 = keep 80%), of the
 *           entry for a stop (1.5 = buy back at 2.5x the entry)
 *   points  a distance in the option's own price: the stop at entry + points,
 *           the target at entry - points
 *   price   the level itself: stop at 70, whatever the entry. The balance --
 *           70 minus the entry -- is re-measured from the entry that happens,
 *           and a level on the wrong side of it refuses the order
 */
/** What a stop or target is judged on: the touch, or the bar's close. */
export type MonitorOn = 'ltp' | 'close';

export type ExitMode = 'pct' | 'points' | 'price';

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
/** Bounds for a strategy's entry grace window, in minutes. A day-long grace is not a grace. */
export const GRACE_MIN_MIN = 1;
export const GRACE_MIN_MAX = 240;

/**
 * The two exits of a config, read the one way everything reads them.
 *
 * A strategy saved before modes and steps existed has neither, and reads as
 * what it was doing: a percentage, the same all day.
 */
export function exitRules(c: StrategyConfig): { target: ExitRule; stop: ExitRule } {
  const modeOf = (m: unknown): ExitMode => (m === 'points' || m === 'price' ? m : 'pct');
  const targetMode = modeOf(c.targetMode);
  const stopMode = modeOf(c.stopMode);
  return {
    target: {
      mode: targetMode,
      value: targetMode === 'points' ? (c.takeProfitPoints ?? 0) : targetMode === 'price' ? (c.takeProfitAt ?? 0) : c.takeProfitPct,
      steps: c.targetSteps ?? [],
    },
    stop: {
      mode: stopMode,
      value: stopMode === 'points' ? (c.stopLossPoints ?? 0) : stopMode === 'price' ? (c.stopLossAt ?? 0) : c.stopLossPct,
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
    if (rule.mode === 'price') return { takeProfitPct: 0, takeProfitPoints: 0, takeProfitAt: value };
    return rule.mode === 'points' ? { takeProfitPct: 0, takeProfitPoints: value } : { takeProfitPct: value, takeProfitPoints: 0 };
  }
  if (rule.mode === 'price') return { stopLossPct: 0, stopLossPoints: 0, stopAt: value };
  return rule.mode === 'points' ? { stopLossPct: 0, stopLossPoints: value } : { stopLossPct: value, stopLossPoints: 0 };
}

/** Why one exit value is not usable, in words; null when it is. */
function exitValueProblem(leg: 'target' | 'stop', mode: ExitMode, v: unknown, bought = false): string | null {
  const Leg = leg === 'target' ? 'Take profit' : 'Stop loss';
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return `${Leg} cannot be negative or blank.`;
  if (mode === 'points') {
    return v > MAX_EXIT_POINTS ? `${Leg} must be at most ${MAX_EXIT_POINTS.toLocaleString('en-US')} points from the entry.` : null;
  }
  if (mode === 'price') {
    return v > MAX_EXIT_POINTS ? `${Leg} must be a price of at most ${MAX_EXIT_POINTS.toLocaleString('en-US')}.` : null;
  }
  // Sold: the target is a buy-back under the entry, so at most 99% of the credit; the stop, over it, has no such end.
  // Bought, the two change places: the stop is a sale under the entry -- the premium and no more -- and the target over it is open.
  if (bought) {
    if (leg === 'target') return v > MAX_STOP_PCT ? 'Take profit must be between 0 and 2000% of the premium paid.' : null;
    return v > MAX_TARGET_PCT ? 'Stop loss must be between 0 and 99% of the premium paid: a bought option can lose its premium and no more.' : null;
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
  /** The option is bought, not sold: its stop ends at the premium and its target is open (`exitValueProblem`). */
  bought = false,
): string[] {
  const bad: string[] = [];
  const Leg = leg === 'target' ? 'Take profit' : 'Stop loss';
  if (rule.mode !== undefined && rule.mode !== 'pct' && rule.mode !== 'points' && rule.mode !== 'price') {
    bad.push(`${Leg} must be a percentage, points or a price.`);
    return bad;
  }
  const mode: ExitMode = rule.mode === 'points' || rule.mode === 'price' ? rule.mode : 'pct';
  const first = exitValueProblem(leg, mode, rule.value, bought);
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
    const p = exitValueProblem(leg, mode, st.value, bought);
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
  /**
   * The broker account this strategy belongs to (`strategies.broker_account_id`), given when it is made and
   * never changed. It trades on that account's own desk (trading/service.ts), at the same time as every other
   * active account's strategies trade on theirs; switched off, the account has no desk and the strategy does
   * not enter. Null or absent -- a desk with no account, a seed -- is the default account's.
   */
  accountId?: number | null;
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
  takeProfitAt: 0,
  targetSteps: [],
  stopMode: 'pct',
  stopLossPoints: 0,
  stopLossAt: 0,
  stopSteps: [],
  monitorOn: 'ltp',
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

/** Minutes after the settlement that Delta auctions the new contract, rather than trading it. */
export const LAUNCH_AUCTION_MIN = 5;

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
    bad.push(...minOtmProblems(p));
  }
  // Both fields are always kept, whichever mode reads them, so both are checked.
  // A bought option's exits are the sold one's turned over: its stop ends at the premium, its target is open.
  const bought = c.trigger === 'signal' && c.signal?.action === 'buy';
  if (!(typeof c.takeProfitPct === 'number') || c.takeProfitPct < 0 || c.takeProfitPct > (bought ? MAX_STOP_PCT : MAX_TARGET_PCT)) {
    bad.push(bought ? 'Take profit must be between 0 and 2000% of the premium paid.' : 'Take profit must be between 0 and 99% of the credit.');
  }
  if (!(typeof c.stopLossPct === 'number') || c.stopLossPct < 0 || c.stopLossPct > (bought ? MAX_TARGET_PCT : MAX_STOP_PCT)) {
    bad.push(bought ? 'Stop loss must be between 0 and 99% of the premium paid: a bought option can lose its premium and no more.' : 'Stop loss must be between 0 and 2000% of the credit.');
  }
  for (const leg of ['target', 'stop'] as const) {
    const mode = leg === 'target' ? c.targetMode : c.stopMode;
    const points = leg === 'target' ? c.takeProfitPoints : c.stopLossPoints;
    const at = leg === 'target' ? c.takeProfitAt : c.stopLossAt;
    const steps = leg === 'target' ? c.targetSteps : c.stopSteps;
    const value = mode === 'points' ? points : mode === 'price' ? at : (leg === 'target' ? c.takeProfitPct : c.stopLossPct);
    // The percentage itself was checked just above; only a mode, points and steps are new here.
    const found = exitRuleProblems(leg, { mode, value: value ?? 0, steps }, c.entryTime, c.exitTime, bought)
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
  if (c.minPremiumUsd !== null && c.minPremiumUsd !== undefined
    && (typeof c.minPremiumUsd !== 'number' || !(c.minPremiumUsd >= 0.1) || c.minPremiumUsd > 10_000)) {
    bad.push('The minimum premium must be at least $0.10, or left empty for the desk\'s $5.');
  }
  if (entryOk && minutesOf(c.entryTime!) >= minutesOf(SETTLEMENT) && minutesOf(c.entryTime!) < minutesOf(SETTLEMENT) + LAUNCH_AUCTION_MIN) {
    bad.push(`Delta runs a launch auction for the new contract from 5:30 to 5:35 PM; an entry at ${time12(c.entryTime!)} `
      + 'would be sent into it. Enter at 5:35 PM or later.');
  }
  if (c.legs !== 'CE' && c.legs !== 'PE' && c.legs !== 'both') bad.push('Legs must be CE, PE or both.');
  if (c.graceMin !== undefined
    && (!Number.isInteger(c.graceMin) || c.graceMin < GRACE_MIN_MIN || c.graceMin > GRACE_MIN_MAX)) {
    bad.push(`The late-entry window must be a whole number of minutes from ${GRACE_MIN_MIN} to ${GRACE_MIN_MAX}.`);
  }
  if (!Array.isArray(c.weekdays) || c.weekdays.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) {
    bad.push('Days must be whole numbers from 0 (Sunday) to 6 (Saturday).');
  } else if (c.weekdays.length === 0) {
    bad.push('Pick at least one day, or the strategy can never run.');
  }
  if (c.trigger !== undefined && c.trigger !== 'time' && c.trigger !== 'signal') bad.push('The trigger must be a time or a signal.');
  if (c.trigger === 'signal') bad.push(...signalRuleProblems(c.signal));
  // Blocks are a signal strategy's: the clock enters once, at one time, under one rule.
  if (c.trigger === 'signal') bad.push(...strikeBlockProblems(c.strikeBlocks, c.entryTime, c.exitTime));
  else if (Array.isArray(c.strikeBlocks) && c.strikeBlocks.length > 0) {
    bad.push('Strike blocks are for a signal strategy: a clock strategy enters once, under one rule.');
  }
  if (c.liveOrders !== undefined && typeof c.liveOrders !== 'boolean') bad.push('Live orders must be on or off.');
  // A bought option's target and stop are judged by the desk at one level each (engine.ts `longExitIfReached`): no timetable yet.
  if (c.trigger === 'signal' && c.signal?.action === 'buy' && ((c.targetSteps ?? []).length || (c.stopSteps ?? []).length)) bad.push(BUY_NO_STEPS);
  return bad;
}

/** What is wrong with a signal rule, in words: an empty list when nothing is. */
export function signalRuleProblems(r: Partial<SignalRule> | undefined): string[] {
  if (!r) return ['A signal strategy needs its signals: the way, the timeframe and at least one method.'];
  const bad: string[] = [];
  if (r.mode !== 'mtf' && r.mode !== 'single') bad.push('Pick with the timeframe chain or without it.');
  if (r.mode === 'single') {
    const tfs = Array.isArray(r.tfs) && r.tfs.length ? r.tfs : [r.tf];
    if (tfs.some((t) => !SIGNAL_TFS.includes(t as SignalTf))) bad.push(`Pick a timeframe: ${SIGNAL_TFS.join(', ')}.`);
  }
  const ids = new Set(METHODS.map((m) => m.id));
  if (!Array.isArray(r.methods) || r.methods.length === 0) bad.push('Pick at least one method whose signals to take.');
  else if (r.methods.some((m) => !ids.has(m))) bad.push(`No such method: ${r.methods.filter((m) => !ids.has(m)).join(', ')}.`);
  if (r.target !== 'tp1' && r.target !== 'tp2' && r.target !== 'tp3') bad.push('The target must be TGT1, TGT2 or TGT3.');
  if (r.enterOn !== undefined && r.enterOn !== 'zone' && r.enterOn !== 'signal') bad.push('Enter at the entry zone or at the signal.');
  if (r.action !== undefined && r.action !== 'sell' && r.action !== 'buy') bad.push('Pick whether the option is bought or sold.');
  if (!Number.isInteger(r.maxOpen) || (r.maxOpen ?? 0) < 1 || (r.maxOpen ?? 0) > MAX_SIGNAL_OPEN) {
    bad.push(`At most 1 to ${MAX_SIGNAL_OPEN} of its trades open at once.`);
  }
  // The distance filters -- a least and a most for the SL and for the TGT -- each a number of points per timeframe, held to the same rules.
  for (const [by, a, name] of [[r.minSlPts, 'an', 'SL'], [r.minTgtPts, 'a', 'TGT'], [r.maxSlPts, 'an', 'SL maximum'], [r.maxTgtPts, 'a', 'TGT maximum']] as const) {
    if (by === undefined || by === null) continue;
    if (typeof by !== 'object' || Array.isArray(by)) { bad.push(`The ${name} distances must be given per timeframe.`); continue; }
    for (const [tf, v] of Object.entries(by)) {
      if (!SIGNAL_TFS.includes(tf as SignalTf)) bad.push(`No such timeframe for ${a} ${name} distance: ${tf}.`);
      else if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > MAX_SL_PTS) {
        bad.push(`The ${name} distance for ${tf} must be from 0 to ${MAX_SL_PTS.toLocaleString('en-US')} points.`);
      }
    }
  }
  // A maximum under its own minimum takes no signal at all: said, rather than saved as a strategy that never trades.
  for (const [lo, hi, name] of [[r.minSlPts, r.maxSlPts, 'SL'], [r.minTgtPts, r.maxTgtPts, 'TGT']] as const) {
    if (!lo || !hi || typeof lo !== 'object' || typeof hi !== 'object') continue;
    for (const tf of SIGNAL_TFS) {
      const least = lo[tf], most = hi[tf];
      if (typeof least === 'number' && typeof most === 'number' && least > 0 && most > 0 && most < least) {
        bad.push(`The ${name} maximum for ${tf} (${most}) is under its minimum (${least}): no signal could pass both.`);
      }
    }
  }
  return bad;
}

/**
 * Why a premium fallback is not usable, or null. Shared with the form, word
 * for word, through the browser's copy of this rule.
 */
export function premiumFallbackProblem(p: Pick<PremiumRule, 'mode' | 'usd' | 'fallbackUsd'>): string | null {
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

/**
 * What is wrong with a premium rule's distance condition and its else strike,
 * in words. Shared with the form, word for word. Both are out of the money, 1
 * to 20: a premium rule never sells at or in the money, and nor does its else.
 */
export function minOtmProblems(p: { minOtm?: unknown; elseOtm?: unknown }): string[] {
  const m = p.minOtm;
  if (m === null || m === undefined) return [];
  const otm = (v: unknown) => typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= MAX_STRIKE_STEP;
  const bad: string[] = [];
  if (!otm(m)) bad.push(`The nearest strike a premium rule may sell must be OTM 1 to OTM ${MAX_STRIKE_STEP}, or switched off.`);
  if (p.elseOtm !== null && p.elseOtm !== undefined && !otm(p.elseOtm)) {
    bad.push(`The else strike must be OTM 1 to OTM ${MAX_STRIKE_STEP}.`);
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
