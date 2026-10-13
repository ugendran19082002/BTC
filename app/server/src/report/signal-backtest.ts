import { rows } from '../db/pool.js';
import { flowSchema } from '../market/flow.js';
import { optionSnapshotsSchema } from '../market/option-snapshots.js';
import { entrySchema } from '../entry/paper.js';
import { methodsSchema } from '../entry/catalogue.js';
import { fillChargesUsd } from '../trading/charges.js';
import { fundsRequiredPerContract } from '../trading/margin.js';
import { CHAIN_KEY } from '../trading/pnl-history.js';
import { FAMILIES, PATTERNS, candles, familyOf, sessionOf, type MinuteBar, type PatternKey } from './market-day.js';
import { marketDays, marketReport, type Tot } from './market-report.js';
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
 *   the option      the whole board every five minutes (`option_snapshots`): the one-minute board is kept for six
 *                   hours only. Sold at the BID of the reading nearest the fill, bought back at the OFFER of the
 *                   first reading at or after the exit -- so an exit is priced up to five minutes late, and the
 *                   option's own target and stop are seen only at a reading.
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
/** An option is not sold for less than this, as the strategies' own floor. */
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
};
export type BoardRow = { at: number; cp: 'C' | 'P'; strike: number; spot: number | null; bid: number | null; ask: number | null; mark: number | null; delta: number | null; oi?: number | null };
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
export function pickStrike(board: readonly BoardRow[], cp: 'C' | 'P', p: Pick<BacktestParams, 'rule' | 'value'>): BoardRow | null {
  const otm = board.filter((r) => r.cp === cp && r.spot !== null && (cp === 'P' ? r.strike < r.spot : r.strike > r.spot)
    && r.bid !== null && r.bid >= MIN_PREMIUM && r.ask !== null && r.ask > 0);
  if (p.rule === 'delta') {
    // The nearest to the money whose delta is still inside the limit.
    const ok = otm.filter((r) => r.delta !== null && Math.abs(r.delta) <= p.value + 1e-9);
    return ok.sort((a, b) => Math.abs(b.delta!) - Math.abs(a.delta!))[0] ?? null;
  }
  // The dearest that is still at or under the price.
  return otm.filter((r) => r.bid! <= p.value + 1e-9).sort((a, b) => b.bid! - a.bid!)[0] ?? null;
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
    ...(p.targetSteps?.length ? {
      targetPctAt: (at: number) => exitValueAt({ mode: 'pct', value: p.targetPct, steps: p.targetSteps!.map((x) => ({ at: x.at, value: x.pct })) }, DAY_START_IST, istMinutes(at)).value,
    } : {}),
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

/**
 * One expiry day: every signal filled in it, traded on its board. `from`/`to` are the day's span; `bars` its perp
 * minutes; `board` every reading of the contract that settles at `to`, oldest first. The signals are taken in the
 * order they filled, which is what "at most N open" is counted in.
 */
export function simulateDay(o: {
  from: number; to: number; signals: readonly BtSignal[]; bars: readonly MinuteBar[]; board: readonly BoardRow[]; params?: BacktestParams; plan?: DayPlan;
  /** The volatility at a moment (`volReader`), and the one level to keep where the filter is on. */
  volAt?: (at: number) => VolLevel | null; volOnly?: VolLevel | null;
}): { trades: BtTrade[]; skipped: Record<BtSkip, number> } {
  const { from, to } = o;
  const plan = o.plan ?? planOfParams(o.params ?? DEFAULT_PARAMS, { from, to });
  const skipped = noSkips();
  const trades: BtTrade[] = [];
  // The board by reading, and each contract's readings in order.
  const times: number[] = [];
  const byTime = new Map<number, BoardRow[]>();
  const bySymbol = new Map<string, BoardRow[]>();
  for (const r of o.board) {
    let at = byTime.get(r.at);
    if (!at) { at = []; byTime.set(r.at, at); times.push(r.at); }
    at.push(r);
    const key = `${r.cp}${r.strike}`;
    const s = bySymbol.get(key);
    if (s) s.push(r); else bySymbol.set(key, [r]);
  }
  const lastBar = o.bars[o.bars.length - 1];
  /** When each trade still open ends, and its side: what "at most N open" and each side's limit count. */
  let open: { until: number; side: 'CE' | 'PE' }[] = [];
  const desk = plan.desk ?? null;

  for (const sig of [...o.signals].sort(signalOrder)) {
    const t0 = sig.filledAt;
    const refused = plan.refuses(sig);
    if (refused) { skipped[refused]++; continue; }
    const vol = o.volAt ? o.volAt(t0) : null;
    // A signal whose volatility cannot be said is not one of the level asked for.
    if (o.volOnly && vol !== o.volOnly) { skipped.volatility++; continue; }
    open = open.filter((x) => x.until > t0);
    // In the runner's order: its own limit, then the desk's, then the side's (strategy/runner.ts `takeSignal`).
    if (plan.maxOpen !== null && open.length >= plan.maxOpen) { skipped['at-limit']++; continue; }
    if (desk && open.length >= desk.max) { skipped['desk-limit']++; continue; }
    const side: 'CE' | 'PE' = sig.dir === 1 ? 'PE' : 'CE';
    if (desk?.side && open.filter((x) => x.side === side).length >= desk.side[side]) { skipped['side-limit']++; continue; }
    // The reading nearest the fill.
    let near = -1;
    for (let i = 0; i < times.length; i++) if (near === -1 || Math.abs(times[i]! - t0) < Math.abs(times[near]! - t0)) near = i;
    if (near === -1 || Math.abs(times[near]! - t0) > BOARD_NEAR_MS) { skipped['no-board']++; continue; }
    const cp = sig.dir === 1 ? 'P' as const : 'C' as const;
    const picked = plan.pick(byTime.get(times[near]!)!, cp, times[near]!);
    if (!picked) { skipped['no-strike']++; continue; }
    const pick = picked.row, lots = picked.lots;
    const entry = pick.bid!, entryAt = times[near]!;
    const target = plan.targetOf(sig);

    // The perp: the first minute after the fill's own that holds the stop or the target; both in one bar is the stop.
    let perpAt = to - MIN, perpBy: 'perp-tgt' | 'perp-sl' | 'window-end' = 'window-end', perpPx = lastBar?.close ?? sig.fillPrice;
    const fillMinute = Math.floor(t0 / MIN) * MIN;
    for (const b of o.bars) {
      if (b.at <= fillMinute) continue;
      const stop = sig.dir === 1 ? b.low <= sig.stop : b.high >= sig.stop;
      const tgt = sig.dir === 1 ? b.high >= target : b.low <= target;
      if (stop || tgt) { perpAt = b.at + MIN; perpBy = stop ? 'perp-sl' : 'perp-tgt'; perpPx = stop ? sig.stop : target; break; }
    }

    // The option's own readings between: its target (a resting buy, filled at its price) and its stop (bought at the offer).
    const series = bySymbol.get(`${cp}${pick.strike}`) ?? [];
    // The option's own levels at a moment: fixed all day, or by the clock where the plan has steps.
    const tgtLevel = (at: number) => { const pc = plan.targetPctAt ? plan.targetPctAt(at) : plan.targetPct; return pc > 0 ? entry * (1 - pc) : null; };
    const stopLevel = (at: number) => { const pc = plan.stopPctAt ? plan.stopPctAt(at) : plan.stopPct; return pc > 0 ? entry * (1 + pc) : null; };
    let restingAt = tgtLevel(entryAt);
    let exit: number | null = null, exitAt = perpAt, by: BtExit = perpBy;
    for (const r of series) {
      if (r.at <= entryAt) continue;
      if (r.at >= perpAt) {
        // The first reading at or after the perp's exit: what buying back costs then.
        exit = r.ask !== null && r.ask > 0 ? r.ask : r.mark !== null && r.mark > 0 ? r.mark : null;
        break;
      }
      if (r.ask === null || !(r.ask > 0)) continue;
      // Prices are on a tick and the levels are products of shares: a level reached exactly must not be missed by a rounding.
      const tgtAt = tgtLevel(r.at), stopAt = stopLevel(r.at);
      if (tgtAt !== null && r.ask <= tgtAt + 1e-9) {
        // A resting buy fills at its own price as the offer comes down to it. One just moved UP over the offer by a
        // time step (a lower share kept) is a buy placed through the market: it fills at the offer.
        exit = restingAt !== null && tgtAt > restingAt + 1e-9 ? Math.min(tgtAt, r.ask) : tgtAt;
        exitAt = r.at; by = 'option-tgt'; break;
      }
      restingAt = tgtAt;
      if (stopAt !== null && r.ask >= stopAt - 1e-9) { exit = r.ask; exitAt = r.at; by = 'option-sl'; break; }
    }
    if (exit === null) {
      // No reading at or after the exit -- held to the end, or out in the day's last minutes: the last reading the contract has.
      const last = series[series.length - 1];
      exit = last && last.at > entryAt ? (last.ask !== null && last.ask > 0 ? last.ask : last.mark) : null;
    }
    if (exit === null || !(exit >= 0)) { skipped['no-exit-price']++; continue; }

    const charges = fillChargesUsd({ price: entry, contracts: lots, contractValue: CONTRACT_VALUE, spot: pick.spot }).totalUsd
      + fillChargesUsd({ price: exit, contracts: lots, contractValue: CONTRACT_VALUE, spot: pick.spot }).totalUsd;
    open.push({ until: exitAt, side: cp === 'P' ? 'PE' : 'CE' });
    trades.push({
      signal: sig, cp, strike: pick.strike, lots, entryAt, entry, exitAt, exit, by,
      netUsd: (entry - exit) * lots * CONTRACT_VALUE - charges, chargesUsd: charges, vol,
      marginUsd: fundsRequiredPerContract({ spot: pick.spot ?? sig.fillPrice, premium: entry, leverage: 200, contractValue: CONTRACT_VALUE }) * lots,
      perpPts: (perpPx - sig.fillPrice) * sig.dir,
    });
  }
  return { trades, skipped };
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
type Span = { at: number; until: number; margin: number; tf: string; method: string };
type HeldDay = { at: number; cells: BtCell[]; skipped: Record<BtSkip, number>; signals: number; spans: Span[] };
const held = new Map<string, HeldDay>();
export function clearSignalBacktestCache(): void { held.clear(); }
/** The SL or the TGT outside the range asked for: nearer than a minimum, or further than a maximum. 0 is no bound. */
function outOfRange(sig: BtSignal, target: number, p: Pick<BacktestParams, 'slMin' | 'slMax' | 'tgtMin' | 'tgtMax'>): boolean {
  const sl = Math.abs(sig.fillPrice - sig.stop), tgt = Math.abs(sig.fillPrice - target);
  const lo = (v: number, min = 0) => min > 0 && v < min, hi = (v: number, max = 0) => max > 0 && v > max;
  return lo(sl, p.slMin) || hi(sl, p.slMax) || lo(tgt, p.tgtMin) || hi(tgt, p.tgtMax);
}
const paramsKey = (p: BacktestParams) => `${p.rule}|${p.value}|${p.lots}|${p.targetPct}|${p.stopPct}|${p.window}${p.window === 'custom' ? `:${p.hoursFrom}-${p.hoursTo}` : ''}|${p.deskMax ?? 0}|${p.cePct ?? 100}|${p.pePct ?? 100}|${p.slMin ?? 0}-${p.slMax ?? 0}-${p.tgtMin ?? 0}-${p.tgtMax ?? 0}|${(p.targetSteps ?? []).map((x) => `${x.at}=${x.pct}`).join(',')}|vol:${p.vol ?? 'off'}`;
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

/** One day under one set of rules. `takes` narrows the signals to those the rules are about at all (a strategy's methods and timeframes). */
async function dayOf(day: string, key: string, now: number, planFor: (span: { from: number; to: number }) => DayPlan, takes: (sig: BtSignal) => boolean, vol: { only: VolLevel | null; baseline: number | null }): Promise<HeldDay> {
  const id = `${day}|${key}`;
  const h = held.get(id);
  const { from, to } = sessionOf(day);
  if (h && (h.at >= to + SETTLED_MS || now - h.at < FRESH_MS)) return h;
  const [sig, bars, board] = await Promise.all([
    rows<Record<string, string | number | null>>(
      `SELECT method, mode, tf, dir, filled_at, fill_price, stop, tp1, tp2, tp3 FROM entry_setups
        WHERE filled_at IS NOT NULL AND filled_at >= $1 AND filled_at < $2 AND first_seen >= $3 AND fill_price IS NOT NULL
        ORDER BY filled_at`, [Math.floor(from / 1_000), Math.floor(to / 1_000), from - 5 * 86_400_000]),
    rows<{ at: string; high: number; low: number; vwap: number }>(
      // From two hours before the day: the volatility at its first signals is read from the candles behind them.
      'SELECT at, high, low, vwap FROM trade_flow_1m WHERE at >= $1 AND at < $2 AND high IS NOT NULL AND low IS NOT NULL AND vwap IS NOT NULL ORDER BY at', [from - VOL_CANDLES * 900_000, to]),
    rows<{ at: string; cp: 'C' | 'P'; strike: number; spot: number | null; bid: number | null; ask: number | null; mark: number | null; delta: number | null; oi: number | null }>(
      'SELECT at, cp, strike, spot, bid, ask, mark, delta, oi FROM option_snapshots WHERE expiry = $1 AND at >= $2 AND at <= $3 ORDER BY at', [expiryCodeOf(day), from - BOARD_NEAR_MS, to]),
  ]);
  const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
  const signals: BtSignal[] = sig.map((x): BtSignal => ({
    method: String(x.method), mode: x.mode === 'mtf' ? 'mtf' : 'single', tf: String(x.tf), dir: Number(x.dir) === 1 ? 1 : -1,
    filledAt: Number(x.filled_at) * 1_000, fillPrice: Number(x.fill_price), stop: Number(x.stop), target: Number(x.tp1), tp2: num(x.tp2), tp3: num(x.tp3),
  })).filter(takes);
  const minutes: MinuteBar[] = bars.map((b) => ({ at: Number(b.at), high: Number(b.high), low: Number(b.low), close: Number(b.vwap) }));
  const r = simulateDay({
    from, to, signals, plan: planFor({ from, to }),
    volAt: volReader(minutes, vol.baseline), volOnly: vol.only,
    bars: minutes.filter((b) => b.at >= from),
    board: board.map((b) => ({ at: Number(b.at), cp: b.cp, strike: Number(b.strike), spot: num(b.spot), bid: num(b.bid), ask: num(b.ask), mark: num(b.mark), delta: num(b.delta), oi: num(b.oi) })),
  });
  const out: HeldDay = {
    at: now, cells: cellsOf(day, r.trades), skipped: r.skipped, signals: signals.length,
    spans: r.trades.map((t) => ({ at: t.signal.filledAt, until: t.exitAt, margin: t.marginUsd, tf: t.signal.mode === 'mtf' ? CHAIN_KEY : t.signal.tf, method: t.signal.method })),
  };
  held.set(id, out);
  return out;
}

/**
 * The most margin open at once over a day's trades, and when: a sweep over their times. A trade ending at the moment
 * another starts has made room for it -- as "at most N open" counts (`until > at`).
 */
export function peakMargin(spans: readonly { at: number; until: number; margin: number }[]): { usd: number; at: number | null; open: number } {
  const ev: [number, number, number][] = [];
  for (const x of spans) { ev.push([x.at, 1, x.margin]); ev.push([x.until, 0, -x.margin]); }
  ev.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let usd = 0, open = 0, best = { usd: 0, at: null as number | null, open: 0 };
  for (const [at, kind, m] of ev) {
    usd += m; open += kind === 1 ? 1 : -1;
    if (usd > best.usd + 1e-9) best = { usd, at, open };
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
  margin: { peakUsd: number; peakDay: string | null; peakAt: number | null; peakOpen: number; avgDailyPeakUsd: number; avgTradeUsd: number };
  /** Signals in the trade in the range, how many were traded, and why the rest were not. */
  signals: number; skipped: Record<BtSkip, number>;
  total: BtTot;
  days: (BtTot & { day: string; pattern: PatternKey | null; live: boolean })[];
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
type Ask = { from: string; to: string; now: number; params: BacktestParams; tfs: readonly string[] | null; methods: readonly string[] | null; strategy?: Strategy | null; spot?: number | null };

/** A strategy the backtest can be asked about: one that trades signals by selling. */
export const backtestable = (s: Strategy): boolean => s.config.trigger === 'signal' && !!s.config.signal && actionOf(s.config.signal) === 'sell';

export function signalBacktest(o: Ask): Promise<SignalBacktest> {
  const run = working.then(() => signalBacktestNow(o));
  working = run.catch(() => { });
  return run;
}

async function signalBacktestNow(o: Ask): Promise<SignalBacktest> {
  await Promise.all([flowSchema(), optionSnapshotsSchema(), entrySchema(), methodsSchema()]);
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
  const spansByDay = new Map<string, Span[]>();
  /*
   * With a limit on what is open, which signals are traded at all decides who gets a place: the time frame and
   * method filters then choose the signals before the day is played, not the rows after it. Without one, every
   * signal is traded and the filters only choose what is shown -- one run serves every choice.
   */
  const chosen = (sig: BtSignal) => (!o.tfs || o.tfs.includes(sig.mode === 'mtf' ? CHAIN_KEY : sig.tf)) && (!o.methods || o.methods.includes(sig.method));
  const takes = (sig: BtSignal) => ownOnly(sig) && (caps === null || chosen(sig));
  const filterKey = caps === null ? '' : `|tf:${(o.tfs ?? []).join(',')}|m:${(o.methods ?? []).join(',')}`;
  const key = (st ? `${strategyKey(st)}|${o.params.deskMax ?? 0}|${o.params.cePct ?? 100}|${o.params.pePct ?? 100}|vol:${volOnly}` : paramsKey(o.params)) + filterKey;
  for (const d of days) {
    const h = await dayOf(d.day, key, o.now, (span) => (st ? planOfStrategy(st, span, caps) : planOfParams(o.params, span)), takes, { only: volOnly, baseline: baselineOf(d.day) });
    signals += h.signals;
    for (const k of BT_SKIPS) skipped[k] += h.skipped[k];
    every.push(...h.cells);
    spansByDay.set(d.day, h.spans);
  }
  // The method list's own figures: what each method makes when it is not competing for a place -- the run with no desk limit.
  const listCells: BtCell[] = [];
  if (caps !== null) {
    const free = { ...o.params, deskMax: 0 };
    for (const d of days) {
      const h = await dayOf(d.day, st ? `${strategyKey(st)}|vol:${volOnly}` : paramsKey(free), o.now, (span) => (st ? planOfStrategy(st, span, null) : planOfParams(free, span)), ownOnly, { only: volOnly, baseline: baselineOf(d.day) });
      listCells.push(...h.cells);
    }
  } else listCells.push(...every);
  const exits = st ? exitRules(st.config) : null;
  const params: BacktestParams = st && exits
    ? {
      rule: st.config.strikeRule === 'delta' ? 'delta' : 'premium', value: st.config.strikeRule === 'delta' ? (st.config.delta?.max ?? 0) : (st.config.premium?.usd ?? 0), lots: st.config.lots,
      targetPct: exits.target.mode === 'pct' ? exits.target.value : 0, stopPct: exits.stop.mode === 'pct' ? exits.stop.value : 0, window: 'desk',
      deskMax: o.params.deskMax ?? 0, cePct: o.params.cePct ?? 100, pePct: o.params.pePct ?? 100
    }
    : o.params;
  const real = st
    ? (await marketReport({ from: o.from, to: o.to, now: o.now, spot: o.spot ?? null, account: st.accountId ?? null, tfs: null, methods: null, strategies: [st.name] })).total.real
    : null;
  const cells = every.filter((c) => (!o.tfs || o.tfs.includes(tfKeyOf(c))) && (!o.methods || o.methods.includes(c.method)));
  // The margin of the trades shown: the same filters as the rows.
  let peak = { usd: 0, at: null as number | null, open: 0, day: null as string | null };
  let daily = 0, dailyN = 0, tradeMargin = 0, tradeN = 0;
  for (const [day, all] of spansByDay) {
    const shown = all.filter((x) => (!o.tfs || o.tfs.includes(x.tf)) && (!o.methods || o.methods.includes(x.method)));
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
    margin: { peakUsd: peak.usd, peakDay: peak.day, peakAt: peak.at, peakOpen: peak.open, avgDailyPeakUsd: dailyN ? daily / dailyN : 0, avgTradeUsd: tradeN ? tradeMargin / tradeN : 0 },
    strategy: st ? { id: st.id, name: st.name, accountId: st.accountId ?? null, caveats: strategyCaveats(st), real: real! } : null,
    total: cells.reduce((t, c) => addBt(t, c.tot), zeroBt()),
    days: days.map((d) => ({ ...cells.filter((c) => c.day === d.day).reduce((t, c) => addBt(t, c.tot), zeroBt()), day: d.day, pattern: d.pattern, live: d.live })),
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
