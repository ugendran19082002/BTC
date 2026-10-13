import { rows } from '../db/pool.js';
import { flowSchema } from '../market/flow.js';
import { optionSnapshotsSchema } from '../market/option-snapshots.js';
import { entrySchema } from '../entry/paper.js';
import { methodsSchema } from '../entry/catalogue.js';
import { fillChargesUsd } from '../trading/charges.js';
import { CHAIN_KEY } from '../trading/pnl-history.js';
import { FAMILIES, PATTERNS, familyOf, sessionOf, type MinuteBar, type PatternKey } from './market-day.js';
import { marketDays, marketReport, type Tot } from './market-report.js';
import { selectLegs, type Candidate } from '../strategy/select.js';
import { istMinutes, istWeekday } from '../strategy/schedule.js';
import {
  actionOf, exitRules, maxSlPtsFor, maxTgtPtsFor, minSlPtsFor, minTgtPtsFor, minutesForward, minutesOf, noEntryWindowAt, ruleTfs, strikePickAt,
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
  window: 'desk' | 'all';
};
export const DEFAULT_PARAMS: BacktestParams = { rule: 'delta', value: 0.1, lots: 10, targetPct: 0.9, stopPct: 3, window: 'desk' };
/** An option is not sold for less than this, as the strategies' own floor. */
export const MIN_PREMIUM = 10;
const CONTRACT_VALUE = 0.001;
const MIN = 60_000;
/** The board reading a fill is priced on is at most this far from it. */
const BOARD_NEAR_MS = 5 * MIN;

export type BtExit = 'perp-tgt' | 'perp-sl' | 'option-tgt' | 'option-sl' | 'window-end';
export const BT_EXITS: readonly BtExit[] = ['perp-tgt', 'perp-sl', 'option-tgt', 'option-sl', 'window-end'];
export type BtSkip = 'outside-window' | 'no-entry-window' | 'distance' | 'at-limit' | 'no-board' | 'no-strike' | 'no-exit-price';
export const BT_SKIPS: readonly BtSkip[] = ['outside-window', 'no-entry-window', 'distance', 'at-limit', 'no-board', 'no-strike', 'no-exit-price'];
const noSkips = (): Record<BtSkip, number> => ({ 'outside-window': 0, 'no-entry-window': 0, distance: 0, 'at-limit': 0, 'no-board': 0, 'no-strike': 0, 'no-exit-price': 0 });

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
  /** At most this many open at once; null, any number. */
  maxOpen: number | null;
};

/** The screen's own settings as a plan: every signal in the hours chosen, one strike rule, a fixed number of lots, no limit. */
export function planOfParams(p: BacktestParams, span: { from: number; to: number }): DayPlan {
  // The strategies' own hours: from 9:30 PM IST (four hours into the expiry day) to 3:59 PM (91 minutes before it ends).
  const opens = p.window === 'desk' ? span.from + 4 * 60 * MIN : span.from;
  const closes = p.window === 'desk' ? span.to - 91 * MIN : span.to - 5 * MIN;
  return {
    refuses: (sig) => (sig.filledAt < opens || sig.filledAt >= closes ? 'outside-window' : null),
    pick: (board, cp) => { const row = pickStrike(board, cp, p); return row ? { row, lots: p.lots } : null; },
    targetOf: (sig) => sig.target,
    targetPct: p.targetPct, stopPct: p.stopPct, maxOpen: null,
  };
}

/** What of a strategy the backtest cannot replay, in words: said beside its result. */
export function strategyCaveats(s: Strategy): string[] {
  const c = s.config, x = exitRules(c);
  const out: string[] = [];
  if (x.target.steps.length || x.stop.steps.length) out.push('Its timed target and stop steps are not replayed: the starting target and stop are used all day.');
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
export function planOfStrategy(s: Strategy, span: { from: number; to: number }): DayPlan {
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
    maxOpen: rule.maxOpen > 0 ? rule.maxOpen : null,
  };
}

/**
 * One expiry day: every signal filled in it, traded on its board. `from`/`to` are the day's span; `bars` its perp
 * minutes; `board` every reading of the contract that settles at `to`, oldest first. The signals are taken in the
 * order they filled, which is what "at most N open" is counted in.
 */
export function simulateDay(o: { from: number; to: number; signals: readonly BtSignal[]; bars: readonly MinuteBar[]; board: readonly BoardRow[]; params?: BacktestParams; plan?: DayPlan }): { trades: BtTrade[]; skipped: Record<BtSkip, number> } {
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
  /** When each trade still open ends: what "at most N open" counts. */
  let openUntil: number[] = [];

  for (const sig of [...o.signals].sort((a, b) => a.filledAt - b.filledAt)) {
    const t0 = sig.filledAt;
    const refused = plan.refuses(sig);
    if (refused) { skipped[refused]++; continue; }
    if (plan.maxOpen !== null) {
      openUntil = openUntil.filter((at) => at > t0);
      if (openUntil.length >= plan.maxOpen) { skipped['at-limit']++; continue; }
    }
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
    const tgtAt = plan.targetPct > 0 ? entry * (1 - plan.targetPct) : null;
    const stopAt = plan.stopPct > 0 ? entry * (1 + plan.stopPct) : null;
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
      if (tgtAt !== null && r.ask <= tgtAt + 1e-9) { exit = tgtAt; exitAt = r.at; by = 'option-tgt'; break; }
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
    openUntil.push(exitAt);
    trades.push({
      signal: sig, cp, strike: pick.strike, lots, entryAt, entry, exitAt, exit, by,
      netUsd: (entry - exit) * lots * CONTRACT_VALUE - charges,
      perpPts: (perpPx - sig.fillPrice) * sig.dir,
    });
  }
  return { trades, skipped };
}

// ------------------------------------------------------------------ adding up

/** A count of backtested trades: money after charges, the same trades' perp points, and each exit with how many of its trades made money. */
export type BtTot = {
  n: number; wins: number; losses: number; net: number; won: number; lost: number; perpPts: number;
  exits: Partial<Record<BtExit, { n: number; wins: number; net: number }>>;
};
export const zeroBt = (): BtTot => ({ n: 0, wins: 0, losses: 0, net: 0, won: 0, lost: 0, perpPts: 0, exits: {} });
function addBt(a: BtTot, b: BtTot): BtTot {
  a.n += b.n; a.wins += b.wins; a.losses += b.losses; a.net += b.net; a.won += b.won; a.lost += b.lost; a.perpPts += b.perpPts;
  for (const k of BT_EXITS) {
    const x = b.exits[k];
    if (!x) continue;
    const mine = a.exits[k] ?? (a.exits[k] = { n: 0, wins: 0, net: 0 });
    mine.n += x.n; mine.wins += x.wins; mine.net += x.net;
  }
  return a;
}
type BtCell = { day: string; method: string; mode: 'single' | 'mtf'; tf: string; tot: BtTot };

function cellsOf(day: string, trades: readonly BtTrade[]): BtCell[] {
  const by = new Map<string, BtCell>();
  for (const t of trades) {
    const s = t.signal;
    const key = `${s.method}|${s.mode}|${s.tf}`;
    const cell = by.get(key) ?? { day, method: s.method, mode: s.mode, tf: s.tf, tot: zeroBt() };
    by.set(key, cell);
    const x = cell.tot, win = t.netUsd > 0;
    x.n++; x.net += t.netUsd; x.perpPts += t.perpPts;
    if (win) { x.wins++; x.won += t.netUsd; } else { x.losses++; x.lost -= t.netUsd; }
    const e = x.exits[t.by] ?? (x.exits[t.by] = { n: 0, wins: 0, net: 0 });
    e.n++; e.net += t.netUsd; if (win) e.wins++;
  }
  return [...by.values()];
}

type HeldDay = { at: number; cells: BtCell[]; skipped: Record<BtSkip, number>; signals: number };
const held = new Map<string, HeldDay>();
export function clearSignalBacktestCache(): void { held.clear(); }
const paramsKey = (p: BacktestParams) => `${p.rule}|${p.value}|${p.lots}|${p.targetPct}|${p.stopPct}|${p.window}`;
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
async function dayOf(day: string, key: string, now: number, planFor: (span: { from: number; to: number }) => DayPlan, takes: (sig: BtSignal) => boolean): Promise<HeldDay> {
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
      'SELECT at, high, low, vwap FROM trade_flow_1m WHERE at >= $1 AND at < $2 AND high IS NOT NULL AND low IS NOT NULL AND vwap IS NOT NULL ORDER BY at', [from, to]),
    rows<{ at: string; cp: 'C' | 'P'; strike: number; spot: number | null; bid: number | null; ask: number | null; mark: number | null; delta: number | null; oi: number | null }>(
      'SELECT at, cp, strike, spot, bid, ask, mark, delta, oi FROM option_snapshots WHERE expiry = $1 AND at >= $2 AND at <= $3 ORDER BY at', [expiryCodeOf(day), from - BOARD_NEAR_MS, to]),
  ]);
  const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
  const signals: BtSignal[] = sig.map((x): BtSignal => ({
    method: String(x.method), mode: x.mode === 'mtf' ? 'mtf' : 'single', tf: String(x.tf), dir: Number(x.dir) === 1 ? 1 : -1,
    filledAt: Number(x.filled_at) * 1_000, fillPrice: Number(x.fill_price), stop: Number(x.stop), target: Number(x.tp1), tp2: num(x.tp2), tp3: num(x.tp3),
  })).filter(takes);
  const r = simulateDay({
    from, to, signals, plan: planFor({ from, to }),
    bars: bars.map((b) => ({ at: Number(b.at), high: Number(b.high), low: Number(b.low), close: Number(b.vwap) })),
    board: board.map((b) => ({ at: Number(b.at), cp: b.cp, strike: Number(b.strike), spot: num(b.spot), bid: num(b.bid), ask: num(b.ask), mark: num(b.mark), delta: num(b.delta), oi: num(b.oi) })),
  });
  const out: HeldDay = { at: now, cells: cellsOf(day, r.trades), skipped: r.skipped, signals: signals.length };
  held.set(id, out);
  return out;
}

export type BtRow = BtTot & { key: string; name: string; tf?: string; days?: number };
export type SignalBacktest = {
  from: string; to: string;
  /** The screen's own settings; with a strategy chosen, what its rules come to where they are one number, for the line that says them. */
  params: BacktestParams;
  /** The strategy backtested, with what of it could not be replayed and what its real orders made in the range. Null: the screen's own settings. */
  strategy: { id: string; name: string; accountId: number | null; caveats: string[]; real: Tot } | null;
  /** Signals in the trade in the range, how many were traded, and why the rest were not. */
  signals: number; skipped: Record<BtSkip, number>;
  total: BtTot;
  days: (BtTot & { day: string; pattern: PatternKey | null; live: boolean })[];
  pairs: BtRow[]; byTf: BtRow[]; byMethod: BtRow[]; byPattern: BtRow[]; byFamily: BtRow[];
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
  working = run.catch(() => {});
  return run;
}

async function signalBacktestNow(o: Ask): Promise<SignalBacktest> {
  await Promise.all([flowSchema(), optionSnapshotsSchema(), entrySchema(), methodsSchema()]);
  const days = await marketDays(o.from, o.to, o.now);
  const names = new Map((await rows<{ id: string; n: number | null; name: string }>('SELECT id, n, name FROM entry_methods')).map((m) => [m.id, m.n === null ? m.name : `#${m.n} ${m.name}`]));
  const nameOf = (id: string) => names.get(id) ?? id;
  const skipped = noSkips();
  let signals = 0;
  const every: BtCell[] = [];
  const st = o.strategy ?? null;
  const rule = st?.config.signal ?? null;
  // A strategy is only ever asked about its own signals: its way of reading, its timeframes, its methods.
  const takes = (sig: BtSignal) => !rule || (sig.mode === rule.mode && (rule.mode !== 'single' || (ruleTfs(rule) as string[]).includes(sig.tf)) && rule.methods.includes(sig.method));
  for (const d of days) {
    const h = await dayOf(d.day, st ? strategyKey(st) : paramsKey(o.params), o.now, (span) => (st ? planOfStrategy(st, span) : planOfParams(o.params, span)), takes);
    signals += h.signals;
    for (const k of BT_SKIPS) skipped[k] += h.skipped[k];
    every.push(...h.cells);
  }
  const exits = st ? exitRules(st.config) : null;
  const params: BacktestParams = st && exits
    ? { rule: st.config.strikeRule === 'delta' ? 'delta' : 'premium', value: st.config.strikeRule === 'delta' ? (st.config.delta?.max ?? 0) : (st.config.premium?.usd ?? 0), lots: st.config.lots,
        targetPct: exits.target.mode === 'pct' ? exits.target.value : 0, stopPct: exits.stop.mode === 'pct' ? exits.stop.value : 0, window: 'desk' }
    : o.params;
  const real = st
    ? (await marketReport({ from: o.from, to: o.to, now: o.now, spot: o.spot ?? null, account: st.accountId ?? null, tfs: null, methods: null, strategies: [st.name] })).total.real
    : null;
  const cells = every.filter((c) => (!o.tfs || o.tfs.includes(tfKeyOf(c))) && (!o.methods || o.methods.includes(c.method)));
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
    strategy: st ? { id: st.id, name: st.name, accountId: st.accountId ?? null, caveats: strategyCaveats(st), real: real! } : null,
    total: cells.reduce((t, c) => addBt(t, c.tot), zeroBt()),
    days: days.map((d) => ({ ...cells.filter((c) => c.day === d.day).reduce((t, c) => addBt(t, c.tot), zeroBt()), day: d.day, pattern: d.pattern, live: d.live })),
    pairs: group((c) => `${c.method}|${c.mode}|${c.tf}`, (c) => ({ name: nameOf(c.method), tf: c.mode === 'mtf' ? `${c.tf} + TF chain` : c.tf })).sort(byNet),
    byTf: group(tfKeyOf, (c) => ({ name: c.mode === 'mtf' ? 'With timeframe chain' : c.tf })).sort((a, b) => tfPlace(a.key) - tfPlace(b.key)),
    byMethod: group((c) => c.method, (c) => ({ name: nameOf(c.method) })).sort(byNet),
    byPattern: group((c) => patternOf.get(c.day) ?? null, (c) => { const p = PATTERNS.find((x) => x.key === patternOf.get(c.day))!; return { name: `#${p.id} ${p.name}` }; }).sort(byNet),
    byFamily: group((c) => { const p = patternOf.get(c.day); return p ? familyOf(p) : null; }, (c) => ({ name: FAMILIES.find((f) => f.key === familyOf(patternOf.get(c.day)!))!.name })).sort(byNet),
    choices: {
      timeframes: distinct(every.map((c) => ({ key: tfKeyOf(c), name: c.mode === 'mtf' ? 'With timeframe chain' : c.tf }))).sort((a, b) => tfPlace(a.key) - tfPlace(b.key)),
      methods: distinct(every.map((c) => ({ key: c.method, name: nameOf(c.method) })))
        .map((m) => {
          const t = every.filter((c) => c.method === m.key && (!o.tfs || o.tfs.includes(tfKeyOf(c)))).reduce((a, c) => addBt(a, c.tot), zeroBt());
          return { ...m, n: t.n, wins: t.wins, net: t.net };
        })
        .sort((a, b) => a.name.localeCompare(b.name, 'en', { numeric: true })),
    },
  };
}
