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
/** A list of trades longer than this is cut, newest kept: the days, timeframes and methods still count every one. */
export const REPLAY_ROWS_MAX = 1_500;

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
  now: number;
};

export type ReplayLeg = { exitAt: number | null; exit: number | null; netUsd: number };
export type OptionReplayRow = {
  tradeId: string; day: string; account: number | null;
  strategyId: string | null; strategyName: string | null;
  method: string; methodName: string; tf: string; side: 'CE' | 'PE'; symbol: string;
  enteredAt: number; entry: number; contracts: number;
  /** The signal's perp levels the replay read: null where the signal had none recorded. */
  perpSl: number | null; perpTgt: number | null;
  actual: ReplayLeg & { why: ActualExit };
  replay: ReplayLeg & { why: ReplayExit };
};
export type ReplaySide = { trades: number; wins: number; losses: number; profitUsd: number; lossUsd: number; netUsd: number };
export type ReplayGroup = { key: string; name: string; trades: number; actual: ReplaySide; replay: ReplaySide };
export type OptionReplay = {
  from: string; to: string; rules: ReplayRules; oneContract: boolean;
  actual: ReplaySide; replay: ReplaySide;
  exits: Record<ReplayExit, number>;
  /** Trades left out: still open, or with no quote of their option after the entry to replay on. */
  open: number; noPrices: number;
  days: ReplayGroup[]; timeframes: ReplayGroup[]; methods: ReplayGroup[]; accounts: ReplayGroup[];
  /** Newest first, at most `REPLAY_ROWS_MAX`. */
  rows: OptionReplayRow[]; rowsCut: boolean;
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
  if (plan.action !== 'sell' || !sig?.method || !sig.tf || state.phase !== 'flat' || !plan.symbol) return null;
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

/** One expiry day, read once: its trades, their signals' perp levels, their options' quotes and the perp's minutes. */
type DayData = { taken: Taken[]; open: number; levels: Map<string, { sl: number; tp: Record<string, number | null> }>; paths: Map<string, OptionPath>; perp: PerpPath };

const levelKey = (method: string, mode: string, tf: string, dir: number, trigger: number) => `${method}|${mode}|${tf}|${dir}|${trigger}`;

async function readDay(day: string): Promise<DayData> {
  const span = sessionOf(day);
  // By when the row last changed -- the journal's own index: every trade entered in the day changed in it or after.
  const all = await rows<TradeRow>(
    `SELECT trade_id, broker_account_id, plan, state FROM trades
      WHERE updated_at >= $1 AND updated_at < $2 AND plan ? 'signal' AND plan->>'action' = 'sell'`,
    [span.from, span.to + 7 * 86_400_000],
  );
  const taken: Taken[] = [];
  let open = 0;
  for (const r of all) {
    const t = takenOf(r, day);
    if (t) taken.push(t);
    else if (r.state.phase !== 'flat' && r.state.phase !== 'aborted' && (r.state.fills ?? []).some((f) => f.role === 'entry' && sessionDayOf(f.ts) === day)) open++;
  }
  const symbols = [...new Set(taken.map((t) => t.symbol))];
  const [setups, minute, five, flow] = await Promise.all([
    taken.length === 0 ? Promise.resolve([]) : rows<{ method: string; mode: string; tf: string; dir: number; trigger_at: string; stop: number; tp1: number; tp2: number | null; tp3: number | null }>(
      `SELECT s.method, s.mode, s.tf, s.dir, s.trigger_at, s.stop, s.tp1, s.tp2, s.tp3
         FROM entry_setups s
         JOIN unnest($1::text[], $2::text[], $3::text[], $4::smallint[], $5::bigint[]) AS k(method, mode, tf, dir, trigger_at)
           USING (method, mode, tf, dir, trigger_at)`,
      [taken.map((t) => t.method), taken.map((t) => t.mode), taken.map((t) => t.signalTf), taken.map((t) => t.dir), taken.map((t) => t.triggerTime)] as never,
    ),
    symbols.length === 0 ? Promise.resolve([]) : rows<{ symbol: string; at: string; ask: number | null; mark: number | null }>(
      'SELECT symbol, at, ask, mark FROM option_snapshots_1m WHERE symbol = ANY($1) AND at >= $2 AND at < $3 ORDER BY symbol, at',
      [symbols, span.from, span.to] as never,
    ),
    symbols.length === 0 ? Promise.resolve([]) : rows<{ symbol: string; at: string; ask: number | null; mark: number | null }>(
      'SELECT symbol, at, ask, mark FROM option_snapshots WHERE symbol = ANY($1) AND at >= $2 AND at < $3 ORDER BY symbol, at',
      [symbols, span.from, span.to] as never,
    ),
    rows<{ at: string; high: number; low: number }>(
      'SELECT at, high, low FROM trade_flow_1m WHERE at >= $1 AND at < $2 AND high IS NOT NULL AND low IS NOT NULL ORDER BY at', [span.from, span.to]),
  ]);

  const levels = new Map(setups.map((s) => [levelKey(s.method, s.mode, s.tf, s.dir, Number(s.trigger_at)), { sl: s.stop, tp: { tp1: s.tp1, tp2: s.tp2, tp3: s.tp3 } }]));
  // The minute record where it has the contract; the five-minute record fills only the minutes it has none of (before 13 Oct 2026, all of them).
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
  const perp: PerpPath = { at: Float64Array.from(flow.map((f) => Number(f.at))), high: Float64Array.from(flow.map((f) => f.high)), low: Float64Array.from(flow.map((f) => f.low)) };
  return { taken, open, levels, paths, perp };
}

/**
 * Days already read, kept: an expiry day that has settled never changes, so a second look -- the SL moved, a switch
 * turned -- is arithmetic only. The day in progress is read again after a minute. At most `HELD_DAYS`, the least
 * recently used let go first.
 */
const HELD_DAYS = 45;
const TODAY_FRESH_MS = 60_000;
const held = new Map<string, { at: number; settled: boolean; data: Promise<DayData> }>();

function dayData(day: string, now: number): Promise<DayData> {
  const h = held.get(day);
  if (h && (h.settled || now - h.at < TODAY_FRESH_MS)) { held.delete(day); held.set(day, h); return h.data; }
  // Settled once its last trade could have been closed and journalled: ten minutes after 5:30 PM.
  const settled = now > sessionOf(day).to + 10 * MIN;
  const data = readDay(day);
  held.set(day, { at: now, settled, data });
  data.catch(() => { if (held.get(day)?.data === data) held.delete(day); });
  while (held.size > HELD_DAYS) held.delete(held.keys().next().value!);
  return data;
}

export function clearOptionReplayCache(): void { held.clear(); }

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

export async function optionReplay(o: OptionReplayAsk): Promise<OptionReplay> {
  const days = sessionDays(o.from, o.to);
  const [data, names, accounts, targets] = await Promise.all([
    // Four days at a time: each is a handful of indexed reads, and the pool is shared with the rest of the thread.
    (async () => { const out: DayData[] = []; for (let i = 0; i < days.length; i += 4) out.push(...await Promise.all(days.slice(i, i + 4).map((d) => dayData(d, o.now)))); return out; })(),
    methodNames(), accountNames(), targetKeys(),
  ]);
  const tfs = o.tfs ? new Set(o.tfs) : null;
  const methods = o.methods ? new Set(o.methods) : null;
  const actual = emptySide(), replay = emptySide();
  const exits: Record<ReplayExit, number> = { 'option-sl': 0, 'option-tgt': 0, 'perp-sl': 0, 'perp-tgt': 0, close: 0 };
  const groups = { day: new Map<string, ReplayGroup>(), tf: new Map<string, ReplayGroup>(), method: new Map<string, ReplayGroup>(), account: new Map<string, ReplayGroup>() };
  const into = (m: Map<string, ReplayGroup>, key: string, name: string, a: number, r: number) => {
    let g = m.get(key);
    if (!g) m.set(key, (g = { key, name, trades: 0, actual: emptySide(), replay: emptySide() }));
    g.trades++; count(g.actual, a); count(g.replay, r);
  };
  const out: OptionReplayRow[] = [];
  let open = 0, noPrices = 0;
  for (const d of data) {
    for (const t of d.taken) {
      if (o.account !== null && t.account !== o.account) continue;
      if (tfs && !tfs.has(t.tf)) continue;
      if (methods && !methods.has(t.method)) continue;
      if (o.window) { const m = contractMinute(t.enteredAt); if (m < o.window.from || m > o.window.to) continue; }
      const lv = d.levels.get(levelKey(t.method, t.mode, t.signalTf, t.dir, t.triggerTime));
      const perpSl = t.ownSl ?? lv?.sl ?? null;
      const perpTgt = t.ownTgt ?? lv?.tp[targets.get(t.strategyId ?? '') ?? 'tp1'] ?? lv?.tp.tp1 ?? null;
      const path = d.paths.get(t.symbol);
      const x = path ? replayExit({ ...t, perpSl, perpTgt }, o.rules, path, d.perp) : null;
      if (!x) { noPrices++; continue; }
      // Charges are a share of the premium, so one contract's share of the real trade is its net over its size.
      const size = o.oneContract ? 1 : t.contracts;
      const net = shortNetUsd(t.entry, x.price, size);
      const actualNet = o.oneContract ? t.actualNet / t.contracts : t.actualNet;
      count(actual, actualNet); count(replay, net); exits[x.why]++;
      const methodName = names.get(t.method) ?? t.method;
      into(groups.day, t.day, t.day, actualNet, net);
      into(groups.tf, t.tf, t.tf === CHAIN_KEY ? 'Chain' : t.tf, actualNet, net);
      into(groups.method, t.method, methodName, actualNet, net);
      const acct = t.account === null ? 'none' : String(t.account);
      into(groups.account, acct, accounts.get(acct) ?? (t.account === null ? 'No account' : `Account ${acct}`), actualNet, net);
      out.push({
        tradeId: t.tradeId, day: t.day, account: t.account, strategyId: t.strategyId, strategyName: t.strategyName,
        method: t.method, methodName, tf: t.tf, side: t.side, symbol: t.symbol, enteredAt: t.enteredAt, entry: t.entry, contracts: size,
        perpSl, perpTgt,
        actual: { exitAt: t.actualExitAt, exit: t.actualExit, netUsd: actualNet, why: t.actualWhy },
        replay: { exitAt: x.at, exit: x.price, netUsd: net, why: x.why },
      });
    }
    // Open trades are counted when nothing narrows the list: which timeframe or method they are of is not looked at.
    if (o.account === null && !tfs && !methods && !o.window) open += d.open;
  }
  out.sort((a, b) => b.enteredAt - a.enteredAt);
  const tfRank = (k: string) => { const i = REPLAY_TFS.indexOf(k); return i < 0 ? REPLAY_TFS.length : i; };
  const byChange = (a: ReplayGroup, b: ReplayGroup) => (b.replay.netUsd - b.actual.netUsd) - (a.replay.netUsd - a.actual.netUsd);
  return {
    from: o.from, to: o.to, rules: o.rules, oneContract: o.oneContract ?? false, actual, replay, exits, open, noPrices,
    days: [...groups.day.values()].sort((a, b) => b.key.localeCompare(a.key)),
    timeframes: [...groups.tf.values()].sort((a, b) => tfRank(a.key) - tfRank(b.key)),
    methods: [...groups.method.values()].sort(byChange),
    accounts: [...groups.account.values()].sort((a, b) => a.key.localeCompare(b.key, 'en', { numeric: true })),
    rows: out.slice(0, REPLAY_ROWS_MAX), rowsCut: out.length > REPLAY_ROWS_MAX,
  };
}
