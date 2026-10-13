import { migrate, type Migration } from '../db/migrate.js';
import { query, rows } from '../db/pool.js';
import { flowSchema } from '../market/flow.js';
import { entrySchema } from '../entry/paper.js';
import { methodsSchema } from '../entry/catalogue.js';
import { CHAIN_KEY, closedNet } from '../trading/pnl-history.js';
import { exitByOf } from '../strategy/store.js';
import type { TradeRecord } from '../trading/engine.js';
import {
  FAMILIES, MARKET_DAY_VERSION, MIN_BARS, PATTERNS, classify, dayStats, familyOf, sessionDayOf, sessionDays, sessionOf,
  type DayStats, type MinuteBar, type PatternFamily, type PatternKey,
} from './market-day.js';

/**
 * The market report (owner, 13 Oct 2026): every expiry day from 1 Oct on -- what kind of day the BTC perp had
 * (`market-day.ts`) -- and, against it, what the methods made on it. Two records side by side:
 *
 *   the signal history   every signal that went "in the trade" that day, on the perp: points and R, closed at
 *                        its target, its stop, or on time;
 *   the real orders      what the strategies really sold on those signals: money after charges, closed by the
 *                        perp's target or stop, the option's own target or stop, the window's end, or by hand.
 *
 * A trade belongs to the expiry day it was entered in -- a signal by its fill on the perp, an order by its first
 * entry fill -- so a day's results are the results of the trades that day's market produced, wherever they ended.
 *
 * Read by method, timeframe, strategy and exit, for one day, one of the twenty kinds of day, one of their four
 * families, or all of them. With a dozen days on record most kinds have one day or two behind them: every group
 * carries its count of days, and the families are there because they fill sooner.
 *
 * A finished day's figures are worked out once and kept (`market_days`); the day in progress is worked out as
 * it is asked for. Trades and signals are added up in memory and kept for a minute while their day is recent,
 * and for good once it is old enough not to change.
 */

const MIGRATIONS: Migration[] = [{
  id: 'report-001-market-days',
  up: `
    CREATE TABLE IF NOT EXISTS market_days (
      day         TEXT    PRIMARY KEY,
      from_ms     BIGINT  NOT NULL,
      to_ms       BIGINT  NOT NULL,
      bars        INTEGER NOT NULL,
      version     INTEGER NOT NULL,
      -- Null with too little of the tape to say anything about the day.
      stats       JSONB,
      pattern     TEXT,
      why         TEXT,
      computed_at BIGINT  NOT NULL
    );
  `,
}];
let ready: Promise<void> | null = null;
export function marketSchema(): Promise<void> {
  ready ??= migrate(MIGRATIONS).then(() => {}, (e) => { ready = null; throw e; });
  return ready;
}

/** The first expiry day the report offers: nothing before it is asked for by default. */
export const REPORT_FIRST_DAY = '2026-10-01';
/** The most expiry days one request may cover. */
export const REPORT_MAX_DAYS = 190;

export type MarketDay = {
  day: string; from: number; to: number;
  /** Still running: its figures are of the day so far. */
  live: boolean;
  bars: number;
  stats: DayStats | null;
  pattern: PatternKey | null;
  why: string | null;
};

const HOUR = 3_600_000;

async function barsBetween(from: number, to: number): Promise<MinuteBar[]> {
  await flowSchema();
  const xs = await rows<{ at: string; high: number; low: number; vwap: number }>(
    'SELECT at, high, low, vwap FROM trade_flow_1m WHERE at >= $1 AND at < $2 AND high IS NOT NULL AND low IS NOT NULL AND vwap IS NOT NULL ORDER BY at', [from, to]);
  return xs.map((x) => ({ at: Number(x.at), high: Number(x.high), low: Number(x.low), close: Number(x.vwap) }));
}

const shiftDay = (day: string, by: number) => new Date(Date.parse(`${day}T00:00:00Z`) + by * 86_400_000).toISOString().slice(0, 10);

let working: Promise<unknown> = Promise.resolve();

/**
 * The expiry days from `from` to `to`, oldest first. Finished days not yet kept (or kept by an older version of
 * the rules) are worked out from the tape and kept; the day in progress is worked out now and not kept.
 */
export function marketDays(from: string, to: string, now = Date.now()): Promise<MarketDay[]> {
  // One at a time: two screens asking at once must not both work the same missing days out.
  const run = working.then(() => marketDaysNow(from, to, now));
  working = run.catch(() => {});
  return run;
}

type Stored = { day: string; from_ms: string; to_ms: string; bars: number; version: number; stats: DayStats | null; pattern: PatternKey | null; why: string | null };

async function marketDaysNow(from: string, to: string, now: number): Promise<MarketDay[]> {
  await marketSchema();
  const today = sessionDayOf(now);
  const days = sessionDays(from, to < today ? to : today);
  if (days.length === 0) return [];
  const finished = days.filter((d) => d < today);
  const read = () => rows<Stored>('SELECT day, from_ms, to_ms, bars, version, stats, pattern, why FROM market_days WHERE day >= $1 AND day <= $2 AND version = $3', [shiftDay(days[0]!, -31), days[days.length - 1]!, MARKET_DAY_VERSION]);
  let stored = new Map((await read()).map((x) => [x.day, x]));
  const missing = finished.filter((d) => !stored.has(d));

  if (missing.length > 0) {
    // From thirty days before the first missing one: a day's ATR is ranked against the days before it.
    const first = shiftDay(missing[0]!, -30), last = missing[missing.length - 1]!;
    const bars = await barsBetween(sessionOf(first).from, sessionOf(last).to);
    const byDay = new Map<string, MinuteBar[]>();
    for (const b of bars) { const d = sessionDayOf(b.at); const a = byDay.get(d); if (a) a.push(b); else byDay.set(d, [b]); }
    const prior: number[] = [];
    for (const day of sessionDays(first, last)) {
      const xs = byDay.get(day) ?? [];
      // A day with most of its tape missing is not ranked, and ranks nothing after it.
      const stats = xs.length >= MIN_BARS * 10 ? dayStats(xs, prior) : null;
      if (stats) prior.push(stats.atr);
      if (!missing.includes(day)) continue;
      const named = stats ? classify(stats) : null;
      const s = sessionOf(day);
      await query(
        `INSERT INTO market_days (day, from_ms, to_ms, bars, version, stats, pattern, why, computed_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (day) DO UPDATE SET from_ms = EXCLUDED.from_ms, to_ms = EXCLUDED.to_ms, bars = EXCLUDED.bars, version = EXCLUDED.version,
                                         stats = EXCLUDED.stats, pattern = EXCLUDED.pattern, why = EXCLUDED.why, computed_at = EXCLUDED.computed_at`,
        [day, s.from, s.to, xs.length, MARKET_DAY_VERSION, stats ? JSON.stringify(stats) : null, named?.key ?? null, named?.why ?? null, now],
      );
    }
    stored = new Map((await read()).map((x) => [x.day, x]));
  }

  const out: MarketDay[] = finished.map((day) => {
    const x = stored.get(day);
    const s = sessionOf(day);
    return { day, from: s.from, to: s.to, live: false, bars: x?.bars ?? 0, stats: x?.stats ?? null, pattern: x?.pattern ?? null, why: x?.why ?? null };
  });
  if (days.includes(today)) {
    const s = sessionOf(today);
    const xs = await barsBetween(s.from, s.to);
    const prior = [...stored.values()].filter((x) => x.day < today && x.stats).sort((a, b) => a.day.localeCompare(b.day)).map((x) => x.stats!.atr);
    const stats = dayStats(xs, prior);
    const named = stats ? classify(stats) : null;
    out.push({ day: today, from: s.from, to: s.to, live: true, bars: xs.length, stats, pattern: named?.key ?? null, why: named?.why ?? null });
  }
  return out;
}

// ------------------------------------------------------------------ results

export type ExitKey = 'perp-tgt' | 'perp-sl' | 'option-tgt' | 'option-sl' | 'window-end' | 'manual' | 'timeout';
export const EXIT_KEYS: readonly ExitKey[] = ['perp-tgt', 'perp-sl', 'option-tgt', 'option-sl', 'timeout', 'window-end', 'manual'];

/**
 * A count of trades and what they made. `net` is BTC perp points for the signal history and US dollars after
 * charges for real orders; `netR` is the signal history's R and 0 for orders. `open` are not in `n`.
 */
export type Tot = {
  n: number; wins: number; losses: number; open: number;
  net: number; won: number; lost: number; netR: number;
  exits: Partial<Record<ExitKey, { n: number; net: number }>>;
};
export const zeroTot = (): Tot => ({ n: 0, wins: 0, losses: 0, open: 0, net: 0, won: 0, lost: 0, netR: 0, exits: {} });
export function addTot(a: Tot, b: Tot): Tot {
  a.n += b.n; a.wins += b.wins; a.losses += b.losses; a.open += b.open;
  a.net += b.net; a.won += b.won; a.lost += b.lost; a.netR += b.netR;
  for (const k of EXIT_KEYS) {
    const x = b.exits[k];
    if (!x) continue;
    const mine = a.exits[k] ?? (a.exits[k] = { n: 0, net: 0 });
    mine.n += x.n; mine.net += x.net;
  }
  return a;
}

/** One method on one timeframe on one expiry day -- and, for real orders, of one strategy on one account. */
export type Cell = {
  day: string; method: string; mode: 'single' | 'mtf'; tf: string;
  strategy: string | null; account: number | null;
  tot: Tot;
};

/** A day's cells are kept this long while the day can still change, and for good after. */
const FRESH_MS = 60_000;
/** A signal filled in a day may close days later (a 4h setup is held for bars); an order cannot outlive its expiry. */
const SIGNALS_SETTLED_MS = 4 * 86_400_000;
const ORDERS_SETTLED_MS = 12 * HOUR;

type Held = { at: number; cells: Cell[] };
const signalHeld = new Map<string, Held>();
const orderHeld = new Map<string, Held>();
/** What an order no strategy placed is listed under. */
const BY_HAND = 'By hand';

/** For tests, and for a rule change: forget what is held. */
export function clearMarketReportCache(): void { signalHeld.clear(); orderHeld.clear(); }

const stale = (held: Map<string, Held>, day: string, now: number, settledMs: number): boolean => {
  const h = held.get(day);
  if (!h) return true;
  // Read after the day could no longer change: good for as long as the process runs.
  if (h.at >= sessionOf(day).to + settledMs) return false;
  return now - h.at > FRESH_MS;
};

async function signalCells(days: readonly string[], now: number): Promise<Cell[]> {
  const need = days.filter((d) => stale(signalHeld, d, now, SIGNALS_SETTLED_MS));
  if (need.length > 0) {
    await entrySchema();
    const from = sessionOf(need[0]!).from, to = sessionOf(need[need.length - 1]!).to;
    const xs = await rows<Record<string, string | number | null>>(
      `SELECT to_char(to_timestamp(filled_at) AT TIME ZONE 'Asia/Kolkata' + interval '6 hours 30 minutes', 'YYYY-MM-DD') AS day,
              method, mode, tf, status,
              count(*) AS n,
              count(*) FILTER (WHERE r_net > 0) AS wins,
              coalesce(sum((exit_price - fill_price) * dir), 0) AS pts,
              coalesce(sum((exit_price - fill_price) * dir) FILTER (WHERE (exit_price - fill_price) * dir > 0), 0) AS won,
              coalesce(sum(r_net), 0) AS r
         FROM entry_setups
        WHERE filled_at IS NOT NULL AND filled_at >= $1 AND filled_at < $2
          -- a setup is filled within bars of being seen: the index on first_seen keeps this off the whole table
          AND first_seen >= $3
          AND status IN ('filled', 'tp1', 'stop', 'timeout')
        GROUP BY 1, method, mode, tf, status`,
      [Math.floor(from / 1_000), Math.floor(to / 1_000), from - 5 * 86_400_000],
    );
    const by = new Map<string, Cell>();
    for (const x of xs) {
      const day = String(x.day);
      const key = `${day}|${x.method}|${x.mode}|${x.tf}`;
      const cell = by.get(key) ?? { day, method: String(x.method), mode: x.mode === 'mtf' ? 'mtf' as const : 'single' as const, tf: String(x.tf), strategy: null, account: null, tot: zeroTot() };
      by.set(key, cell);
      const n = Number(x.n), t = cell.tot;
      if (x.status === 'filled') { t.open += n; continue; }
      const pts = Number(x.pts), won = Number(x.won), wins = Number(x.wins);
      t.n += n; t.wins += wins; t.losses += n - wins; t.net += pts; t.won += won; t.lost += won - pts; t.netR += Number(x.r);
      const exit: ExitKey = x.status === 'tp1' ? 'perp-tgt' : x.status === 'stop' ? 'perp-sl' : 'timeout';
      const e = t.exits[exit] ?? (t.exits[exit] = { n: 0, net: 0 });
      e.n += n; e.net += pts;
    }
    for (const d of need) signalHeld.set(d, { at: now, cells: [] });
    for (const c of by.values()) signalHeld.get(c.day)?.cells.push(c);
  }
  return days.flatMap((d) => signalHeld.get(d)?.cells ?? []);
}

async function orderCells(days: readonly string[], now: number, spot: number | null): Promise<Cell[]> {
  const need = days.filter((d) => stale(orderHeld, d, now, ORDERS_SETTLED_MS));
  if (need.length > 0) {
    const from = sessionOf(need[0]!).from, to = sessionOf(need[need.length - 1]!).to;
    // By when a trade last changed: one entered in a day changed at or after its entry, and for the last time by its expiry.
    const xs = await rows<{ broker_account_id: string | null; plan: TradeRecord['plan']; state: TradeRecord['state'] }>(
      `SELECT broker_account_id, plan, state FROM trades
        WHERE updated_at >= $1 AND updated_at < $2 AND plan->>'origin' = 'strategy' AND plan ? 'signal'`,
      [from, to + ORDERS_SETTLED_MS],
    ).catch((e: Error) => {
      // A desk that has never placed an order has no journal yet: no orders, not an error.
      if (/relation "trades" does not exist/.test(e.message)) return [];
      throw e;
    });
    const wanted = new Set(need);
    const by = new Map<string, Cell>();
    for (const x of xs) {
      const sig = x.plan.signal;
      const entries = (x.state.fills ?? []).filter((f) => f.role === 'entry');
      if (!sig || entries.length === 0) continue;
      const day = sessionDayOf(Math.min(...entries.map((f) => f.ts)));
      if (!wanted.has(day)) continue;
      // By the name it was placed under: a strategy deleted and made again, or cloned under the same name, is one line.
      const strategy = x.plan.strategyName ?? x.plan.strategyId ?? BY_HAND;
      const account = x.broker_account_id === null ? null : Number(x.broker_account_id);
      const key = `${day}|${sig.method}|${sig.mode}|${sig.tf}|${strategy}|${account}`;
      const cell = by.get(key) ?? { day, method: sig.method, mode: sig.mode, tf: sig.tf, strategy, account, tot: zeroTot() };
      by.set(key, cell);
      const t = cell.tot;
      const closed = closedNet({ plan: x.plan, state: x.state, events: [] }, spot);
      if (!closed) { if (x.state.position !== 0) t.open += 1; continue; }
      const net = closed.netUsd;
      t.n += 1; t.net += net;
      if (net > 0) { t.wins += 1; t.won += net; } else { t.losses += 1; t.lost -= net; }
      const exit: ExitKey = exitByOf(x.state.exitReason ?? null, x.state.exitWinner ?? null);
      const e = t.exits[exit] ?? (t.exits[exit] = { n: 0, net: 0 });
      e.n += 1; e.net += net;
    }
    for (const d of need) orderHeld.set(d, { at: now, cells: [] });
    for (const c of by.values()) orderHeld.get(c.day)?.cells.push(c);
  }
  return days.flatMap((d) => orderHeld.get(d)?.cells ?? []);
}

// ------------------------------------------------------------------ the report

export type ReportFilters = {
  /** Real orders of this broker account only; null, every account's. The signal history has no account. */
  account: number | null;
  /** Only these timeframes (`chain` for the timeframe chain), methods and strategies (by name); null, all. */
  tfs: readonly string[] | null; methods: readonly string[] | null; strategies: readonly string[] | null;
};

/** The timeframe a cell is filtered and listed under: its own, or `chain` when read with the timeframe chain. */
const tfKeyOf = (c: Pick<Cell, 'mode' | 'tf'>) => (c.mode === 'mtf' ? CHAIN_KEY : c.tf);
const tfLabelOf = (c: Pick<Cell, 'mode' | 'tf'>) => (c.mode === 'mtf' ? `${c.tf} + TF chain` : c.tf);
const TF_ORDER = ['1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', CHAIN_KEY];
const tfPlace = (k: string) => { const i = TF_ORDER.indexOf(k); return i === -1 ? TF_ORDER.length : i; };

export type Row = Tot & { key: string; name: string; tf?: string };
export type Side = { total: Tot; pairs: Row[]; byTf: Row[]; byMethod: Row[]; byStrategy: Row[] };

function grouped(cells: readonly Cell[], keyOf: (c: Cell) => string, nameOf: (c: Cell) => { name: string; tf?: string }): Row[] {
  const by = new Map<string, Row>();
  for (const c of cells) {
    const key = keyOf(c);
    const row = by.get(key) ?? { key, ...nameOf(c), ...zeroTot() };
    by.set(key, row);
    addTot(row, c.tot);
  }
  return [...by.values()];
}
const totalOf = (cells: readonly Cell[]): Tot => cells.reduce((t, c) => addTot(t, c.tot), zeroTot());
/** Most made first; level on that, the one with more trades behind it. */
const byNet = (a: Row, b: Row) => b.net - a.net || b.n - a.n;

type Names = { method: (id: string) => string };

function sideOf(cells: readonly Cell[], names: Names): Side {
  return {
    total: totalOf(cells),
    pairs: grouped(cells, (c) => `${c.method}|${c.mode}|${c.tf}`, (c) => ({ name: names.method(c.method), tf: tfLabelOf(c) })).sort(byNet),
    byTf: grouped(cells, tfKeyOf, (c) => ({ name: c.mode === 'mtf' ? 'With timeframe chain' : c.tf })).sort((a, b) => tfPlace(a.key) - tfPlace(b.key)),
    byMethod: grouped(cells, (c) => c.method, (c) => ({ name: names.method(c.method) })).sort(byNet),
    byStrategy: grouped(cells.filter((c) => c.strategy !== null), (c) => c.strategy!, (c) => ({ name: c.strategy! })).sort(byNet),
  };
}

/** The three best and the three worst pairs of a group: only pairs with a closed trade, a pair in at most one list. */
function ends(pairs: readonly Row[]): { best: Row[]; worst: Row[] } {
  const closed = pairs.filter((p) => p.n > 0);
  return { best: closed.filter((p) => p.net > 0).sort(byNet).slice(0, 3), worst: closed.filter((p) => p.net < 0).sort((a, b) => a.net - b.net || b.n - a.n).slice(0, 3) };
}

/** What a method or a strategy made, for the list it is chosen from: closed trades, how many won, and the net in the record's own unit. */
export type Made = { n: number; wins: number; net: number };
const madeOf = (cells: readonly Cell[]): Made => { const t = totalOf(cells); return { n: t.n, wins: t.wins, net: t.net }; };

export type GroupRow = {
  key: string; name: string; meaning?: string; id?: number;
  /** The expiry days of this kind in the range, oldest first. */
  days: string[];
  signal: Tot; real: Tot;
  signalEnds: { best: Row[]; worst: Row[] }; realEnds: { best: Row[]; worst: Row[] };
};

export type MarketReport = {
  from: string; to: string;
  days: (MarketDay & { family: PatternFamily | null; signal: Tot; real: Tot })[];
  total: { signal: Tot; real: Tot };
  /** The three best and the three worst pairs of the whole range, in each record. */
  ends: { signal: { best: Row[]; worst: Row[] }; real: { best: Row[]; worst: Row[] } };
  patterns: GroupRow[]; families: GroupRow[];
  catalogue: typeof PATTERNS;
  /**
   * What there is to filter by in the range. The timeframes are every one there is. Each method carries what it
   * made in both records, and each strategy what its orders made, as the other filters leave them -- a list is
   * never narrowed by its own choice, so what is ticked can be seen beside what is not.
   */
  choices: {
    timeframes: { key: string; name: string }[];
    methods: { key: string; name: string; signal: Made; real: Made }[];
    strategies: ({ key: string; name: string } & Made)[];
  };
};

async function namesOf(): Promise<Names> {
  await methodsSchema();
  const ms = await rows<{ id: string; n: number | null; name: string }>('SELECT id, n, name FROM entry_methods');
  const method = new Map(ms.map((m) => [m.id, m.n === null ? m.name : `#${m.n} ${m.name}`]));
  return { method: (id) => method.get(id) ?? id };
}

const kept = (cells: readonly Cell[], f: ReportFilters, real: boolean): Cell[] => cells.filter((c) =>
  (!f.tfs || f.tfs.includes(tfKeyOf(c)))
  && (!f.methods || f.methods.includes(c.method))
  && (!real || ((f.account === null || c.account === f.account) && (!f.strategies || f.strategies.includes(c.strategy ?? BY_HAND)))));

type Read = { days: MarketDay[]; signal: Cell[]; real: Cell[]; every: { signal: Cell[]; real: Cell[] }; names: Names };

async function readAll(o: { from: string; to: string; now: number; spot: number | null } & ReportFilters): Promise<Read> {
  const days = await marketDays(o.from, o.to, o.now);
  const ids = days.map((d) => d.day);
  const [signal, real] = await Promise.all([signalCells(ids, o.now), orderCells(ids, o.now, o.spot)]);
  return { days, signal: kept(signal, o, false), real: kept(real, o, true), every: { signal, real }, names: await namesOf() };
}

/** The whole range: each day with its kind and its results, and the results by kind of day and by family. */
export async function marketReport(o: { from: string; to: string; now: number; spot: number | null } & ReportFilters): Promise<MarketReport> {
  const r = await readAll(o);
  const of = (cells: readonly Cell[], days: ReadonlySet<string>) => cells.filter((c) => days.has(c.day));
  const group = (key: string, name: string, days: string[], extra: Partial<GroupRow> = {}): GroupRow => {
    const set = new Set(days);
    const s = sideOf(of(r.signal, set), r.names), x = sideOf(of(r.real, set), r.names);
    return { key, name, ...extra, days, signal: s.total, real: x.total, signalEnds: ends(s.pairs), realEnds: ends(x.pairs) };
  };
  const named = r.days.filter((d) => d.pattern !== null);
  const choices = [...r.every.signal, ...r.every.real.filter((c) => o.account === null || c.account === o.account)];
  const distinct = (xs: { key: string; name: string }[]) => [...new Map(xs.map((x) => [x.key, x])).values()];
  // Each list from what the other choices leave, and not narrowed by its own.
  const butMethods = { signal: kept(r.every.signal, { ...o, methods: null }, false), real: kept(r.every.real, { ...o, methods: null }, true) };
  const butStrategies = kept(r.every.real, { ...o, strategies: null }, true);
  return {
    from: o.from, to: o.to,
    days: r.days.map((d) => ({
      ...d, family: d.pattern ? familyOf(d.pattern) : null,
      signal: totalOf(r.signal.filter((c) => c.day === d.day)), real: totalOf(r.real.filter((c) => c.day === d.day)),
    })),
    total: { signal: totalOf(r.signal), real: totalOf(r.real) },
    ends: { signal: ends(sideOf(r.signal, r.names).pairs), real: ends(sideOf(r.real, r.names).pairs) },
    patterns: PATTERNS.filter((p) => named.some((d) => d.pattern === p.key))
      .map((p) => group(p.key, p.name, named.filter((d) => d.pattern === p.key).map((d) => d.day), { id: p.id, meaning: p.meaning })),
    families: FAMILIES.filter((f) => named.some((d) => familyOf(d.pattern!) === f.key))
      .map((f) => group(f.key, f.name, named.filter((d) => familyOf(d.pattern!) === f.key).map((d) => d.day))),
    catalogue: PATTERNS,
    choices: {
      timeframes: distinct(choices.map((c) => ({ key: tfKeyOf(c), name: c.mode === 'mtf' ? 'With timeframe chain' : c.tf }))).sort((a, b) => tfPlace(a.key) - tfPlace(b.key)),
      methods: distinct(choices.map((c) => ({ key: c.method, name: r.names.method(c.method) })))
        .map((m) => ({ ...m, signal: madeOf(butMethods.signal.filter((c) => c.method === m.key)), real: madeOf(butMethods.real.filter((c) => c.method === m.key)) }))
        .sort((a, b) => a.name.localeCompare(b.name, 'en', { numeric: true })),
      strategies: distinct(r.every.real.filter((c) => o.account === null || c.account === o.account).map((c) => ({ key: c.strategy ?? BY_HAND, name: c.strategy ?? BY_HAND })))
        .map((s) => ({ ...s, ...madeOf(butStrategies.filter((c) => (c.strategy ?? BY_HAND) === s.key)) }))
        .sort((a, b) => a.name.localeCompare(b.name, 'en', { numeric: true })),
    },
  };
}

export type Scope = { kind: 'all' } | { kind: 'day'; day: string } | { kind: 'pattern'; key: PatternKey } | { kind: 'family'; key: PatternFamily };

/** One day, one kind of day, one family, or the whole range: both records by pair, timeframe, method and strategy. */
export async function marketBreakdown(o: { from: string; to: string; now: number; spot: number | null; scope: Scope } & ReportFilters): Promise<{ scope: Scope; days: string[]; signal: Side; real: Side }> {
  const r = await readAll(o);
  const s = o.scope;
  const days = new Set(r.days.filter((d) =>
    s.kind === 'all' ? true
      : s.kind === 'day' ? d.day === s.day
        : s.kind === 'pattern' ? d.pattern === s.key
          : d.pattern !== null && familyOf(d.pattern) === s.key).map((d) => d.day));
  return {
    scope: s, days: [...days],
    signal: sideOf(r.signal.filter((c) => days.has(c.day)), r.names),
    real: sideOf(r.real.filter((c) => days.has(c.day)), r.names),
  };
}
