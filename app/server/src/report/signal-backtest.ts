import { rows } from '../db/pool.js';
import { flowSchema } from '../market/flow.js';
import { optionSnapshotsSchema } from '../market/option-snapshots.js';
import { marksFetchedBy, marksWanted, optionMarksSchema } from '../market/option-marks.js';
import { entrySchema } from '../entry/paper.js';
import { methodsSchema } from '../entry/catalogue.js';
import { fillChargesUsd } from '../trading/charges.js';
import { fundsRequiredPerContract } from '../trading/margin.js';
import { CHAIN_KEY } from '../trading/pnl-history.js';
import { FAMILIES, PATTERNS, candles, familyOf, sessionOf, type MinuteBar, type PatternKey } from './market-day.js';
import { marketDays, marketReport, zeroTot, type Tot } from './market-report.js';
import { selectLegs, type Candidate } from '../strategy/select.js';
import { istMinutes, istWeekday } from '../strategy/schedule.js';
import {
  actionOf, exitRules, exitValueAt, sideCaps, maxSlPtsFor, maxTgtPtsFor, minSlPtsFor, minTgtPtsFor, minutesForward, minutesOf, noEntryWindowAt, ruleTfs, strikePickAt,
  type Strategy,
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
  /**
   * An option is not sold for less than this many dollars (owner, 13 Oct 2026: "a minimum premium filter, 10
   * dollars to begin with; 0 switches it off"). Absent: `MIN_PREMIUM`, the strategies' own floor. 0: no floor --
   * anything with a bid is sold.
   */
  minPremium?: number;
};

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
/** The start of an expiry day on the IST clock: what a backtest's own time steps are read forward from. */
export const DAY_START_IST = '17:30';
export const DEFAULT_PARAMS: BacktestParams = { rule: 'delta', value: 0.1, lots: 10, targetPct: 0.9, stopPct: 3, window: 'desk', deskMax: 0, cePct: 100, pePct: 100 };
/** The desk's limits of a set of settings: null with none. */
export function deskCapsOf(p: Pick<BacktestParams, 'deskMax' | 'cePct' | 'pePct'>): { max: number; side: { CE: number; PE: number } | null } | null {
  const max = p.deskMax ?? 0;
  if (!(max > 0)) return null;
  return { max, side: sideCaps(max, { CE: p.cePct ?? 100, PE: p.pePct ?? 100 }) };
}
/** An option is not sold for less than this, as the strategies' own floor; a backtest may set its own (`minPremium`). */
export const MIN_PREMIUM = 10;
const CONTRACT_VALUE = 0.001;
const MIN = 60_000;
/** The board reading a fill is priced on is at most this far from it. */
const BOARD_NEAR_MS = 5 * MIN;

export type BtExit = 'perp-tgt' | 'perp-sl' | 'option-tgt' | 'option-sl' | 'window-end';
export const BT_EXITS: readonly BtExit[] = ['perp-tgt', 'perp-sl', 'option-tgt', 'option-sl', 'window-end'];
export type BtSkip = 'outside-window' | 'no-entry-window' | 'distance' | 'volatility' | 'at-limit' | 'desk-limit' | 'side-limit' | 'no-board' | 'no-strike' | 'no-exit-price';
export const BT_SKIPS: readonly BtSkip[] = ['outside-window', 'no-entry-window', 'distance', 'volatility', 'at-limit', 'desk-limit', 'side-limit', 'no-board', 'no-strike', 'no-exit-price'];
const noSkips = (): Record<BtSkip, number> => ({ 'outside-window': 0, 'no-entry-window': 0, distance: 0, volatility: 0, 'at-limit': 0, 'desk-limit': 0, 'side-limit': 0, 'no-board': 0, 'no-strike': 0, 'no-exit-price': 0 });

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
  /** The strike and the lots, from one reading of the board (both sides, as it stood at `at`). Null: nothing to sell. */
  pick: (board: readonly BoardRow[], cp: 'C' | 'P', at: number) => { row: BoardRow; lots: number } | null;
  /** The perp level that ends the trade at its target. */
  targetOf: (sig: BtSignal) => number;
  /** The option's own target and stop, as shares of the premium sold; 0 is none. */
  targetPct: number; stopPct: number;
  /** The target and the stop in force at a moment, where they move with the clock; absent, the ones above all day. */
  targetPctAt?: (at: number) => number;
  stopPctAt?: (at: number) => number;
  /** At most this many open at once; null, any number. */
  maxOpen: number | null;
  /** The desk's own limits on top: at most this many across all, and each side at most so many. Null: none. */
  desk?: { max: number; side: { CE: number; PE: number } | null } | null;
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
  return {
    refuses: (sig) => {
      if (sig.filledAt < span.from || sig.filledAt >= span.to - 5 * MIN) return 'outside-window';
      if (custom ? !(minutesForward(custom.from, istMinutes(sig.filledAt)) < minutesForward(custom.from, custom.to)) : sig.filledAt < opens || sig.filledAt >= closes) return 'outside-window';
      return outOfRange(sig, sig.target, p) ? 'distance' : null;
    },
    pick: (board, cp) => { const row = pickStrike(board, cp, p); return row ? { row, lots: p.lots } : null; },
    targetOf: (sig) => sig.target,
    targetPct: p.targetPct, stopPct: p.stopPct, maxOpen: null, desk: deskCapsOf(p),
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
    maxOpen: rule.maxOpen > 0 ? rule.maxOpen : null,
    desk,
  };
}

/** The index of the first item later than `t`, in a list sorted by time. */
function firstAfter<T>(xs: readonly T[], t: number, at: (x: T) => number): number {
  let lo = 0, hi = xs.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (at(xs[mid]!) <= t) lo = mid + 1; else hi = mid; }
  return lo;
}
const atOf = (x: { at: number }) => x.at;

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
  /** When each trade still open ends, its side and whose it is: what "at most N open" and each side's limit count. */
  let open: { until: number; side: 'CE' | 'PE'; book: number }[] = [];
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
    const pickKey = near * 2 + (cp === 'P' ? 1 : 0);
    let picked = picks.get(pickKey);
    if (picked === undefined) { picked = plan.pick(readingAt(board, times[near]!), cp, times[near]!); picks.set(pickKey, picked); }
    if (!picked) { skip('no-strike'); continue; }
    const pick = picked.row, lots = picked.lots;
    const entry = pick.bid!, entryAt = times[near]!;
    const target = plan.targetOf(sig);

    // The perp: the first minute after the fill's own that holds the stop or the target; both in one bar is the stop.
    let perpAt = to - MIN, perpBy: 'perp-tgt' | 'perp-sl' | 'window-end' = 'window-end', perpPx = lastBar?.close ?? sig.fillPrice;
    const fillMinute = Math.floor(t0 / MIN) * MIN;
    for (let i = firstAfter(o.bars, fillMinute, atOf); i < o.bars.length; i++) {
      const b = o.bars[i]!;
      const stop = sig.dir === 1 ? b.low <= sig.stop : b.high >= sig.stop;
      const tgt = sig.dir === 1 ? b.high >= target : b.low <= target;
      if (stop || tgt) { perpAt = b.at + MIN; perpBy = stop ? 'perp-sl' : 'perp-tgt'; perpPx = stop ? sig.stop : target; break; }
    }

    // The option's own readings between: its target (a resting buy, filled at its price) and its stop (bought at the offer).
    const series = board.series.get(`${cp}${pick.strike}`);
    // The option's own levels at a moment: fixed all day, or by the clock where the plan has steps.
    const tgtAtFn = plan.targetPctAt, stopAtFn = plan.stopPctAt;
    const level = (pc: number, sign: 1 | -1) => (pc > 0 ? entry * (1 + sign * pc) : null);
    const fixedTgt = level(plan.targetPct, -1), fixedStop = level(plan.stopPct, 1);
    let restingAt = tgtAtFn ? level(pctAt(tgtPcts, tgtAtFn, entryAt), -1) : fixedTgt;
    let exit: number | null = null, exitAt = perpAt, by: BtExit = perpBy;
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
        const stopAt = stopAtFn ? level(pctAt(stopPcts, stopAtFn, t), 1) : fixedStop;
        if (tgtAt !== null && offer <= tgtAt + 1e-9) {
          // A resting buy fills at its own price as the offer comes down to it. One just moved UP over the offer by a
          // time step (a lower share kept) is a buy placed through the market: it fills at the offer.
          exit = restingAt !== null && tgtAt > restingAt + 1e-9 ? Math.min(tgtAt, offer) : tgtAt;
          exitAt = t; by = 'option-tgt'; exitSpot = orNull(spot[i]!) ?? exitSpot; break;
        }
        restingAt = tgtAt;
        if (stopAt !== null && offer >= stopAt - 1e-9) { exit = offer; exitAt = t; by = 'option-sl'; exitSpot = orNull(spot[i]!) ?? exitSpot; break; }
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
    open.push({ until: exitAt, side: cp === 'P' ? 'PE' : 'CE', book });
    trades.push({
      signal: sig, cp, strike: pick.strike, lots, entryAt, entry, exitAt, exit, by,
      netUsd: (entry - exit) * lots * CONTRACT_VALUE - charges, chargesUsd: charges, vol,
      marginUsd: fundsRequiredPerContract({ spot: pick.spot ?? sig.fillPrice, premium: entry, leverage: 200, contractValue: CONTRACT_VALUE }) * lots,
      perpPts: (perpPx - sig.fillPrice) * sig.dir,
    });
  }
  return outs;
}

// ------------------------------------------------------------------ adding up

/** A count of backtested trades: money after charges, the same trades' perp points, and each exit with how many of its trades made money. */
export type BtTot = {
  n: number; wins: number; losses: number; net: number; won: number; lost: number; perpPts: number;
  /** The charges on every fill, dollars: `net` is after them, `net + charges` before. */
  charges: number;
  exits: Partial<Record<BtExit, { n: number; wins: number; net: number }>>;
};
export const zeroBt = (): BtTot => ({ n: 0, wins: 0, losses: 0, net: 0, won: 0, lost: 0, perpPts: 0, charges: 0, exits: {} });
function addBt(a: BtTot, b: BtTot): BtTot {
  a.n += b.n; a.wins += b.wins; a.losses += b.losses; a.net += b.net; a.won += b.won; a.lost += b.lost; a.perpPts += b.perpPts; a.charges += b.charges;
  for (const k of BT_EXITS) {
    const x = b.exits[k];
    if (!x) continue;
    const mine = a.exits[k] ?? (a.exits[k] = { n: 0, wins: 0, net: 0 });
    mine.n += x.n; mine.wins += x.wins; mine.net += x.net;
  }
  return a;
}
type BtCell = { day: string; method: string; mode: 'single' | 'mtf'; tf: string; vol: VolLevel | null; tot: BtTot };

function cellsOf(day: string, trades: readonly BtTrade[]): BtCell[] {
  const by = new Map<string, BtCell>();
  for (const t of trades) {
    const s = t.signal;
    const key = `${s.method}|${s.mode}|${s.tf}|${t.vol}`;
    const cell = by.get(key) ?? { day, method: s.method, mode: s.mode, tf: s.tf, vol: t.vol, tot: zeroBt() };
    by.set(key, cell);
    const x = cell.tot, win = t.netUsd > 0;
    x.n++; x.net += t.netUsd; x.perpPts += t.perpPts; x.charges += t.chargesUsd;
    if (win) { x.wins++; x.won += t.netUsd; } else { x.losses++; x.lost -= t.netUsd; }
    const e = x.exits[t.by] ?? (x.exits[t.by] = { n: 0, wins: 0, net: 0 });
    e.n++; e.net += t.netUsd; if (win) e.wins++;
  }
  return [...by.values()];
}

/** A trade's time open and the margin it held, with what it is filtered by: what the day's peak margin is worked from. */
type Span = { at: number; until: number; margin: number; lots: number; tf: string; method: string };
/** A day's signals by what they are filtered by: how many there were of a time frame and method, and why those not traded were not. */
type Tally = { tf: string; method: string; signals: number; skipped: Record<BtSkip, number> };
type HeldDay = { at: number; cells: BtCell[]; tally: Tally[]; spans: Span[]; grain: BoardGrain };
const held = new Map<string, HeldDay>();
/** At most this many worked days are kept -- some sixty sets of settings over a fortnight; the longest unasked-for goes first. */
const HELD_MAX = 800;
export function clearSignalBacktestCache(): void { held.clear(); raw.clear(); }
/** The SL or the TGT outside the range asked for: nearer than a minimum, or further than a maximum. 0 is no bound. */
function outOfRange(sig: BtSignal, target: number, p: Pick<BacktestParams, 'slMin' | 'slMax' | 'tgtMin' | 'tgtMax'>): boolean {
  const sl = Math.abs(sig.fillPrice - sig.stop), tgt = Math.abs(sig.fillPrice - target);
  const lo = (v: number, min = 0) => min > 0 && v < min, hi = (v: number, max = 0) => max > 0 && v > max;
  return lo(sl, p.slMin) || hi(sl, p.slMax) || lo(tgt, p.tgtMin) || hi(tgt, p.tgtMax);
}
const paramsKey = (p: BacktestParams) => `${p.rule}|${p.value}|${p.lots}|${p.targetPct}|${p.stopPct}|${p.window}${p.window === 'custom' ? `:${p.hoursFrom}-${p.hoursTo}` : ''}|${p.deskMax ?? 0}|${p.cePct ?? 100}|${p.pePct ?? 100}|${p.slMin ?? 0}-${p.slMax ?? 0}-${p.tgtMin ?? 0}-${p.tgtMax ?? 0}|${(p.targetSteps ?? []).map((x) => `${x.at}=${x.pct}`).join(',')}|vol:${p.vol ?? 'off'}|floor:${p.minPremium ?? MIN_PREMIUM}`;
/** A strategy's rules as a key: its id, and its rules themselves -- edited, it is another backtest. */
function strategyKey(s: Strategy): string {
  const text = JSON.stringify(s.config);
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

/** One day under one set of rules. `takes` narrows the signals to those the rules are about at all (a strategy's methods and timeframes). */
async function dayOf(day: string, key: string, now: number, planFor: (span: { from: number; to: number }) => DayPlan, takes: (sig: BtSignal) => boolean, vol: { only: VolLevel | null; baseline: number | null }, marksSeen = 0): Promise<HeldDay> {
  const id = `${day}|${key}|marks:${marksSeen}`;
  const h = held.get(id);
  const { from, to } = sessionOf(day);
  if (h && (h.at >= to + SETTLED_MS || now - h.at < FRESH_MS)) { held.delete(id); held.set(id, h); return h; }
  const d = await rawDay(day, now, marksSeen);
  const signals = d.signals.filter(takes);
  const r = simulateDay({
    from, to, signals, plan: planFor({ from, to }),
    volAt: volReader(d.minutes, vol.baseline), volOnly: vol.only,
    bars: d.minutes.filter((b) => b.at >= from),
    board: d.board,
  });
  const tally = new Map<string, Tally>();
  const tallyOf = (sig: BtSignal) => {
    const tf = sig.mode === 'mtf' ? CHAIN_KEY : sig.tf, k = `${tf}|${sig.method}`;
    let x = tally.get(k);
    if (!x) { x = { tf, method: sig.method, signals: 0, skipped: noSkips() }; tally.set(k, x); }
    return x;
  };
  for (const sig of signals) tallyOf(sig).signals++;
  for (const x of r.refused) tallyOf(x.signal).skipped[x.why]++;
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
  shared?: { deskMax: number; cePct: number; pePct: number } | null;
  /** Each with its settings; one that cannot be worked -- its strategy deleted -- carries why, and is listed with nothing. */
  members: { id: string; name: string; ask: Pick<Ask, 'params' | 'tfs' | 'methods' | 'strategy'> | null; problem?: string | null }[];
};
export type BacktestPortfolioResult = {
  from: string; to: string;
  /** The one limit they were traded under together, as the desk rounds it; null where each kept its own. */
  shared: { max: number; ce: number; pe: number; cePct: number; pePct: number; /** Signals that found the account, or their side of it, full. */ turnedAway: number } | null;
  members: { id: string; name: string; problem: string | null; signals: number; total: BtTot; marginPeakUsd: number; priced: Record<BoardGrain, number> | null }[];
  total: BtTot;
  /** Each expiry day: all of them together, and each one's own net in the members' order. */
  days: { day: string; live: boolean; n: number; wins: number; net: number; charges: number; byMember: number[] }[];
  margin: { peakUsd: number; peakDay: string | null; peakAt: number | null; peakOpen: number; /** The lots open at that moment, across all of them. */ peakLots: number; avgDailyPeakUsd: number; sumOfPeaksUsd: number };
};

export function portfolioBacktestHere(o: PortfolioAsk): Promise<BacktestPortfolioResult> {
  const run = working.then(() => portfolioNow(o));
  working = run.catch(() => { });
  return run;
}

/** What one backtest asks of a day's signals, with no limit of the desk's on it: which it is about, how it trades them, its volatility filter. */
function bookOf(o: Pick<Ask, 'params' | 'tfs' | 'methods' | 'strategy'>): { takes: (sig: BtSignal) => boolean; planFor: (span: { from: number; to: number }) => DayPlan; volOnly: VolLevel | null } {
  const st = o.strategy ?? null, rule = st?.config.signal ?? null;
  const free = { ...o.params, deskMax: 0 };
  return {
    takes: (sig) => (!rule || (sig.mode === rule.mode && (rule.mode !== 'single' || (ruleTfs(rule) as string[]).includes(sig.tf)) && rule.methods.includes(sig.method)))
      && (!o.tfs || o.tfs.includes(sig.mode === 'mtf' ? CHAIN_KEY : sig.tf)) && (!o.methods || o.methods.includes(sig.method)),
    planFor: (span) => (st ? planOfStrategy(st, span, null) : planOfParams(free, span)),
    volOnly: o.params.vol && o.params.vol !== 'off' ? o.params.vol : null,
  };
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
  const books = o.members.map((m) => (m.ask && !m.problem ? bookOf(m.ask) : null));
  const totals = o.members.map(() => zeroBt()), signals = o.members.map(() => 0), peaks = o.members.map(() => 0);
  const priced = o.members.map((): Record<BoardGrain, number> => ({ 'own-1m': 0, 'mark-1m': 0, '5m': 0 }));
  const rows: BacktestPortfolioResult['days'] = [];
  let peak = { usd: 0, at: null as number | null, open: 0, lots: 0, day: null as string | null }, daily = 0, dailyN = 0, turnedAway = 0;
  for (const d of days) {
    const { from, to } = sessionOf(d.day);
    const raw = await rawDay(d.day, o.now, fetched.get(expiryCodeOf(d.day))?.contracts ?? 0);
    const volAt = volReader(raw.minutes, baselineOf(d.day));
    const live = books.flatMap((b, i) => (b ? [{ i, b }] : []));
    const outs = simulateTogether({
      from, to, bars: raw.minutes.filter((x) => x.at >= from), board: raw.board, shared: caps,
      books: live.map(({ b }) => ({ signals: raw.signals.filter(b.takes), plan: b.planFor({ from, to }), volAt, volOnly: b.volOnly })),
    });
    const row = { day: d.day, live: d.live, n: 0, wins: 0, net: 0, charges: 0, byMember: o.members.map(() => 0) };
    const all: { at: number; until: number; margin: number; lots: number }[] = [];
    live.forEach(({ i }, k) => {
      const out = outs[k]!;
      const t = cellsOf(d.day, out.trades).reduce((a, c) => addBt(a, c.tot), zeroBt());
      addBt(totals[i]!, t);
      signals[i]! += out.trades.length + out.refused.length;
      turnedAway += out.skipped['desk-limit'] + out.skipped['side-limit'];
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
  return {
    from: o.from, to: o.to, members,
    shared: { max: caps.max, ce: caps.side?.CE ?? caps.max, pe: caps.side?.PE ?? caps.max, cePct: o.shared!.cePct, pePct: o.shared!.pePct, turnedAway },
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
  for (const m of o.members) {
    if (!m.ask || m.problem) {
      members.push({ id: m.id, name: m.name, problem: m.problem ?? 'It cannot be worked out.', signals: 0, total: zeroBt(), marginPeakUsd: 0, priced: null });
      results.push(null);
      continue;
    }
    const own = new Map<string, Span[]>();
    const r = await signalBacktestNow({ ...m.ask, from: o.from, to: o.to, now: o.now, spot: o.spot ?? null }, own);
    for (const [day, xs] of own) { const all = spans.get(day); if (all) all.push(...xs); else spans.set(day, [...xs]); }
    members.push({ id: m.id, name: m.name, problem: null, signals: r.signals, total: r.total, marginPeakUsd: r.margin.peakUsd, priced: r.priced });
    results.push(r);
  }
  const worked = results.filter((r): r is SignalBacktest => r !== null);
  const dayList = worked[0]?.days.map((d) => ({ day: d.day, live: d.live })) ?? [];
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
  return {
    from: o.from, to: o.to, members, shared: null,
    total: worked.reduce((t, r) => addBt(t, r.total), zeroBt()),
    days,
    margin: { peakUsd: peak.usd, peakDay: peak.day, peakAt: peak.at, peakOpen: peak.open, peakLots: peak.lots, avgDailyPeakUsd: dailyN ? daily / dailyN : 0, sumOfPeaksUsd: members.reduce((a, m) => a + m.marginPeakUsd, 0) },
  };
}

/** `shownOut`, where given, is filled with the trades shown -- their times and margin -- by expiry day: what a portfolio lays on one clock. */
async function signalBacktestNow(o: Ask, shownOut?: Map<string, Span[]>): Promise<SignalBacktest> {
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
  const names = new Map((await rows<{ id: string; n: number | null; name: string }>('SELECT id, n, name FROM entry_methods')).map((m) => [m.id, m.n === null ? m.name : `#${m.n} ${m.name}`]));
  const nameOf = (id: string) => names.get(id) ?? id;
  const skipped = noSkips();
  let signals = 0;
  const every: BtCell[] = [];
  const st = o.strategy ?? null;
  const rule = st?.config.signal ?? null;
  // A strategy is only ever asked about its own signals: its way of reading, its timeframes, its methods.
  const ownOnly = (sig: BtSignal) => !rule || (sig.mode === rule.mode && (rule.mode !== 'single' || (ruleTfs(rule) as string[]).includes(sig.tf)) && rule.methods.includes(sig.method));
  const caps = deskCapsOf(o.params);
  const strategyPlan = (s: Strategy, span: { from: number; to: number }, desk: DayPlan['desk']): DayPlan => (o.draft ? { ...planOfStrategy(s, span, desk), maxOpen: null } : planOfStrategy(s, span, desk));
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
  const key = (st ? `${strategyKey(st)}${o.draft ? '|draft' : ''}|${o.params.deskMax ?? 0}|${o.params.cePct ?? 100}|${o.params.pePct ?? 100}|vol:${volOnly}` : paramsKey(o.params)) + filterKey;
  for (const d of days) {
    const h = await dayOf(d.day, key, o.now, (span) => (st ? strategyPlan(st, span, caps) : planOfParams(o.params, span)), takes, { only: volOnly, baseline: baselineOf(d.day) }, marksSeen(d.day));
    grainOf.set(d.day, h.grain);
    // The counts follow the time frame and method filters as the rows do: "N signals, M traded" is of what is shown.
    for (const x of h.tally) {
      if ((o.tfs && !o.tfs.includes(x.tf)) || (o.methods && !o.methods.includes(x.method))) continue;
      signals += x.signals;
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
      const h = await dayOf(d.day, st ? `${strategyKey(st)}|vol:${volOnly}` : paramsKey(free), o.now, (span) => (st ? strategyPlan(st, span, null) : planOfParams(free, span)), ownOnly, { only: volOnly, baseline: baselineOf(d.day) }, marksSeen(d.day));
      listCells.push(...h.cells);
    }
  } else listCells.push(...every);
  const exits = st ? exitRules(st.config) : null;
  const params: BacktestParams = st && exits
    ? {
      rule: st.config.strikeRule === 'delta' ? 'delta' : 'premium', value: st.config.strikeRule === 'delta' ? (st.config.delta?.max ?? 0) : (st.config.premium?.usd ?? 0), lots: st.config.lots,
      targetPct: exits.target.mode === 'pct' ? exits.target.value : 0, stopPct: exits.stop.mode === 'pct' ? exits.stop.value : 0, window: 'desk',
      deskMax: o.params.deskMax ?? 0, cePct: o.params.cePct ?? 100, pePct: o.params.pePct ?? 100, vol: o.params.vol ?? 'off',
    }
    : o.params;
  const real = st && o.draft ? zeroTot() : st
    ? (await marketReport({ from: o.from, to: o.to, now: o.now, spot: o.spot ?? null, account: st.accountId ?? null, tfs: null, methods: null, strategies: [st.name] })).total.real
    : null;
  const cells = every.filter((c) => (!o.tfs || o.tfs.includes(tfKeyOf(c))) && (!o.methods || o.methods.includes(c.method)));
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
  const patternOf = new Map(days.map((d) => [d.day, d.pattern]));
  const byNet = (a: BtRow, b: BtRow) => b.net - a.net || b.n - a.n;
  const distinct = (xs: { key: string; name: string }[]) => [...new Map(xs.map((x) => [x.key, x])).values()];
  return {
    from: o.from, to: o.to, params, signals, skipped,
    margin: { peakUsd: peak.usd, peakDay: peak.day, peakAt: peak.at, peakOpen: peak.open, peakLots: peak.lots, avgDailyPeakUsd: dailyN ? daily / dailyN : 0, avgTradeUsd: tradeN ? tradeMargin / tradeN : 0 },
    strategy: st ? { id: st.id, name: st.name, accountId: st.accountId ?? null, caveats: strategyCaveats(st), real: real! } : null,
    total: cells.reduce((t, c) => addBt(t, c.tot), zeroBt()),
    days: days.map((d) => ({ ...cells.filter((c) => c.day === d.day).reduce((t, c) => addBt(t, c.tot), zeroBt()), day: d.day, pattern: d.pattern, live: d.live, grain: grainOf.get(d.day) ?? '5m' })),
    priced: { 'own-1m': 0, 'mark-1m': 0, '5m': 0, ...Object.fromEntries(BOARD_GRAINS.map((g) => [g, days.filter((d) => grainOf.get(d.day) === g).length])) } as Record<BoardGrain, number>,
    pairs: group((c) => `${c.method}|${c.mode}|${c.tf}`, (c) => ({ name: nameOf(c.method), tf: c.mode === 'mtf' ? `${c.tf} + TF chain` : c.tf })).sort(byNet),
    byTf: group(tfKeyOf, (c) => ({ name: c.mode === 'mtf' ? 'With timeframe chain' : c.tf })).sort((a, b) => tfPlace(a.key) - tfPlace(b.key)),
    byMethod: group((c) => c.method, (c) => ({ name: nameOf(c.method) })).sort(byNet),
    byPattern: group((c) => patternOf.get(c.day) ?? null, (c) => { const p = PATTERNS.find((x) => x.key === patternOf.get(c.day))!; return { name: `#${p.id} ${p.name}` }; }).sort(byNet),
    byFamily: group((c) => { const p = patternOf.get(c.day); return p ? familyOf(p) : null; }, (c) => ({ name: FAMILIES.find((f) => f.key === familyOf(patternOf.get(c.day)!))!.name })).sort(byNet),
    byVol: group((c) => c.vol, (c) => ({ name: c.vol === 'low' ? 'Low' : c.vol === 'high' ? 'High' : 'Medium' })).sort((a, b) => VOL_LEVELS.indexOf(a.key as VolLevel) - VOL_LEVELS.indexOf(b.key as VolLevel)),
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
  accounts: { id: number | null; name: string | null; caps: { deskMax: number; cePct: number; pePct: number } | null; strategies: Strategy[] }[];
};
/** Signals on one side only, by why, with the first few to look at. */
export type LiveCheckWhy = { why: string; n: number; first: { at: number; method: string; tf: string; dir: 1 | -1 }[] };
export type LiveCheckRow = {
  id: string; name: string; account: string | null;
  /** What the desk did with the signals of its methods: orders placed, refused at the gate, skipped by its rules. */
  live: { placed: number; refused: number; skipped: number };
  /** Trades the backtest makes of the same signals, by the strategy's rules as they stand. */
  backtest: number;
  /** Signals that are an order on the desk and a trade in the backtest. */
  same: number;
  backtestOnly: LiveCheckWhy[]; liveOnly: LiveCheckWhy[];
};
export type LiveCheck = {
  from: string; to: string;
  /** The first and the last moment the desk has a record in the range; null with none. */
  liveFrom: number | null; liveTo: number | null;
  /** Signals filled up to here are compared: the desk is given two minutes to have written a signal down. */
  until: number;
  strategies: LiveCheckRow[];
  total: { placed: number; refused: number; skipped: number; backtest: number; same: number; backtestOnly: number; liveOnly: number };
  days: { day: string; placed: number; backtest: number; same: number }[];
};

/** How long the desk is given to write down what it did with a signal before its absence counts. */
const LIVE_GRACE_MS = 120_000;

/** Why the desk did not place an order for a signal, from its own sentence: a few plain reasons, else the sentence without its figures. */
export function liveReason(status: string, detail: string): string {
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
  const lead = status === 'refused' ? 'refused' : status === 'skipped' ? 'skipped' : status;
  return `the desk ${lead}: ${hit ? hit[1] : said.replace(/[\d.,]+/g, 'N').slice(0, 90)}`;
}

const BT_WHY: Record<BtSkip, string> = {
  'outside-window': 'outside its days and hours, as its rules stand now',
  'no-entry-window': 'inside its no-entry window, as its rules stand now',
  distance: 'its SL / TGT distance, as its rules stand now',
  volatility: 'the volatility filter',
  'at-limit': 'its own most open at once',
  'desk-limit': 'the account\'s limit on open trades',
  'side-limit': 'the account\'s CE / PE limit',
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
  const span = days.length ? { from: sessionOf(days[0]!.day).from, to: sessionOf(days[days.length - 1]!.day).to } : null;
  type Live = { strategy_id: string; signal_key: string; status: string; detail: string; at: string };
  const live = span && every.length ? await rows<Live>(
    'SELECT strategy_id, signal_key, status, detail, at FROM strategy_signal_runs WHERE strategy_id = ANY($1) AND at >= $2 AND at < $3 ORDER BY at',
    [every.map((x) => x.st.id), span.from, Math.min(span.to, o.now) + LIVE_GRACE_MS]) : [];
  const liveBy = new Map<string, Map<string, Live>>();
  for (const r of live) (liveBy.get(r.strategy_id) ?? liveBy.set(r.strategy_id, new Map()).get(r.strategy_id)!).set(r.signal_key, r);

  type Side = { traded: Map<string, BtSignal>; refused: Map<string, BtSkip>; known: Map<string, BtSignal> };
  const bt = new Map<string, Side>(every.map((x) => [x.st.id, { traded: new Map(), refused: new Map(), known: new Map() }]));
  const dayOfKey = new Map<string, string>();
  const anyDay = new Set<string>();
  const fetched = await marksFetchedBy(days.map((d) => expiryCodeOf(d.day)));
  for (const d of days) {
    const { from, to } = sessionOf(d.day);
    const raw = await rawDay(d.day, o.now, fetched.get(expiryCodeOf(d.day))?.contracts ?? 0);
    const upTo = raw.signals.filter((s) => s.filledAt <= until);
    for (const s of upTo) { anyDay.add(keyOf(s)); dayOfKey.set(keyOf(s), d.day); }
    const bars = raw.minutes.filter((b) => b.at >= from);
    for (const a of o.accounts) {
      const mine = a.strategies.filter(backtestable);
      if (!mine.length) continue;
      const books = mine.map((st) => {
        const rule = st.config.signal!;
        const takes = (sig: BtSignal) => sig.mode === rule.mode && (rule.mode !== 'single' || (ruleTfs(rule) as string[]).includes(sig.tf)) && rule.methods.includes(sig.method);
        return { signals: upTo.filter(takes), plan: planOfStrategy(st, { from, to }, null) };
      });
      // As the desk holds them: the strategies of one account for the same places, under that account's limit.
      const outs = simulateTogether({ from, to, bars, board: raw.board, books, shared: a.caps ? deskCapsOf(a.caps) : null });
      mine.forEach((st, i) => {
        const side = bt.get(st.id)!;
        for (const s of books[i]!.signals) side.known.set(keyOf(s), s);
        for (const t of outs[i]!.trades) side.traded.set(keyOf(t.signal), t.signal);
        for (const r of outs[i]!.refused) side.refused.set(keyOf(r.signal), r.why);
      });
    }
  }

  const groups = (xs: { why: string; sig: { at: number; method: string; tf: string; dir: 1 | -1 } }[]): LiveCheckWhy[] => {
    const m = new Map<string, LiveCheckWhy>();
    for (const x of xs) {
      const g = m.get(x.why) ?? m.set(x.why, { why: x.why, n: 0, first: [] }).get(x.why)!;
      g.n++;
      if (g.first.length < 3) g.first.push(x.sig);
    }
    return [...m.values()].sort((a, b) => b.n - a.n || a.why.localeCompare(b.why));
  };
  const partsOf = (key: string, at: number) => { const p = key.split('|'); return { at, method: p[0] ?? '', tf: p[1] === 'mtf' ? CHAIN_KEY : p[2] ?? '', dir: (Number(p[3]) === 1 ? 1 : -1) as 1 | -1 }; };
  const byDay = new Map<string, { day: string; placed: number; backtest: number; same: number }>(days.map((d) => [d.day, { day: d.day, placed: 0, backtest: 0, same: 0 }]));
  const strategies: LiveCheckRow[] = every.map(({ st, account }) => {
    const mine = liveBy.get(st.id) ?? new Map<string, Live>();
    const side = bt.get(st.id)!;
    const placed = [...mine.values()].filter((r) => r.status === 'placed');
    let same = 0;
    const liveOnly: Parameters<typeof groups>[0] = [];
    for (const r of placed) {
      const day = dayOfKey.get(r.signal_key);
      if (day) byDay.get(day)!.placed++;
      if (side.traded.has(r.signal_key)) { same++; if (day) byDay.get(day)!.same++; continue; }
      const why = side.refused.get(r.signal_key);
      liveOnly.push({
        sig: partsOf(r.signal_key, Number(r.at)),
        why: why ? `the backtest would not: ${BT_WHY[why]}`
          : anyDay.has(r.signal_key) ? 'its method or time frame is not in the strategy\'s rules now'
            : 'no filled setup is on record for that signal in these days',
      });
    }
    const backtestOnly: Parameters<typeof groups>[0] = [];
    for (const [key, sig] of side.traded) {
      const day = dayOfKey.get(key);
      if (day) byDay.get(day)!.backtest++;
      const r = mine.get(key);
      if (r?.status === 'placed') continue;
      backtestOnly.push({
        sig: { at: sig.filledAt, method: sig.method, tf: sig.mode === 'mtf' ? CHAIN_KEY : sig.tf, dir: sig.dir },
        why: r ? liveReason(r.status, r.detail) : 'no record on the desk: it or the strategy was not running then, or its rules were different',
      });
    }
    return {
      id: st.id, name: st.name, account: account.name,
      live: { placed: placed.length, refused: [...mine.values()].filter((r) => r.status === 'refused').length, skipped: [...mine.values()].filter((r) => r.status === 'skipped').length },
      backtest: side.traded.size, same, backtestOnly: groups(backtestOnly), liveOnly: groups(liveOnly),
    };
  }).sort((a, b) => (a.account ?? '').localeCompare(b.account ?? '') || a.name.localeCompare(b.name, 'en', { numeric: true }));
  const sum = (f: (r: LiveCheckRow) => number) => strategies.reduce((n, r) => n + f(r), 0);
  return {
    from: o.from, to: o.to, until,
    liveFrom: live.length ? Number(live[0]!.at) : null, liveTo: live.length ? Number(live[live.length - 1]!.at) : null,
    strategies,
    total: {
      placed: sum((r) => r.live.placed), refused: sum((r) => r.live.refused), skipped: sum((r) => r.live.skipped), backtest: sum((r) => r.backtest), same: sum((r) => r.same),
      backtestOnly: sum((r) => r.backtestOnly.reduce((n, g) => n + g.n, 0)), liveOnly: sum((r) => r.liveOnly.reduce((n, g) => n + g.n, 0)),
    },
    days: [...byDay.values()],
  };
}
