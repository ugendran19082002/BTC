import { rows } from '../db/pool.js';
import { flowSchema } from '../market/flow.js';
import { optionSnapshotsSchema } from '../market/option-snapshots.js';
import { marksFetchedBy, marksWanted, optionMarksSchema } from '../market/option-marks.js';
import { entrySchema } from '../entry/paper.js';
import { freshInBackground } from '../entry/version.js';
import { methodsSchema } from '../entry/catalogue.js';
import { GST_RATE, fillChargesUsd } from '../trading/charges.js';
import { fundsRequiredPerContract } from '../trading/margin.js';
import { CHAIN_KEY } from '../trading/pnl-history.js';
import { FAMILIES, PATTERNS, candles, familyOf, sessionDayOf, sessionOf, type MinuteBar, type PatternKey } from './market-day.js';
import { marketDays, marketReport, zeroTot, type Tot } from './market-report.js';
import { selectLegs, type Candidate } from '../strategy/select.js';
import { pickMethods } from '../strategy/pick-methods.js';
import { exitMomentFor, istMinutes, istWeekday } from '../strategy/schedule.js';
import {
  DEFAULT_CONFIG, SIGNAL_TFS, actionOf, exitRules, exitValueAt, sideCaps, strikeCapOf, maxSlPtsFor, maxTgtPtsFor, minSlPtsFor, minTgtPtsFor, minutesForward, minutesOf, noEntryWindowAt, ruleTfs, strikePickAt,
  type SignalTf, type Strategy, type StrategyConfig, type StrikeBlock, volSourceOf,
} from '../strategy/types.js';

/**
 * The signal history, traded as options on the prices the contracts really had (owner, 13 Oct 2026).
 *
 * "Can the signal history be backtested on the past contracts' market price? Keep the perp's TGT and SL. I ask
 * because when the perp's SL is hit the contract has often decayed by then, and the trade is a profit."
 *
 * So, for every signal that went "in the trade": an option is sold at the moment of its fill -- the put on a BUY,
 * the call on a SELL, on the contract that settles at the end of that expiry day, at the strike a rule picks from
 * the board as it stood -- and bought back when the perp reaches the signal's stop or its target, or when the
 * option reaches its own target or stop first, or at the end of the window. Priced on the desk's own record of
 * the chain.
 *
 * WHAT IT IS PRICED ON, and what that makes it:
 *
 *   the perp        one-minute highs and lows (`trade_flow_1m`); a bar that holds both levels is taken as the stop.
 *   the option      the whole board A MINUTE AT A TIME wherever there is one (13 Oct 2026: "backtest on one-minute
 *                   option prices; where the database has none, take them from Delta's API"), in this order:
 *                     1. the desk's own one-minute record (`option_snapshots_1m`, kept 90 days from that day on);
 *                     2. before it: Delta's own one-minute mark of each contract (`option_marks_1m`), with the
 *                        bid and the offer put around it at the distance the desk's last five-minute reading
 *                        had them (`minuteBoard`) -- an estimate, and said as one;
 *                     3. where neither has arrived yet: the five-minute record (`option_snapshots`) alone.
 *                   Sold at the BID of the reading nearest the fill, bought back at the OFFER of the first reading
 *                   at or after the exit -- so an exit is priced up to a minute late (five on the days still on
 *                   the five-minute record), and the option's own target and stop are seen only at a reading.
 *   charges         the desk's own (`fillChargesUsd`), on both fills.
 *
 * It takes EVERY signal -- no "at most N open", no margin, no order queue -- so its total is not what an account
 * would have made; what a trade of each kind made, and how often, is what it is for.
 *
 * Pure in `simulateDay`: a day's signals, perp minutes and board in, trades out. The rest reads and adds up.
 */

export type StrikeRule = 'delta' | 'premium';
export type BacktestParams = {
  /** How the strike is picked: the nearest with a delta at most `value` (0.10), or the dearest with a bid at most `value` dollars (50). */
  rule: StrikeRule; value: number;
  lots: number;
  /** The option's own target and stop, as shares of the premium sold: 0.9 buys back at a tenth; 3 at four times. 0 is none. */
  targetPct: number; stopPct: number;
  /** `desk`: only signals filled 9:30 PM to 3:59 PM IST, as the strategies trade. `all`: the whole expiry day. */
  window: 'desk' | 'all' | 'custom';
  /** With `custom`: the signals filled from this IST time to this one ("HH:MM", the end not included); it may run past midnight. */
  hoursFrom?: string; hoursTo?: string;
  /**
   * The desk's own limits (13 Oct 2026, "the At most open, CE max and PE max, in the backtest"): at most this many
   * open at once across every signal traded, 0 for none; and each side at most this per cent of it, as the desk
   * rounds it (`sideCaps`). Absent: none.
   */
  deskMax?: number; cePct?: number; pePct?: number;
  /**
   * The most open on one strike, as the live desk holds it (22 Oct 2026, owner: "strike max and forward to the next
   * strike -- in the backtest and the portfolio too"): this per cent of `deskMax`, at least one (`strikeCapOf`); 100,
   * or absent, none. At it, `strikeFull`: 'next' (the default, as live) has the rule pick again among the strikes
   * further out that are not full, never nearer the money; 'skip' skips the signal.
   */
  strikePct?: number; strikeFull?: 'next' | 'skip';
  /**
   * Take a signal only if its SL and TGT are in range (13 Oct 2026, as the strategy form's): the BTC points from
   * the perp entry to the signal's SL, and to its TGT, at least the minimum and at most the maximum. 0 is off.
   */
  slMin?: number; slMax?: number; tgtMin?: number; tgtMax?: number;
  /**
   * The option's target by the clock (13 Oct 2026, "fixed target, or dynamic time-based -- as the strategy form's"):
   * `targetPct` to begin with, and from each step's IST time the step's share, for every trade open then and every
   * one sold after. Read forward from 5:30 PM, the start of the expiry day, as a strategy's steps are from its entry
   * time. Absent or empty: the one target all day.
   */
  targetSteps?: { at: string; pct: number }[];
  /** Only the signals that filled while the market was this volatile (`volReader`); `off` or absent, all of them. */
  vol?: 'off' | VolLevel;
  /** What that level is read from (`VolBy`): the candles' ATR, the default, or the board's ATM implied volatility. */
  volBy?: VolBy;
  /**
   * An option is not sold for less than this many dollars (owner, 13 Oct 2026: "a minimum premium filter, 10
   * dollars to begin with; 0 switches it off"). Absent: `MIN_PREMIUM`, the strategies' own floor. 0: no floor --
   * anything with a bid is sold.
   */
  minPremium?: number;
  /**
   * Stretches of the hours in which no new entry is taken (owner, 15 Oct 2026: "a no-entry window in the backtest's
   * settings, as the strategy form has"): the strategy's own shape and rule (`noEntryWindowAt`) -- a signal filling
   * inside one is skipped as `no-entry-window`; what is open keeps its exits. Off or absent: none.
   */
  noEntry?: { on: boolean; windows: { from: string; to: string }[] };
  /**
   * A different strike rule by time of day (owner, 18 Oct 2026: "the strategy form's strike blocks, in the backtest and
   * the portfolio"): the rule above is block 1, from the start of the hours; from each block's IST time its own rule --
   * by premium, by strike, by delta or by distance -- as a strategy's `strikeBlocks` are read (`strikePickAt`), held to
   * the form's own rules against these hours. Absent or empty: one rule all day.
   */
  strikeBlocks?: StrikeBlock[];
  /**
   * A trailing stop on the option's own stop (owner, 18 Oct 2026: "TSL in the backtest -- points and per cent; as the
   * price moves from the entry, the SL moves"): every `move` the premium falls from the price sold, the stop comes
   * down `by` -- each in premium points or a per cent of the price sold -- and never goes back up. It needs an
   * option stop to move. Absent: the stop stays where it was set.
   */
  tsl?: Tsl;
  /**
   * The perp's SL and TGT widened with volatility (owner, 18 Oct 2026: "when the signal comes, its PERP SL and PERP TGT
   * are the least; as volatility rises the SL and TGT widen -- checked at every 1m candle close"): after each closed
   * 1m candle, each is at least `widenSlAtr` (`widenTgtAtr`) ATRs of the 1m candles from the perp entry, and never
   * nearer than the signal's own or the widest it has been (asked, 18 Oct: "stay at the widest so far"). A level
   * touched inside a minute is hit then, at the level in force. 0 or absent: the signal's own all trade.
   */
  widenSlAtr?: number; widenTgtAtr?: number;
  /**
   * When volatility falls again (owner, 18 Oct 2026, the two set side by side): `widest`, the default -- kept at the
   * widest so far; `calm` -- widened only while the 1m ATR is over its level at the fill, and back to the signal's own
   * SL and TGT once it is at or under it again.
   */
  widenMode?: WidenMode;
  /**
   * The perp's own levels left out (owner, 18 Oct 2026: "skip perp SL, skip perp TGT -- enable, disable"): a trade
   * not closed when the perp reaches the signal's SL (`skipPerpSl`) or TGT (`skipPerpTgt`) -- only by the option's own
   * target and stop, the exit time or the day's end. Absent: both are used, as on the desk.
   */
  skipPerpSl?: boolean; skipPerpTgt?: boolean;
  /**
   * The option's stop to the price sold once the premium has fallen `move` from it (owner, 18 Oct 2026: "SL to the
   * entry price -- pts and %"): a break-even stop, never loosened, with or without a stop set before it (none set, it
   * is the stop from then on). Beside a trailing SL, the tighter of the two. Absent: off.
   */
  breakEven?: { move: number; unit: TslUnit };
  /**
   * The chase guard (owner, 22 Oct 2026, after the afternoon losses were found on the days BTC ran one way from the
   * morning: "B: chase 11:00, 400pt -- in the backtest settings, to test"): from `after` (IST), a signal that would
   * sell the way BTC has already moved `pts` or more since `from` is skipped as `chase` -- a buy (a PE sold) after a
   * rise, a sell (a CE sold) after a fall. The move is the perp's last minute closed before the fill against its
   * minute at `from`, of the same expiry day. A backtest's alone: the live desk takes such signals. Absent: off.
   */
  chase?: Chase;
};
export type Chase = { from: string; after: string; pts: number };
export type WidenMode = 'widest' | 'calm';
export const WIDEN_MODES: readonly WidenMode[] = ['widest', 'calm'];
/** The most the perp's widening may ask for, in ATRs of the 1m candles: a 1m ATR is a few tens of points. */
export const WIDEN_ATR_MAX = 100;
/** The ATR the widening reads: Wilder's, 14 one-minute candles. */
export const WIDEN_ATR_BARS = 14;
/**
 * Wilder's ATR of minute bars, each bar's from that bar and the ones before it (NaN until there are enough). The
 * minutes are the day's own, as the desk would have had them at each close.
 */
export function minuteAtr(bars: readonly MinuteBar[], n = WIDEN_ATR_BARS): Float64Array {
  const out = new Float64Array(bars.length).fill(Number.NaN);
  let a = 0;
  for (let i = 1; i < bars.length; i++) {
    const b = bars[i]!, p = bars[i - 1]!;
    const tr = Math.max(b.high - b.low, Math.abs(b.high - p.close), Math.abs(b.low - p.close));
    if (i <= n) { a += tr; if (i === n) { a /= n; out[i] = a; } } else { a = (a * (n - 1) + tr) / n; out[i] = a; }
  }
  return out;
}
/**
 * One closed minute of the widening: each level at least so many ATRs from the entry -- moved only further out, so
 * neither is ever nearer than the signal's own nor than the widest it has been. Pure: the simulation and its tests
 * ask the same question.
 */
export function widenAfter(lv: { stop: number; target: number }, o: {
  dir: 1 | -1; entry: number; atr: number; slAtr: number; tgtAtr: number;
  /** `calm`: at or under `baseAtr` (the ATR at the fill), back to the signal's own `own` levels. */
  mode?: WidenMode; baseAtr?: number; own?: { stop: number; target: number };
}): { stop: number; target: number } {
  if (!(o.atr > 0)) return lv;
  if (o.mode === 'calm' && o.own && o.baseAtr !== undefined && o.baseAtr > 0 && o.atr <= o.baseAtr) return o.own;
  const slWant = o.slAtr * o.atr, tgWant = o.tgtAtr * o.atr;
  return {
    stop: o.slAtr > 0 && slWant > Math.abs(o.entry - lv.stop) ? o.entry - o.dir * slWant : lv.stop,
    target: o.tgtAtr > 0 && tgWant > Math.abs(lv.target - o.entry) ? o.entry + o.dir * tgWant : lv.target,
  };
}
export type TslUnit = 'pts' | 'pct';
export const TSL_UNITS: readonly TslUnit[] = ['pts', 'pct'];
export type Tsl = { move: number; moveUnit: TslUnit; by: number; byUnit: TslUnit };
/** The most a TSL step may be: points of premium, or a per cent of the price sold. */
export const TSL_MAX: Record<TslUnit, number> = { pts: 1_000, pct: 100 };
/** One step in dollars of premium, for an option sold at `entry`. */
const tslAmount = (v: number, unit: TslUnit, entry: number) => (unit === 'pts' ? v : (v / 100) * entry);
/**
 * How far a trailing stop has come down, in dollars of premium: one `by` for every whole `move` the best offer since
 * the sale is under the price sold. Pure: the simulation and its tests ask the same question.
 */
export function tslTrail(t: Tsl, entry: number, best: number): number {
  const move = tslAmount(t.move, t.moveUnit, entry);
  if (!(move > 0) || !(best < entry)) return 0;
  const steps = Math.floor((entry - best) / move + 1e-9);
  return steps > 0 ? steps * tslAmount(t.by, t.byUnit, entry) : 0;
}
/** A TSL's settings checked, in the words the screen says them; [] when right. */
export function tslProblems(t: Tsl, stopPct: number): string[] {
  const bad: string[] = [];
  for (const [v, u, what] of [[t.move, t.moveUnit, 'The price move'], [t.by, t.byUnit, 'The SL move']] as const) {
    if (!TSL_UNITS.includes(u)) bad.push(`${what} is in points or per cent.`);
    else if (!(Number.isFinite(v) && v > 0 && v <= TSL_MAX[u])) bad.push(`${what} is more than 0 and at most ${u === 'pts' ? `${TSL_MAX.pts} points` : '100%'}.`);
  }
  if (!bad.length && t.moveUnit === t.byUnit && t.by > t.move) bad.push('The SL cannot move further than the price did: the SL move must be at most the price move.');
  if (!(stopPct > 0)) bad.push('A trailing SL needs an option stop to move: set the option stop.');
  return bad;
}
/** Whether the best offer since the sale has fallen far enough from it for the stop to go to the price sold. */
export const breakEvenReached = (be: { move: number; unit: TslUnit }, entry: number, best: number): boolean =>
  be.move > 0 && entry - best >= tslAmount(be.move, be.unit, entry) - 1e-9;
/** A break-even's setting checked, in the screen's words; [] when right. */
export function breakEvenProblems(be: { move: number; unit: TslUnit }): string[] {
  if (!TSL_UNITS.includes(be.unit)) return ['The move to break-even is in points or per cent.'];
  return Number.isFinite(be.move) && be.move > 0 && be.move <= TSL_MAX[be.unit] ? [] : [`The move to break-even is more than 0 and at most ${be.unit === 'pts' ? `${TSL_MAX.pts} points` : '100%'}.`];
}
/** "every 5 pts, SL 5 pts" -- the setting as a query (`?tsl=5pts:5pts`) and back. */
export const tslQueryOf = (t: Tsl) => `${t.move}${t.moveUnit}:${t.by}${t.byUnit}`;

/**
 * How volatile the market was at a moment (owner, 13 Oct 2026: "a volatility filter: off, low, medium, high --
 * default off"): the mean true range of the last two hours of 15-minute candles, over the mean 15-minute ATR of
 * the five expiry days before. Under `VOL_LOW` is low, over `VOL_HIGH` high, between them medium.
 *
 * Read at the signal's own fill from candles already closed, so it is something the desk could have known then --
 * a filter that can be asked of a live signal, not a label put on the day afterwards.
 */
export type VolLevel = 'low' | 'medium' | 'high';
export const VOL_LEVELS: readonly VolLevel[] = ['low', 'medium', 'high'];
export const VOL_LOW = 0.8;
export const VOL_HIGH = 1.3;
/** The candles looked back over, and the fewest of them that say anything. */
export const VOL_CANDLES = 8;
const VOL_MIN_CANDLES = 4;

/**
 * A day's reader: the level at any moment of it. `bars` run from two hours before the day begins, so its first
 * signals have candles behind them; `baseline` is the mean ATR of the five expiry days before, null where there
 * are none -- and then, as with too few candles, there is no level to say.
 */
export function volReader(bars: readonly MinuteBar[], baseline: number | null): (at: number) => VolLevel | null {
  const c15 = candles(bars, 900);
  const tr = c15.map((c, i) => (i === 0 ? c.high - c.low : Math.max(c.high - c.low, Math.abs(c.high - c15[i - 1]!.close), Math.abs(c.low - c15[i - 1]!.close))));
  return (at) => {
    if (baseline === null || !(baseline > 0)) return null;
    // The candles closed by then: one that began less than fifteen minutes before is still forming.
    let end = c15.length;
    while (end > 0 && c15[end - 1]!.at + 900_000 > at) end--;
    const recent = tr.slice(Math.max(0, end - VOL_CANDLES), end);
    if (recent.length < VOL_MIN_CANDLES) return null;
    const ratio = recent.reduce((a, x) => a + x, 0) / recent.length / baseline;
    return ratio < VOL_LOW ? 'low' : ratio > VOL_HIGH ? 'high' : 'medium';
  };
}

/**
 * What the level is read from (owner, 17 Oct 2026: "Volatility by: ATR 2h / ATM straddle"). `atr`, the default, is
 * `volReader`'s candles. `iv` is what the market PRICES the move at: the at-the-money implied volatility of the
 * contract the signal would sell. The straddle itself was not used: on a daily contract it shrinks with the clock
 * alone (theta), so a 3 PM signal would always read low and a 9:30 PM one high; the IV is the straddle with the time
 * to expiry taken out.
 */
export type VolBy = 'atr' | 'iv';
export const VOL_BYS: readonly VolBy[] = ['atr', 'iv'];
/** The ATM implied volatility at one reading of the board: the call's and the put's nearest the money, averaged. */
export type AtmIv = { at: number; iv: number };
/** A reading older than this at a signal's fill says nothing about it (the five-minute record, and a minute's grace). */
export const IV_STALE_MS = 6 * 60_000;
/** The expiry days before that a day's levels are cut from. */
export const IV_DAYS = 5;
/** The fewest readings an hour (or, failing that, the whole of the days before) must have to cut levels from. */
export const IV_MIN_READINGS = 30;
const hourOfDay = (at: number) => Math.floor(slotOf(at) / 4);

/** Each reading's ATM IV from the board's at-the-money rows (one a side, nearest the money): the two sides averaged, or the one there is. */
export function atmIvOf(xs: readonly { at: number; cp: 'C' | 'P'; iv: number | null }[]): AtmIv[] {
  const by = new Map<number, number[]>();
  for (const x of xs) {
    if (x.iv === null || !(x.iv > 0)) continue;
    const ys = by.get(x.at);
    if (ys) ys.push(x.iv); else by.set(x.at, [x.iv]);
  }
  return [...by].map(([at, ys]) => ({ at, iv: ys.reduce((a, v) => a + v, 0) / ys.length })).sort((a, b) => a.at - b.at);
}

/**
 * A day's IV reader: the level at any moment of it, from the newest reading at or before that moment -- none in the
 * last `IV_STALE_MS`, no level. The levels are thirds of the IV in the `IV_DAYS` expiry days before, in the same
 * hour of the expiry day (the IV of a contract hours from settling is not the IV of one a day away); an hour with
 * too few readings is cut from all of them; too few in all, no level. Nothing of the day itself goes into its own
 * cut-offs, so a level is something the desk could have known at the fill.
 */
export function ivReader(today: readonly AtmIv[], prior: readonly AtmIv[]): (at: number) => VolLevel | null {
  const all: number[] = [];
  const byHour = new Map<number, number[]>();
  for (const r of prior) {
    if (!(r.iv > 0)) continue;
    all.push(r.iv);
    const h = hourOfDay(r.at), xs = byHour.get(h);
    if (xs) xs.push(r.iv); else byHour.set(h, [r.iv]);
  }
  const thirds = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return { lo: s[Math.floor(s.length / 3)]!, hi: s[Math.floor((2 * s.length) / 3)]! }; };
  const pooled = all.length >= IV_MIN_READINGS ? thirds(all) : null;
  const cuts = new Map<number, { lo: number; hi: number } | null>();
  const cutAt = (h: number) => {
    if (!cuts.has(h)) { const xs = byHour.get(h); cuts.set(h, xs && xs.length >= IV_MIN_READINGS ? thirds(xs) : pooled); }
    return cuts.get(h)!;
  };
  const xs = [...today].sort((a, b) => a.at - b.at);
  return (at) => {
    let lo = 0, hi = xs.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (xs[mid]!.at <= at) lo = mid + 1; else hi = mid; }
    const r = xs[lo - 1];
    if (!r || at - r.at > IV_STALE_MS) return null;
    const c = cutAt(hourOfDay(at));
    if (!c) return null;
    return r.iv < c.lo ? 'low' : r.iv > c.hi ? 'high' : 'medium';
  };
}
/** The start of an expiry day on the IST clock: what a backtest's own time steps are read forward from. */
export const DAY_START_IST = '17:30';
export const DEFAULT_PARAMS: BacktestParams = { rule: 'delta', value: 0.1, lots: 10, targetPct: 0.9, stopPct: 3, window: 'desk', deskMax: 0, cePct: 100, pePct: 100 };
/** The desk's limits of a set of settings: null with none. */
export type DeskCaps = {
  max: number; side: { CE: number; PE: number } | null;
  /** The most open on one strike (`strikePct` of `max`); null, none. And what a signal does at it. */
  strike: number | null; strikeFull: 'next' | 'skip';
};
export function deskCapsOf(p: Pick<BacktestParams, 'deskMax' | 'cePct' | 'pePct' | 'strikePct' | 'strikeFull'>): DeskCaps | null {
  const max = p.deskMax ?? 0;
  if (!(max > 0)) return null;
  return {
    max, side: sideCaps(max, { CE: p.cePct ?? 100, PE: p.pePct ?? 100 }),
    strike: strikeCapOf(max, p.strikePct ?? 100), strikeFull: p.strikeFull === 'skip' ? 'skip' : 'next',
  };
}
/** An option is not sold for less than this, as the strategies' own floor; a backtest may set its own (`minPremium`). */
export const MIN_PREMIUM = 10;
const CONTRACT_VALUE = 0.001;
const MIN = 60_000;
/** The board reading a fill is priced on is at most this far from it. */
const BOARD_NEAR_MS = 5 * MIN;

/** `option-tsl`: the option's stop, after a trailing stop had moved it; `option-be` at the price sold (break-even) */
export type BtExit = 'perp-tgt' | 'perp-sl' | 'option-tgt' | 'option-sl' | 'option-tsl' | 'option-be' | 'window-end';
export const BT_EXITS: readonly BtExit[] = ['perp-tgt', 'perp-sl', 'option-tgt', 'option-sl', 'option-tsl', 'option-be', 'window-end'];
export type BtSkip = 'outside-window' | 'no-entry-window' | 'distance' | 'chase' | 'volatility' | 'at-limit' | 'desk-limit' | 'side-limit' | 'strike-limit' | 'no-board' | 'no-strike' | 'no-exit-price';
export const BT_SKIPS: readonly BtSkip[] = ['outside-window', 'no-entry-window', 'distance', 'chase', 'volatility', 'at-limit', 'desk-limit', 'side-limit', 'strike-limit', 'no-board', 'no-strike', 'no-exit-price'];
const noSkips = (): Record<BtSkip, number> => ({ 'outside-window': 0, 'no-entry-window': 0, distance: 0, chase: 0, volatility: 0, 'at-limit': 0, 'desk-limit': 0, 'side-limit': 0, 'strike-limit': 0, 'no-board': 0, 'no-strike': 0, 'no-exit-price': 0 });

export type BtSignal = {
  method: string; mode: 'single' | 'mtf'; tf: string; dir: 1 | -1; filledAt: number; fillPrice: number; stop: number;
  /** TGT1, and the further targets where the signal has them: a strategy may be set to exit at TGT2 or TGT3. */
  target: number; tp2?: number | null; tp3?: number | null;
  /**
   * The bar the setup triggered on, epoch seconds: with the method, the way, the time frame and the direction it is
   * what the live desk keys a signal by (`strategy_signal_runs.signal_key`), so a backtested trade can be matched
   * with the order the desk did or did not place for it (`liveCheckHere`). Plays no part in the backtest itself.
   */
  triggerAt?: number;
};
export type BoardRow = {
  at: number; cp: 'C' | 'P'; strike: number; spot: number | null; bid: number | null; ask: number | null; mark: number | null; delta: number | null; oi?: number | null;
  /** Set on a minute the desk did not record: Delta's mark, with the spread of the desk's last reading around it. */
  est?: boolean;
};

/** One contract's minute from Delta's mark candles: its mark as the minute opened, which is when the desk's own record reads a minute. */
export type MarkMinute = { cp: 'C' | 'P'; strike: number; at: number; open: number };
/** What a day's options were priced on: the desk's own minutes, Delta's mark a minute at a time, or the five-minute record alone. */
export type BoardGrain = 'own-1m' | 'mark-1m' | '5m';
export const BOARD_GRAINS: readonly BoardGrain[] = ['own-1m', 'mark-1m', '5m'];
/** A spread is carried from a reading no older than this: two five-minute readings, so one missed does not leave a hole. */
const SPREAD_KEEP_MS = 10 * 60_000;
/** A day is "a minute at a time" when this share of its minutes has a reading. */
const MINUTE_SHARE = 0.8;

/**
 * A day's board a minute at a time, from what there is: the desk's own minute readings first, its five-minute
 * readings where a minute has none, and -- for a contract and a minute neither has -- Delta's mark with the bid
 * and the offer as far from it as they stood at the desk's last reading of that contract. The delta, BTC and the
 * open interest of an estimated minute are that reading's too. Pure; oldest first.
 *
 * Only a reading at or before the minute is used for the spread, never a later one: nothing in a minute's row
 * was unknown at that minute.
 */
export function minuteBoard(o: { five: readonly BoardRow[]; own: readonly BoardRow[]; marks: readonly MarkMinute[] }): { board: BoardRow[]; grain: BoardGrain } {
  const real = new Map<string, BoardRow[]>();
  const put = (r: BoardRow) => { const k = `${r.cp}${r.strike}`; const xs = real.get(k); if (xs) xs.push(r); else real.set(k, [r]); };
  const seen = new Set<string>();
  for (const r of o.own) { seen.add(`${r.cp}${r.strike}|${r.at}`); put(r); }
  for (const r of o.five) if (!seen.has(`${r.cp}${r.strike}|${r.at}`)) put(r);
  const board: BoardRow[] = [];
  for (const xs of real.values()) { xs.sort((a, b) => a.at - b.at); board.push(...xs); }
  const byContract = new Map<string, MarkMinute[]>();
  for (const m of o.marks) { const k = `${m.cp}${m.strike}`; const xs = byContract.get(k); if (xs) xs.push(m); else byContract.set(k, [m]); }
  for (const [k, ms] of byContract) {
    const xs = real.get(k);
    if (!xs) continue;
    ms.sort((a, b) => a.at - b.at);
    let i = 0;
    for (const m of ms) {
      while (i + 1 < xs.length && xs[i + 1]!.at <= m.at) i++;
      const prior = xs[i]!;
      if (prior.at >= m.at || m.at - prior.at > SPREAD_KEEP_MS || prior.mark === null || !(prior.mark > 0) || !(m.open >= 0)) continue;
      const ask = prior.ask === null || !(prior.ask > 0) ? null : m.open + (prior.ask - prior.mark);
      board.push({
        at: m.at, cp: m.cp, strike: m.strike, spot: prior.spot, mark: m.open, delta: prior.delta, oi: prior.oi ?? null, est: true,
        bid: prior.bid === null ? null : Math.max(0, m.open - (prior.mark - prior.bid)),
        ask: ask !== null && ask > 0 ? ask : null,
      });
    }
  }
  board.sort((a, b) => a.at - b.at);
  const times = new Set<number>(), ownTimes = new Set<number>();
  for (const r of board) times.add(r.at);
  for (const r of o.own) ownTimes.add(r.at);
  const span = board.length ? (board[board.length - 1]!.at - board[0]!.at) / 60_000 + 1 : 0;
  const grain: BoardGrain = span > 0 && ownTimes.size >= MINUTE_SHARE * span ? 'own-1m' : span > 0 && times.size >= MINUTE_SHARE * span ? 'mark-1m' : '5m';
  return { board, grain };
}
export type BtTrade = {
  signal: BtSignal; cp: 'C' | 'P'; strike: number; lots: number;
  entryAt: number; entry: number; exitAt: number; exit: number; by: BtExit;
  /** Dollars after charges. */
  netUsd: number;
  /** The charges on both fills, dollars: the exchange's fee and its GST (`fillChargesUsd`). */
  chargesUsd: number;
  /** How volatile the market was when its signal filled; null where that could not be said. */
  vol: VolLevel | null;
  /** The margin it held while open, dollars: the desk's own estimate at 200x (`fundsRequiredPerContract`), as the Signal Strategies card prices it. */
  marginUsd: number;
  /** What the same trade made on the perp, in points: to the level reached, or to the perp's price at the window's end. */
  perpPts: number;
  /** The option's own target and stop as they stood when it was sold; null where the rules set none. For the trade list. */
  optTgt?: number | null; optStop?: number | null;
  /** Where a trailing stop had brought the option's stop by the exit; absent where it never moved. */
  optStopEnd?: number;
  /** Where the widening had taken the perp's SL and target by the exit; absent where they never moved. */
  perpStopEnd?: number; perpTgtEnd?: number;
  /** The perp level that ends it at its target, as the rules read the signal (TGT1, 2 or 3). */
  perpTgt?: number;
  /** Sold here because the strike its rule picked first was full (`strikePct`, 'next'): that strike. */
  fwdFrom?: number;
};

/** The strike a rule picks from one side of one reading of the board: out of the money, with a bid worth selling. Null with none. */
export function pickStrike(board: readonly BoardRow[], cp: 'C' | 'P', p: Pick<BacktestParams, 'rule' | 'value' | 'minPremium'>): BoardRow | null {
  const floor = p.minPremium ?? MIN_PREMIUM;
  const otm = board.filter((r) => r.cp === cp && r.spot !== null && (cp === 'P' ? r.strike < r.spot : r.strike > r.spot)
    && r.bid !== null && r.bid > 0 && r.bid >= floor && r.ask !== null && r.ask > 0);
  // Two strikes level on the rule (the same bid, far out, is common): the nearer the money, as the desk walks the
  // board outward -- never whichever the database happened to return first (13 Oct 2026).
  const nearer = (a: BoardRow, b: BoardRow) => Math.abs(a.strike - a.spot!) - Math.abs(b.strike - b.spot!);
  if (p.rule === 'delta') {
    // The nearest to the money whose delta is still inside the limit.
    const ok = otm.filter((r) => r.delta !== null && Math.abs(r.delta) <= p.value + 1e-9);
    return ok.sort((a, b) => Math.abs(b.delta!) - Math.abs(a.delta!) || nearer(a, b))[0] ?? null;
  }
  // The dearest that is still at or under the price.
  return otm.filter((r) => r.bid! <= p.value + 1e-9).sort((a, b) => b.bid! - a.bid! || nearer(a, b))[0] ?? null;
}

/**
 * What a backtest does with a signal: whether it is taken, which strike and how many lots, where the perp's
 * target is, the option's own exits, and how many may be open at once. Made from the screen's own settings
 * (`planOfParams`) or from a saved strategy's rules (`planOfStrategy`).
 */
export type DayPlan = {
  /** Why this signal is not traded, or null: it is. */
  refuses: (sig: BtSignal) => BtSkip | null;
  /**
   * The strike and the lots, from one reading of the board (both sides, as it stood at `at`). Null: nothing to sell.
   */
  pick: (board: readonly BoardRow[], cp: 'C' | 'P', at: number) => { row: BoardRow; lots: number } | null;
  /** The perp level that ends the trade at its target. */
  targetOf: (sig: BtSignal) => number;
  /** The option's own target and stop, as shares of the premium sold; 0 is none. */
  targetPct: number; stopPct: number;
  /** The target and the stop in force at a moment, where they move with the clock; absent, the ones above all day. */
  targetPctAt?: (at: number) => number;
  stopPctAt?: (at: number) => number;
  /**
   * The option's stop by how volatile the market was at the signal's fill (the volatility study, 17 Oct 2026): it
   * replaces `stopPct` and `stopPctAt` for that trade. A level that cannot be said keeps the plan's own stop.
   */
  stopPctByVol?: Record<VolLevel, number> | null;
  /** The option's stop trailed as the premium falls (`tslTrail`); absent, it stays where it was set. */
  tsl?: Tsl | null;
  /** The option's stop to the price sold once the premium has fallen so far (`breakEvenReached`); absent, off. */
  breakEven?: { move: number; unit: TslUnit } | null;
  /** The perp's SL and target left out: a trade is not closed when the perp reaches it. Absent: both used. */
  skipPerp?: { sl: boolean; tgt: boolean } | null;
  /** The perp's SL and target widened with the 1m ATR (`widenAfter`); absent, the signal's own all trade. */
  perpWiden?: { slAtr: number; tgtAtr: number; mode: WidenMode } | null;
  /**
   * The strike by the same level (the volatility study, 17 Oct 2026: "delta by volatility -- high 0.08, low 0.12"):
   * each level's own pick, in place of `pick` for that trade. A level that cannot be said keeps `pick`.
   */
  pickByVol?: Record<VolLevel, DayPlan['pick']> | null;
  /** The lots by the same level ("fewer lots when it is volatile"), in place of the pick's own. A level not known keeps them. */
  lotsByVol?: Record<VolLevel, number> | null;
  /**
   * When a trade still open is closed by the rules (18 Oct 2026): a strategy closes what it opened at its exit time
   * (strategy/runner.ts `considerExit`, `exitMomentFor`), not at the settlement. Absent: held to the end of the day.
   */
  closeAt?: (sig: BtSignal) => number;
  /** At most this many open at once; null, any number. */
  maxOpen: number | null;
  /** The desk's own limits on top: at most this many across all, and each side at most so many. Null: none. */
  desk?: DeskCaps | null;
  /** The chase guard (`BacktestParams.chase`, `chasing`); absent, off. */
  chase?: Chase | null;
};

/** The screen's own settings as a plan: every signal in the hours chosen, one strike rule, a fixed number of lots, no limit. */
export function planOfParams(p: BacktestParams, span: { from: number; to: number }): DayPlan {
  // The strategies' own hours: from 9:30 PM IST (four hours into the expiry day) to 3:59 PM (91 minutes before it ends).
  const opens = p.window === 'desk' ? span.from + 4 * 60 * MIN : span.from;
  const closes = p.window === 'desk' ? span.to - 91 * MIN : span.to - 5 * MIN;
  // Hours of the owner's own (13 Oct 2026): by the IST clock, as a strategy's own hours are read -- forward from the start, so past midnight is the same sum.
  const custom = p.window === 'custom' && p.hoursFrom && p.hoursTo ? { from: minutesOf(p.hoursFrom), to: minutesOf(p.hoursTo) } : null;
  // The steps in the order the clock reaches them from 5:30 PM, however they were typed: the reader keeps the last
  // one reached in the order it is given (13 Oct 2026: 03:30 typed above 23:30 left 23:30's share on all morning).
  const start = minutesOf(DAY_START_IST);
  const steps = [...(p.targetSteps ?? [])].sort((a, b) => minutesForward(start, minutesOf(a.at)) - minutesForward(start, minutesOf(b.at))).map((x) => ({ at: x.at, value: x.pct }));
  const livePick = planOfStrategy(strategyOfParams(p, null, null), span).pick;
  return {
    refuses: (sig) => {
      if (sig.filledAt < span.from || sig.filledAt >= span.to - 5 * MIN) return 'outside-window';
      if (custom ? !(minutesForward(custom.from, istMinutes(sig.filledAt)) < minutesForward(custom.from, custom.to)) : sig.filledAt < opens || sig.filledAt >= closes) return 'outside-window';
      // In the runner's order: its hours, then its no-entry windows, then the SL / TGT distances.
      if (p.noEntry?.on && noEntryWindowAt({ noEntry: p.noEntry }, istMinutes(sig.filledAt))) return 'no-entry-window';
      return outOfRange(sig, sig.target, p) ? 'distance' : null;
    },
    /*
     * The strike as the desk picks it (owner, 14 Oct 2026: "the backtest a copy of the live logic"): through the live
     * rules' own selection (`selectLegs`, by way of `strategyOfParams`), not a picker of the backtest's own. The two
     * agreed on all but 9 of 35,902 trades over 1-14 Oct; on those 9 the backtest's sold a strike the desk's would
     * not have, and the live check said so.
     */
    pick: livePick,
    targetOf: (sig) => sig.target,
    targetPct: p.targetPct, stopPct: p.stopPct, maxOpen: null, desk: deskCapsOf(p),
    ...(p.tsl ? { tsl: p.tsl } : {}),
    ...(p.breakEven ? { breakEven: p.breakEven } : {}),
    ...(p.chase ? { chase: p.chase } : {}),
    ...(p.skipPerpSl || p.skipPerpTgt ? { skipPerp: { sl: p.skipPerpSl === true, tgt: p.skipPerpTgt === true } } : {}),
    ...((p.widenSlAtr ?? 0) > 0 || (p.widenTgtAtr ?? 0) > 0 ? { perpWiden: { slAtr: p.widenSlAtr ?? 0, tgtAtr: p.widenTgtAtr ?? 0, mode: p.widenMode ?? 'widest' } } : {}),
    // By the clock, where steps are set: read by the function a strategy's own steps are (`exitValueAt`).
    ...(steps.length ? { targetPctAt: (at: number) => exitValueAt({ mode: 'pct', value: p.targetPct, steps }, DAY_START_IST, istMinutes(at)).value } : {}),
  };
}

/** What of a strategy the backtest cannot replay, in words: said beside its result. */
export function strategyCaveats(s: Strategy): string[] {
  const c = s.config, x = exitRules(c);
  const out: string[] = [];
  if (x.target.mode !== 'pct' && x.target.value > 0) out.push('Its option target is set in points or as a price, which is not replayed: no option target is used.');
  if (x.stop.mode !== 'pct' && x.stop.value > 0) out.push('Its option stop is set in points or as a price, which is not replayed: no option stop is used.');
  if (c.strikeRule !== 'premium' && c.strikeRule !== 'delta' && c.strikeRule !== 'strict' && c.strikeRule !== 'distance') out.push('Its strike is picked by open interest, which the recorded board cannot replay: few or no trades can be made.');
  return out;
}

/**
 * A saved signal strategy as a plan (owner, 13 Oct 2026: "a strategy list in the backtest: choose one, and
 * backtest by it"). Its own rules, read by the same functions the runner trades by: its days and hours, its
 * no-entry window, its nearest and furthest SL and TGT, the strike rule in force at that minute -- picked by the
 * runner's own `selectLegs` from the board as it stood -- its lots, its target (TGT1, 2 or 3), the option's own
 * target and stop, and its "at most N open". Other strategies' trades, the desk-wide limit and margin are not in it.
 */
/**
 * A backtest's settings as the strategy the live desk would run with them (owner, 14 Oct 2026: "the live check is
 * the live logic with the backtest's settings; the backtest a copy of the live logic"). The same hours, strike
 * rule, lots, option target (by the clock where it moves) and stop, premium floor and SL / TGT range, on the same
 * time frames and methods -- so the live rules (`planOfStrategy`, the path checked against the desk's own records)
 * can be asked what they do with these settings, signal for signal. No "at most open" of its own: the settings'
 * limit is the account's, laid over it as the backtest lays it.
 *
 * Checked on 1-14 Oct 2026, every saved backtest: 26,040 signals, the same decision on every one, and on all
 * 4,340 traded the same strike and the same money.
 */
/**
 * A strategy as a backtest is asked about it: with its methods' history (18 Oct 2026, `strategy_method_updates`) where
 * the route had it to give. A strategy whose methods are picked again every day traded each day on that day's list;
 * backtested on today's list for every day, it was another strategy than the one that traded.
 */
export type BacktestStrategy = Strategy & { methodHistory?: readonly { at: number; before: readonly string[]; after: readonly string[] }[] };
/**
 * The methods a strategy took signals of at a moment, as the desk had them then: the list after the last change at or
 * before it; before the first change, the list that change replaced; with no history, its list as it stands.
 */
export function methodsAt(st: Strategy, at: number): readonly string[] {
  const history = (st as BacktestStrategy).methodHistory ?? [];
  if (!history.length) return st.config.signal?.methods ?? [];
  let list: readonly string[] | null = null;
  for (const h of history) { if (h.at <= at) list = h.after; else break; }
  return list ?? history[0]!.before;
}
/** Whether a signal is a strategy's own: its way of reading, its time frames, and a method it took then (`methodsAt`). None: every signal. */
export function ownSignal(st: Strategy | null | undefined): (sig: BtSignal) => boolean {
  const rule = st?.config.signal ?? null;
  if (!st || !rule) return () => true;
  const tfs = ruleTfs(rule) as string[];
  return (sig) => sig.mode === rule.mode && (rule.mode !== 'single' || tfs.includes(sig.tf)) && methodsAt(st, sig.filledAt).includes(sig.method);
}

/**
 * Strike blocks laid on the hours they are traded in (18 Oct 2026). A block's time is a time of the expiry day, read
 * from 5:30 PM -- a run together's blocks are set over the whole day, and each saved backtest in it keeps hours of its
 * own. A strategy reads its blocks forward from its entry (`strikePickAt`), so one before the hours open read as one
 * after they close, and was never in force: a 7:00 PM block under the desk's 9:30 PM-3:59 PM did nothing. Here, the
 * last block at or before the hours open is in force from their start; one at or after they close is not traded in;
 * the rest stand as they are -- blocks inside the hours, which is every single backtest's, are unchanged. Hours that
 * run over 5:30 PM span two expiry days and have no one order of the day: their blocks are left as they are.
 */
export function blocksForHours(blocks: readonly StrikeBlock[], entryTime: string, exitTime: string): StrikeBlock[] {
  const copy = (b: StrikeBlock, at = b.at): StrikeBlock => ({ ...b, at, premium: { ...b.premium } });
  const start = minutesOf(DAY_START_IST);
  const day = (hhmm: string) => minutesForward(start, minutesOf(hhmm));
  const open = day(entryTime), close = day(exitTime);
  if (close <= open) return blocks.map((b) => copy(b));
  const sorted = [...blocks].sort((a, b) => day(a.at) - day(b.at));
  const before = sorted.filter((b) => day(b.at) <= open).at(-1);
  const inside = sorted.filter((b) => day(b.at) > open && day(b.at) < close).map((b) => copy(b));
  return before ? [copy(before, entryTime), ...inside] : inside;
}

export function strategyOfParams(p: BacktestParams, tfs: readonly string[] | null, methods: readonly string[] | null): Strategy {
  const chain = !tfs || tfs.length === 0 ? false : tfs.includes(CHAIN_KEY) && tfs.every((t) => t === CHAIN_KEY);
  const single = (tfs && tfs.length ? tfs.filter((t) => t !== CHAIN_KEY) : [...SIGNAL_TFS]) as SignalTf[];
  const pts = (v: number | undefined) => (v && v > 0 ? Object.fromEntries((chain ? [CHAIN_KEY] : single).map((t) => [t, v])) : undefined);
  const hours = p.window === 'desk' ? { entryTime: '21:30', exitTime: '15:59' }
    : p.window === 'custom' && p.hoursFrom && p.hoursTo ? { entryTime: p.hoursFrom, exitTime: p.hoursTo } : { entryTime: '17:30', exitTime: '17:25' };
  const config: StrategyConfig = {
    ...DEFAULT_CONFIG, trigger: 'signal', liveOrders: false, ...hours, weekdays: [0, 1, 2, 3, 4, 5, 6],
    strikeRule: p.rule, strikeStep: 0, strikeBlocks: blocksForHours(p.strikeBlocks ?? [], hours.entryTime, hours.exitTime), delta: { max: p.value }, premium: { mode: 'atMost', usd: p.value, fallbackUsd: null }, distance: null,
    lots: p.lots, legs: 'both', targetMode: 'pct', stopMode: 'pct', takeProfitPct: p.targetPct, stopLossPct: p.stopPct,
    // Read forward from the day's start, as the settings' own steps are; the strategy's from its entry time -- the same order on the clock.
    targetSteps: (p.targetSteps ?? []).map((x) => ({ at: x.at, value: x.pct })), minPremiumUsd: p.minPremium ?? MIN_PREMIUM, noEntry: p.noEntry?.on ? { on: true, windows: p.noEntry.windows.map((w) => ({ ...w })) } : { on: false, windows: [] },
    signal: {
      mode: chain ? 'mtf' : 'single', tf: single[0] ?? '5m', ...(chain ? {} : { tfs: single }), methods: methods ? [...methods] : [], target: 'tp1', maxOpen: 0, enterOn: 'zone', action: 'sell',
      minSlPts: pts(p.slMin), maxSlPts: pts(p.slMax), minTgtPts: pts(p.tgtMin), maxTgtPts: pts(p.tgtMax),
    },
  } as StrategyConfig;
  return { id: 'settings', name: 'These settings', enabled: true, accountId: null, config } as unknown as Strategy;
}

export function planOfStrategy(s: Strategy, span: { from: number; to: number }, desk: DayPlan['desk'] = null): DayPlan {
  const c = s.config;
  const rule = c.signal!;
  const x = exitRules(c);
  const targetOf = (sig: BtSignal) => (rule.target === 'tp3' ? sig.tp3 : rule.target === 'tp2' ? sig.tp2 : null) ?? sig.target;
  const entry = minutesOf(c.entryTime);
  return {
    refuses: (sig) => {
      const minute = istMinutes(sig.filledAt);
      if (!c.weekdays.includes(istWeekday(sig.filledAt)) || !(minutesForward(entry, minute) < minutesForward(entry, minutesOf(c.exitTime)))) return 'outside-window';
      if (noEntryWindowAt(c, minute)) return 'no-entry-window';
      const sl = Math.abs(sig.fillPrice - sig.stop), tgt = Math.abs(sig.fillPrice - targetOf(sig));
      const needSl = minSlPtsFor(rule, sig.tf), needTgt = minTgtPtsFor(rule, sig.tf), mostSl = maxSlPtsFor(rule, sig.tf), mostTgt = maxTgtPtsFor(rule, sig.tf);
      if ((needSl > 0 && sl < needSl) || (needTgt > 0 && tgt < needTgt) || (mostSl > 0 && sl > mostSl) || (mostTgt > 0 && tgt > mostTgt)) return 'distance';
      return null;
    },
    pick: (board, cp, at) => {
      const spot = board.find((r) => r.spot !== null)?.spot ?? null;
      const nearest = spot === null ? null : board.reduce<number | null>((best, r) => (best === null || Math.abs(r.strike - spot) < Math.abs(best - spot) ? r.strike : best), null);
      const candidates: Candidate[] = board.map((r) => ({
        cp: r.cp, strike: r.strike, sellPrice: r.bid, ask: r.ask, delta: r.delta, oi: r.oi ?? null, emBuffer: null,
        // The board's own delta as the chance of expiring worthless; the strike nearest BTC is "at the money", as on the live board.
        pOtm: r.delta === null ? null : 1 - Math.abs(r.delta),
        moneyness: r.strike === nearest ? 'ATM' : spot !== null && (r.cp === 'P' ? r.strike < spot : r.strike > spot) ? 'OTM' : 'ITM',
      }));
      // The strike rule in force at that minute: the strategy's own, or the block the clock had reached.
      const now = strikePickAt(c, istMinutes(at));
      const sel = selectLegs({ ...s, config: { ...c, ...now.pick, legs: cp === 'P' ? 'PE' : 'CE' } }, candidates, { spot, hoursToExpiry: (span.to - at) / 3_600_000 });
      const chosen = sel.legs[0];
      const row = chosen ? board.find((r) => r.cp === cp && r.strike === chosen.strike) : undefined;
      if (!chosen || !row || row.bid === null || !(row.bid >= (c.minPremiumUsd ?? MIN_PREMIUM)) || row.ask === null || !(row.ask > 0)) return null;
      return { row, lots: chosen.lots };
    },
    targetOf,
    targetPct: x.target.mode === 'pct' ? x.target.value : 0,
    stopPct: x.stop.mode === 'pct' ? x.stop.value : 0,
    // Its timed steps, read as the runner's stepper reads them: forward from its entry time.
    ...(x.target.mode === 'pct' && x.target.steps.length ? { targetPctAt: (at: number) => exitValueAt(x.target, c.entryTime, istMinutes(at)).value } : {}),
    ...(x.stop.mode === 'pct' && x.stop.steps.length ? { stopPctAt: (at: number) => exitValueAt(x.stop, c.entryTime, istMinutes(at)).value } : {}),
    // Its delta and its SL by volatility, as the runner trades them: each level its own, read by the strategy's own source (`ownVolBy`).
    ...(byVolPicks(s, span, desk)),
    ...(x.stop.mode === 'pct' && c.signal?.slByVol?.on ? { stopPctByVol: { low: c.signal.slByVol.low, medium: c.signal.slByVol.medium, high: c.signal.slByVol.high } } : {}),
    // What it opened, closed at its exit time -- the first after the fill -- as the runner's `considerExit` does.
    closeAt: (sig) => exitMomentFor(c.exitTime, sig.filledAt),
    // The perp's levels it skips (18 Oct 2026), as the runner sends them: a level skipped closes nothing.
    ...(rule.skipPerpSl || rule.skipPerpTgt ? { skipPerp: { sl: rule.skipPerpSl === true, tgt: rule.skipPerpTgt === true } } : {}),
    maxOpen: rule.maxOpen > 0 ? rule.maxOpen : null,
    desk,
  };
}
/** A strategy's strike picks by level, where it sets its delta by volatility: the same pick with each level's delta. */
function byVolPicks(s: Strategy, span: { from: number; to: number }, desk: DayPlan['desk']): Pick<DayPlan, 'pickByVol'> {
  const c = s.config, dv = c.signal?.deltaByVol;
  if (!dv?.on || c.strikeRule !== 'delta') return {};
  const plain = { ...c, signal: { ...c.signal!, deltaByVol: null, slByVol: null } };
  const at = (d: number) => planOfStrategy({ ...s, config: { ...plain, delta: { ...(c.delta ?? { max: d }), max: d } } } as Strategy, span, desk).pick;
  return { pickByVol: { low: at(dv.low), medium: at(dv.medium), high: at(dv.high) } };
}

/** The index of the first item later than `t`, in a list sorted by time. */
function firstAfter<T>(xs: readonly T[], t: number, at: (x: T) => number): number {
  let lo = 0, hi = xs.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (at(xs[mid]!) <= t) lo = mid + 1; else hi = mid; }
  return lo;
}
const atOf = (x: { at: number }) => x.at;

/**
 * Whether a signal sells the way the expiry day has already run (`BacktestParams.chase`): filled at or after `after`,
 * and the perp's last minute closed before the fill `pts` or more from its minute at `from` the same day, up for a
 * buy and down for a sell. Both are the minutes' own closes, so the move is of one record. Both times are read
 * forward from 5:30 PM, as the target steps are. No minute at `from` closed before the fill: not chasing.
 */
export function chasing(c: Chase, sig: BtSignal, bars: readonly MinuteBar[]): boolean {
  const start = minutesOf(DAY_START_IST), fill = minutesForward(start, istMinutes(sig.filledAt));
  const from = minutesForward(start, minutesOf(c.from));
  if (fill < minutesForward(start, minutesOf(c.after)) || fill < from) return false;
  const at = Math.floor(sig.filledAt / MIN) * MIN - (fill - from) * MIN;
  const ref = bars[firstAfter(bars, at - 1, atOf)], now = bars[firstAfter(bars, sig.filledAt - MIN, atOf) - 1];
  if (!ref || !now || ref.at > now.at) return false;
  const move = now.close - ref.close;
  return Math.abs(move) >= c.pts && Math.sign(move) === sig.dir;
}
/** A strategy's plan with the backtest's chase guard on it: the guard is the run's, not the strategy's. */
const withChase = (plan: DayPlan, p: Pick<BacktestParams, 'chase'>): DayPlan => (p.chase ? { ...plan, chase: p.chase } : plan);
/** The chase guard in a cache key. */
const chaseKey = (p: Pick<BacktestParams, 'chase'>) => (p.chase ? `|ch:${p.chase.from}-${p.chase.after}-${p.chase.pts}` : '');

const TF_RANK: Record<string, number> = { '1m': 60, '3m': 180, '5m': 300, '15m': 900, '30m': 1_800, '1h': 3_600, '2h': 7_200, '4h': 14_400 };
/**
 * The order signals are taken in: as they filled; and those that filled in the same second -- many do, the graders
 * work a minute at a time -- in the live queue's order (strategy/runner.ts `goesBefore`): the longer timeframe
 * first. Then by method, way and direction, so the order never depends on how the database happened to return
 * the rows (13 Oct 2026: with a limit on open trades, which of a tie took the last place changed the day's count
 * from one read to the next -- 759 or 873 for 12 Oct).
 */
export function signalOrder(a: BtSignal, b: BtSignal): number {
  return a.filledAt - b.filledAt
    || (TF_RANK[b.tf] ?? 0) - (TF_RANK[a.tf] ?? 0)
    || a.method.localeCompare(b.method) || a.mode.localeCompare(b.mode) || a.dir - b.dir
    || a.fillPrice - b.fillPrice || a.stop - b.stop;
}

/** One contract's readings as columns, oldest first; a figure the board did not have is NaN. */
type Series = { cp: 'C' | 'P'; strike: number; n: number; at: Float64Array; spot: Float64Array; bid: Float64Array; ask: Float64Array; mark: Float64Array; delta: Float64Array; oi: Float64Array };
/**
 * A day's board made ready to be played: every reading time, and each contract's readings as columns of numbers.
 * A day a minute at a time is a hundred thousand readings and is read by thousands of trades; as rows of objects
 * that was most of a second a day, and too much to keep. Made once (`prepareBoard`) and kept by the backtest's
 * thread for the days that will not change.
 */
export type PreparedBoard = { times: Float64Array; series: Map<string, Series>; all: Series[] };

const NONE = Number.NaN;
const orNone = (v: number | null | undefined) => (v === null || v === undefined ? NONE : v);
const orNull = (v: number) => (Number.isNaN(v) ? null : v);
const isPrepared = (b: readonly BoardRow[] | PreparedBoard): b is PreparedBoard => !Array.isArray(b);

export function prepareBoard(board: readonly BoardRow[]): PreparedBoard {
  const rowsOf = new Map<string, BoardRow[]>();
  const seen = new Set<number>();
  for (const r of board) {
    seen.add(r.at);
    const k = `${r.cp}${r.strike}`;
    const xs = rowsOf.get(k);
    if (xs) xs.push(r); else rowsOf.set(k, [r]);
  }
  const series = new Map<string, Series>();
  for (const [k, xs] of rowsOf) {
    // Oldest first, as every board is given; put right where one is not.
    for (let i = 1; i < xs.length; i++) if (xs[i]!.at < xs[i - 1]!.at) { xs.sort((a, b) => a.at - b.at); break; }
    const n = xs.length;
    const s: Series = { cp: xs[0]!.cp, strike: xs[0]!.strike, n, at: new Float64Array(n), spot: new Float64Array(n), bid: new Float64Array(n), ask: new Float64Array(n), mark: new Float64Array(n), delta: new Float64Array(n), oi: new Float64Array(n) };
    for (let i = 0; i < n; i++) {
      const r = xs[i]!;
      s.at[i] = r.at; s.spot[i] = orNone(r.spot); s.bid[i] = orNone(r.bid); s.ask[i] = orNone(r.ask); s.mark[i] = orNone(r.mark); s.delta[i] = orNone(r.delta); s.oi[i] = orNone(r.oi);
    }
    series.set(k, s);
  }
  return { times: Float64Array.from(seen).sort(), series, all: [...series.values()] };
}

/** The first index of a sorted column later than `t`. */
function after(xs: Float64Array, t: number, n = xs.length): number {
  let lo = 0, hi = n;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (xs[mid]! <= t) lo = mid + 1; else hi = mid; }
  return lo;
}

/** One reading of the board as rows again -- every contract that has that time -- for a strike rule to pick from. */
function readingAt(b: PreparedBoard, t: number): BoardRow[] {
  const out: BoardRow[] = [];
  for (const s of b.all) {
    const i = after(s.at, t, s.n) - 1;
    if (i < 0 || s.at[i] !== t) continue;
    out.push({ at: t, cp: s.cp, strike: s.strike, spot: orNull(s.spot[i]!), bid: orNull(s.bid[i]!), ask: orNull(s.ask[i]!), mark: orNull(s.mark[i]!), delta: orNull(s.delta[i]!), oi: orNull(s.oi[i]!) });
  }
  return out;
}

/**
 * One expiry day: every signal filled in it, traded on its board. `from`/`to` are the day's span; `bars` its perp
 * minutes; `board` every reading of the contract that settles at `to`, oldest first. The signals are taken in the
 * order they filled, which is what "at most N open" is counted in.
 */
export type DayOut = { trades: BtTrade[]; skipped: Record<BtSkip, number>; /** Each signal not traded, with why: what the time frame and method filters count. */ refused: { signal: BtSignal; why: BtSkip }[] };
/** One backtest's part of a day: its signals, the rules it trades them by, and its volatility filter. */
export type DayBook = {
  signals: readonly BtSignal[]; plan: DayPlan;
  /** The volatility at a moment (`volReader`), and the one level to keep where the filter is on. */
  volAt?: (at: number) => VolLevel | null; volOnly?: VolLevel | null;
};

export function simulateDay(o: {
  from: number; to: number; signals: readonly BtSignal[]; bars: readonly MinuteBar[];
  /** The board as rows, or one already made ready (`prepareBoard`). */
  board: readonly BoardRow[] | PreparedBoard; params?: BacktestParams; plan?: DayPlan;
  volAt?: (at: number) => VolLevel | null; volOnly?: VolLevel | null;
}): DayOut {
  const plan = o.plan ?? planOfParams(o.params ?? DEFAULT_PARAMS, { from: o.from, to: o.to });
  return simulateTogether({ from: o.from, to: o.to, bars: o.bars, board: o.board, books: [{ signals: o.signals, plan, volAt: o.volAt, volOnly: o.volOnly }] })[0]!;
}

/**
 * Several backtests on one day, on one clock (owner, 13 Oct 2026: "the portfolio's margin at most, together --
 * work it out correctly"). Each book trades its own signals by its own rules; what they share is the order -- as
 * they filled, the longer timeframe first, as the desk's one queue takes them -- and, where `shared` is given, ONE
 * limit on what is open across all of them: the desk's "at most open" and its CE and PE shares are an account's,
 * not a strategy's, so seven backtests of 120 each run side by side on one account are not 840 places but 120.
 * Before, each kept its own 120 and the total said 152 open at once -- more than the account would ever hold, and
 * a margin worked from trades it would not have taken.
 *
 * Without `shared` each book is counted against its own plan's limit, on its own trades: one book alone is
 * `simulateDay`. A book's own "at most N open" (a strategy's) is always its own.
 */
export function simulateTogether(o: {
  from: number; to: number; bars: readonly MinuteBar[]; board: readonly BoardRow[] | PreparedBoard;
  books: readonly DayBook[];
  /** One account's limit over every book; null or absent, each book's own. */
  shared?: DayPlan['desk'];
}): DayOut[] {
  const { to } = o;
  const outs: DayOut[] = o.books.map(() => ({ trades: [], skipped: noSkips(), refused: [] }));
  const board = isPrepared(o.board) ? o.board : prepareBoard(o.board);
  const times = board.times;
  // A strike rule's pick depends on the reading and the side alone: thousands of signals share a few hundred of them.
  const picksOf = o.books.map(() => new Map<number, ReturnType<DayPlan['pick']>>());
  // The target and the stop by the clock depend on the minute alone.
  const tgtPctsOf = o.books.map(() => new Map<number, number>()), stopPctsOf = o.books.map(() => new Map<number, number>());
  const pctAt = (memo: Map<number, number>, f: (at: number) => number, at: number) => { let v = memo.get(at); if (v === undefined) { v = f(at); memo.set(at, v); } return v; };
  const lastBar = o.bars[o.bars.length - 1];
  // The 1m ATR at each minute's close, worked out once for every book that widens the perp's levels.
  const minuteAtrs = o.books.some((b) => b.plan.perpWiden) ? minuteAtr(o.bars) : null;
  /** When each trade still open ends, its side and whose it is: what "at most N open" and each side's limit count. */
  let open: { until: number; side: 'CE' | 'PE'; book: number; cp: 'C' | 'P'; strike: number }[] = [];
  const shared = o.shared ?? null;
  // One line for all of them, in the order the desk takes signals; two books' same signal, in the books' own order.
  const line = o.books.flatMap((b, book) => b.signals.map((sig) => ({ sig, book }))).sort((a, b) => signalOrder(a.sig, b.sig) || a.book - b.book);

  for (const { sig, book } of line) {
    const me = o.books[book]!, plan = me.plan, out = outs[book]!;
    const picks = picksOf[book]!, tgtPcts = tgtPctsOf[book]!, stopPcts = stopPctsOf[book]!;
    const { trades } = out;
    const t0 = sig.filledAt;
    const skip = (why: BtSkip) => { out.skipped[why]++; out.refused.push({ signal: sig, why }); };
    const refused = plan.refuses(sig);
    if (refused) { skip(refused); continue; }
    if (plan.chase && chasing(plan.chase, sig, o.bars)) { skip('chase'); continue; }
    const vol = me.volAt ? me.volAt(t0) : null;
    // A signal whose volatility cannot be said is not one of the level asked for.
    if (me.volOnly && vol !== me.volOnly) { skip('volatility'); continue; }
    open = open.filter((x) => x.until > t0);
    const mine = shared ? open : open.filter((x) => x.book === book);
    // In the runner's order: its own limit, then the desk's, then the side's (strategy/runner.ts `takeSignal`).
    if (plan.maxOpen !== null && (shared ? open.filter((x) => x.book === book) : mine).length >= plan.maxOpen) { skip('at-limit'); continue; }
    const desk = shared ?? plan.desk ?? null;
    if (desk && mine.length >= desk.max) { skip('desk-limit'); continue; }
    const side: 'CE' | 'PE' = sig.dir === 1 ? 'PE' : 'CE';
    if (desk?.side && mine.filter((x) => x.side === side).length >= desk.side[side]) { skip('side-limit'); continue; }
    // The reading nearest the fill; of two as near, the earlier.
    const next = after(times, t0);
    const near = next === 0 ? (times.length ? 0 : -1) : next === times.length || t0 - times[next - 1]! <= times[next]! - t0 ? next - 1 : next;
    if (near === -1 || Math.abs(times[near]! - t0) > BOARD_NEAR_MS) { skip('no-board'); continue; }
    const cp = sig.dir === 1 ? 'P' as const : 'C' as const;
    // Several trades may share a contract, and several books one signal, as on the desk (the one-per-contract rule of 14 Oct morning was lifted).
    // The strike rule of this signal's level where the plan picks by volatility; the reading, the side and the rule decide the pick.
    const levelPick = plan.pickByVol && vol ? plan.pickByVol[vol] : null;
    const pickKey = (near * 2 + (cp === 'P' ? 1 : 0)) * 4 + (levelPick && vol ? 1 + VOL_LEVELS.indexOf(vol) : 0);
    let picked = picks.get(pickKey);
    if (picked === undefined) {
      picked = (levelPick ?? plan.pick)(readingAt(board, times[near]!), cp, times[near]!);
      picks.set(pickKey, picked);
    }
    if (!picked) { skip('no-strike'); continue; }
    /*
     * The most on one strike, as the runner holds it (strategy/runner.ts, 22 Oct 2026): what is open on the strike
     * picked -- the account's, every book's where they share it -- against its number. At it, skipped; or, forwarding,
     * the rule picks again among the strikes further out (above a call's, below a put's) not full themselves.
     */
    let fwdFrom: number | undefined;
    if (desk?.strike != null) {
      const cap = desk.strike;
      const onStrike = (k: number) => mine.reduce((n, x) => n + (x.cp === cp && x.strike === k ? 1 : 0), 0);
      const first = picked.row;
      if (onStrike(first.strike) >= cap) {
        if (desk.strikeFull === 'skip') { skip('strike-limit'); continue; }
        const out = readingAt(board, times[near]!).filter((r) => r.cp === cp && (cp === 'C' ? r.strike > first.strike : r.strike < first.strike) && onStrike(r.strike) < cap);
        const again = out.length ? (levelPick ?? plan.pick)(out, cp, times[near]!) : null;
        if (!again) { skip('strike-limit'); continue; }
        picked = again;
        fwdFrom = first.strike;
      }
    }
    const pick = picked.row, lots = plan.lotsByVol && vol ? plan.lotsByVol[vol] : picked.lots;
    const entry = pick.bid!, entryAt = times[near]!;
    const target = plan.targetOf(sig);

    // The perp: the first minute after the fill's own that holds the stop or the target; both in one bar is the stop.
    // Closed by the rules at the strategy's exit time, if that comes before the day's end -- as the desk closes it.
    const closesAt = Math.min(to - MIN, plan.closeAt?.(sig) ?? Number.POSITIVE_INFINITY);
    const closeBar = closesAt < to - MIN ? o.bars[firstAfter(o.bars, closesAt - 1, atOf) - 1] : lastBar;
    let perpAt = closesAt, perpBy: 'perp-tgt' | 'perp-sl' | 'window-end' = 'window-end', perpPx = closeBar?.close ?? lastBar?.close ?? sig.fillPrice;
    const fillMinute = Math.floor(t0 / MIN) * MIN;
    // The levels in force: the signal's own, widened after each closed minute where the plan says so.
    const widen = plan.perpWiden ?? null;
    const own = { stop: sig.stop, target };
    let lv = own;
    // The 1m ATR at the fill: what "calm again" is measured against.
    const first = firstAfter(o.bars, fillMinute, atOf);
    const baseAtr = widen?.mode === 'calm' && minuteAtrs && first > 0 ? minuteAtrs[first - 1]! : undefined;
    for (let i = first; i < o.bars.length; i++) {
      const b = o.bars[i]!;
      if (b.at >= closesAt) break;
      // Inside the minute, at the levels the last close left: a touch is a hit then, not at this minute's close.
      const stop = !plan.skipPerp?.sl && (sig.dir === 1 ? b.low <= lv.stop : b.high >= lv.stop);
      const tgt = !plan.skipPerp?.tgt && (sig.dir === 1 ? b.high >= lv.target : b.low <= lv.target);
      if (stop || tgt) { perpAt = b.at + MIN; perpBy = stop ? 'perp-sl' : 'perp-tgt'; perpPx = stop ? lv.stop : lv.target; break; }
      if (widen && minuteAtrs) lv = widenAfter(lv, { dir: sig.dir, entry: sig.fillPrice, atr: minuteAtrs[i]!, slAtr: widen.slAtr, tgtAtr: widen.tgtAtr, mode: widen.mode, baseAtr, own });
    }

    // The option's own readings between: its target (a resting buy, filled at its price) and its stop (bought at the offer).
    const series = board.series.get(`${cp}${pick.strike}`);
    // The option's own levels at a moment: fixed all day, or by the clock where the plan has steps -- or, where the
    // plan sets the stop by volatility and this signal's level is known, that level's stop for the whole trade.
    const volStop = plan.stopPctByVol && vol ? plan.stopPctByVol[vol] : null;
    const tgtAtFn = plan.targetPctAt, stopAtFn = volStop === null ? plan.stopPctAt : undefined;
    const level = (pc: number, sign: 1 | -1) => (pc > 0 ? entry * (1 + sign * pc) : null);
    const fixedTgt = level(plan.targetPct, -1), fixedStop = level(volStop ?? plan.stopPct, 1);
    let restingAt = tgtAtFn ? level(pctAt(tgtPcts, tgtAtFn, entryAt), -1) : fixedTgt;
    const tgtAtEntry = restingAt, stopAtEntry = stopAtFn ? level(pctAt(stopPcts, stopAtFn, entryAt), 1) : fixedStop;
    let exit: number | null = null, exitAt = perpAt, by: BtExit = perpBy;
    // A trailing stop: the best offer since the sale, and how far the stop has come down for it.
    const tsl = plan.tsl ?? null, be = plan.breakEven ?? null;
    let best = entry, trailBy = 0, atEntry = false, lastStop: number | null = null;
    // BTC at the reading the exit is priced on: what the exit's own fee is worked from.
    let exitSpot = pick.spot;
    if (series) {
      const { at, ask, mark, spot, n } = series;
      for (let i = after(at, entryAt, n); i < n; i++) {
        const t = at[i]!, offer = ask[i]!;
        if (t >= perpAt) {
          // The first reading at or after the perp's exit: what buying back costs then.
          exit = offer > 0 ? offer : mark[i]! > 0 ? mark[i]! : null;
          exitSpot = orNull(spot[i]!) ?? exitSpot;
          /*
           * Unless the offer is by then at or under the option's own target (13 Oct 2026, 38 to 458 trades in
           * 34,000 to 42,000): the buy resting there filled on the way down, at its own price, before the desk had
           * anything to close -- so the trade is the target's, and is not bought back for less than its own order
           * stood at. A few cents a trade, and every one of them in the backtest's favour.
           */
          const resting = tgtAtFn ? level(pctAt(tgtPcts, tgtAtFn, t), -1) : fixedTgt;
          if (offer > 0 && resting !== null && offer <= resting + 1e-9) {
            exit = restingAt !== null && resting > restingAt + 1e-9 ? Math.min(resting, offer) : resting;
            exitAt = t; by = 'option-tgt';
          }
          break;
        }
        if (!(offer > 0)) continue;
        // Prices are on a tick and the levels are products of shares: a level reached exactly must not be missed by a rounding.
        const tgtAt = tgtAtFn ? level(pctAt(tgtPcts, tgtAtFn, t), -1) : fixedTgt;
        const setStop = stopAtFn ? level(pctAt(stopPcts, stopAtFn, t), 1) : fixedStop;
        if ((tsl || be) && offer < best) {
          best = offer;
          if (tsl) trailBy = tslTrail(tsl, entry, best);
          if (be && !atEntry) atEntry = breakEvenReached(be, entry, best);
        }
        const trailed = setStop !== null && trailBy > 0 ? setStop - trailBy : setStop;
        // At break-even the stop is the price sold, or the trailed one where that is tighter: never loosened.
        const stopAt = atEntry ? (trailed === null ? entry : Math.min(trailed, entry)) : trailed;
        lastStop = stopAt;
        if (tgtAt !== null && offer <= tgtAt + 1e-9) {
          // A resting buy fills at its own price as the offer comes down to it. One just moved UP over the offer by a
          // time step (a lower share kept) is a buy placed through the market: it fills at the offer.
          exit = restingAt !== null && tgtAt > restingAt + 1e-9 ? Math.min(tgtAt, offer) : tgtAt;
          exitAt = t; by = 'option-tgt'; exitSpot = orNull(spot[i]!) ?? exitSpot; break;
        }
        restingAt = tgtAt;
        if (stopAt !== null && offer >= stopAt - 1e-9) { exit = offer; exitAt = t; by = atEntry && stopAt === entry ? 'option-be' : trailBy > 0 ? 'option-tsl' : 'option-sl'; exitSpot = orNull(spot[i]!) ?? exitSpot; break; }
      }
      if (exit === null && n > 0 && at[n - 1]! > entryAt) {
        // No reading at or after the exit -- held to the end, or out in the day's last minutes: the last reading the contract has.
        exit = ask[n - 1]! > 0 ? ask[n - 1]! : orNull(mark[n - 1]!);
        if (exit !== null) exitSpot = orNull(spot[n - 1]!) ?? exitSpot;
      }
    }
    if (exit === null || !(exit >= 0)) { skip('no-exit-price'); continue; }

    const charges = fillChargesUsd({ price: entry, contracts: lots, contractValue: CONTRACT_VALUE, spot: pick.spot }).totalUsd
      + fillChargesUsd({ price: exit, contracts: lots, contractValue: CONTRACT_VALUE, spot: exitSpot }).totalUsd;
    open.push({ until: exitAt, side: cp === 'P' ? 'PE' : 'CE', book, cp, strike: pick.strike });
    trades.push({
      signal: sig, cp, strike: pick.strike, lots, entryAt, entry, exitAt, exit, by, ...(fwdFrom !== undefined ? { fwdFrom } : {}),
      netUsd: (entry - exit) * lots * CONTRACT_VALUE - charges, chargesUsd: charges, vol,
      marginUsd: fundsRequiredPerContract({ spot: pick.spot ?? sig.fillPrice, premium: entry, leverage: 200, contractValue: CONTRACT_VALUE }) * lots,
      perpPts: (perpPx - sig.fillPrice) * sig.dir,
      optTgt: tgtAtEntry, optStop: stopAtEntry, perpTgt: target,
      // Where a trailing stop had brought the stop by the exit: said beside the stop it started from.
      // Only a stop the trail or the break-even moved: one by the clock is the rule's own.
      ...((trailBy > 0 || atEntry) && lastStop !== null && lastStop !== stopAtEntry ? { optStopEnd: lastStop } : {}),
      // And where the widening had taken the perp's levels.
      ...(lv.stop !== sig.stop ? { perpStopEnd: lv.stop } : {}), ...(lv.target !== target ? { perpTgtEnd: lv.target } : {}),
    });
  }
  return outs;
}

// ------------------------------------------------------------------ adding up

/** A count of backtested trades: money after charges, the same trades' perp points, and each exit with how many of its trades made money. */
export type BtTot = {
  n: number; wins: number; losses: number; net: number; won: number; lost: number; perpPts: number;
  /**
   * The same trades on the perp, apart from the options (18 Oct 2026, the R&D audit: "perp R and options P&L after
   * fees, separately -- a good perp result is not a good options one"): how many the perp won after its fees, its
   * points after them (`PERP_FEE_RATE` a side and GST, on the fill), and its R before and after them -- the points
   * over the signal's own risk, fill to stop. Sums; `perpPts` is the points before fees.
   */
  perpWins: number; perpNetPts: number; perpR: number; perpRNet: number;
  /** The charges on every fill, dollars: `net` is after them, `net + charges` before. */
  charges: number;
  exits: Partial<Record<BtExit, { n: number; wins: number; net: number }>>;
};
export const zeroBt = (): BtTot => ({ n: 0, wins: 0, losses: 0, net: 0, won: 0, lost: 0, perpPts: 0, perpWins: 0, perpNetPts: 0, perpR: 0, perpRNet: 0, charges: 0, exits: {} });
/** The perp's taker fee a side, as the research counts it (0.05%), and the GST on it: what a perp round trip costs in points. */
export const PERP_FEE_RATE = 0.0005;
export const perpFeePts = (price: number) => 2 * PERP_FEE_RATE * (1 + GST_RATE) * price;
/** One trade on the perp: its points after the round trip's fees, and its R before and after them (0 with no risk). */
export function perpOf(t: { perpPts: number; signal: Pick<BtSignal, 'fillPrice' | 'stop'> }): { netPts: number; r: number; rNet: number } {
  const risk = Math.abs(t.signal.fillPrice - t.signal.stop), netPts = t.perpPts - perpFeePts(t.signal.fillPrice);
  return { netPts, r: risk > 0 ? t.perpPts / risk : 0, rNet: risk > 0 ? netPts / risk : 0 };
}
function addBt(a: BtTot, b: BtTot): BtTot {
  a.n += b.n; a.wins += b.wins; a.losses += b.losses; a.net += b.net; a.won += b.won; a.lost += b.lost; a.perpPts += b.perpPts; a.perpWins += b.perpWins; a.perpNetPts += b.perpNetPts; a.perpR += b.perpR; a.perpRNet += b.perpRNet; a.charges += b.charges;
  for (const k of BT_EXITS) {
    const x = b.exits[k];
    if (!x) continue;
    const mine = a.exits[k] ?? (a.exits[k] = { n: 0, wins: 0, net: 0 });
    mine.n += x.n; mine.wins += x.wins; mine.net += x.net;
  }
  return a;
}
/**
 * The fifteen minutes of the trading day a signal filled in: 0 is 5:30-5:45 PM IST, when the daily contract's day
 * begins, 95 the last quarter before the next 5:30 PM. Sessions of any length the screen asks for -- 15 minutes to six
 * hours -- are made of these (owner, 15 Oct 2026: "by session, 1h by default, 15m to 6h").
 */
export const SLOT_MS = 15 * 60_000;
export const slotOf = (ms: number): number => {
  const day = 86_400_000, sinceStart = (ms + 330 * 60_000 - (17 * 60 + 30) * 60_000) % day;
  return Math.floor(((sinceStart + day) % day) / SLOT_MS);
};
type BtCell = { day: string; method: string; mode: 'single' | 'mtf'; tf: string; vol: VolLevel | null; slot: number; tot: BtTot };
/**
 * One method's trades in one fifteen-minute slot, over the range: what the session table is added up from. `stops`:
 * of them, those bought back at a stop loss -- the perp's or the option's, not a trailing SL or break-even (23 Oct
 * 2026, owner: "SL % per session").
 */
export type BtSlotRow = { slot: number; method: string; name: string; n: number; wins: number; net: number; charges: number; stops: number };
const STOP_EXITS: readonly BtExit[] = ['perp-sl', 'option-sl'];
export const stopsOf = (t: Pick<BtTot, 'exits'>) => STOP_EXITS.reduce((n, k) => n + (t.exits[k]?.n ?? 0), 0);
function slotRows(cells: readonly Pick<BtCell, 'slot' | 'method' | 'tot'>[], nameOf: (id: string) => string, into = new Map<string, BtSlotRow>()): Map<string, BtSlotRow> {
  for (const c of cells) {
    const k = `${c.slot}|${c.method}`;
    const r = into.get(k) ?? { slot: c.slot, method: c.method, name: nameOf(c.method), n: 0, wins: 0, net: 0, charges: 0, stops: 0 };
    r.n += c.tot.n; r.wins += c.tot.wins; r.net += c.tot.net; r.charges += c.tot.charges; r.stops += stopsOf(c.tot);
    into.set(k, r);
  }
  return into;
}
const slotList = (m: Map<string, BtSlotRow>) => [...m.values()].sort((a, b) => a.slot - b.slot || b.net - a.net);
/** Each method's name as the screens say it: "#50 Gamma wall reaction". */
async function methodNames(): Promise<Map<string, string>> {
  return new Map((await rows<{ id: string; n: number | null; name: string }>('SELECT id, n, name FROM entry_methods')).map((m) => [m.id, m.n === null ? m.name : `#${m.n} ${m.name}`]));
}

function cellsOf(day: string, trades: readonly BtTrade[]): BtCell[] {
  const by = new Map<string, BtCell>();
  for (const t of trades) {
    const s = t.signal;
    const slot = slotOf(s.filledAt);
    const key = `${s.method}|${s.mode}|${s.tf}|${t.vol}|${slot}`;
    const cell = by.get(key) ?? { day, method: s.method, mode: s.mode, tf: s.tf, vol: t.vol, slot, tot: zeroBt() };
    by.set(key, cell);
    const x = cell.tot, win = t.netUsd > 0;
    x.n++; x.net += t.netUsd; x.perpPts += t.perpPts; x.charges += t.chargesUsd;
    // The perp's own: after its fees, and over the signal's risk.
    const p = perpOf(t);
    x.perpNetPts += p.netPts; x.perpR += p.r; x.perpRNet += p.rNet; if (p.netPts > 0) x.perpWins++;
    if (win) { x.wins++; x.won += t.netUsd; } else { x.losses++; x.lost -= t.netUsd; }
    const e = x.exits[t.by] ?? (x.exits[t.by] = { n: 0, wins: 0, net: 0 });
    e.n++; e.net += t.netUsd; if (win) e.wins++;
  }
  return [...by.values()];
}

/** A trade's time open and the margin it held, with what it is filtered by: what the day's peak margin is worked from. */
type Span = { at: number; until: number; margin: number; lots: number; tf: string; method: string };
/** A day's signals by what they are filtered by: how many there were of a time frame and method, and why those not traded were not. */
type Tally = { tf: string; method: string; signals: number; skipped: Record<BtSkip, number>; /** Traded one strike further out, the one picked first being full. */ fwd: number };
type HeldDay = { at: number; cells: BtCell[]; tally: Tally[]; spans: Span[]; grain: BoardGrain };
const held = new Map<string, HeldDay>();
/** At most this many worked days are kept -- some sixty sets of settings over a fortnight; the longest unasked-for goes first. */
const HELD_MAX = 800;
export function clearSignalBacktestCache(): void { held.clear(); raw.clear(); ivHeld.clear(); levelHeld.clear(); baselineHeld.clear(); }
/** The SL or the TGT outside the range asked for: nearer than a minimum, or further than a maximum. 0 is no bound. */
function outOfRange(sig: BtSignal, target: number, p: Pick<BacktestParams, 'slMin' | 'slMax' | 'tgtMin' | 'tgtMax'>): boolean {
  const sl = Math.abs(sig.fillPrice - sig.stop), tgt = Math.abs(sig.fillPrice - target);
  const lo = (v: number, min = 0) => min > 0 && v < min, hi = (v: number, max = 0) => max > 0 && v > max;
  return lo(sl, p.slMin) || hi(sl, p.slMax) || lo(tgt, p.tgtMin) || hi(tgt, p.tgtMax);
}
/** The most on one strike as a key: its per cent and what is done at it; none at 100 or absent. */
const strikeKey = (p: Pick<BacktestParams, 'strikePct' | 'strikeFull'>) => ((p.strikePct ?? 100) >= 100 ? 'sk:-' : `sk:${p.strikePct}${p.strikeFull === 'skip' ? 's' : 'n'}`);
export const paramsKey = (p: BacktestParams) => `${p.rule}|${p.value}|${p.lots}|${p.targetPct}|${p.stopPct}|${p.window}${p.window === 'custom' ? `:${p.hoursFrom}-${p.hoursTo}` : ''}|${p.deskMax ?? 0}|${p.cePct ?? 100}|${p.pePct ?? 100}|${strikeKey(p)}|${p.slMin ?? 0}-${p.slMax ?? 0}-${p.tgtMin ?? 0}-${p.tgtMax ?? 0}|${(p.targetSteps ?? []).map((x) => `${x.at}=${x.pct}`).join(',')}|vol:${p.vol ?? 'off'}|vb:${p.volBy ?? 'atr'}|floor:${p.minPremium ?? MIN_PREMIUM}|ne:${p.noEntry?.on ? p.noEntry.windows.map((w) => `${w.from}-${w.to}`).join(',') : ''}|sb:${p.strikeBlocks?.length ? JSON.stringify(p.strikeBlocks) : ''}|tsl:${p.tsl ? tslQueryOf(p.tsl) : ''}|wid:${p.widenSlAtr ?? 0}-${p.widenTgtAtr ?? 0}-${p.widenMode ?? 'widest'}|skip:${p.skipPerpSl ? 'sl' : ''}${p.skipPerpTgt ? 'tgt' : ''}|be:${p.breakEven ? `${p.breakEven.move}${p.breakEven.unit}` : ''}${chaseKey(p)}`;
/** A strategy's rules as a key: its id, and its rules themselves -- edited, it is another backtest. */
function strategyKey(s: Strategy): string {
  // Its methods' history too: a new day's pick is another backtest of the same rules (`methodsAt`).
  const text = JSON.stringify({ c: s.config, h: (s as BacktestStrategy).methodHistory ?? [] });
  let h = 0;
  for (let i = 0; i < text.length; i++) h = (Math.imul(h, 31) + text.charCodeAt(i)) | 0;
  return `strategy:${s.id}:${h}`;
}
/** A day still running, or just over, is worked again after this long; one long settled is kept. */
const FRESH_MS = 5 * 60_000;
const SETTLED_MS = 6 * 3_600_000;

const expiryCodeOf = (day: string) => `${day.slice(8, 10)}${day.slice(5, 7)}${day.slice(2, 4)}`;

/**
 * A day as it was read: its signals in the order they are taken, its perp minutes (from two hours before it, for
 * the volatility at its first signals), and its board made ready. Kept by the thread that works the backtests --
 * a settled day does not change, and reading and preparing a day a minute at a time is most of what one costs;
 * with it kept, another set of settings is only the arithmetic again.
 */
type RawDay = { at: number; signals: BtSignal[]; minutes: MinuteBar[]; board: PreparedBoard; grain: BoardGrain };
const raw = new Map<string, RawDay>();
/** At most this many days are kept ready (about 7 MB each a minute at a time); the oldest read goes first. */
const RAW_DAYS = 45;

async function rawDay(day: string, now: number, marksSeen: number): Promise<RawDay> {
  // With how many of its contracts' minutes have been fetched: a day read on the five-minute record is read again when they arrive.
  const id = `${day}|marks:${marksSeen}`;
  const h = raw.get(id);
  const { from, to } = sessionOf(day);
  if (h && (h.at >= to + SETTLED_MS || now - h.at < FRESH_MS)) return h;
  type Reading = { at: string; cp: 'C' | 'P'; strike: number; spot: number | null; bid: number | null; ask: number | null; mark: number | null; delta: number | null; oi: number | null };
  const code = expiryCodeOf(day);
  const [sig, bars, five, own, wanted] = await Promise.all([
    rows<Record<string, string | number | null>>(
      `SELECT method, mode, tf, dir, trigger_at, filled_at, fill_price, stop, tp1, tp2, tp3 FROM entry_setups
        WHERE filled_at IS NOT NULL AND filled_at >= $1 AND filled_at < $2 AND first_seen >= $3 AND fill_price IS NOT NULL
        ORDER BY filled_at`, [Math.floor(from / 1_000), Math.floor(to / 1_000), from - 5 * 86_400_000]),
    rows<{ at: string; high: number; low: number; vwap: number }>(
      // From two hours before the day: the volatility at its first signals is read from the candles behind them.
      'SELECT at, high, low, vwap FROM trade_flow_1m WHERE at >= $1 AND at < $2 AND high IS NOT NULL AND low IS NOT NULL AND vwap IS NOT NULL ORDER BY at', [from - VOL_CANDLES * 900_000, to]),
    rows<Reading>('SELECT at, cp, strike, spot, bid, ask, mark, delta, oi FROM option_snapshots WHERE expiry = $1 AND at >= $2 AND at <= $3 ORDER BY at', [code, from - BOARD_NEAR_MS, to]),
    rows<Reading>('SELECT at, cp, strike, spot, bid, ask, mark, delta, oi FROM option_snapshots_1m WHERE expiry = $1 AND at >= $2 AND at <= $3 ORDER BY at', [code, from - BOARD_NEAR_MS, to]),
    // Delta's minutes are used for a day only once every contract of it has been fetched: half a board would pick other strikes.
    to <= now ? marksWanted(day, { from, to }) : Promise.resolve(['still running']),
  ]);
  // A contract's minutes as one line of text each -- "time:mark,time:mark" -- not a row a minute: a hundred thousand rows a day is mostly the cost of carrying them.
  const marks = wanted.length ? [] : await rows<{ symbol: string; xs: string }>(
    `SELECT m.symbol, string_agg(m.at::text || ':' || m.open::text, ',' ORDER BY m.at) AS xs
       FROM option_marks_fetched f JOIN option_marks_1m m ON m.symbol = f.symbol
      WHERE f.expiry = $1 AND m.at >= $2 AND m.at <= $3 GROUP BY m.symbol`, [code, from - BOARD_NEAR_MS, to]);
  const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
  const signals: BtSignal[] = sig.map((x): BtSignal => ({
    method: String(x.method), mode: x.mode === 'mtf' ? 'mtf' : 'single', tf: String(x.tf), dir: Number(x.dir) === 1 ? 1 : -1,
    filledAt: Number(x.filled_at) * 1_000, fillPrice: Number(x.fill_price), stop: Number(x.stop), target: Number(x.tp1), tp2: num(x.tp2), tp3: num(x.tp3),
    triggerAt: Number(x.trigger_at),
  })).sort(signalOrder);
  const minutes: MinuteBar[] = bars.map((b) => ({ at: Number(b.at), high: Number(b.high), low: Number(b.low), close: Number(b.vwap) }));
  const reading = (b: Reading): BoardRow => ({ at: Number(b.at), cp: b.cp, strike: Number(b.strike), spot: num(b.spot), bid: num(b.bid), ask: num(b.ask), mark: num(b.mark), delta: num(b.delta), oi: num(b.oi) });
  const minuteMarks: MarkMinute[] = [];
  for (const m of marks) {
    // `P-BTC-80000-091026`: the side and the strike are in the contract's own name.
    const part = m.symbol.split('-'), cp = part[0] === 'P' ? 'P' as const : 'C' as const, strike = Number(part[2]);
    for (const pair of m.xs.split(',')) { const cut = pair.indexOf(':'); minuteMarks.push({ cp, strike, at: Number(pair.slice(0, cut)), open: Number(pair.slice(cut + 1)) }); }
  }
  const priced = minuteBoard({ five: five.map(reading), own: own.map(reading), marks: minuteMarks });
  const out: RawDay = { at: now, signals, minutes, board: prepareBoard(priced.board), grain: priced.grain };
  for (const k of [...raw.keys()]) if (k.startsWith(`${day}|`)) raw.delete(k);
  raw.set(id, out);
  while (raw.size > RAW_DAYS) raw.delete(raw.keys().next().value!);
  return out;
}

/** Each expiry day's ATM IV, a reading every five minutes (`option_snapshots`); a settled day is kept, as `raw` keeps its board. */
const ivHeld = new Map<string, { at: number; xs: AtmIv[] }>();
const IV_HELD_MAX = 120;
/** The days before one that its IV levels may be cut from: enough calendar days to find `IV_DAYS` with readings. */
const ivBack = (day: string) => Array.from({ length: IV_DAYS + 4 }, (_, i) => new Date(Date.parse(`${day}T00:00:00Z`) - (i + 1) * 86_400_000).toISOString().slice(0, 10));

async function atmIvDays(days: readonly string[], now: number, freshMs = FRESH_MS): Promise<Map<string, AtmIv[]>> {
  const out = new Map<string, AtmIv[]>();
  const want: string[] = [];
  for (const d of new Set(days)) {
    const h = ivHeld.get(d), { to } = sessionOf(d);
    if (h && (h.at >= to + SETTLED_MS || now - h.at < freshMs)) out.set(d, h.xs); else want.push(d);
  }
  if (!want.length) return out;
  const spans = want.map((d) => ({ d, code: expiryCodeOf(d), ...sessionOf(d) }));
  // The call and the put nearest the money at each reading of each day's own contract; nothing else of the board is read.
  const got = await rows<{ expiry: string; at: string; cp: 'C' | 'P'; iv: number | null }>(
    `SELECT DISTINCT ON (expiry, at, cp) expiry, at, cp, mark_iv AS iv FROM option_snapshots
      WHERE expiry = ANY($1) AND at >= $2 AND at < $3 AND spot IS NOT NULL AND mark_iv > 0
      ORDER BY expiry, at, cp, abs(strike - spot)`,
    [spans.map((s) => s.code), Math.min(...spans.map((s) => s.from)), Math.max(...spans.map((s) => s.to))]);
  for (const s of spans) {
    const xs = atmIvOf(got.filter((g) => g.expiry === s.code && Number(g.at) >= s.from && Number(g.at) < s.to)
      .map((g) => ({ at: Number(g.at), cp: g.cp, iv: g.iv === null ? null : Number(g.iv) })));
    ivHeld.delete(s.d);
    ivHeld.set(s.d, { at: now, xs });
    out.set(s.d, xs);
  }
  while (ivHeld.size > IV_HELD_MAX) ivHeld.delete(ivHeld.keys().next().value!);
  return out;
}
/** Every day of a range read in one go, with the days before each that its levels are cut from: then `ivReaderOf` finds them kept. */
async function preloadIv(days: readonly string[], now: number): Promise<void> {
  await atmIvDays(days.flatMap((d) => [d, ...ivBack(d)]), now);
}
/** A day's IV reader (`ivReader`), its levels cut from the `IV_DAYS` latest expiry days before it that have readings. */
async function ivReaderOf(day: string, now: number, freshMs = FRESH_MS): Promise<(at: number) => VolLevel | null> {
  const back = ivBack(day);
  const m = await atmIvDays([day, ...back], now, freshMs);
  const prior = back.map((d) => m.get(d) ?? []).filter((xs) => xs.length).slice(0, IV_DAYS).flat();
  return ivReader(m.get(day) ?? [], prior);
}
/** A day's volatility reader for one backtest's settings: the candles' (`volReader`) or the board's IV (`ivReader`). */
async function volAtFor(by: VolBy | undefined, day: string, minutes: readonly MinuteBar[], baseline: number | null, now: number): Promise<(at: number) => VolLevel | null> {
  return by === 'iv' ? ivReaderOf(day, now) : volReader(minutes, baseline);
}

/**
 * How volatile it is NOW, for a live signal (owner, 17 Oct 2026: delta by volatility in the signal strategy form):
 * the very reading the backtest makes at a fill -- `volReader` on the perp's minutes against the five expiry days
 * before, or `ivReader` on the board's recorded ATM IV against the same hour of them -- so a strategy trades on the
 * level its backtest says it would have. Null where it cannot be said, and on any failure: the strategy then keeps
 * its own delta. Kept a minute; the board's IV read again a minute at most after it was last read.
 */
const levelHeld = new Map<string, VolLevel | null>();
const baselineHeld = new Map<string, number | null>();
const LIVE_IV_FRESH_MS = 60_000;
export async function volLevelNow(by: VolBy, at: number): Promise<VolLevel | null> {
  const key = `${by}|${Math.floor(at / 60_000)}`;
  if (levelHeld.has(key)) return levelHeld.get(key)!;
  let level: VolLevel | null = null;
  try {
    const day = sessionDayOf(at);
    if (by === 'iv') level = (await ivReaderOf(day, at, LIVE_IV_FRESH_MS))(at);
    else {
      let baseline = baselineHeld.get(day);
      if (baseline === undefined) {
        const before = new Date(Date.parse(`${day}T00:00:00Z`) - 8 * 86_400_000).toISOString().slice(0, 10);
        const prior = (await marketDays(before, day, at)).filter((d) => d.day < day && d.stats && !d.live).slice(-5).map((d) => d.stats!.atr);
        baseline = prior.length ? prior.reduce((a, x) => a + x, 0) / prior.length : null;
        baselineHeld.set(day, baseline);
        while (baselineHeld.size > 8) baselineHeld.delete(baselineHeld.keys().next().value!);
      }
      const bars = await rows<{ at: string; high: number; low: number; vwap: number }>(
        'SELECT at, high, low, vwap FROM trade_flow_1m WHERE at >= $1 AND at < $2 AND high IS NOT NULL AND low IS NOT NULL AND vwap IS NOT NULL ORDER BY at',
        [at - (VOL_CANDLES + 1) * 900_000, at]);
      level = volReader(bars.map((b) => ({ at: Number(b.at), high: Number(b.high), low: Number(b.low), close: Number(b.vwap) })), baseline)(at);
    }
  } catch { level = null; }
  levelHeld.set(key, level);
  while (levelHeld.size > 16) levelHeld.delete(levelHeld.keys().next().value!);
  return level;
}

/**
 * The level now by both sources, for the strategies screen (17 Oct 2026): its five-second poll is served what was
 * read, never made to wait on a reading -- the server reads it once a minute (index.ts), and a read older than half a
 * minute is read again behind the answer, waited on at most a quarter of a second.
 */
export const volNowHeld = freshInBackground(async () => {
  const now = Date.now();
  const [iv, atr] = await Promise.all([volLevelNow('iv', now), volLevelNow('atr', now)]);
  return { iv, atr };
}, 30_000);
/** What a strategy's own volatility is read by, where it sets its delta or its SL by it; else the backtest's own setting. */
export const ownVolBy = (st: Strategy | null | undefined, fallback: VolBy | undefined): VolBy | undefined =>
  (st ? volSourceOf(st.config) : null) ?? fallback;

/** One day under one set of rules. `takes` narrows the signals to those the rules are about at all (a strategy's methods and timeframes). */
async function dayOf(day: string, key: string, now: number, planFor: (span: { from: number; to: number }) => DayPlan, takes: (sig: BtSignal) => boolean, vol: { only: VolLevel | null; baseline: number | null; by?: VolBy }, marksSeen = 0): Promise<HeldDay> {
  const id = `${day}|${key}|marks:${marksSeen}`;
  const h = held.get(id);
  const { from, to } = sessionOf(day);
  if (h && (h.at >= to + SETTLED_MS || now - h.at < FRESH_MS)) { held.delete(id); held.set(id, h); return h; }
  const d = await rawDay(day, now, marksSeen);
  const signals = d.signals.filter(takes);
  const r = simulateDay({
    from, to, signals, plan: planFor({ from, to }),
    volAt: await volAtFor(vol.by, day, d.minutes, vol.baseline, now), volOnly: vol.only,
    bars: d.minutes.filter((b) => b.at >= from),
    board: d.board,
  });
  const tally = new Map<string, Tally>();
  const tallyOf = (sig: BtSignal) => {
    const tf = sig.mode === 'mtf' ? CHAIN_KEY : sig.tf, k = `${tf}|${sig.method}`;
    let x = tally.get(k);
    if (!x) { x = { tf, method: sig.method, signals: 0, skipped: noSkips(), fwd: 0 }; tally.set(k, x); }
    return x;
  };
  for (const sig of signals) tallyOf(sig).signals++;
  for (const x of r.refused) tallyOf(x.signal).skipped[x.why]++;
  for (const t of r.trades) if (t.fwdFrom !== undefined) tallyOf(t.signal).fwd++;
  const out: HeldDay = {
    at: now, cells: cellsOf(day, r.trades), tally: [...tally.values()], grain: d.grain,
    spans: r.trades.map((t) => ({ at: t.signal.filledAt, until: t.exitAt, margin: t.marginUsd, lots: t.lots, tf: t.signal.mode === 'mtf' ? CHAIN_KEY : t.signal.tf, method: t.signal.method })),
  };
  held.delete(id);
  held.set(id, out);
  while (held.size > HELD_MAX) held.delete(held.keys().next().value!);
  return out;
}

/**
 * The most margin open at once over a day's trades, and when: a sweep over their times. A trade ending at the moment
 * another starts has made room for it -- as "at most N open" counts (`until > at`).
 */
export function peakMargin(spans: readonly { at: number; until: number; margin: number; lots?: number }[]): { usd: number; at: number | null; open: number; /** The lots those trades were of, together: what the margin is so many times a lot's. */ lots: number } {
  const ev: [number, number, number, number][] = [];
  for (const x of spans) { ev.push([x.at, 1, x.margin, x.lots ?? 0]); ev.push([x.until, 0, -x.margin, -(x.lots ?? 0)]); }
  ev.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let usd = 0, open = 0, lots = 0, best = { usd: 0, at: null as number | null, open: 0, lots: 0 };
  for (const [at, kind, m, l] of ev) {
    usd += m; open += kind === 1 ? 1 : -1; lots += l;
    if (usd > best.usd + 1e-9) best = { usd, at, open, lots };
  }
  return best;
}

export type BtRow = BtTot & { key: string; name: string; tf?: string; days?: number };
export type SignalBacktest = {
  from: string; to: string;
  /** The screen's own settings; with a strategy chosen, what its rules come to where they are one number, for the line that says them. */
  params: BacktestParams;
  /** The strategy backtested, with what of it could not be replayed and what its real orders made in the range. Null: the screen's own settings. */
  strategy: { id: string; name: string; accountId: number | null; caveats: string[]; real: Tot } | null;
  /**
   * The margin the trades shown would have held, by the desk's 200x estimate: the most open at once in the range
   * (and when, and how many trades that was), an average day's most, and an average trade's.
   */
  margin: { peakUsd: number; peakDay: string | null; peakAt: number | null; peakOpen: number; /** The lots open at that moment, together. */ peakLots: number; avgDailyPeakUsd: number; avgTradeUsd: number };
  /** Signals in the trade in the range, how many were traded, and why the rest were not. */
  signals: number; skipped: Record<BtSkip, number>;
  /** Of those traded, how many on a strike further out than the rule's first pick, that one being full (`strikePct`). */
  forwarded?: number;
  total: BtTot;
  days: (BtTot & { day: string; pattern: PatternKey | null; live: boolean; grain: BoardGrain })[];
  /**
   * What the options were priced on, in expiry days: the desk's own minute record, Delta's minute mark with the
   * desk's spread, or the five-minute record alone -- the last where a day's minutes are still to be fetched.
   */
  priced: Record<BoardGrain, number>;
  pairs: BtRow[]; byTf: BtRow[]; byMethod: BtRow[]; byPattern: BtRow[]; byFamily: BtRow[];
  /** By how volatile the market was when each signal filled: low, medium, high, in that order; those it could not be said of are left out. */
  byVol: BtRow[];
  /** Each method in each fifteen-minute slot of the day (`slotOf`), over the range: the session table's own figures. */
  bySession: BtSlotRow[];
  /** What there is to filter by. Each method carries what it made on the timeframes chosen, whichever methods are ticked. */
  choices: { timeframes: { key: string; name: string }[]; methods: { key: string; name: string; n: number; wins: number; net: number }[] };
};

const TF_ORDER = ['1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', CHAIN_KEY];
const tfPlace = (k: string) => { const i = TF_ORDER.indexOf(k); return i === -1 ? TF_ORDER.length : i; };
const tfKeyOf = (c: Pick<BtCell, 'mode' | 'tf'>) => (c.mode === 'mtf' ? CHAIN_KEY : c.tf);

let working: Promise<unknown> = Promise.resolve();

/** The whole range, one request at a time: a cold range reads every day's board, and two at once would read it twice. */
export type Ask = {
  from: string; to: string; now: number; params: BacktestParams; tfs: readonly string[] | null; methods: readonly string[] | null; strategy?: Strategy | null; spot?: number | null;
  /**
   * The strategy is a form's draft asked for its methods' records, not a saved one: it has placed no orders to
   * read, and its "at most open" is left out -- each method is tried on all its signals.
   */
  draft?: boolean;
};

/** A strategy the backtest can be asked about: one that trades signals by selling. */
export const backtestable = (s: Strategy): boolean => s.config.trigger === 'signal' && !!s.config.signal && actionOf(s.config.signal) === 'sell';

/**
 * A backtest worked in the thread that asks for it, one at a time. The server asks through `backtest-run.ts`,
 * which gives it a thread of its own; this is that thread's work, and what a test or a script calls.
 */
export function signalBacktestHere(o: Ask): Promise<SignalBacktest> {
  const run = working.then(() => signalBacktestNow(o));
  working = run.catch(() => { });
  return run;
}

/**
 * Several backtests over the same days, and what they come to together (owner, 13 Oct 2026: "several saved
 * backtests as a portfolio, with the total of them all").
 *
 * Each is worked on its own, exactly as it is alone -- its own signals, its own limits; one does not take a place
 * from another -- and the results are added: the trades, the money, the charges, day by day. The margin is not a
 * sum of each one's most: their trades are laid on one clock and the most held at once is found across all of
 * them (`peakMargin`), which is what running them side by side on one account would have needed.
 */
export type PortfolioAsk = {
  from: string; to: string; now: number; spot?: number | null;
  /**
   * One account's limit over all of them: at most this many open together, and each side its per cent of it. With
   * it the members are not worked alone and added up but traded on one clock, in the desk's own order, for the same
   * places (`simulateTogether`); their own "at most open" settings are set aside for it. Null or absent: each as
   * it is alone, its own limit on its own trades.
   */
  shared?: { deskMax: number; cePct: number; pePct: number; strikePct?: number; strikeFull?: 'next' | 'skip' } | null;
  /** Each with its settings; one that cannot be worked -- its strategy deleted -- carries why, and is listed with nothing. */
  members: { id: string; name: string; ask: Pick<Ask, 'params' | 'tfs' | 'methods' | 'strategy'> | null; problem?: string | null }[];
};
export type BacktestPortfolioResult = {
  from: string; to: string;
  /** The one limit they were traded under together, as the desk rounds it; null where each kept its own. */
  shared: {
    max: number; ce: number; pe: number; cePct: number; pePct: number;
    /** The most on one strike, and its per cent of `max`; null, none. What a signal did at it, and how many went further out. */
    strike: number | null; strikePct: number; strikeFull: 'next' | 'skip'; forwarded: number;
    /** Signals that found the account, or their side of it, or their strike with nowhere further out, full. */
    turnedAway: number;
  } | null;
  /** Each method in each fifteen-minute slot, all of them together (`BtSlotRow`). */
  bySession: BtSlotRow[];
  members: { id: string; name: string; problem: string | null; signals: number; total: BtTot; marginPeakUsd: number; priced: Record<BoardGrain, number> | null }[];
  total: BtTot;
  /** Each expiry day: all of them together, and each one's own net in the members' order. */
  days: { day: string; live: boolean; n: number; wins: number; net: number; charges: number; byMember: number[]; /** What its options were priced on: one board for all of them. */ grain: BoardGrain }[];
  margin: { peakUsd: number; peakDay: string | null; peakAt: number | null; peakOpen: number; /** The lots open at that moment, across all of them. */ peakLots: number; avgDailyPeakUsd: number; sumOfPeaksUsd: number };
  /**
   * The same breakdowns as one backtest's, of all of them together (owner, 17 Oct 2026: "the backtest's output screen
   * and the portfolio's do not match"): by exit (in `total`), time frame, method, pair, kind of day and volatility.
   * And the signals in the trade, with why those not traded were not, added over the members.
   */
  breakdown: BtBreakdown;
  signals: number;
  skipped: Record<BtSkip, number>;
};

export function portfolioBacktestHere(o: PortfolioAsk): Promise<BacktestPortfolioResult> {
  const run = working.then(() => portfolioNow(o));
  working = run.catch(() => { });
  return run;
}

/** What one backtest asks of a day's signals, with no limit of the desk's on it: which it is about, how it trades them, its volatility filter. */
function bookOf(o: Pick<Ask, 'params' | 'tfs' | 'methods' | 'strategy'>): { takes: (sig: BtSignal) => boolean; planFor: (span: { from: number; to: number }) => DayPlan; volOnly: VolLevel | null; volBy: VolBy } {
  const st = o.strategy ?? null, own = ownSignal(st);
  const free = { ...o.params, deskMax: 0 };
  return {
    takes: (sig) => own(sig)
      && (!o.tfs || o.tfs.includes(sig.mode === 'mtf' ? CHAIN_KEY : sig.tf)) && (!o.methods || o.methods.includes(sig.method)),
    planFor: (span) => (st ? withChase(planOfStrategy(st, span, null), o.params) : planOfParams(free, span)),
    volOnly: o.params.vol && o.params.vol !== 'off' ? o.params.vol : null,
    volBy: ownVolBy(st, o.params.volBy) ?? 'atr',
  };
}
/** A day's readers for the books that need them: the candles' always (it costs nothing), the IV's only where a book reads it. */
async function dayReaders(books: readonly { volBy: VolBy }[], day: string, minutes: readonly MinuteBar[], baseline: number | null, now: number): Promise<Record<VolBy, (at: number) => VolLevel | null>> {
  const atr = volReader(minutes, baseline);
  return { atr, iv: books.some((b) => b.volBy === 'iv') ? await ivReaderOf(day, now) : () => null };
}

/** The members traded as one account: one clock, one line, one limit on what is open (`simulateTogether`). */
async function portfolioShared(o: PortfolioAsk, caps: NonNullable<ReturnType<typeof deskCapsOf>>): Promise<BacktestPortfolioResult> {
  await Promise.all([flowSchema(), optionSnapshotsSchema(), optionMarksSchema(), entrySchema(), methodsSchema()]);
  const before = new Date(Date.parse(`${o.from}T00:00:00Z`) - 8 * 86_400_000).toISOString().slice(0, 10);
  const known = await marketDays(before, o.to, o.now);
  const days = known.filter((d) => d.day >= o.from);
  const baselineOf = (day: string): number | null => {
    const prior = known.filter((d) => d.day < day && d.stats && !d.live).slice(-5).map((d) => d.stats!.atr);
    return prior.length ? prior.reduce((a, x) => a + x, 0) / prior.length : null;
  };
  const fetched = await marksFetchedBy(days.map((d) => expiryCodeOf(d.day)));
  const names = await methodNames();
  const sessions = new Map<string, BtSlotRow>();
  const books = o.members.map((m) => (m.ask && !m.problem ? bookOf(m.ask) : null));
  const totals = o.members.map(() => zeroBt()), signals = o.members.map(() => 0), peaks = o.members.map(() => 0);
  const priced = o.members.map((): Record<BoardGrain, number> => ({ 'own-1m': 0, 'mark-1m': 0, '5m': 0 }));
  const rows: BacktestPortfolioResult['days'] = [];
  const cells: BtCell[] = [];
  const skipped = noSkips();
  let peak = { usd: 0, at: null as number | null, open: 0, lots: 0, day: null as string | null }, daily = 0, dailyN = 0, turnedAway = 0, forwarded = 0;
  for (const d of days) {
    const { from, to } = sessionOf(d.day);
    const raw = await rawDay(d.day, o.now, fetched.get(expiryCodeOf(d.day))?.contracts ?? 0);
    const live = books.flatMap((b, i) => (b ? [{ i, b }] : []));
    const readers = await dayReaders(live.map(({ b }) => b), d.day, raw.minutes, baselineOf(d.day), o.now);
    const outs = simulateTogether({
      from, to, bars: raw.minutes.filter((x) => x.at >= from), board: raw.board, shared: caps,
      books: live.map(({ b }) => ({ signals: raw.signals.filter(b.takes), plan: b.planFor({ from, to }), volAt: readers[b.volBy], volOnly: b.volOnly })),
    });
    const row = { day: d.day, live: d.live, n: 0, wins: 0, net: 0, charges: 0, byMember: o.members.map(() => 0), grain: raw.grain };
    const all: { at: number; until: number; margin: number; lots: number }[] = [];
    live.forEach(({ i }, k) => {
      const out = outs[k]!;
      const dayCells = cellsOf(d.day, out.trades);
      slotRows(dayCells, (id) => names.get(id) ?? id, sessions);
      cells.push(...dayCells);
      for (const k of BT_SKIPS) skipped[k] += out.skipped[k];
      const t = dayCells.reduce((a, c) => addBt(a, c.tot), zeroBt());
      addBt(totals[i]!, t);
      signals[i]! += out.trades.length + out.refused.length;
      turnedAway += out.skipped['desk-limit'] + out.skipped['side-limit'] + out.skipped['strike-limit'];
      forwarded += out.trades.reduce((n, t) => n + (t.fwdFrom !== undefined ? 1 : 0), 0);
      priced[i]![raw.grain]++;
      row.n += t.n; row.wins += t.wins; row.net += t.net; row.charges += t.charges; row.byMember[i] = t.net;
      const mine = out.trades.map((x) => ({ at: x.signal.filledAt, until: x.exitAt, margin: x.marginUsd, lots: x.lots }));
      peaks[i] = Math.max(peaks[i]!, peakMargin(mine).usd);
      all.push(...mine);
    });
    rows.push(row);
    if (all.length) {
      const p = peakMargin(all);
      if (p.usd > peak.usd) peak = { ...p, day: d.day };
      daily += p.usd; dailyN++;
    }
  }
  const members = o.members.map((m, i) => (books[i]
    ? { id: m.id, name: m.name, problem: null, signals: signals[i]!, total: totals[i]!, marginPeakUsd: peaks[i]!, priced: priced[i]! }
    : { id: m.id, name: m.name, problem: m.problem ?? 'It cannot be worked out.', signals: 0, total: zeroBt(), marginPeakUsd: 0, priced: null }));
  const nameOf = (id: string) => names.get(id) ?? id;
  return {
    from: o.from, to: o.to, members, bySession: slotList(sessions),
    breakdown: breakdownOf(cells, new Map(days.map((d) => [d.day, d.pattern])), nameOf),
    signals: signals.reduce((a, x) => a + x, 0), skipped,
    shared: {
      max: caps.max, ce: caps.side?.CE ?? caps.max, pe: caps.side?.PE ?? caps.max, cePct: o.shared!.cePct, pePct: o.shared!.pePct,
      strike: caps.strike, strikePct: o.shared!.strikePct ?? 100, strikeFull: caps.strikeFull, forwarded, turnedAway,
    },
    total: totals.reduce((t, x) => addBt(t, x), zeroBt()),
    days: rows,
    margin: { peakUsd: peak.usd, peakDay: peak.day, peakAt: peak.at, peakOpen: peak.open, peakLots: peak.lots, avgDailyPeakUsd: dailyN ? daily / dailyN : 0, sumOfPeaksUsd: peaks.reduce((a, x) => a + x, 0) },
  };
}

async function portfolioNow(o: PortfolioAsk): Promise<BacktestPortfolioResult> {
  const caps = o.shared ? deskCapsOf(o.shared) : null;
  if (caps) return portfolioShared(o, caps);
  const members: BacktestPortfolioResult['members'] = [];
  const results: (SignalBacktest | null)[] = [];
  const spans = new Map<string, Span[]>();
  const shown: BtCell[] = [];
  const skipped = noSkips();
  for (const m of o.members) {
    if (!m.ask || m.problem) {
      members.push({ id: m.id, name: m.name, problem: m.problem ?? 'It cannot be worked out.', signals: 0, total: zeroBt(), marginPeakUsd: 0, priced: null });
      results.push(null);
      continue;
    }
    const own = new Map<string, Span[]>();
    const r = await signalBacktestNow({ ...m.ask, from: o.from, to: o.to, now: o.now, spot: o.spot ?? null }, own, shown);
    for (const k of BT_SKIPS) skipped[k] += r.skipped[k];
    for (const [day, xs] of own) { const all = spans.get(day); if (all) all.push(...xs); else spans.set(day, [...xs]); }
    members.push({ id: m.id, name: m.name, problem: null, signals: r.signals, total: r.total, marginPeakUsd: r.margin.peakUsd, priced: r.priced });
    results.push(r);
  }
  const worked = results.filter((r): r is SignalBacktest => r !== null);
  const dayList = worked[0]?.days.map((d) => ({ day: d.day, live: d.live, grain: d.grain })) ?? [];
  const days = dayList.map((d, i) => {
    const each = results.map((r) => r?.days[i] ?? null);
    return {
      ...d,
      n: each.reduce((a, x) => a + (x?.n ?? 0), 0), wins: each.reduce((a, x) => a + (x?.wins ?? 0), 0),
      net: each.reduce((a, x) => a + (x?.net ?? 0), 0), charges: each.reduce((a, x) => a + (x?.charges ?? 0), 0),
      byMember: each.map((x) => x?.net ?? 0),
    };
  });
  let peak = { usd: 0, at: null as number | null, open: 0, lots: 0, day: null as string | null }, daily = 0, dailyN = 0;
  for (const [day, xs] of spans) {
    if (!xs.length) continue;
    const p = peakMargin(xs);
    if (p.usd > peak.usd) peak = { ...p, day };
    daily += p.usd; dailyN++;
  }
  const sessions = new Map<string, BtSlotRow>();
  for (const r of worked) for (const x of r.bySession) {
    const k = `${x.slot}|${x.method}`, h = sessions.get(k);
    if (h) { h.n += x.n; h.wins += x.wins; h.net += x.net; h.charges += x.charges; h.stops += x.stops; } else sessions.set(k, { ...x });
  }
  const known = await marketDays(o.from, o.to, o.now);
  const names = await methodNames();
  return {
    from: o.from, to: o.to, members, shared: null, bySession: slotList(sessions),
    breakdown: breakdownOf(shown, new Map(known.map((d) => [d.day, d.pattern])), (id) => names.get(id) ?? id),
    signals: worked.reduce((a, r) => a + r.signals, 0), skipped,
    total: worked.reduce((t, r) => addBt(t, r.total), zeroBt()),
    days,
    margin: { peakUsd: peak.usd, peakDay: peak.day, peakAt: peak.at, peakOpen: peak.open, peakLots: peak.lots, avgDailyPeakUsd: dailyN ? daily / dailyN : 0, sumOfPeaksUsd: members.reduce((a, m) => a + m.marginPeakUsd, 0) },
  };
}

/**
 * Methods by win % at several bars at once (owner, 20 Oct 2026, after a table of net at win 50% to 75%, worked by
 * hand: "an editable range -- the win %, the strategies and the least trades -- in the backtest and the portfolio").
 *
 * For each saved backtest (or the settings on the screen): every method's record on the pick days, as the run's
 * "methods by win %" reads it, then -- for each least-trades and each win % -- the methods that pass (`pickMethods`)
 * backtested on the run's days, each alone on its own limit. A cell is exactly what a run of that one with that bar
 * would make. The same list at two bars is worked once. Beside them, as saved and every method, for the baseline.
 */
export type WinSweepAsk = {
  from: string; to: string; now: number; spot?: number | null;
  /** The days each one's methods are picked on: before the run, its first days, its own, or days chosen. */
  pick: { from: string; to: string };
  pcts: readonly number[]; minTrades: readonly number[];
  members: PortfolioAsk['members'];
};
/** What a list traded: how many methods, trades, won, and money after charges, dollars. Null: no method passed -- nothing traded. */
export type WinSweepCell = { methods: number; n: number; wins: number; net: number; charges: number } | null;
export type WinSweepRow = {
  id: string; name: string; problem: string | null;
  saved: WinSweepCell; all: WinSweepCell;
  /** By least trades, then by win %, in the order asked. */
  cells: WinSweepCell[][];
};
export type WinSweep = {
  from: string; to: string; pick: { from: string; to: string }; pcts: number[]; minTrades: number[];
  rows: WinSweepRow[];
  /** Every row added up -- each alone, so as a run together with each its own limit. */
  total: Omit<WinSweepRow, 'id' | 'name' | 'problem'>;
  /** The backtests it took, after the same lists were worked once. */
  runs: number;
};

export function winSweepHere(o: WinSweepAsk): Promise<WinSweep> {
  const run = working.then(() => winSweepNow(o));
  working = run.catch(() => { });
  return run;
}

async function winSweepNow(o: WinSweepAsk): Promise<WinSweep> {
  let runs = 0;
  const rows: WinSweepRow[] = [];
  for (const m of o.members) {
    const empty = { saved: null, all: null, cells: o.minTrades.map(() => o.pcts.map((): WinSweepCell => null)) };
    if (!m.ask || m.problem) { rows.push({ id: m.id, name: m.name, problem: m.problem ?? 'It cannot be worked out.', ...empty }); continue; }
    if (m.ask.strategy) { rows.push({ id: m.id, name: m.name, problem: 'Worked by a strategy: it keeps the strategy\'s methods.', ...empty }); continue; }
    const ask = m.ask;
    // One backtest a list of methods: `*` every one.
    const done = new Map<string, WinSweepCell>();
    const tried = async (methods: readonly string[] | null): Promise<WinSweepCell> => {
      const key = methods === null ? '*' : [...methods].sort().join(',');
      const had = done.get(key);
      if (had !== undefined) return had;
      runs++;
      const r = await signalBacktestNow({ ...ask, methods, from: o.from, to: o.to, now: o.now, spot: o.spot ?? null });
      const cell = { methods: methods?.length ?? r.choices.methods.length, n: r.total.n, wins: r.total.wins, net: r.total.net, charges: r.total.charges };
      done.set(key, cell);
      return cell;
    };
    // The record: every method on the pick days. Picked on the run's own days, it is also every method's run.
    runs++;
    const rec = await signalBacktestNow({ ...ask, methods: null, from: o.pick.from, to: o.pick.to, now: o.now, spot: o.spot ?? null });
    if (o.pick.from === o.from && o.pick.to === o.to) done.set('*', { methods: rec.choices.methods.length, n: rec.total.n, wins: rec.total.wins, net: rec.total.net, charges: rec.total.charges });
    const record = rec.choices.methods.map((x) => ({ method: x.key, trades: x.n, wins: x.wins, net: x.net }));
    const all = await tried(null);
    const saved = ask.methods ? await tried(ask.methods) : all;
    const cells: WinSweepCell[][] = [];
    for (const minTrades of o.minTrades) {
      const line: WinSweepCell[] = [];
      for (const winPct of o.pcts) {
        const ids = pickMethods(record, { winPct, minTrades });
        line.push(ids.length ? await tried(ids) : null);
      }
      cells.push(line);
    }
    rows.push({ id: m.id, name: m.name, problem: null, saved, all, cells });
  }
  const add = (xs: readonly WinSweepCell[]): WinSweepCell => xs.reduce<WinSweepCell>((t, c) => (c === null ? t
    : { methods: (t?.methods ?? 0) + c.methods, n: (t?.n ?? 0) + c.n, wins: (t?.wins ?? 0) + c.wins, net: (t?.net ?? 0) + c.net, charges: (t?.charges ?? 0) + c.charges }), null);
  const worked = rows.filter((r) => r.problem === null);
  return {
    from: o.from, to: o.to, pick: o.pick, pcts: [...o.pcts], minTrades: [...o.minTrades], rows, runs,
    total: {
      saved: add(worked.map((r) => r.saved)), all: add(worked.map((r) => r.all)),
      cells: o.minTrades.map((_, i) => o.pcts.map((__, j) => add(worked.map((r) => r.cells[i]![j]!)))),
    },
  };
}

/** What a result is broken down by: the same for one backtest and for saved backtests run together (`breakdownOf`). */
export type BtBreakdown = Pick<SignalBacktest, 'pairs' | 'byTf' | 'byMethod' | 'byPattern' | 'byFamily' | 'byVol'>;
/** The cells of a result, added up every way the screen breaks it down -- each row with the days it had. */
function breakdownOf(cells: readonly BtCell[], patternOf: ReadonlyMap<string, PatternKey | null>, nameOf: (id: string) => string): BtBreakdown {
  const group = (keyOf: (c: BtCell) => string | null, nameFor: (c: BtCell) => { name: string; tf?: string }): BtRow[] => {
    const by = new Map<string, BtRow & { seen: Set<string> }>();
    for (const c of cells) {
      const key = keyOf(c);
      if (key === null) continue;
      const row = by.get(key) ?? { key, ...nameFor(c), ...zeroBt(), seen: new Set<string>() };
      by.set(key, row);
      addBt(row, c.tot); row.seen.add(c.day);
    }
    return [...by.values()].map(({ seen, ...row }) => ({ ...row, days: seen.size }));
  };
  const byNet = (a: BtRow, b: BtRow) => b.net - a.net || b.n - a.n;
  return {
    pairs: group((c) => `${c.method}|${c.mode}|${c.tf}`, (c) => ({ name: nameOf(c.method), tf: c.mode === 'mtf' ? `${c.tf} + TF chain` : c.tf })).sort(byNet),
    byTf: group(tfKeyOf, (c) => ({ name: c.mode === 'mtf' ? 'With timeframe chain' : c.tf })).sort((a, b) => tfPlace(a.key) - tfPlace(b.key)),
    byMethod: group((c) => c.method, (c) => ({ name: nameOf(c.method) })).sort(byNet),
    byPattern: group((c) => patternOf.get(c.day) ?? null, (c) => { const p = PATTERNS.find((x) => x.key === patternOf.get(c.day))!; return { name: `#${p.id} ${p.name}` }; }).sort(byNet),
    byFamily: group((c) => { const p = patternOf.get(c.day); return p ? familyOf(p) : null; }, (c) => ({ name: FAMILIES.find((f) => f.key === familyOf(patternOf.get(c.day)!))!.name })).sort(byNet),
    byVol: group((c) => c.vol, (c) => ({ name: c.vol === 'low' ? 'Low' : c.vol === 'high' ? 'High' : 'Medium' })).sort((a, b) => VOL_LEVELS.indexOf(a.key as VolLevel) - VOL_LEVELS.indexOf(b.key as VolLevel)),
  };
}

/**
 * `shownOut`, where given, is filled with the trades shown -- their times and margin -- by expiry day: what a portfolio
 * lays on one clock; `cellsOut` with the cells shown: what its breakdowns are added up from.
 */
async function signalBacktestNow(o: Ask, shownOut?: Map<string, Span[]>, cellsOut?: BtCell[]): Promise<SignalBacktest> {
  await Promise.all([flowSchema(), optionSnapshotsSchema(), optionMarksSchema(), entrySchema(), methodsSchema()]);
  // With the eight expiry days before the range: each day's volatility is read against the five before it.
  const before = new Date(Date.parse(`${o.from}T00:00:00Z`) - 8 * 86_400_000).toISOString().slice(0, 10);
  const known = await marketDays(before, o.to, o.now);
  const days = known.filter((d) => d.day >= o.from);
  const baselineOf = (day: string): number | null => {
    const prior = known.filter((d) => d.day < day && d.stats && !d.live).slice(-5).map((d) => d.stats!.atr);
    return prior.length ? prior.reduce((a, x) => a + x, 0) / prior.length : null;
  };
  const volOnly: VolLevel | null = o.params.vol && o.params.vol !== 'off' ? o.params.vol : null;
  // A strategy that sets its delta by volatility is read by its own source, so the backtest trades as the desk does.
  const volBy: VolBy = ownVolBy(o.strategy, o.params.volBy) ?? 'atr';
  if (volBy === 'iv') await preloadIv(days.map((d) => d.day), o.now);
  const names = new Map((await rows<{ id: string; n: number | null; name: string }>('SELECT id, n, name FROM entry_methods')).map((m) => [m.id, m.n === null ? m.name : `#${m.n} ${m.name}`]));
  const nameOf = (id: string) => names.get(id) ?? id;
  const skipped = noSkips();
  let signals = 0, forwarded = 0;
  const every: BtCell[] = [];
  const st = o.strategy ?? null;
  // A strategy's own signals, each on the methods it had then (`ownSignal`).
  // A strategy is only ever asked about its own signals: its way of reading, its timeframes, its methods.
  const ownOnly = ownSignal(st);
  const caps = deskCapsOf(o.params);
  const strategyPlan = (s: Strategy, span: { from: number; to: number }, desk: DayPlan['desk']): DayPlan => withChase(o.draft ? { ...planOfStrategy(s, span, desk), maxOpen: null } : planOfStrategy(s, span, desk), o.params);
  const spansByDay = new Map<string, Span[]>();
  const fetched = await marksFetchedBy(days.map((d) => expiryCodeOf(d.day)));
  const marksSeen = (day: string) => fetched.get(expiryCodeOf(day))?.contracts ?? 0;
  const grainOf = new Map<string, BoardGrain>();
  /*
   * With a limit on what is open, which signals are traded at all decides who gets a place: the time frame and
   * method filters then choose the signals before the day is played, not the rows after it. Without one, every
   * signal is traded and the filters only choose what is shown -- one run serves every choice.
   */
  const chosen = (sig: BtSignal) => (!o.tfs || o.tfs.includes(sig.mode === 'mtf' ? CHAIN_KEY : sig.tf)) && (!o.methods || o.methods.includes(sig.method));
  const takes = (sig: BtSignal) => ownOnly(sig) && (caps === null || chosen(sig));
  const filterKey = caps === null ? '' : `|tf:${(o.tfs ?? []).join(',')}|m:${(o.methods ?? []).join(',')}`;
  const key = (st ? `${strategyKey(st)}${o.draft ? '|draft' : ''}|${o.params.deskMax ?? 0}|${o.params.cePct ?? 100}|${o.params.pePct ?? 100}|${strikeKey(o.params)}|vol:${volOnly}|vb:${volBy}${chaseKey(o.params)}` : paramsKey(o.params)) + filterKey;
  for (const d of days) {
    const h = await dayOf(d.day, key, o.now, (span) => (st ? strategyPlan(st, span, caps) : planOfParams(o.params, span)), takes, { only: volOnly, baseline: baselineOf(d.day), by: volBy }, marksSeen(d.day));
    grainOf.set(d.day, h.grain);
    // The counts follow the time frame and method filters as the rows do: "N signals, M traded" is of what is shown.
    for (const x of h.tally) {
      if ((o.tfs && !o.tfs.includes(x.tf)) || (o.methods && !o.methods.includes(x.method))) continue;
      signals += x.signals;
      forwarded += x.fwd ?? 0;
      for (const k of BT_SKIPS) skipped[k] += x.skipped[k];
    }
    every.push(...h.cells);
    spansByDay.set(d.day, h.spans);
  }
  // The method list's own figures: what each method makes when it is not competing for a place -- the run with no desk limit.
  const listCells: BtCell[] = [];
  if (caps !== null) {
    const free = { ...o.params, deskMax: 0 };
    for (const d of days) {
      const h = await dayOf(d.day, st ? `${strategyKey(st)}|vol:${volOnly}|vb:${volBy}${chaseKey(o.params)}` : paramsKey(free), o.now, (span) => (st ? strategyPlan(st, span, null) : planOfParams(free, span)), ownOnly, { only: volOnly, baseline: baselineOf(d.day), by: volBy }, marksSeen(d.day));
      listCells.push(...h.cells);
    }
  } else listCells.push(...every);
  const exits = st ? exitRules(st.config) : null;
  const params: BacktestParams = st && exits
    ? {
      rule: st.config.strikeRule === 'delta' ? 'delta' : 'premium', value: st.config.strikeRule === 'delta' ? (st.config.delta?.max ?? 0) : (st.config.premium?.usd ?? 0), lots: st.config.lots,
      targetPct: exits.target.mode === 'pct' ? exits.target.value : 0, stopPct: exits.stop.mode === 'pct' ? exits.stop.value : 0, window: 'desk',
      deskMax: o.params.deskMax ?? 0, cePct: o.params.cePct ?? 100, pePct: o.params.pePct ?? 100, vol: o.params.vol ?? 'off',
      ...(o.params.strikePct !== undefined ? { strikePct: o.params.strikePct } : {}), ...(o.params.strikeFull ? { strikeFull: o.params.strikeFull } : {}),
      ...(volBy === 'iv' ? { volBy } : {}), ...(o.params.chase ? { chase: o.params.chase } : {}),
    }
    : o.params;
  const real = st && o.draft ? zeroTot() : st
    ? (await marketReport({ from: o.from, to: o.to, now: o.now, spot: o.spot ?? null, account: st.accountId ?? null, tfs: null, methods: null, strategies: [st.name] })).total.real
    : null;
  const cells = every.filter((c) => (!o.tfs || o.tfs.includes(tfKeyOf(c))) && (!o.methods || o.methods.includes(c.method)));
  const patternOf = new Map(days.map((d) => [d.day, d.pattern]));
  // The margin of the trades shown: the same filters as the rows.
  let peak = { usd: 0, at: null as number | null, open: 0, lots: 0, day: null as string | null };
  let daily = 0, dailyN = 0, tradeMargin = 0, tradeN = 0;
  for (const [day, all] of spansByDay) {
    const shown = all.filter((x) => (!o.tfs || o.tfs.includes(x.tf)) && (!o.methods || o.methods.includes(x.method)));
    shownOut?.set(day, shown);
    if (!shown.length) continue;
    const p = peakMargin(shown);
    if (p.usd > peak.usd) peak = { ...p, day };
    daily += p.usd; dailyN++;
    for (const x of shown) { tradeMargin += x.margin; tradeN++; }
  }
  cellsOut?.push(...cells);
  const distinct = (xs: { key: string; name: string }[]) => [...new Map(xs.map((x) => [x.key, x])).values()];
  return {
    from: o.from, to: o.to, params, signals, skipped, forwarded,
    margin: { peakUsd: peak.usd, peakDay: peak.day, peakAt: peak.at, peakOpen: peak.open, peakLots: peak.lots, avgDailyPeakUsd: dailyN ? daily / dailyN : 0, avgTradeUsd: tradeN ? tradeMargin / tradeN : 0 },
    strategy: st ? { id: st.id, name: st.name, accountId: st.accountId ?? null, caveats: strategyCaveats(st), real: real! } : null,
    total: cells.reduce((t, c) => addBt(t, c.tot), zeroBt()),
    days: days.map((d) => ({ ...cells.filter((c) => c.day === d.day).reduce((t, c) => addBt(t, c.tot), zeroBt()), day: d.day, pattern: d.pattern, live: d.live, grain: grainOf.get(d.day) ?? '5m' })),
    priced: { 'own-1m': 0, 'mark-1m': 0, '5m': 0, ...Object.fromEntries(BOARD_GRAINS.map((g) => [g, days.filter((d) => grainOf.get(d.day) === g).length])) } as Record<BoardGrain, number>,
    ...breakdownOf(cells, patternOf, nameOf),
    bySession: slotList(slotRows(cells, nameOf)),
    choices: {
      timeframes: distinct(listCells.map((c) => ({ key: tfKeyOf(c), name: c.mode === 'mtf' ? 'With timeframe chain' : c.tf }))).sort((a, b) => tfPlace(a.key) - tfPlace(b.key)),
      methods: distinct(listCells.map((c) => ({ key: c.method, name: nameOf(c.method) })))
        .map((m) => {
          const t = listCells.filter((c) => c.method === m.key && (!o.tfs || o.tfs.includes(tfKeyOf(c)))).reduce((a, c) => addBt(a, c.tot), zeroBt());
          return { ...m, n: t.n, wins: t.wins, net: t.net };
        })
        .sort((a, b) => a.name.localeCompare(b.name, 'en', { numeric: true })),
    },
  };
}

// ------------------------------------------------------------------------------------------------ the volatility study

/**
 * Does the option's stop want to move with volatility? (owner, 17 Oct 2026: the research on two years of settled
 * chains found a stop set tighter when it is volatile and wider when it is calm did better than one stop -- "show
 * it on the desk's own trades before anything changes".) Report only: nothing here is read by a strategy or an order.
 *
 * Every signal the settings (or the strategy) take is traded three times on the same board, the same fills and the
 * same charges: with the plan's own stop, and with a stop by the level at the signal's fill -- once by the candles'
 * ATR, once by the board's ATM IV (`VolBy`). No limit on what is open, the strategy's "at most open" included: an
 * earlier exit must not free a place for a trade the other rule did not take, so the three are the same trades and
 * differ only in where the stop sat. A signal whose level cannot be said keeps the plan's own stop.
 */
export const VOL_STUDY_SL: Record<VolLevel, number> = { low: 2.5, medium: 2, high: 1.5 };
/**
 * What is set by the level: the option's stop (per level, shares of the premium: 1.5 is +150%), the strike's delta
 * (per level, the most a strike may have: 0.08), the lots (per level, whole), or any of them together. At least one.
 */
export type VolRule = { sl: Record<VolLevel, number> | null; delta: Record<VolLevel, number> | null; lots?: Record<VolLevel, number> | null; win?: VolWin | null };
/**
 * Methods by win %, the bar moved by the level (owner, 20 Oct 2026: "win % by volatility -- the strategy's 50% as it
 * is, low volatility 5% less, high 5% more"): a signal is traded only if its method won `base` + the level's `adj`
 * per cent (points) of its trades, on `minTrades` or more, over the `days` calendar days before the signal's day --
 * never its own, as the desk's daily update picks. As set is held to `base` at every level, so the two sides differ
 * only in the move. A level that cannot be said keeps `base`. The record is every method on all its signals as set.
 */
export type VolWin = { base: number; minTrades: number; days: number; adj: Record<VolLevel, number> };
export const VOL_STUDY_WIN: VolWin = { base: 50, minTrades: 3, days: 14, adj: { low: -5, medium: 0, high: 5 } };
/** The bar at a level: the base, moved by the level's points, held to 0-100. */
export const winBarAt = (w: VolWin, level: VolLevel | 'unknown' | null): number =>
  Math.min(100, Math.max(0, w.base + (level && level !== 'unknown' ? w.adj[level] : 0)));
export type WinTally = Map<string, { n: number; wins: number }>;
/** A method's record against a bar: enough trades, and won at least that share of them. */
export const passesBar = (tally: WinTally, method: string, bar: number, minTrades: number): boolean => {
  const r = tally.get(method);
  return !!r && r.n >= minTrades && (r.wins / r.n) * 100 >= bar - 1e-9;
};
/** One day's trades as a tally by method; a win is a trade that made money after charges. */
export const tallyOf = (ts: readonly BtTrade[]): WinTally => {
  const m: WinTally = new Map();
  for (const t of ts) { const r = m.get(t.signal.method) ?? { n: 0, wins: 0 }; r.n++; if (t.netUsd > 0) r.wins++; m.set(t.signal.method, r); }
  return m;
};
/** The record of the `days` calendar days before `day`, from each day's tally. */
export const recordBefore = (byDay: ReadonlyMap<string, WinTally>, day: string, days: number): WinTally => {
  const from = new Date(Date.parse(`${day}T00:00:00Z`) - days * 86_400_000).toISOString().slice(0, 10);
  const out: WinTally = new Map();
  for (const [d, t] of byDay) {
    if (d < from || d >= day) continue;
    for (const [k, r] of t) { const o = out.get(k) ?? { n: 0, wins: 0 }; o.n += r.n; o.wins += r.wins; out.set(k, o); }
  }
  return out;
};
export const VOL_STUDY_DELTA: Record<VolLevel, number> = { low: 0.12, medium: 0.1, high: 0.08 };
/** Fewer when it is volatile (owner, 17 Oct 2026: "Low / Medium 2 lots, High 1 lot"). */
export const VOL_STUDY_LOTS: Record<VolLevel, number> = { low: 2, medium: 2, high: 1 };
export type VolStudyAsk = Ask & VolRule;
/**
 * The same study over saved backtests run together (owner, 17 Oct 2026: "portfolio-la illa"): each traded on its own
 * signals by its own settings, with no limit -- the shared one included, for the same reason as above -- and the
 * trades of all of them added up day by day. One that cannot be worked is listed with why and counted as nothing.
 */
export type PortfolioVolStudyAsk = Pick<PortfolioAsk, 'from' | 'to' | 'now' | 'spot' | 'members'> & VolRule;
export type VolStudyLevel = VolLevel | 'unknown';
export const VOL_STUDY_LEVELS: readonly VolStudyLevel[] = ['low', 'medium', 'high', 'unknown'];
export type VolStudyLine = {
  rule: 'fixed' | 'by-vol';
  n: number; wins: number; net: number; charges: number;
  /** The lots of all its trades together: with lots by level, the money is of another size, and net per lot is what compares. */
  lots: number;
  /** Trades the option's own stop closed. */
  stopHits: number;
  /** The expiry day that lost the most, and what it lost; null with no trades. */
  worstDay: { day: string; net: number } | null;
  /** The deepest fall of the running total from its high, day by day, dollars. */
  maxDrawdown: number;
  /** The first half of the days and the second, apart: a rule that only works on one of them is not a rule. */
  halves: [number, number];
  byLevel: { level: VolStudyLevel; n: number; wins: number; net: number; stopHits: number }[];
  /** Each expiry day of the range, oldest first, with what it made under this rule (17 Oct 2026: "tap Net -- by expiry day"). */
  byDay: { day: string; live: boolean; n: number; wins: number; net: number; charges: number; lots: number }[];
};
export type VolStudy = {
  from: string; to: string; days: number;
  /** The first day of the second half. */
  secondHalfFrom: string | null;
  /**
   * The plan's own stop: a share of the premium (0 none), and whether it moves with the clock. Over several saved
   * backtests, `each` is every one's own (distinct, in order); `pct` is the first's.
   */
  fixed: { pct: number; stepped: boolean; each: number[] };
  /** Each level's stop, and each level's delta: what the "by volatility" rule set. Null: that one was left as set. */
  sl: Record<VolLevel, number> | null;
  delta: Record<VolLevel, number> | null;
  lots: Record<VolLevel, number> | null;
  /** Methods by win %, with each level's bar (`bars`); null, off. With it on, as set is held to the base. */
  win: (VolWin & { bars: Record<VolLevel, number> }) | null;
  signals: number;
  sources: { by: VolBy; lines: VolStudyLine[] }[];
  /**
   * Both rules traded the same signals on every day. With the stop alone they must; with the delta by level a signal
   * may find no strike worth selling inside its level's delta, and is then traded by one rule only.
   */
  sameTrades: boolean;
  /** Over saved backtests run together: each, and why one could not be worked (null: it was). Absent for one backtest. */
  members?: { id: string; name: string; problem: string | null }[];
};

type Labelled = { day: string; t: BtTrade; level: VolStudyLevel };
function studyLine(rule: VolStudyLine['rule'], xs: readonly Labelled[], days: readonly string[], mid: number, live: ReadonlySet<string> = new Set()): VolStudyLine {
  const byDay = new Map(days.map((d) => [d, 0]));
  const dayRows = new Map(days.map((d) => [d, { day: d, live: live.has(d), n: 0, wins: 0, net: 0, charges: 0, lots: 0 }]));
  const lv = new Map(VOL_STUDY_LEVELS.map((l) => [l, { level: l, n: 0, wins: 0, net: 0, stopHits: 0 }]));
  let n = 0, wins = 0, net = 0, charges = 0, stopHits = 0, lots = 0;
  for (const { day, t, level } of xs) {
    const win = t.netUsd > 0, stop = t.by === 'option-sl' || t.by === 'option-tsl' || t.by === 'option-be';
    n++; net += t.netUsd; charges += t.chargesUsd; lots += t.lots; if (win) wins++; if (stop) stopHits++;
    byDay.set(day, (byDay.get(day) ?? 0) + t.netUsd);
    const r = dayRows.get(day);
    if (r) { r.n++; r.net += t.netUsd; r.charges += t.chargesUsd; r.lots += t.lots; if (win) r.wins++; }
    const l = lv.get(level)!;
    l.n++; l.net += t.netUsd; if (win) l.wins++; if (stop) l.stopHits++;
  }
  let run = 0, peak = 0, maxDrawdown = 0, worstDay: VolStudyLine['worstDay'] = null;
  const halves: [number, number] = [0, 0];
  days.forEach((d, i) => {
    const v = byDay.get(d) ?? 0;
    run += v; peak = Math.max(peak, run); maxDrawdown = Math.max(maxDrawdown, peak - run);
    halves[i < mid ? 0 : 1] += v;
    if (xs.some((x) => x.day === d) && (worstDay === null || v < worstDay.net)) worstDay = { day: d, net: v };
  });
  return { rule, n, wins, net, charges, lots, stopHits, worstDay, maxDrawdown, halves, byLevel: [...lv.values()], byDay: [...dayRows.values()] };
}

type StudyBook = Pick<Ask, 'params' | 'tfs' | 'methods' | 'strategy'>;
/** A book of the study as it trades: which signals are its own, and its plan -- as set, or with what is set by level. Shared by the study and its trade list. */
function studyBookOf(b: StudyBook): { takes: (sig: BtSignal) => boolean; planFor: (span: { from: number; to: number }, byVol: VolRule | null) => DayPlan } {
  const st = b.strategy ?? null, own = ownSignal(st);
  return {
    takes: (sig: BtSignal) => own(sig)
      && (!b.tfs || b.tfs.includes(sig.mode === 'mtf' ? CHAIN_KEY : sig.tf)) && (!b.methods || b.methods.includes(sig.method)),
    // No limit of any kind, so the rules trade the same signals; the volatility filter is the study's own subject, so it is off too.
    planFor: (span: { from: number; to: number }, byVol: VolRule | null): DayPlan => {
      const base = st ? { ...planOfStrategy(st, span, null), maxOpen: null } : planOfParams({ ...b.params, deskMax: 0 }, span);
      if (!byVol) return base;
      // A level's strike: the live rules' own pick with that delta -- the settings' rule turned to delta, or the
      // strategy's with its strike blocks set aside (one delta for the level, not the clock's).
      const deltaPick = (d: number): DayPlan['pick'] => (st
        ? planOfStrategy({ ...st, config: { ...st.config, strikeRule: 'delta', delta: { ...st.config.delta, max: d }, strikeBlocks: [], signal: { ...st.config.signal!, deltaByVol: null, slByVol: null } } } as Strategy, span, null).pick
        : planOfStrategy(strategyOfParams({ ...b.params, rule: 'delta', value: d, strikeBlocks: [] }, null, null), span).pick);
      return {
        ...base,
        ...(byVol.sl ? { stopPctByVol: byVol.sl } : {}),
        ...(byVol.lots ? { lotsByVol: byVol.lots } : {}),
        ...(byVol.delta ? { pickByVol: { low: deltaPick(byVol.delta.low), medium: deltaPick(byVol.delta.medium), high: deltaPick(byVol.delta.high) } } : {}),
      };
    },
  };
}
async function volStudyOf(o: { from: string; to: string; now: number; books: readonly StudyBook[] } & VolRule): Promise<Omit<VolStudy, 'members'>> {
  await Promise.all([flowSchema(), optionSnapshotsSchema(), optionMarksSchema(), entrySchema(), methodsSchema()]);
  const win = o.win ?? null;
  // Methods by win % read the days before the range too: its first days are picked from them.
  const back = 8 + (win ? win.days : 0);
  const before = new Date(Date.parse(`${o.from}T00:00:00Z`) - back * 86_400_000).toISOString().slice(0, 10);
  const known = await marketDays(before, o.to, o.now);
  const days = known.filter((d) => d.day >= o.from).map((d) => d.day);
  const warmFrom = win ? new Date(Date.parse(`${o.from}T00:00:00Z`) - win.days * 86_400_000).toISOString().slice(0, 10) : o.from;
  const warm = known.filter((d) => d.day >= warmFrom && d.day < o.from && !d.live).map((d) => d.day);
  // Each book's record day by day: every method on all its signals, as set.
  const tallies = o.books.map(() => new Map<string, WinTally>());
  const live = new Set(known.filter((d) => d.day >= o.from && d.live).map((d) => d.day));
  const baselineOf = (day: string): number | null => {
    const prior = known.filter((d) => d.day < day && d.stats && !d.live).slice(-5).map((d) => d.stats!.atr);
    return prior.length ? prior.reduce((a, x) => a + x, 0) / prior.length : null;
  };
  await preloadIv(days, o.now);
  const fetched = await marksFetchedBy(days.map(expiryCodeOf));
  const books = o.books.map(studyBookOf);
  const fixedTrades: Labelled[][] = [[], []], volTrades: Labelled[][] = [[], []];
  let signals = 0, sameTrades = true;
  const fixedOf = books.map(() => ({ pct: 0, stepped: false }));
  // The signal a trade is of: by the delta of its level the same signal may sell another strike, and is still the same trade.
  const keyOf = (t: BtTrade) => `${t.signal.method}|${t.signal.mode}|${t.signal.tf}|${t.signal.dir}|${t.signal.filledAt}|${t.signal.fillPrice}`;
  if (win) await preloadIv(warm, o.now);
  const fetchedWarm = win && warm.length ? await marksFetchedBy(warm.map(expiryCodeOf)) : new Map();
  for (const day of [...warm, ...days]) {
    const inRange = day >= o.from;
    const { from, to } = sessionOf(day);
    const raw = await rawDay(day, o.now, (inRange ? fetched : fetchedWarm).get(expiryCodeOf(day))?.contracts ?? 0);
    const readers: Record<VolBy, (at: number) => VolLevel | null> = { atr: volReader(raw.minutes, baselineOf(day)), iv: await ivReaderOf(day, o.now) };
    const bars = raw.minutes.filter((b) => b.at >= from);
    books.forEach((b, i) => {
      const sigs = raw.signals.filter(b.takes);
      if (inRange) signals += sigs.length;
      const base = b.planFor({ from, to }, null);
      const play = (plan: DayPlan, volAt: (at: number) => VolLevel | null) => simulateDay({ from, to, signals: sigs, plan, volAt, bars, board: raw.board }).trades;
      // As set: read by the strategy's own source where it sets its delta by volatility (the desk's own trades).
      const flat = play(base, readers[ownVolBy(o.books[i]!.strategy, 'atr')!]);
      // The record a day is picked by is the days before it; this day's own goes in after.
      const record = win ? recordBefore(tallies[i]!, day, win.days) : null;
      if (win) tallies[i]!.set(day, tallyOf(flat));
      if (!inRange) return;
      fixedOf[i] = { pct: base.stopPct, stepped: !!base.stopPctAt };
      const asSet = record ? flat.filter((t) => passesBar(record, t.signal.method, win!.base, win!.minTrades)) : flat;
      VOL_BYS.forEach((by, k) => {
        const read = readers[by];
        fixedTrades[k]!.push(...asSet.map((t) => ({ day, t, level: read(t.signal.filledAt) ?? 'unknown' as const })));
        const all = play(b.planFor({ from, to }, { sl: o.sl, delta: o.delta, lots: o.lots ?? null }), read);
        const moved = record ? all.filter((t) => passesBar(record, t.signal.method, winBarAt(win!, t.vol), win!.minTrades)) : all;
        volTrades[k]!.push(...moved.map((t) => ({ day, t, level: t.vol ?? 'unknown' as const })));
        if (moved.length !== asSet.length || moved.some((t, j) => keyOf(t) !== keyOf(asSet[j]!))) sameTrades = false;
      });
    });
  }
  const mid = Math.ceil(days.length / 2);
  const each = [...new Set(fixedOf.map((f) => f.pct))];
  return {
    from: o.from, to: o.to, days: days.length, secondHalfFrom: days[mid] ?? null, sl: o.sl ? { ...o.sl } : null, delta: o.delta ? { ...o.delta } : null, lots: o.lots ? { ...o.lots } : null, signals, sameTrades,
    win: win ? { ...win, adj: { ...win.adj }, bars: { low: winBarAt(win, 'low'), medium: winBarAt(win, 'medium'), high: winBarAt(win, 'high') } } : null,
    fixed: { pct: fixedOf[0]?.pct ?? 0, stepped: fixedOf.some((f) => f.stepped), each },
    sources: VOL_BYS.map((by, k) => ({ by, lines: [studyLine('fixed', fixedTrades[k]!, days, mid, live), studyLine('by-vol', volTrades[k]!, days, mid, live)] })),
  };
}

const volStudyNow = (o: VolStudyAsk): Promise<VolStudy> => volStudyOf({ from: o.from, to: o.to, now: o.now, sl: o.sl, delta: o.delta, lots: o.lots ?? null, win: o.win ?? null, books: [o] });
async function portfolioVolStudyNow(o: PortfolioVolStudyAsk): Promise<VolStudy> {
  const r = await volStudyOf({ from: o.from, to: o.to, now: o.now, sl: o.sl, delta: o.delta, lots: o.lots ?? null, win: o.win ?? null, books: o.members.flatMap((m) => (m.ask && !m.problem ? [m.ask] : [])) });
  return { ...r, members: o.members.map((m) => ({ id: m.id, name: m.name, problem: m.ask && !m.problem ? null : (m.problem ?? 'It cannot be worked out.') })) };
}

/** The volatility study in the thread that asks for it, one at a time with the backtests (`signalBacktestHere`). */
export function volStudyHere(o: VolStudyAsk): Promise<VolStudy> {
  const run = working.then(() => volStudyNow(o));
  working = run.catch(() => { });
  return run;
}
export function portfolioVolStudyHere(o: PortfolioVolStudyAsk): Promise<VolStudy> {
  const run = working.then(() => portfolioVolStudyNow(o));
  working = run.catch(() => { });
  return run;
}

// ------------------------------------------------------------------------------------------------ the live check

/**
 * The backtest against what the live desk really did (owner, 14 Oct 2026: "the real trades since 9:30 last night
 * and the backtest's trades do not match in number -- check the calculation").
 *
 * They are two records of the same signals and can be laid side by side signal for signal: the desk writes down
 * what it did with every signal of a strategy's methods (`strategy_signal_runs`: placed, refused, skipped, with
 * why), under the same key a setup has. So each strategy is backtested by its own rules as they stand, the
 * strategies of an account together under that account's limit as the desk holds them, and every trade the
 * backtest makes is looked up in the desk's record, and every order the desk placed in the backtest's.
 *
 * What comes back is the count on each side and, for every signal on one side only, why -- in the desk's own
 * words for a signal it refused or skipped, in the backtest's for one it would not trade. On the night it was
 * first run the answer was: all 162 orders the desk placed were trades in the backtest, and the backtest had
 * 13 more -- the 13 the desk had refused, each "exceeds the $-82 left in today's loss budget".
 *
 * The backtest replays the rules; it does not replay the account. The daily loss limit, margin, and a desk that
 * was switched off are the desk's, so those are where a difference is expected and it is named, not hidden.
 */
export type LiveCheckAsk = {
  from: string; to: string; now: number;
  /** Each trading account's strategies and its limit on open trades as it stands (null: none). */
  accounts: { id: number | null; name: string | null; caps: { deskMax: number; cePct: number; pePct: number; strikePct?: number; strikeFull?: 'next' | 'skip' } | null; strategies: Strategy[] }[];
  /**
   * Saved backtests to lay beside the desk in place of the strategies' own rules (owner, 14 Oct 2026: "check the
   * backtest and the portfolio"): the members worked as they are in a portfolio run -- under one account's limit
   * (`shared`) or each its own -- and every trade of theirs looked up in what the desk did with that signal under
   * any strategy. Absent: each strategy by its own rules.
   */
  portfolio?: { name: string; shared: { deskMax: number; cePct: number; pePct: number; strikePct?: number; strikeFull?: 'next' | 'skip' } | null; members: { id: string; name: string; ask: Pick<Ask, 'params' | 'tfs' | 'methods' | 'strategy'> }[] } | null;
  spot?: number | null;
  /** Only these strategies are reported -- one chosen on the screen; its account's others are still worked beside it, for the same places. */
  only?: string[];
};
/** Trades counted with their money, as a day's row reads them: how many, how many made money, and the net after charges. */
export type LiveCheckMoney = { n: number; wins: number; net: number };
/**
 * What became of the signals on one side (owner, 14 Oct 2026: "taken, not taken, skipped, refused, rejected,
 * expired -- columns in the live check"). The desk's: taken (its order filled), still waiting to fill, and not
 * taken -- skipped by its rules, refused at its own gate, rejected by Delta, expired unfilled, cancelled before a
 * fill. The backtest's and the live rules': taken, and not taken (skipped by the rules); the rest are the desk's
 * alone and stay 0 there.
 */
export type LiveCheckFate = { taken: number; waiting: number; notTaken: number; skipped: number; refused: number; rejected: number; expired: number; cancelled: number };
export const noFate = (): LiveCheckFate => ({ taken: 0, waiting: 0, notTaken: 0, skipped: 0, refused: 0, rejected: 0, expired: 0, cancelled: 0 });
/** Signals on one side only, by why, with the first few to look at. */
export type LiveCheckWhy = { why: string; n: number; first: { at: number; method: string; tf: string; dir: 1 | -1 }[] };
export type LiveCheckRow = {
  id: string; name: string; account: string | null;
  /** What the desk did with the signals of its methods: orders placed, refused at the gate, skipped by its rules. */
  live: { placed: number; refused: number; skipped: number };
  /** The other side's fate of the signals of its methods -- the desk's own record, or the live rules' -- and the backtest's. */
  fate: { live: LiveCheckFate; backtest: LiveCheckFate };
  /** Why the desk refused, and why it skipped: every one of them, by reason, the most common first (owner, 14 Oct 2026: "show the skipped and rejected counts"). */
  liveWhy: { refused: { why: string; n: number }[]; skipped: { why: string; n: number }[] };
  /** Trades the backtest makes of the same signals, by the strategy's rules as they stand. */
  backtest: number;
  /** The signals of its methods the backtest did not trade, by why: beside the desk's skipped, the same rules should give the same counts. */
  backtestSkipped: { why: string; n: number }[];
  /** Signals that are an order on the desk and a trade in the backtest. */
  same: number;
  backtestOnly: LiveCheckWhy[]; liveOnly: LiveCheckWhy[];
  /**
   * Where the desk's orders in the range were sold with other lots or another option stop than the strategy has now
   * (14 Oct 2026 audit: on 13 Oct a strategy sold 12-16 lots with a 300% stop; the backtest replays every day by the
   * rules as they stand -- 2 lots, 160% -- so its money is not the desk's). Null when they all match, or by settings.
   */
  rulesThen?: { lots: number[]; stopPct: number[]; orders: number; now: { lots: number; stopPct: number } } | null;
};
export type LiveCheck = {
  from: string; to: string;
  /** The first and the last moment the desk has a record in the range; null with none. */
  liveFrom: number | null; liveTo: number | null;
  /** Signals filled up to here are compared: the desk is given two minutes to have written a signal down. */
  until: number;
  strategies: LiveCheckRow[];
  total: { placed: number; refused: number; skipped: number; backtest: number; backtestSkipped: number; same: number; backtestOnly: number; liveOnly: number };
  /** What is on the backtest's side: each strategy's own rules, or a portfolio of saved backtests by name. */
  against: { kind: 'strategies' } | { kind: 'portfolio'; name: string };
  /** With a portfolio: the desk's orders no saved backtest of it trades, by why (a strategy's own are on its row). */
  liveOnly: LiveCheckWhy[];
  /**
   * What is not compared, and why (owner, 14 Oct 2026: "the live check must be by the backtest's settings"). The
   * comparison is of the signals both sides saw: the backtest's trades of signals the desk has a record of, and
   * the desk's orders on signals inside the backtest's settings. Set apart, counted and named: the backtest's
   * trades of signals the desk never saw (no strategy took that method or time frame then, or it was off), and
   * the desk's orders on signals outside the backtest's methods, time frames or hours.
   */
  notCompared: { backtest: number; desk: number };
  notComparedWhy: { backtest: LiveCheckWhy[]; desk: LiveCheckWhy[] };
  /**
   * The money on each side over the range: the backtest's trades, and -- against saved backtests or settings -- the
   * same trades as the live rules make them. Null on the desk's side when it is the desk's own record: a check of
   * decisions, not of finished orders (owner, 14 Oct 2026: "the live check must not be by finished orders").
   */
  money: { real: LiveCheckMoney | null; backtest: LiveCheckMoney };
  /** Every refusal and every skip on the desk in the range, by reason, across the strategies. */
  liveWhy: { refused: { why: string; n: number }[]; skipped: { why: string; n: number }[] };
  /** Each expiry day, as the portfolio's own day table reads: the desk's real orders and the backtest's trades, with their money. */
  days: { day: string; live: boolean; placed: number; backtest: number; same: number; real: LiveCheckMoney | null; bt: LiveCheckMoney; fate: { live: LiveCheckFate; backtest: LiveCheckFate } }[];
  /** The fates over the whole range. */
  fate: { live: LiveCheckFate; backtest: LiveCheckFate };
};

const addFate = (a: LiveCheckFate, b: LiveCheckFate): LiveCheckFate => ({
  taken: a.taken + b.taken, waiting: a.waiting + b.waiting, notTaken: a.notTaken + b.notTaken, skipped: a.skipped + b.skipped,
  refused: a.refused + b.refused, rejected: a.rejected + b.rejected, expired: a.expired + b.expired, cancelled: a.cancelled + b.cancelled,
});

/** How long the desk is given to write down what it did with a signal before its absence counts. */
const LIVE_GRACE_MS = 120_000;

/** Why the desk did not place an order for a signal, from its own sentence: a few plain reasons, else the sentence without its figures. */
export function liveReason(status: string, detail: string): string {
  return `the desk ${status === 'refused' ? 'refused' : status === 'skipped' ? 'skipped' : status}: ${liveWhy(detail)}`;
}

/** The reason alone, as the counts by reason name it. */
export function liveWhy(detail: string): string {
  const said = detail.includes(' -- refused: ') ? detail.split(' -- refused: ')[1]! : detail.includes(' | ') ? detail.slice(detail.indexOf(' | ') + 3) : detail;
  const known: [RegExp, string][] = [
    [/loss budget/i, 'the daily loss limit'],
    [/too near|too far/i, 'its SL / TGT distance'],
    [/over before it could be entered|in the same moment/i, 'over before it could be entered'],
    [/at most \d+ (CE|PE)|already has \d+ (CE|PE)/i, 'the account\'s CE / PE limit'],
    [/at most|already has|open trades/i, 'a limit on open trades'],
    [/Needs \$|margin/i, 'not enough margin'],
    [/pays|premium/i, 'the premium floor'],
    [/Would take total short/i, 'the short limit'],
    [/no-entry|no entry/i, 'its no-entry window'],
    [/nothing out of the money|no strike/i, 'no strike the rule could sell'],
  ];
  const hit = known.find(([re]) => re.test(said));
  return hit ? hit[1] : said.replace(/[\d.,]+/g, 'N').slice(0, 90);
}

const BT_WHY: Record<BtSkip, string> = {
  'outside-window': 'outside its days and hours, as its rules stand now',
  'no-entry-window': 'inside its no-entry window, as its rules stand now',
  distance: 'its SL / TGT distance, as its rules stand now',
  chase: 'the chase guard (a backtest setting: the desk takes these)',
  volatility: 'the volatility filter',
  'at-limit': 'its own most open at once',
  'desk-limit': 'the account\'s limit on open trades',
  'side-limit': 'the account\'s CE / PE limit',
  'strike-limit': 'the account\'s most on one strike (and none further out to forward to)',
  'no-board': 'no option prices on record at that minute',
  'no-strike': 'no strike its rule could sell on the recorded prices',
  'no-exit-price': 'no price on record to exit at',
};

export function liveCheckHere(o: LiveCheckAsk): Promise<LiveCheck> {
  const run = working.then(() => liveCheckNow(o));
  working = run.catch(() => { });
  return run;
}

async function liveCheckNow(o: LiveCheckAsk): Promise<LiveCheck> {
  await Promise.all([flowSchema(), optionSnapshotsSchema(), optionMarksSchema(), entrySchema(), methodsSchema()]);
  const days = (await marketDays(o.from, o.to, o.now)).filter((d) => d.day >= o.from);
  const until = o.now - LIVE_GRACE_MS;
  const keyOf = (s: BtSignal) => `${s.method}|${s.mode}|${s.tf}|${s.dir}|${s.triggerAt}`;
  const every = o.accounts.flatMap((a) => a.strategies.filter(backtestable).map((st) => ({ st, account: a })));
  const folio = o.portfolio ?? null;
  const span = days.length ? { from: sessionOf(days[0]!.day).from, to: sessionOf(days[days.length - 1]!.day).to } : null;
  type Live = { strategy_id: string; signal_key: string; status: string; detail: string; trade_id: string | null; at: string };
  const live = span && every.length ? await rows<Live>(
    'SELECT strategy_id, signal_key, status, detail, trade_id, at FROM strategy_signal_runs WHERE strategy_id = ANY($1) AND at >= $2 AND at < $3 ORDER BY at',
    [every.map((x) => x.st.id), span.from, Math.min(span.to, o.now) + LIVE_GRACE_MS]) : [];
  const liveBy = new Map<string, Map<string, Live>>();
  for (const r of live) (liveBy.get(r.strategy_id) ?? liveBy.set(r.strategy_id, new Map()).get(r.strategy_id)!).set(r.signal_key, r);
  /*
   * What became of each order the desk placed: filled (taken), still working, rejected by Delta, expired -- its wait
   * ran out with nothing filled -- or cancelled before a fill. Read from the journal: the entry's fill, and the
   * events that end an entry unfilled.
   */
  type OrderFate = 'taken' | 'waiting' | 'rejected' | 'expired' | 'cancelled';
  const orderFate = new Map<string, OrderFate>();
  // The lots and the option stop each placed order was sold with: what the strategy's rules were then.
  const orderRules = new Map<string, { lots: number; stopPct: number }>();
  const placedIds = live.filter((r) => r.status === 'placed' && r.trade_id).map((r) => r.trade_id!);
  if (placedIds.length) {
    const found = await rows<{ trade_id: string; phase: string; filled: string; timed_out: boolean; rejected: boolean; lots: string | null; stop_pct: string | null }>(
      `SELECT t.trade_id, t.phase, coalesce((t.state->>'entrySize')::numeric, 0) AS filled,
              t.plan->>'lots' AS lots, t.plan->'exitAsk'->>'stopLossPct' AS stop_pct,
              EXISTS (SELECT 1 FROM trade_events e WHERE e.trade_id = t.trade_id AND e.kind = 'entry_timeout') AS timed_out,
              EXISTS (SELECT 1 FROM trade_events e WHERE e.trade_id = t.trade_id AND e.kind IN ('entry_rejected', 'precheck_failed')) AS rejected
         FROM trades t WHERE t.trade_id = ANY($1)`, [placedIds]);
    for (const t of found) {
      if (t.lots !== null) orderRules.set(t.trade_id, { lots: Number(t.lots), stopPct: Number(t.stop_pct ?? 0) });
      orderFate.set(t.trade_id, Number(t.filled) > 0 ? 'taken' : t.phase !== 'flat' && t.phase !== 'aborted' ? 'waiting' : t.rejected ? 'rejected' : t.timed_out ? 'expired' : 'cancelled');
    }
  }
  // An order the journal has no row for is taken as placed: the desk's decision was to place it.
  const fateOf = (r: { trade_id: string | null }): OrderFate => (r.trade_id ? orderFate.get(r.trade_id) ?? 'taken' : 'taken');
  const FATE_WHY: Record<Exclude<OrderFate, 'taken' | 'waiting'>, string> = {
    rejected: 'the desk placed it and Delta rejected the order',
    expired: 'the desk placed it and the order expired unfilled',
    cancelled: 'the desk placed it and the order was cancelled before it filled',
  };

  // Under any strategy: what the desk did with a signal at all -- an order where one was placed, else the refusal, else the skip.
  const rank: Record<string, number> = { placed: 3, refused: 2, skipped: 1 };
  const liveAny = new Map<string, Live>();
  for (const r of live) { const h = liveAny.get(r.signal_key); if (!h || (rank[r.status] ?? 0) > (rank[h.status] ?? 0)) liveAny.set(r.signal_key, r); }

  /*
   * What is laid beside the desk, as rows: each strategy by its own rules, the strategies of an account worked
   * together under that account's limit as the desk holds them -- or, asked for a portfolio, its saved backtests
   * as a portfolio run works them.
   */
  type Unit = { id: string; name: string; account: string | null; group: number; takes: (sig: BtSignal) => boolean; planFor: (span: { from: number; to: number }) => DayPlan; mine: Map<string, Live> | null; now?: { lots: number; stopPct: number }; volBy?: VolBy };
  const groups: { caps: DayPlan['desk'] }[] = [];
  const units: Unit[] = [];
  if (folio) {
    groups.push({ caps: folio.shared ? deskCapsOf(folio.shared) : null });
    for (const m of folio.members) { const b = bookOf(m.ask); units.push({ id: m.id, name: m.name, account: null, group: 0, takes: b.takes, planFor: folio.shared ? b.planFor : (sp) => (m.ask.strategy ? planOfStrategy(m.ask.strategy, sp, null) : planOfParams(m.ask.params, sp)), mine: null, volBy: ownVolBy(m.ask.strategy, undefined) }); }
  } else {
    o.accounts.forEach((a) => {
      const mine = a.strategies.filter(backtestable);
      if (!mine.length) return;
      groups.push({ caps: a.caps ? deskCapsOf(a.caps) : null });
      for (const st of mine) {
        units.push({
          id: st.id, name: st.name, account: a.name, group: groups.length - 1,
          takes: ownSignal(st),
          planFor: (sp) => planOfStrategy(st, sp, null), mine: liveBy.get(st.id) ?? new Map(),
          now: { lots: st.config.lots, stopPct: st.config.stopLossPct ?? 0 },
          // Its delta by volatility, read as the desk read it.
          volBy: ownVolBy(st, undefined),
        });
      }
    });
  }

  const shown = (u: Unit) => folio !== null || !o.only || o.only.includes(u.id);
  type Side = { traded: Map<string, BtTrade>; refused: Map<string, BtSkip> };
  const bt = units.map((): Side => ({ traded: new Map(), refused: new Map() }));
  /*
   * Against saved backtests or the screen's settings the other side is not the desk's record -- the desk never ran
   * those settings -- but the live rules run with them: each member as the strategy the desk would run
   * (`strategyOfParams`; a member worked by a strategy, that strategy), on the same signals, under the same limit.
   */
  const liveRulesOf = folio ? folio.members.map((m) => m.ask.strategy ?? strategyOfParams(m.ask.params, m.ask.tfs, m.ask.methods)) : [];
  const lv = units.map((): Side => ({ traded: new Map(), refused: new Map() }));
  const dayOfKey = new Map<string, string>();
  const fetched = await marksFetchedBy(days.map((d) => expiryCodeOf(d.day)));
  const zero = (): LiveCheckMoney => ({ n: 0, wins: 0, net: 0 });
  // A strategy that sets its delta by volatility needs the level at each fill, as the desk read it; the others none.
  const reading = units.some((u) => u.volBy);
  const knownAtr = reading ? await marketDays(new Date(Date.parse(`${o.from}T00:00:00Z`) - 8 * 86_400_000).toISOString().slice(0, 10), o.to, o.now) : [];
  const baselineAt = (day: string) => { const p = knownAtr.filter((x) => x.day < day && x.stats && !x.live).slice(-5).map((x) => x.stats!.atr); return p.length ? p.reduce((a, x) => a + x, 0) / p.length : null; };
  for (const d of days) {
    const { from, to } = sessionOf(d.day);
    const raw = await rawDay(d.day, o.now, fetched.get(expiryCodeOf(d.day))?.contracts ?? 0);
    const readers = reading ? await dayReaders(units.map((u) => ({ volBy: u.volBy ?? 'atr' })), d.day, raw.minutes, baselineAt(d.day), o.now) : null;
    const volAtOf = (u: Unit) => (readers && u.volBy ? readers[u.volBy] : undefined);
    const upTo = raw.signals.filter((s) => s.filledAt <= until);
    for (const s of upTo) dayOfKey.set(keyOf(s), d.day);
    const bars = raw.minutes.filter((b) => b.at >= from);
    groups.forEach((g, gi) => {
      const at = units.flatMap((u, i) => (u.group === gi ? [i] : []));
      const books = at.map((i) => ({ signals: upTo.filter(units[i]!.takes), plan: units[i]!.planFor({ from, to }), volAt: volAtOf(units[i]!) }));
      // Each its own limit: worked alone, as a portfolio run of that kind works them. Else for the same places.
      const outs = !folio || folio.shared ? simulateTogether({ from, to, bars, board: raw.board, books, shared: g.caps })
        : books.map((b) => simulateDay({ from, to, bars, board: raw.board, signals: b.signals, plan: b.plan, volAt: b.volAt }));
      at.forEach((i, k) => {
        for (const t of outs[k]!.trades) {
          bt[i]!.traded.set(keyOf(t.signal), t);
        }
        for (const r of outs[k]!.refused) bt[i]!.refused.set(keyOf(r.signal), r.why);
      });
      if (folio) {
        const liveBooks = at.map((i, k) => ({ signals: books[k]!.signals, plan: planOfStrategy(liveRulesOf[i]!, { from, to }, null), volAt: volAtOf(units[i]!) }));
        const louts = folio.shared ? simulateTogether({ from, to, bars, board: raw.board, books: liveBooks, shared: g.caps })
          : liveBooks.map((b) => simulateDay({ from, to, bars, board: raw.board, signals: b.signals, plan: b.plan, volAt: b.volAt }));
        at.forEach((i, k) => {
          for (const t of louts[k]!.trades) lv[i]!.traded.set(keyOf(t.signal), t);
          for (const r of louts[k]!.refused) lv[i]!.refused.set(keyOf(r.signal), r.why);
        });
      }
    });
  }

  const counted = (xs: string[]): { why: string; n: number }[] => {
    const m = new Map<string, number>();
    for (const x of xs) m.set(x, (m.get(x) ?? 0) + 1);
    return [...m.entries()].map(([why, n]) => ({ why, n })).sort((a, b) => b.n - a.n || a.why.localeCompare(b.why));
  };
  const merged = (xs: { why: string; n: number }[]) => counted(xs.flatMap((x) => Array.from({ length: x.n }, () => x.why)));
  type One = { why: string; sig: { at: number; method: string; tf: string; dir: 1 | -1 } };
  const groupsOf = (xs: One[]): LiveCheckWhy[] => {
    const m = new Map<string, LiveCheckWhy>();
    for (const x of xs) {
      const g = m.get(x.why) ?? m.set(x.why, { why: x.why, n: 0, first: [] }).get(x.why)!;
      g.n++;
      if (g.first.length < 3) g.first.push(x.sig);
    }
    return [...m.values()].sort((a, b) => b.n - a.n || a.why.localeCompare(b.why));
  };
  const partsOf = (key: string, at: number) => { const p = key.split('|'); return { at, method: p[0] ?? '', tf: p[1] === 'mtf' ? CHAIN_KEY : p[2] ?? '', dir: (Number(p[3]) === 1 ? 1 : -1) as 1 | -1 }; };
  const sigOf = (t: BtTrade) => ({ at: t.signal.filledAt, method: t.signal.method, tf: t.signal.mode === 'mtf' ? CHAIN_KEY : t.signal.tf, dir: t.signal.dir });
  // Hours are a setting: a signal the backtest left out for its hours is outside it, as one of another method is.
  const OUTSIDE: ReadonlySet<BtSkip> = new Set<BtSkip>(['outside-window', 'no-entry-window']);
  const inScope = (side: Side, key: string) => side.traded.has(key) || (side.refused.has(key) && !OUTSIDE.has(side.refused.get(key)!));

  // Compared, by day: the other side's takes (the desk's orders, or the live rules' trades) and the backtest's, and the same signals.
  const byDay = new Map<string, { placed: number; backtest: number; same: number }>(days.map((d) => [d.day, { placed: 0, backtest: 0, same: 0 }]));
  const btMoney = new Map<string, LiveCheckMoney>(days.map((d) => [d.day, zero()]));
  const lvMoney = new Map<string, LiveCheckMoney>(days.map((d) => [d.day, zero()]));
  let notBt = 0, notDesk = 0;
  const notBtWhy: One[] = [], notDeskWhy: One[] = [];
  const addMoney = (m: Map<string, LiveCheckMoney>, day: string, t: BtTrade) => { const x = m.get(day)!; x.n++; x.net += t.netUsd; if (t.netUsd > 0) x.wins++; };
  const countBt = (t: BtTrade, key: string) => {
    const day = dayOfKey.get(key);
    if (!day) return;
    byDay.get(day)!.backtest++;
    addMoney(btMoney, day, t);
  };
  const countOther = (key: string, same: boolean, t?: BtTrade) => {
    const day = dayOfKey.get(key);
    if (!day) return;
    byDay.get(day)!.placed++;
    if (same) byDay.get(day)!.same++;
    if (t) addMoney(lvMoney, day, t);
  };
  const NO_RECORD = 'the desk has no record of the signal: the strategy was off, not yet made, or its rules were different then';

  const fateByDay = new Map<string, { live: LiveCheckFate; backtest: LiveCheckFate }>(days.map((d) => [d.day, { live: noFate(), backtest: noFate() }]));
  /** A backtest's -- or the live rules' -- taken and not taken, into a row's count and each day's. Hours are a setting: a signal outside them is no one's. */
  const btFate = (x: Side, into: LiveCheckFate, sideName: 'live' | 'backtest' = 'backtest') => {
    for (const key of x.traded.keys()) { const day = dayOfKey.get(key); if (!day) continue; into.taken++; fateByDay.get(day)![sideName].taken++; }
    for (const [key, why] of x.refused) {
      if (OUTSIDE.has(why)) continue;
      const day = dayOfKey.get(key); if (!day) continue;
      into.skipped++; into.notTaken++;
      const d = fateByDay.get(day)![sideName]; d.skipped++; d.notTaken++;
    }
  };

  const rowsOut: LiveCheckRow[] = units.flatMap((u, i): LiveCheckRow[] => {
    if (!shown(u)) return [];
    const side = bt[i]!;
    let same = 0, traded = 0;
    const backtestOnly: One[] = [], liveOnly: One[] = [];
    if (folio) {
      // The live rules with these settings, signal for signal: what each takes, and why one would not.
      const other = lv[i]!;
      for (const [key, t] of side.traded) {
        traded++;
        countBt(t, key);
        if (other.traded.has(key)) { same++; continue; }
        const why = other.refused.get(key);
        backtestOnly.push({ sig: sigOf(t), why: why ? `the live rules would not: ${BT_WHY[why]}` : 'the live rules did not see it' });
      }
      for (const [key, t] of other.traded) {
        countOther(key, side.traded.has(key), t);
        if (side.traded.has(key)) continue;
        const why = side.refused.get(key);
        liveOnly.push({ sig: sigOf(t), why: why ? `the backtest would not: ${BT_WHY[why]}` : 'the backtest did not see it' });
      }
      const skipped = [...other.refused.values()].filter((w) => !OUTSIDE.has(w));
      const rowFate = { live: noFate(), backtest: noFate() };
      btFate(other, rowFate.live, 'live');
      btFate(side, rowFate.backtest);
      return [{
        id: u.id, name: u.name, account: u.account, fate: rowFate,
        live: { placed: other.traded.size, refused: 0, skipped: skipped.length },
        liveWhy: { refused: [], skipped: counted(skipped.map((w) => BT_WHY[w])) },
        backtest: traded, backtestSkipped: counted([...side.refused.values()].filter((w) => !OUTSIDE.has(w)).map((w) => BT_WHY[w])),
        same, backtestOnly: groupsOf(backtestOnly), liveOnly: groupsOf(liveOnly),
      }];
    }
    // A strategy: against the desk's own record of what it decided -- placed, refused, skipped -- never its fills.
    const records = u.mine!;
    for (const [key, t] of side.traded) {
      const r = records.get(key);
      if (!r) { notBt++; notBtWhy.push({ why: NO_RECORD, sig: sigOf(t) }); continue; }
      traded++;
      countBt(t, key);
      if (r.status === 'placed') {
        const f = fateOf(r);
        if (f === 'taken' || f === 'waiting') { same++; countOther(key, true); continue; }
        // Placed, and never filled: the desk did not take it in the end -- said as such, not as the same trade.
        backtestOnly.push({ sig: sigOf(t), why: FATE_WHY[f] });
        continue;
      }
      backtestOnly.push({ sig: sigOf(t), why: liveReason(r.status, r.detail) });
    }
    for (const r of records.values()) {
      if (r.status !== 'placed' || side.traded.has(r.signal_key)) continue;
      // An order that never filled, on a signal the backtest did not trade either: neither side took it.
      if (fateOf(r) !== 'taken' && fateOf(r) !== 'waiting') continue;
      if (!inScope(side, r.signal_key)) {
        notDesk++;
        notDeskWhy.push({ sig: partsOf(r.signal_key, Number(r.at)), why: dayOfKey.has(r.signal_key) ? 'outside the strategy\'s rules as they stand now' : 'no filled setup is on record for that signal in these days' });
        continue;
      }
      countOther(r.signal_key, false);
      liveOnly.push({ sig: partsOf(r.signal_key, Number(r.at)), why: `the backtest would not: ${BT_WHY[side.refused.get(r.signal_key)!]}` });
    }
    const refused = [...records.values()].filter((r) => r.status === 'refused'), skipped = [...records.values()].filter((r) => r.status === 'skipped');
    // The desk's fate of every signal of this strategy in the range, and the backtest's, by day and over the range.
    const rowFate = { live: noFate(), backtest: noFate() };
    for (const r of records.values()) {
      const day = dayOfKey.get(r.signal_key);
      if (!day) continue;
      const f: keyof LiveCheckFate = r.status === 'placed' ? fateOf(r) : r.status === 'refused' ? 'refused' : 'skipped';
      for (const x of [rowFate.live, fateByDay.get(day)!.live]) { x[f]++; if (f !== 'taken' && f !== 'waiting') x.notTaken++; }
    }
    btFate(side, rowFate.backtest);
    // The rules the desk's orders were sold by, beside the strategy's now: only where they differ.
    const then = [...records.values()].flatMap((r) => (r.status === 'placed' && r.trade_id && orderRules.has(r.trade_id) ? [orderRules.get(r.trade_id)!] : []));
    const uniq = (xs: number[]) => [...new Set(xs.map((x) => Math.round(x * 1_000) / 1_000))].sort((a, b) => a - b);
    const lotsThen = uniq(then.map((x) => x.lots)), stopThen = uniq(then.map((x) => x.stopPct));
    const now = u.now ?? null;
    const differs = now !== null && then.length > 0
      && (lotsThen.some((x) => x !== now.lots) || stopThen.some((x) => Math.abs(x - now.stopPct) > 1e-9));
    return [{
      id: u.id, name: u.name, account: u.account, fate: rowFate,
      rulesThen: differs ? { lots: lotsThen, stopPct: stopThen, orders: then.length, now: now! } : null,
      live: { placed: same + liveOnly.length, refused: refused.length, skipped: skipped.length },
      liveWhy: { refused: counted(refused.map((r) => liveWhy(r.detail))), skipped: counted(skipped.map((r) => liveWhy(r.detail))) },
      backtest: traded, backtestSkipped: counted([...side.refused.values()].filter((w) => !OUTSIDE.has(w)).map((w) => BT_WHY[w])),
      same, backtestOnly: groupsOf(backtestOnly), liveOnly: groupsOf(liveOnly),
    }];
  });
  const strategies = folio ? rowsOut : [...rowsOut].sort((a, b) => (a.account ?? '').localeCompare(b.account ?? '') || a.name.localeCompare(b.name, 'en', { numeric: true }));
  const sum = (f: (r: LiveCheckRow) => number) => strategies.reduce((n, r) => n + f(r), 0);
  const reported = folio || !o.only ? every : every.filter((x) => o.only!.includes(x.st.id));
  const seen = folio ? [] : live.filter((r) => reported.some((x) => x.st.id === r.strategy_id));
  const add = (xs: LiveCheckMoney[]): LiveCheckMoney => xs.reduce((a, m) => ({ n: a.n + m.n, wins: a.wins + m.wins, net: a.net + m.net }), zero());
  return {
    from: o.from, to: o.to, until,
    liveFrom: seen.length ? Number(seen[0]!.at) : null, liveTo: seen.length ? Number(seen[seen.length - 1]!.at) : null,
    against: folio ? { kind: 'portfolio', name: folio.name } : { kind: 'strategies' },
    strategies,
    total: {
      placed: sum((r) => r.live.placed), refused: sum((r) => r.live.refused), skipped: sum((r) => r.live.skipped),
      backtest: sum((r) => r.backtest), backtestSkipped: sum((r) => r.backtestSkipped.reduce((n, g) => n + g.n, 0)),
      same: sum((r) => r.same),
      backtestOnly: sum((r) => r.backtestOnly.reduce((n, g) => n + g.n, 0)),
      liveOnly: sum((r) => r.liveOnly.reduce((n, g) => n + g.n, 0)),
    },
    liveOnly: [],
    notCompared: { backtest: notBt, desk: notDesk },
    notComparedWhy: { backtest: groupsOf(notBtWhy), desk: groupsOf(notDeskWhy) },
    liveWhy: { refused: merged(strategies.flatMap((r) => r.liveWhy.refused)), skipped: merged(strategies.flatMap((r) => r.liveWhy.skipped)) },
    money: { real: folio ? add([...lvMoney.values()]) : null, backtest: add([...btMoney.values()]) },
    days: days.map((d) => ({ day: d.day, live: d.live, ...byDay.get(d.day)!, real: folio ? lvMoney.get(d.day)! : null, bt: btMoney.get(d.day)!, fate: fateByDay.get(d.day)! })),
    fate: {
      live: strategies.reduce((a, r) => addFate(a, r.fate.live), noFate()),
      backtest: strategies.reduce((a, r) => addFate(a, r.fate.backtest), noFate()),
    },
  };
}

// ------------------------------------------------------------------ one day's trades

/**
 * One trade of a backtest, as the screen lists it (owner, 14 Oct 2026: "tap the count -- trade by trade, the entry,
 * the exit, the SL and TGT, the points and the money"): the signal on the perp, the option sold and bought back,
 * the levels it was held to, and what it came to.
 */
export type BtTradeRow = {
  /** The signal's fill on the perp, epoch ms. */
  at: number;
  method: string; name: string; tf: string; dir: 1 | -1;
  perpEntry: number; perpSl: number; perpTgt: number;
  cp: 'C' | 'P'; strike: number; lots: number;
  entryAt: number; entry: number; exitAt: number; exit: number; by: BtExit;
  /** The option's own target and stop when it was sold; null where the rules set none. */
  optTgt: number | null; optStop: number | null;
  /** Where a trailing stop had brought the stop by the exit; null where it never moved. */
  optStopEnd: number | null;
  /** Sold here because the strike first picked was full: that strike. Null where it was not forwarded. */
  fwdFrom: number | null;
  /** Where the widening had taken the perp's SL and target by the exit; null where they never moved. */
  perpStopEnd: number | null; perpTgtEnd: number | null;
  perpPts: number; netUsd: number; chargesUsd: number;
  /** In a portfolio: whose trade it is. */
  member?: string;
  /** In the volatility study's trade list: the level at its fill, which set its SL, delta or lots. */
  level?: VolStudyLevel;
};
export type BtDayTrades = { day: string; total: number; trades: BtTradeRow[] };
/**
 * Which trades to list: one expiry day, or every day of the range; and within them a session of the day -- fifteen-
 * minute slots `slotFrom` to `slotTo`, both in (`slotOf`) -- and one method. Absent is all.
 */
export type TradePick = { day?: string | null; slotFrom?: number | null; slotTo?: number | null; method?: string | null };
const picked = (pick: TradePick) => (t: BtTradeRow) => {
  const slot = slotOf(t.at);
  return (pick.slotFrom == null || slot >= pick.slotFrom) && (pick.slotTo == null || slot <= pick.slotTo) && (!pick.method || t.method === pick.method);
};
/** A day's list is cut here: a day of every signal can run to thousands, and a screen does not need them all at once. */
const DAY_TRADES_MAX = 3_000;

/** What one day needs to be played again: its readings, how volatile the days before were, and the methods' names. */
async function dayContext(day: string, now: number) {
  await Promise.all([flowSchema(), optionSnapshotsSchema(), optionMarksSchema(), entrySchema(), methodsSchema()]);
  const before = new Date(Date.parse(`${day}T00:00:00Z`) - 8 * 86_400_000).toISOString().slice(0, 10);
  const known = await marketDays(before, day, now);
  const prior = known.filter((d) => d.day < day && d.stats && !d.live).slice(-5).map((d) => d.stats!.atr);
  const baseline = prior.length ? prior.reduce((a, x) => a + x, 0) / prior.length : null;
  const fetched = await marksFetchedBy([expiryCodeOf(day)]);
  const raw = await rawDay(day, now, fetched.get(expiryCodeOf(day))?.contracts ?? 0);
  const names = new Map((await rows<{ id: string; n: number | null; name: string }>('SELECT id, n, name FROM entry_methods')).map((m) => [m.id, m.n === null ? m.name : `#${m.n} ${m.name}`]));
  return { raw, baseline, known, nameOf: (id: string) => names.get(id) ?? id, ...sessionOf(day) };
}

const rowOf = (t: BtTrade, nameOf: (id: string) => string, member?: string): BtTradeRow => ({
  at: t.signal.filledAt, method: t.signal.method, name: nameOf(t.signal.method), tf: t.signal.mode === 'mtf' ? CHAIN_KEY : t.signal.tf, dir: t.signal.dir,
  perpEntry: t.signal.fillPrice, perpSl: t.signal.stop, perpTgt: t.perpTgt ?? t.signal.target,
  cp: t.cp, strike: t.strike, lots: t.lots, entryAt: t.entryAt, entry: t.entry, exitAt: t.exitAt, exit: t.exit, by: t.by,
  optTgt: t.optTgt ?? null, optStop: t.optStop ?? null, optStopEnd: t.optStopEnd ?? null, fwdFrom: t.fwdFrom ?? null, perpStopEnd: t.perpStopEnd ?? null, perpTgtEnd: t.perpTgtEnd ?? null, perpPts: t.perpPts, netUsd: t.netUsd, chargesUsd: t.chargesUsd,
  ...(member ? { member } : {}),
});
const listed = (day: string, xs: BtTradeRow[]): BtDayTrades => {
  const sorted = xs.sort((a, b) => a.at - b.at || a.method.localeCompare(b.method));
  return { day, total: sorted.length, trades: sorted.slice(0, DAY_TRADES_MAX) };
};

/** One expiry day of a backtest, played again with the same settings, trade by trade: what its day row adds up. */
async function signalBacktestDayRows(o: Ask, day: string, member?: string): Promise<BtTradeRow[]> {
  const c = await dayContext(day, o.now);
  const st = o.strategy ?? null;
  const ownOnly = ownSignal(st);
  const caps = deskCapsOf(o.params);
  const chosen = (sig: BtSignal) => (!o.tfs || o.tfs.includes(sig.mode === 'mtf' ? CHAIN_KEY : sig.tf)) && (!o.methods || o.methods.includes(sig.method));
  // As the whole run takes them (`signalBacktestNow`): with a limit, the filters choose who competes for the places.
  const takes = (sig: BtSignal) => ownOnly(sig) && (caps === null || chosen(sig));
  const span = { from: c.from, to: c.to };
  const plan = st ? withChase(o.draft ? { ...planOfStrategy(st, span, caps), maxOpen: null } : planOfStrategy(st, span, caps), o.params) : planOfParams(o.params, span);
  const volOnly: VolLevel | null = o.params.vol && o.params.vol !== 'off' ? o.params.vol : null;
  const r = simulateDay({
    from: c.from, to: c.to, signals: c.raw.signals.filter(takes), plan,
    volAt: await volAtFor(ownVolBy(o.strategy, o.params.volBy), day, c.raw.minutes, c.baseline, o.now), volOnly, bars: c.raw.minutes.filter((b) => b.at >= c.from), board: c.raw.board,
  });
  return r.trades.filter((t) => chosen(t.signal)).map((t) => rowOf(t, c.nameOf, member));
}

/** One expiry day of a portfolio, as its run works it: one account's clock and limit, or each member alone. */
async function portfolioDayRows(o: PortfolioAsk, day: string): Promise<BtTradeRow[]> {
  const caps = o.shared ? deskCapsOf(o.shared) : null;
  const members = o.members.filter((m) => m.ask && !m.problem);
  if (!caps) {
    const all: BtTradeRow[] = [];
    for (const m of members) all.push(...await signalBacktestDayRows({ ...m.ask!, from: day, to: day, now: o.now, spot: o.spot ?? null }, day, m.name));
    return all;
  }
  const c = await dayContext(day, o.now);
  const books = members.map((m) => ({ m, b: bookOf(m.ask!) }));
  const readers = await dayReaders(books.map(({ b }) => b), day, c.raw.minutes, c.baseline, o.now);
  const outs = simulateTogether({
    from: c.from, to: c.to, bars: c.raw.minutes.filter((x) => x.at >= c.from), board: c.raw.board, shared: caps,
    books: books.map(({ b }) => ({ signals: c.raw.signals.filter(b.takes), plan: b.planFor({ from: c.from, to: c.to }), volAt: readers[b.volBy], volOnly: b.volOnly })),
  });
  return books.flatMap(({ m }, k) => outs[k]!.trades.map((t) => rowOf(t, c.nameOf, m.name)));
}

/** The expiry days a pick covers: its one day, or every day of the range that has a record. */
async function pickDays(from: string, to: string, now: number, pick: TradePick): Promise<string[]> {
  if (pick.day) return [pick.day];
  return (await marketDays(from, to, now)).filter((d) => d.day >= from && d.day <= to).map((d) => d.day);
}
/** A backtest's trades by session, method or day (`TradePick`), each day played again as its row was. */
async function signalBacktestTradesNow(o: Ask, pick: TradePick): Promise<BtDayTrades> {
  const all: BtTradeRow[] = [];
  for (const day of await pickDays(o.from, o.to, o.now, pick)) all.push(...(await signalBacktestDayRows(o, day)).filter(picked(pick)));
  return listed(pick.day ?? `${o.from}..${o.to}`, all);
}
async function portfolioTradesNow(o: PortfolioAsk, pick: TradePick): Promise<BtDayTrades> {
  const all: BtTradeRow[] = [];
  for (const day of await pickDays(o.from, o.to, o.now, pick)) all.push(...(await portfolioDayRows(o, day)).filter(picked(pick)));
  return listed(pick.day ?? `${o.from}..${o.to}`, all);
}
export function signalBacktestTradesHere(o: Ask, pick: TradePick): Promise<BtDayTrades> {
  const run = working.then(() => signalBacktestTradesNow(o, pick));
  working = run.catch(() => { });
  return run;
}
/**
 * One cell of a win % sweep, trade by trade (owner, 20 Oct 2026: "each cell, a tap, a popup, trade by trade"): the row's
 * methods for that cell worked out again as the sweep worked them -- as saved, every method, or those that passed the
 * bar on the pick days -- and the row's trades with them over the run's days. `methods`: the list traded (null, every one).
 */
export type WinSweepCellPick = { row: string; cell: 'saved' | 'all' | { pct: number; minTrades: number } };
export function winSweepTradesHere(o: WinSweepAsk, at: WinSweepCellPick): Promise<BtDayTrades & { methods: string[] | null }> {
  const run = working.then(() => winSweepTradesNow(o, at));
  working = run.catch(() => { });
  return run;
}
async function winSweepTradesNow(o: WinSweepAsk, at: WinSweepCellPick): Promise<BtDayTrades & { methods: string[] | null }> {
  const m = o.members.find((x) => x.id === at.row);
  if (!m?.ask || m.problem || m.ask.strategy) throw new Error('That row was not swept: it cannot be worked out, or a strategy works it.');
  const ask = m.ask;
  let methods: readonly string[] | null = at.cell === 'all' ? null : at.cell === 'saved' ? ask.methods : null;
  if (typeof at.cell === 'object') {
    const rec = await signalBacktestNow({ ...ask, methods: null, from: o.pick.from, to: o.pick.to, now: o.now, spot: o.spot ?? null });
    methods = pickMethods(rec.choices.methods.map((x) => ({ method: x.key, trades: x.n, wins: x.wins, net: x.net })), { winPct: at.cell.pct, minTrades: at.cell.minTrades });
    if (!methods.length) return { ...listed(`${o.from}..${o.to}`, []), methods: [] };
  }
  const r = await signalBacktestTradesNow({ ...ask, methods, from: o.from, to: o.to, now: o.now, spot: o.spot ?? null }, {});
  return { ...r, methods: methods ? [...methods] : null };
}
export function portfolioTradesHere(o: PortfolioAsk, pick: TradePick): Promise<BtDayTrades> {
  const run = working.then(() => portfolioTradesNow(o, pick));
  working = run.catch(() => { });
  return run;
}

/**
 * The volatility study's trades of one expiry day, one by one (owner, 17 Oct 2026: "tap the count -- trade by trade"):
 * one side -- as set, or by volatility -- and one way of reading the level, each trade with its level. Played again as
 * the study plays it (`studyBookOf`), so the list adds up to the day's row.
 */
export type VolTradesPick = { day: string; side: 'fixed' | 'by-vol'; by: VolBy };
/** One book's trades of a day as set -- every one of its signals, read by its own source -- for a record (`VolWin`). */
async function flatDayOf(b: StudyBook, day: string, now: number): Promise<BtTrade[]> {
  const c = await dayContext(day, now);
  const by = ownVolBy(b.strategy, 'atr')!;
  const read = by === 'iv' ? await ivReaderOf(day, now) : volReader(c.raw.minutes, c.baseline);
  const book = studyBookOf(b);
  return simulateDay({ from: c.from, to: c.to, signals: c.raw.signals.filter(book.takes), plan: book.planFor({ from: c.from, to: c.to }, null), volAt: read, bars: c.raw.minutes.filter((x) => x.at >= c.from), board: c.raw.board }).trades;
}
async function volStudyDayRows(books: readonly { b: StudyBook; name?: string }[], rule: VolRule, pick: VolTradesPick, now: number): Promise<BtDayTrades> {
  const c = await dayContext(pick.day, now);
  const read = pick.by === 'iv' ? await ivReaderOf(pick.day, now) : volReader(c.raw.minutes, c.baseline);
  const bars = c.raw.minutes.filter((x) => x.at >= c.from);
  const win = rule.win ?? null;
  // Methods by win %: the record of the days before this one, as the study reads it.
  const prior = win ? (await marketDays(new Date(Date.parse(`${pick.day}T00:00:00Z`) - win.days * 86_400_000).toISOString().slice(0, 10), pick.day, now))
    .filter((d) => d.day < pick.day && !d.live).map((d) => d.day) : [];
  const rows: BtTradeRow[] = [];
  for (const { b, name } of books) {
    const book = studyBookOf(b);
    const plan = book.planFor({ from: c.from, to: c.to }, pick.side === 'by-vol' ? rule : null);
    // As set, the trades are its own source's, as the study plays them; by volatility, the source asked.
    const all = pick.side === 'fixed' && win ? await flatDayOf(b, pick.day, now)
      : simulateDay({ from: c.from, to: c.to, signals: c.raw.signals.filter(book.takes), plan, volAt: read, bars, board: c.raw.board }).trades;
    let trades = all;
    if (win) {
      const byDay = new Map<string, WinTally>();
      for (const d of prior) byDay.set(d, tallyOf(await flatDayOf(b, d, now)));
      const record = recordBefore(byDay, pick.day, win.days);
      trades = all.filter((t) => passesBar(record, t.signal.method, pick.side === 'fixed' ? win.base : winBarAt(win, t.vol), win.minTrades));
    }
    rows.push(...trades.map((t) => ({ ...rowOf(t, c.nameOf, name), level: (pick.side === 'fixed' ? read(t.signal.filledAt) : t.vol) ?? 'unknown' as const })));
  }
  return listed(pick.day, rows);
}
const ruleOf = (o: VolRule): VolRule => ({ sl: o.sl, delta: o.delta, lots: o.lots ?? null, win: o.win ?? null });
export function volStudyTradesHere(o: VolStudyAsk, pick: VolTradesPick): Promise<BtDayTrades> {
  const run = working.then(() => volStudyDayRows([{ b: o }], ruleOf(o), pick, o.now));
  working = run.catch(() => { });
  return run;
}
export function portfolioVolStudyTradesHere(o: PortfolioVolStudyAsk, pick: VolTradesPick): Promise<BtDayTrades> {
  const run = working.then(() => volStudyDayRows(o.members.flatMap((m) => (m.ask && !m.problem ? [{ b: m.ask, name: m.name }] : [])), ruleOf(o), pick, o.now));
  working = run.catch(() => { });
  return run;
}

