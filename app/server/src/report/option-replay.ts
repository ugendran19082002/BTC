import { rows } from '../db/pool.js';
import { fillChargesUsd } from '../trading/charges.js';
import { MAX_STOP_PCT, MAX_TARGET_PCT } from '../strategy/types.js';
import { sessionDayOf, sessionDays, sessionOf } from './market-day.js';

/**
 * The option history (owner, 3 Nov 2026: "in the Methods menu, like the signal history, an option history -- the
 * option taken against each signal; skip perp SL and skip perp TGT, the option's SL and TGT, the time range, the date
 * range and the timeframe editable, user friendly -- to see whether it would have made a profit or a loss").
 *
 * Not a backtest: no strike is picked and no signal is guessed at. Each trade is one the desk really sold, at the
 * price it really sold at, on the contract it really sold -- and its exit is worked again on that contract's recorded
 * quotes with the rules asked for, beside what it really did. Read-only: the journal (`trades`), the signals'
 * levels (`entry_setups`), the option's minutes (`option_snapshots_1m`, the five-minute record where the minute one
 * has none -- before 13 Oct 2026) and the perp's minutes (`trade_flow_1m`).
 *
 * The replay, trade by trade, from the minute after the entry fill to 5:29 PM IST on its expiry day:
 *   - each option quote: its ask (the mark when there is no ask) at or over the option SL buys back there; at or
 *     under the option TGT buys back at the TGT, a resting limit;
 *   - each perp minute after it: past the signal's SL (unless `skipPerpSl`) or its TGT (unless `skipPerpTgt`), the
 *     next option quote buys back -- what a market order does when the perp crosses;
 *   - none of those, the last quote by 5:29 PM.
 * Charges as the desk is charged (`fillChargesUsd`), on both sides, and the real trade's the same way -- so the two
 * figures differ by the rules alone.
 */

export type ReplayRules = {
  /** The trade is not closed when the perp reaches the signal's SL / TGT. */
  skipPerpSl: boolean; skipPerpTgt: boolean;
  /** The option's stop as a share of the price sold: 2.5 buys back at 3.5 times it. 0: none. */
  stopPct: number;
  /** The option's target as a share of the price sold: 0.9 buys back at a tenth of it. 0: none. */
  targetPct: number;
};
/** What the desk runs today (all 32 strategies, 3 Nov 2026): the perp's levels left out, a 250% stop, a 90% target. */
export const LIVE_RULES: ReplayRules = { skipPerpSl: true, skipPerpTgt: true, stopPct: 2.5, targetPct: 0.9 };

export type ReplayExit = 'option-sl' | 'option-tgt' | 'perp-sl' | 'perp-tgt' | 'close';
export const REPLAY_EXITS: readonly ReplayExit[] = ['option-sl', 'option-tgt', 'perp-sl', 'perp-tgt', 'close'];
/** How the real trade closed, from its `exitWinner`: the exchange's TGT or SL order, or the desk's own close (a perp level, the clock, a step, a hand). */
export type ActualExit = 'option-tgt' | 'option-sl' | 'desk' | 'other';

/** The timeframe a trade is filed under, as the P&L screen's filter names it: the signal's own, or `chain` for the timeframe chain. */
export const CHAIN_KEY = 'chain';
export const REPLAY_TFS: readonly string[] = ['1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', CHAIN_KEY];

/** At most this many expiry days in one ask: a month and a day, so "this month" always fits. */
export const REPLAY_MAX_DAYS = 31;
/** The most trades one page of the list holds; the spreadsheet takes them all (`REPLAY_CSV_MAX`). */
export const REPLAY_PAGE_MAX = 1_000;
export const REPLAY_CSV_MAX = 250_000;

/** Which trades the list holds, by what they make under the rules: all, in profit, in loss, or better / worse than the real order. */
export type ReplayShow = 'all' | 'profit' | 'loss' | 'better' | 'worse';
export const REPLAY_SHOWS: readonly ReplayShow[] = ['all', 'profit', 'loss', 'better', 'worse'];
/** One page of the list: of one expiry day or all, filtered by `show`, newest first from `offset`. */
export type ReplayList = { day: string | null; show: ReplayShow; offset: number; limit: number };

export type OptionReplayAsk = {
  /** Expiry days, YYYY-MM-DD, both included. */
  from: string; to: string;
  /** Only the trades entered from one minute of the expiry day to the other, both included (0 is 5:30 PM IST). Null: all. */
  window: { from: number; to: number } | null;
  /** `REPLAY_TFS` keys; null, all. */
  tfs: readonly string[] | null;
  /** Entry method ids; null, all. */
  methods: readonly string[] | null;
  /** One broker account's trades; null, every account's. */
  account: number | null;
  rules: ReplayRules;
  /** Every trade counted as one contract, as traded and replayed alike -- so a day of big lots does not outweigh the rest. Absent: as traded. */
  oneContract?: boolean;
  /** `orders` (the default): the desk's real orders. `signals`: every signal in the signal history (`SIGNAL_STRIKE`). */
  source?: ReplaySource;
  /** Which page of the trades to hold. Absent: the first `REPLAY_PAGE_MAX / 5` of all of them. */
  list?: ReplayList;
  now: number;
};

/**
 * What is replayed (owner, 3 Nov 2026: "against the signal history every trade must come -- no max open, no settings --
 * every entry"). `orders`: the options the desk really sold. `signals`: every signal of the signal history that filled,
 * whatever the strategies did with it -- no max open, no method list, no SL distance, no no-entry window, no refusal --
 * one contract of the option the strategies' strike rule picks (`SIGNAL_STRIKE`) at the first recorded quote after the
 * fill, sold at its bid; beside it the desk's real order on the same signal where there was one.
 */
export type ReplaySource = 'orders' | 'signals';
/** The strike a signal is sold at under `signals`: as the strategies pick it (3 Nov 2026) -- the nearest the money with a delta of at most 0.10 and a bid of at least $13. */
export const SIGNAL_STRIKE = { deltaMax: 0.1, minBidUsd: 13 } as const;

export type ReplayLeg = { exitAt: number | null; exit: number | null; netUsd: number };
export type OptionReplayRow = {
  tradeId: string; day: string; account: number | null;
  strategyId: string | null; strategyName: string | null;
  method: string; methodName: string; tf: string; side: 'CE' | 'PE'; symbol: string;
  enteredAt: number; entry: number; contracts: number;
  /** The signal's perp levels the replay read: null where the signal had none recorded. */
  perpSl: number | null; perpTgt: number | null;
  /** What the desk's real order did; null for a signal the desk did not trade (`signals` only). */
  actual: (ReplayLeg & { why: ActualExit }) | null;
  replay: ReplayLeg & { why: ReplayExit };
};
export type ReplaySide = { trades: number; wins: number; losses: number; profitUsd: number; lossUsd: number; netUsd: number };
/**
 * `open`: trades of the group still open, not in its figures. A day of the range with no trade is a group of none.
 * `traded`: those with a real order, the ones `actual` counts; of them, `better` the rules made more of and `worse` less.
 */
export type ReplayGroup = { key: string; name: string; trades: number; open: number; traded: number; better: number; worse: number; actual: ReplaySide; replay: ReplaySide };
export type OptionReplay = {
  from: string; to: string; rules: ReplayRules; oneContract: boolean; source: ReplaySource;
  /** `actual` is of the `traded` trades alone: all of them under `orders`, those the desk had an order on under `signals`. */
  actual: ReplaySide; replay: ReplaySide; traded: number;
  /** Of the replayed, how many the rules made more of than the real order did, and how many less. */
  better: number; worse: number;
  exits: Record<ReplayExit, number>;
  /**
   * Left out: trades still open; trades with no quote of their option after the entry to replay on; and (`signals`)
   * signals with no strike inside the rule at the fill -- nothing the strategies would have sold.
   */
  open: number; noPrices: number; noStrike: number;
  days: ReplayGroup[]; timeframes: ReplayGroup[]; methods: ReplayGroup[]; accounts: ReplayGroup[];
  /** One page of the trades, newest first (`list`), and how many the list's filter holds in all. */
  rows: OptionReplayRow[]; rowsTotal: number; list: ReplayList;
};

// ------------------------------------------------------------------ the rules, checked

/** What is wrong with a set of rules, in words; null when it can be replayed. */
export function rulesProblem(r: ReplayRules): string | null {
  if (!Number.isFinite(r.stopPct) || r.stopPct < 0 || r.stopPct > MAX_STOP_PCT) return `The option SL must be 0 (none) to ${MAX_STOP_PCT * 100}%.`;
  if (!Number.isFinite(r.targetPct) || r.targetPct < 0 || r.targetPct > MAX_TARGET_PCT) return `The option TGT must be 0 (none) to ${Math.round(MAX_TARGET_PCT * 100)}%.`;
  return null;
}

// ------------------------------------------------------------------ one trade, replayed

/** An option's quotes over its day, oldest first: the price to buy back at (the ask, else the mark) and when. */
export type OptionPath = { at: Float64Array; ask: Float64Array };
/** The perp's minutes, oldest first: each minute's high and low, the minute starting at `at`. */
export type PerpPath = { at: Float64Array; high: Float64Array; low: Float64Array };

const MIN = 60_000;
const CONTRACT_VALUE = 0.001;

/** The first index with `xs[i] > t`. */
function after(xs: Float64Array, t: number): number {
  let lo = 0, hi = xs.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (xs[mid]! <= t) lo = mid + 1; else hi = mid; }
  return lo;
}

/**
 * Where one sold option would have been bought back under `rules`: when, at what, and why. Null when there is no
 * quote of it after the entry and by `closeAt` to replay on. `dir` is the signal's: 1 bought the perp (a PE sold),
 * -1 sold it (a CE sold). Pure.
 */
export function replayExit(t: {
  enteredAt: number; entry: number; dir: 1 | -1; closeAt: number;
  perpSl: number | null; perpTgt: number | null;
}, rules: ReplayRules, option: OptionPath, perp: PerpPath): { at: number; price: number; why: ReplayExit } | null {
  const stop = rules.stopPct > 0 ? t.entry * (1 + rules.stopPct) : Number.POSITIVE_INFINITY;
  // Rounded past any tick: 10 × (1 − 0.9) is 0.9999999999999998 in floating point, and the limit is at 1.
  const target = rules.targetPct > 0 ? Math.round(t.entry * (1 - rules.targetPct) * 1e6) / 1e6 : Number.NEGATIVE_INFINITY;
  const sl = rules.skipPerpSl ? null : t.perpSl;
  const tgt = rules.skipPerpTgt ? null : t.perpTgt;
  // The first perp minute wholly after the fill: the one it filled inside began before it.
  const firstMinute = Math.floor(t.enteredAt / MIN) * MIN + MIN;
  let p = after(perp.at, firstMinute - 1);
  let last: { at: number; price: number } | null = null;
  let crossed: ReplayExit | null = null;
  for (let i = after(option.at, t.enteredAt); i < option.at.length && option.at[i]! <= t.closeAt; i++) {
    const at = option.at[i]!, ask = option.ask[i]!;
    // A perp level crossed before this quote: bought back here, at whatever it asks.
    if (crossed) return { at, price: ask, why: crossed };
    if (ask >= stop) return { at, price: ask, why: 'option-sl' };
    if (ask <= target) return { at, price: target, why: 'option-tgt' };
    last = { at, price: ask };
    // The perp's minutes up to the next quote. Its SL first: within a minute there is no telling which came first, and the stop is the one that costs.
    const next = i + 1 < option.at.length ? option.at[i + 1]! : t.closeAt + 1;
    for (; p < perp.at.length && perp.at[p]! + MIN <= next; p++) {
      const hi = perp.high[p]!, lo = perp.low[p]!;
      if (sl !== null && (t.dir === 1 ? lo <= sl : hi >= sl)) { crossed = 'perp-sl'; break; }
      if (tgt !== null && (t.dir === 1 ? hi >= tgt : lo <= tgt)) { crossed = 'perp-tgt'; break; }
    }
  }
  // Crossed after the last quote of the day: bought back at that last quote.
  if (last && crossed) return { ...last, why: crossed };
  return last ? { ...last, why: 'close' } : null;
}

/** USD made selling `contracts` at `entry` and buying back at `exit`, after the charges on both. */
export function shortNetUsd(entry: number, exit: number, contracts: number): number {
  const charge = (price: number) => fillChargesUsd({ price, contracts, contractValue: CONTRACT_VALUE, spot: null }).totalUsd;
  return (entry - exit) * contracts * CONTRACT_VALUE - charge(entry) - charge(exit);
}

// ------------------------------------------------------------------ the record, read

type Fill = { ts: number; role: string; side: 'buy' | 'sell'; size: number; price: number };
type TradeRow = {
  trade_id: string; broker_account_id: string | null;
  plan: {
    action?: string; origin?: string; symbol?: string; strategyId?: string; strategyName?: string;
    signal?: { tf?: string; dir?: number; mode?: string; method?: string; triggerTime?: number };
    expect?: { expiryTs?: number; optionSide?: string };
    underlying?: { stop?: number | null; target?: number | null } | null;
  };
  state: { phase?: string; fills?: Fill[]; contractValue?: number; exitWinner?: string | null };
};

/** One real trade, as the replay needs it. */
type Taken = Omit<OptionReplayRow, 'actual' | 'replay' | 'perpSl' | 'perpTgt'> & {
  dir: 1 | -1; closeAt: number; mode: string; triggerTime: number; signalTf: string;
  /** The levels the desk set at the entry; null where the strategy left them out (and the signal's are read instead). */
  ownSl: number | null; ownTgt: number | null;
  actualExitAt: number | null; actualExit: number | null; actualNet: number; actualWhy: ActualExit;
};

const SETTLE_LAST_MIN = 60_000;
const whyOf = (w: string | null | undefined): ActualExit =>
  (w === 'take_profit' ? 'option-tgt' : w === 'stop_loss' ? 'option-sl' : w === 'manual' ? 'desk' : 'other');

/** A sold signal option the desk opened and closed, read off its journal row; null for anything else. */
function takenOf(r: TradeRow, day: string): Taken | null {
  const { plan, state } = r;
  const sig = plan.signal;
  // Sold by its entry fill: journal rows before 5 Oct 2026 carry no `action` (162 of them on 3-4 Oct, left out until 3 Nov).
  if (plan.action === 'buy' || !sig?.method || !sig.tf || state.phase !== 'flat' || !plan.symbol) return null;
  const fills = state.fills ?? [];
  const entries = fills.filter((f) => f.role === 'entry' && f.side === 'sell');
  if (entries.length === 0) return null;
  const contracts = entries.reduce((n, f) => n + f.size, 0);
  const entry = entries.reduce((n, f) => n + f.price * f.size, 0) / contracts;
  const enteredAt = Math.min(...entries.map((f) => f.ts));
  if (sessionDayOf(enteredAt) !== day) return null;
  const exits = fills.filter((f) => f.role !== 'entry');
  const cv = state.contractValue ?? CONTRACT_VALUE;
  const charge = (f: Fill) => fillChargesUsd({ price: f.price, contracts: f.size, contractValue: cv, spot: null }).totalUsd;
  const actualNet = fills.reduce((n, f) => n + (f.side === 'sell' ? 1 : -1) * f.price * f.size * cv - charge(f), 0);
  const exitSize = exits.reduce((n, f) => n + f.size, 0);
  const side = plan.expect?.optionSide === 'CE' || plan.symbol.startsWith('C-') ? 'CE' : 'PE';
  const expiryMs = (plan.expect?.expiryTs ?? 0) * 1000 || sessionOf(day).to;
  return {
    tradeId: r.trade_id, day, account: r.broker_account_id === null ? null : Number(r.broker_account_id),
    strategyId: plan.strategyId ?? null, strategyName: plan.strategyName ?? null,
    method: sig.method, methodName: sig.method, tf: sig.mode === 'mtf' ? CHAIN_KEY : sig.tf, side, symbol: plan.symbol,
    enteredAt, entry, contracts,
    dir: (sig.dir ?? (side === 'PE' ? 1 : -1)) >= 0 ? 1 : -1, closeAt: Math.min(expiryMs, sessionOf(day).to) - SETTLE_LAST_MIN,
    mode: sig.mode ?? 'single', triggerTime: sig.triggerTime ?? 0, signalTf: sig.tf,
    ownSl: plan.underlying?.stop ?? null, ownTgt: plan.underlying?.target ?? null,
    actualExitAt: exits.length ? Math.max(...exits.map((f) => f.ts)) : null,
    actualExit: exitSize > 0 ? exits.reduce((n, f) => n + f.price * f.size, 0) / exitSize : null,
    actualNet, actualWhy: whyOf(state.exitWinner),
  };
}

/** A trade still open: counted beside the replay, under the same filters, never replayed -- it has no exit yet. */
type OpenTrade = { account: number | null; tf: string; method: string; methodName: string; enteredAt: number };

/** One expiry day, read once: its trades, their signals' perp levels, their options' quotes and the perp's minutes. */
type DayData = { taken: Taken[]; open: OpenTrade[]; levels: Map<string, { sl: number; tp: Record<string, number | null> }>; paths: Map<string, OptionPath>; perp: PerpPath };

const levelKey = (method: string, mode: string, tf: string, dir: number, trigger: number) => `${method}|${mode}|${tf}|${dir}|${trigger}`;

async function readDay(day: string): Promise<DayData> {
  const span = sessionOf(day);
  // By when the row last changed -- the journal's own index: every trade entered in the day changed in it or after.
  const all = await rows<TradeRow>(
    `SELECT trade_id, broker_account_id, plan, state FROM trades
      WHERE updated_at >= $1 AND updated_at < $2 AND plan ? 'signal' AND coalesce(plan->>'action', 'sell') = 'sell'`,
    [span.from, span.to + 7 * 86_400_000],
  );
  const taken: Taken[] = [];
  const open: OpenTrade[] = [];
  for (const r of all) {
    const t = takenOf(r, day);
    if (t) { taken.push(t); continue; }
    const sig = r.plan.signal;
    const entry = (r.state.fills ?? []).filter((f) => f.role === 'entry' && f.side === 'sell');
    if (r.plan.action === 'buy' || !sig?.method || !sig.tf || r.state.phase === 'flat' || r.state.phase === 'aborted' || entry.length === 0) continue;
    const enteredAt = Math.min(...entry.map((f) => f.ts));
    if (sessionDayOf(enteredAt) !== day) continue;
    open.push({ account: r.broker_account_id === null ? null : Number(r.broker_account_id), tf: sig.mode === 'mtf' ? CHAIN_KEY : sig.tf, method: sig.method, methodName: sig.method, enteredAt });
  }
  const symbols = [...new Set(taken.map((t) => t.symbol))];
  const [setups, paths, flow] = await Promise.all([
    taken.length === 0 ? Promise.resolve([]) : rows<{ method: string; mode: string; tf: string; dir: number; trigger_at: string; stop: number; tp1: number; tp2: number | null; tp3: number | null }>(
      `SELECT s.method, s.mode, s.tf, s.dir, s.trigger_at, s.stop, s.tp1, s.tp2, s.tp3
         FROM entry_setups s
         JOIN unnest($1::text[], $2::text[], $3::text[], $4::smallint[], $5::bigint[]) AS k(method, mode, tf, dir, trigger_at)
           USING (method, mode, tf, dir, trigger_at)`,
      [taken.map((t) => t.method), taken.map((t) => t.mode), taken.map((t) => t.signalTf), taken.map((t) => t.dir), taken.map((t) => t.triggerTime)] as never,
    ),
    pathsOf(symbols, span),
    rows<{ at: string; high: number; low: number }>(
      'SELECT at, high, low FROM trade_flow_1m WHERE at >= $1 AND at < $2 AND high IS NOT NULL AND low IS NOT NULL ORDER BY at', [span.from, span.to]),
  ]);

  const levels = new Map(setups.map((s) => [levelKey(s.method, s.mode, s.tf, s.dir, Number(s.trigger_at)), { sl: s.stop, tp: { tp1: s.tp1, tp2: s.tp2, tp3: s.tp3 } }]));
  const perp: PerpPath = { at: Float64Array.from(flow.map((f) => Number(f.at))), high: Float64Array.from(flow.map((f) => f.high)), low: Float64Array.from(flow.map((f) => f.low)) };
  return { taken, open, levels, paths, perp };
}

/** Each contract's quotes over the day: the minute record where it has the contract; the five-minute record fills only the minutes it has none of (before 13 Oct 2026, all of them). */
async function pathsOf(symbols: readonly string[], span: { from: number; to: number }): Promise<Map<string, OptionPath>> {
  if (symbols.length === 0) return new Map();
  type Quote = { symbol: string; at: string; ask: number | null; mark: number | null };
  const [minute, five] = await Promise.all([
    rows<Quote>('SELECT symbol, at, ask, mark FROM option_snapshots_1m WHERE symbol = ANY($1) AND at >= $2 AND at < $3 ORDER BY symbol, at', [symbols, span.from, span.to] as never),
    rows<Quote>('SELECT symbol, at, ask, mark FROM option_snapshots WHERE symbol = ANY($1) AND at >= $2 AND at < $3 ORDER BY symbol, at', [symbols, span.from, span.to] as never),
  ]);
  const merged = new Map<string, Map<number, number>>();
  for (const src of [five, minute]) {
    for (const q of src) {
      const px = q.ask ?? q.mark;
      if (px === null || !(px > 0)) continue;
      let m = merged.get(q.symbol);
      if (!m) merged.set(q.symbol, (m = new Map()));
      m.set(Number(q.at), px);
    }
  }
  const paths = new Map<string, OptionPath>();
  for (const [symbol, m] of merged) {
    const ats = [...m.keys()].sort((a, b) => a - b);
    paths.set(symbol, { at: Float64Array.from(ats), ask: Float64Array.from(ats.map((a) => m.get(a)!)) });
  }
  return paths;
}

/** One board reading, as the strike is picked from it. */
export type BoardQuote = { at: number; symbol: string; cp: 'C' | 'P'; strike: number; bid: number | null; delta: number | null };

/** The strike the strategies would sell from one reading of the board: the nearest the money inside `SIGNAL_STRIKE`. Null: none. Pure. */
export function pickSignalStrike(board: readonly BoardQuote[], cp: 'C' | 'P'): BoardQuote | null {
  let best: BoardQuote | null = null;
  for (const q of board) {
    if (q.cp !== cp || q.bid === null || q.delta === null || q.bid < SIGNAL_STRIKE.minBidUsd || Math.abs(q.delta) > SIGNAL_STRIKE.deltaMax) continue;
    if (!best || Math.abs(q.delta) > Math.abs(best.delta!)) best = q;
  }
  return best;
}

/** A signal of the signal history, sold as `SIGNAL_STRIKE` picks: what the replay needs. */
type SignalTrade = Taken & { perpSl: number; perpTgt: number };
type SignalDay = { trades: SignalTrade[]; noStrike: number; paths: Map<string, OptionPath> };

const expiryCodeOf = (day: string) => `${day.slice(8, 10)}${day.slice(5, 7)}${day.slice(2, 4)}`;

/** Every signal of one expiry day that filled, each with the option the strategies would have sold at the first board after its fill. */
async function readSignals(day: string): Promise<SignalDay> {
  const span = sessionOf(day);
  const setups = await rows<{ method: string; mode: string; tf: string; dir: number; trigger_at: string; filled_at: string; stop: number; tp1: number }>(
    `SELECT method, mode, tf, dir, trigger_at, filled_at, stop, tp1 FROM entry_setups
      WHERE trigger_at >= $1 AND trigger_at < $2 AND filled_at >= $3 AND filled_at < $2`,
    // By the trigger -- its own index -- from a day before: a signal can fill long after it was given.
    [Math.floor(span.from / 1000) - 86_400, Math.floor(span.to / 1000), Math.floor(span.from / 1000)],
  );
  // The board a signal is sold from: the first minute after its fill, or the first five-minute reading where there is no minute one.
  const minuteOf = (filled: number) => Math.floor((filled * 1000) / MIN) * MIN + MIN;
  const fiveOf = (filled: number) => Math.floor((filled * 1000) / (5 * MIN)) * 5 * MIN + 5 * MIN;
  const code = expiryCodeOf(day);
  type Raw = { at: string; symbol: string; cp: 'C' | 'P'; strike: number; bid: number | null; delta: number | null };
  const [minute, five] = setups.length === 0 ? [[], []] : await Promise.all([
    rows<Raw>('SELECT at, symbol, cp, strike, bid, delta FROM option_snapshots_1m WHERE at = ANY($1) AND expiry = $2',
      [[...new Set(setups.map((x) => minuteOf(Number(x.filled_at))))], code] as never),
    rows<Raw>('SELECT at, symbol, cp, strike, bid, delta FROM option_snapshots WHERE at = ANY($1) AND expiry = $2',
      [[...new Set(setups.map((x) => fiveOf(Number(x.filled_at))))], code] as never),
  ]);
  const boards = new Map<number, BoardQuote[]>();
  for (const q of [...minute, ...five]) {
    const at = Number(q.at);
    let b = boards.get(at);
    if (!b) boards.set(at, (b = []));
    b.push({ at, symbol: q.symbol, cp: q.cp, strike: q.strike, bid: q.bid, delta: q.delta });
  }
  const trades: SignalTrade[] = [];
  let noStrike = 0;
  const closeAt = span.to - SETTLE_LAST_MIN;
  for (const x of setups) {
    const filled = Number(x.filled_at);
    const dir: 1 | -1 = x.dir >= 0 ? 1 : -1;
    const cp = dir === 1 ? 'P' : 'C';
    const board = boards.get(minuteOf(filled)) ?? boards.get(fiveOf(filled)) ?? [];
    const q = pickSignalStrike(board, cp);
    if (!q || q.at >= closeAt) { noStrike++; continue; }
    trades.push({
      tradeId: levelKey(x.method, x.mode, x.tf, dir, Number(x.trigger_at)), day, account: null, strategyId: null, strategyName: null,
      method: x.method, methodName: x.method, tf: x.mode === 'mtf' ? CHAIN_KEY : x.tf, side: cp === 'P' ? 'PE' : 'CE', symbol: q.symbol,
      enteredAt: q.at, entry: q.bid!, contracts: 1, dir, closeAt, mode: x.mode, triggerTime: Number(x.trigger_at), signalTf: x.tf,
      ownSl: null, ownTgt: null, actualExitAt: null, actualExit: null, actualNet: 0, actualWhy: 'other',
      perpSl: x.stop, perpTgt: x.tp1,
    });
  }
  return { trades, noStrike, paths: await pathsOf([...new Set(trades.map((t) => t.symbol))], span) };
}

/**
 * Days already read, kept: an expiry day that has settled never changes, so a second look -- the SL moved, a switch
 * turned -- is arithmetic only. The day in progress is read again after a minute. At most `HELD_DAYS`, the least
 * recently used let go first.
 */
const HELD_DAYS = 45;
const TODAY_FRESH_MS = 60_000;
type Held<T> = Map<string, { at: number; settled: boolean; data: Promise<T> }>;
const held: Held<DayData> = new Map();
const heldSignals: Held<SignalDay> = new Map();

function kept<T>(store: Held<T>, day: string, now: number, read: (day: string) => Promise<T>): Promise<T> {
  const h = store.get(day);
  if (h && (h.settled || now - h.at < TODAY_FRESH_MS)) { store.delete(day); store.set(day, h); return h.data; }
  // Settled once its last trade could have been closed and journalled: ten minutes after 5:30 PM.
  const settled = now > sessionOf(day).to + 10 * MIN;
  const data = read(day);
  store.set(day, { at: now, settled, data });
  data.catch(() => { if (store.get(day)?.data === data) store.delete(day); });
  while (store.size > HELD_DAYS) store.delete(store.keys().next().value!);
  return data;
}
const dayData = (day: string, now: number) => kept(held, day, now, readDay);
const signalDay = (day: string, now: number) => kept(heldSignals, day, now, readSignals);

export function clearOptionReplayCache(): void { held.clear(); heldSignals.clear(); cores.clear(); }

async function methodNames(): Promise<Map<string, string>> {
  return new Map((await rows<{ id: string; n: number | null; name: string }>('SELECT id, n, name FROM entry_methods')).map((m) => [m.id, m.n === null ? m.name : `#${m.n} ${m.name}`]));
}
async function accountNames(): Promise<Map<string, string>> {
  return new Map((await rows<{ id: string; name: string }>('SELECT id, name FROM broker_accounts')).map((a) => [String(a.id), a.name]));
}
/** Which of the signal's targets each strategy's perp TGT is (`signal.target`): tp1 unless it says otherwise. */
async function targetKeys(): Promise<Map<string, string>> {
  return new Map((await rows<{ id: string; target: string | null }>("SELECT id, config->'signal'->>'target' AS target FROM strategies")).map((s) => [s.id, s.target ?? 'tp1']));
}

// ------------------------------------------------------------------ the answer

const emptySide = (): ReplaySide => ({ trades: 0, wins: 0, losses: 0, profitUsd: 0, lossUsd: 0, netUsd: 0 });
function count(s: ReplaySide, net: number): void {
  s.trades++; s.netUsd += net;
  if (net > 0) { s.wins++; s.profitUsd += net; } else if (net < 0) { s.losses++; s.lossUsd -= net; }
}
/** The contract minute a moment is at: 0 is 5:30 PM IST. */
const contractMinute = (ms: number) => Math.floor((ms - sessionOf(sessionDayOf(ms)).from) / MIN);

/** One trade to replay, whichever the source: where it was sold, the perp levels it reads, and the real order beside it. */
type Item = Taken & { perpSl: number | null; perpTgt: number | null; real: { net: number; contracts: number; exitAt: number | null; exit: number | null; why: ActualExit } | null };

/** Four days at a time: each is a handful of indexed reads, and the pool is shared with the rest of the thread. */
async function byFours<T>(days: readonly string[], read: (day: string) => Promise<T>): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < days.length; i += 4) out.push(...await Promise.all(days.slice(i, i + 4).map(read)));
  return out;
}

/** Whether a trade is on a list filtered by `show`. A signal the desk did not trade is neither better nor worse. */
export function onList(r: OptionReplayRow, show: ReplayShow): boolean {
  if (show === 'all') return true;
  if (show === 'profit') return r.replay.netUsd > 0;
  if (show === 'loss') return r.replay.netUsd < 0;
  if (!r.actual) return false;
  return show === 'better' ? r.replay.netUsd > r.actual.netUsd + 1e-9 : r.replay.netUsd < r.actual.netUsd - 1e-9;
}

/**
 * The last few answers, whole, a minute each: the list's next page, another filter, the spreadsheet -- each the same
 * replay, sliced differently -- answer from here instead of working a month of signals again.
 */
type Core = Omit<OptionReplay, 'rows' | 'rowsTotal' | 'list'> & { all: OptionReplayRow[] };
const cores = new Map<string, { at: number; core: Promise<Core> }>();
const CORES_KEPT = 4;

export async function optionReplay(o: OptionReplayAsk): Promise<OptionReplay> {
  const key = JSON.stringify({ ...o, list: undefined, now: undefined });
  let c = cores.get(key);
  if (!c || o.now - c.at > TODAY_FRESH_MS) {
    c = { at: o.now, core: replayCore(o) };
    cores.delete(key); cores.set(key, c);
    const mine = c;
    mine.core.catch(() => { if (cores.get(key) === mine) cores.delete(key); });
    while (cores.size > CORES_KEPT) cores.delete(cores.keys().next().value!);
  }
  const { all, ...core } = await c.core;
  const list: ReplayList = o.list ?? { day: null, show: 'all', offset: 0, limit: REPLAY_PAGE_MAX / 5 };
  const picked = all.filter((r) => (list.day === null || r.day === list.day) && onList(r, list.show));
  return { ...core, rows: picked.slice(list.offset, list.offset + list.limit), rowsTotal: picked.length, list };
}

async function replayCore(o: OptionReplayAsk): Promise<Core> {
  const days = sessionDays(o.from, o.to);
  const source: ReplaySource = o.source ?? 'orders';
  const [data, signals, names, accounts, targets] = await Promise.all([
    byFours(days, (d) => dayData(d, o.now)),
    source === 'signals' ? byFours(days, (d) => signalDay(d, o.now)) : Promise.resolve(null),
    methodNames(), accountNames(), targetKeys(),
  ]);
  const tfs = o.tfs ? new Set(o.tfs) : null;
  const methods = o.methods ? new Set(o.methods) : null;
  const actual = emptySide(), replay = emptySide();
  const exits: Record<ReplayExit, number> = { 'option-sl': 0, 'option-tgt': 0, 'perp-sl': 0, 'perp-tgt': 0, close: 0 };
  const groups = { day: new Map<string, ReplayGroup>(), tf: new Map<string, ReplayGroup>(), method: new Map<string, ReplayGroup>(), account: new Map<string, ReplayGroup>() };
  const groupOf = (m: Map<string, ReplayGroup>, key: string, name: string) => {
    let g = m.get(key);
    if (!g) m.set(key, (g = { key, name, trades: 0, open: 0, traded: 0, better: 0, worse: 0, actual: emptySide(), replay: emptySide() }));
    return g;
  };
  // Every day asked for has its line, a day with no trade too: a date the list skipped read as one the screen had lost.
  for (const d of days) groupOf(groups.day, d, d);
  const accountName = (id: number | null) => (id === null ? 'No account' : accounts.get(String(id)) ?? `Account ${id}`);
  /** Whether a trade is one the ask is about. A signal is no account's: under `signals` the account is not read. */
  const wanted = (t: { account: number | null; tf: string; method: string; enteredAt: number }, signal = false) => {
    if (!signal && o.account !== null && t.account !== o.account) return false;
    if (tfs && !tfs.has(t.tf)) return false;
    if (methods && !methods.has(t.method)) return false;
    if (o.window) { const m = contractMinute(t.enteredAt); if (m < o.window.from || m > o.window.to) return false; }
    return true;
  };
  const out: OptionReplayRow[] = [];
  let open = 0, noPrices = 0, noStrike = 0, traded = 0, better = 0, worse = 0;
  for (const [k, d] of data.entries()) {
    const realItem = (t: Taken): Item['real'] => ({ net: t.actualNet, contracts: t.contracts, exitAt: t.actualExitAt, exit: t.actualExit, why: t.actualWhy });
    let items: Item[];
    let paths = d.paths;
    if (signals) {
      const sd = signals[k]!;
      noStrike += sd.noStrike;
      paths = sd.paths;
      // The desk's real order on the same signal -- the first entered, whichever account (owner, 3 Nov 2026: "not by the
      // accounts' rules; by the signal history, with only the option history's settings").
      const real = new Map<string, Taken>();
      for (const t of [...d.taken].sort((a, b) => a.enteredAt - b.enteredAt)) {
        const key = levelKey(t.method, t.mode, t.signalTf, t.dir, t.triggerTime);
        if (!real.has(key)) real.set(key, t);
      }
      items = sd.trades.filter((t) => wanted(t, true)).map((t) => { const r = real.get(t.tradeId); return { ...t, real: r ? realItem(r) : null }; });
    } else {
      items = d.taken.filter((t) => wanted(t)).map((t) => {
        const lv = d.levels.get(levelKey(t.method, t.mode, t.signalTf, t.dir, t.triggerTime));
        return {
          ...t, real: realItem(t),
          perpSl: t.ownSl ?? lv?.sl ?? null,
          perpTgt: t.ownTgt ?? lv?.tp[targets.get(t.strategyId ?? '') ?? 'tp1'] ?? lv?.tp.tp1 ?? null,
        };
      });
    }
    for (const t of items) {
      const path = paths.get(t.symbol);
      const x = path ? replayExit(t, o.rules, path, d.perp) : null;
      if (!x) { noPrices++; continue; }
      // Charges are a share of the premium, so one contract's share of the real trade is its net over its size.
      const size = o.oneContract || signals ? 1 : t.contracts;
      const net = shortNetUsd(t.entry, x.price, size);
      const actualNet = t.real ? (size === t.real.contracts ? t.real.net : (t.real.net / t.real.contracts) * size) : null;
      count(replay, net); exits[x.why]++;
      const verdict = actualNet === null ? 0 : net > actualNet + 1e-9 ? 1 : net < actualNet - 1e-9 ? -1 : 0;
      if (actualNet !== null) { traded++; count(actual, actualNet); }
      if (verdict > 0) better++; else if (verdict < 0) worse++;
      const methodName = names.get(t.method) ?? t.method;
      const into = (m: Map<string, ReplayGroup>, key: string, name: string) => {
        const g = groupOf(m, key, name);
        g.trades++; count(g.replay, net);
        if (actualNet !== null) { g.traded++; count(g.actual, actualNet); }
        if (verdict > 0) g.better++; else if (verdict < 0) g.worse++;
      };
      into(groups.day, t.day, t.day);
      into(groups.tf, t.tf, t.tf === CHAIN_KEY ? 'Chain' : t.tf);
      into(groups.method, t.method, methodName);
      if (!signals) into(groups.account, t.account === null ? 'none' : String(t.account), accountName(t.account));
      out.push({
        tradeId: t.tradeId, day: t.day, account: t.account, strategyId: t.strategyId, strategyName: t.strategyName,
        method: t.method, methodName, tf: t.tf, side: t.side, symbol: t.symbol, enteredAt: t.enteredAt, entry: t.entry, contracts: size,
        perpSl: t.perpSl, perpTgt: t.perpTgt,
        actual: t.real && actualNet !== null ? { exitAt: t.real.exitAt, exit: t.real.exit, netUsd: actualNet, why: t.real.why } : null,
        replay: { exitAt: x.at, exit: x.price, netUsd: net, why: x.why },
      });
    }
    // Still open is of the real orders; a signal is replayed whatever its order is doing.
    for (const t of signals ? [] : d.open) {
      if (!wanted(t)) continue;
      open++;
      groupOf(groups.day, sessionDayOf(t.enteredAt), sessionDayOf(t.enteredAt)).open++;
      groupOf(groups.tf, t.tf, t.tf === CHAIN_KEY ? 'Chain' : t.tf).open++;
      groupOf(groups.method, t.method, names.get(t.method) ?? t.method).open++;
      if (!signals) groupOf(groups.account, t.account === null ? 'none' : String(t.account), accountName(t.account)).open++;
    }
  }
  out.sort((a, b) => b.enteredAt - a.enteredAt);
  const tfRank = (k: string) => { const i = REPLAY_TFS.indexOf(k); return i < 0 ? REPLAY_TFS.length : i; };
  // Methods best first: by what they make under the rules, most first.
  const byNet = (a: ReplayGroup, b: ReplayGroup) => b.replay.netUsd - a.replay.netUsd;
  return {
    from: o.from, to: o.to, rules: o.rules, oneContract: o.oneContract === true || source === 'signals', source,
    actual, replay, traded, better, worse, exits, open, noPrices, noStrike,
    days: [...groups.day.values()].sort((a, b) => b.key.localeCompare(a.key)),
    timeframes: [...groups.tf.values()].sort((a, b) => tfRank(a.key) - tfRank(b.key)),
    methods: [...groups.method.values()].sort(byNet),
    accounts: [...groups.account.values()].sort((a, b) => a.key.localeCompare(b.key, 'en', { numeric: true })),
    all: out,
  };
}

const csvCell = (v: string | number | null) => (v === null ? '' : typeof v === 'number' ? String(Math.round(v * 1e6) / 1e6) : /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
const istStamp = (ms: number | null) => (ms === null ? null : new Date(ms + 5.5 * 3_600_000).toISOString().slice(0, 16).replace('T', ' '));

/** The trades as a spreadsheet: what each was, what the desk's order did, and what it would have done. */
export function optionReplayCsv(rows: readonly OptionReplayRow[]): string {
  const head = ['expiry_day', 'entered_ist', 'account', 'strategy', 'timeframe', 'method', 'side', 'symbol', 'contracts', 'sold_at', 'perp_sl', 'perp_tgt',
    'actual_exit_ist', 'actual_exit', 'actual_why', 'actual_net_usd', 'replay_exit_ist', 'replay_exit', 'replay_why', 'replay_net_usd'];
  const lines = rows.map((r) => [r.day, istStamp(r.enteredAt), r.account, r.strategyName, r.tf, r.methodName, r.side, r.symbol, r.contracts, r.entry, r.perpSl, r.perpTgt,
    istStamp(r.actual?.exitAt ?? null), r.actual?.exit ?? null, r.actual?.why ?? 'not traded', r.actual?.netUsd ?? null,
    istStamp(r.replay.exitAt), r.replay.exit, r.replay.why, r.replay.netUsd].map(csvCell).join(','));
  return [head.join(','), ...lines].join('\n') + '\n';
}
