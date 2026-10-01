import { query, rows, type Param } from '../db/pool.js';
import { migrate, type Migration } from '../db/migrate.js';
import { TF_SEC, type MethodRead, type SetupClock, type Tf } from './types.js';
import { METHODS } from './methods.js';
import { entrySchema, fillByOf, fillExitOf, timeoutAtOf } from './paper.js';
import { SINGLE_TFS } from './engine.js';
import { alertsSchema } from './alerts.js';

/**
 * The signal journal: every signal the entry engine gives -- every WAIT and
 * every TRADE, on every timeframe, with the chain and without it -- written on
 * the server, so nothing depends on a screen being open to be remembered.
 *
 * One row per setup per state: a setup is its method, way, timeframe,
 * direction and the bar its trigger closed on; a WAIT that becomes a TRADE is
 * two rows. A signal seen again the next minute is not a new row -- its
 * `last_seen` moves, so the journal also says how long each one stood.
 *
 * The paper log (entry_setups) is the other half: it grades the TRADEs. This
 * table is what was *shown*, graded or not.
 */

const MIGRATIONS: Migration[] = [{
  id: 'entry-005-signals',
  up: `
    CREATE TABLE IF NOT EXISTS entry_signals (
      id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      method      TEXT             NOT NULL,
      mode        TEXT             NOT NULL CHECK (mode IN ('mtf', 'single')),
      tf          TEXT             NOT NULL,
      dir         SMALLINT         NOT NULL CHECK (dir IN (-1, 1)),
      state       TEXT             NOT NULL CHECK (state IN ('WAIT', 'TRADE')),
      trigger_at  BIGINT           NOT NULL,
      first_seen  BIGINT           NOT NULL,
      last_seen   BIGINT           NOT NULL,
      score       SMALLINT,
      reason      TEXT             NOT NULL,
      entry_lo    DOUBLE PRECISION,
      entry_hi    DOUBLE PRECISION,
      stop        DOUBLE PRECISION,
      tp1         DOUBLE PRECISION,
      rr          DOUBLE PRECISION,
      gates_off   TEXT[]           NOT NULL DEFAULT '{}',
      UNIQUE (method, mode, tf, dir, trigger_at, state)
    );
    CREATE INDEX IF NOT EXISTS entry_signals_by_time ON entry_signals (first_seen DESC);
  `,
}, {
  // The market when the signal was first seen: the perpetual's last trade and Delta's BTC index.
  id: 'entry-007-signal-prices',
  up: `
    ALTER TABLE entry_signals ADD COLUMN IF NOT EXISTS ltp DOUBLE PRECISION;
    ALTER TABLE entry_signals ADD COLUMN IF NOT EXISTS index_price DOUBLE PRECISION;
  `,
}, {
  // 1m without the chain is view-only from 1 Oct 2026 (engine.ts SINGLE_TFS): its signals leave the history.
  // The chain's rows are kept -- its entry is 5m. The paper log (entry_setups) is left as it was.
  id: 'entry-008-signals-no-1m',
  up: `DELETE FROM entry_signals WHERE mode = 'single' AND tf = '1m';`,
}, {
  // The whole plan, not just TP1: TP2, TP3, and why each level is where it is (owner's SL/TP table, 1 Oct 2026).
  // Older rows keep NULLs -- their reasons were never recorded, and none is made up for them.
  id: 'entry-011-signal-targets',
  up: `
    ALTER TABLE entry_signals ADD COLUMN IF NOT EXISTS tp2 DOUBLE PRECISION;
    ALTER TABLE entry_signals ADD COLUMN IF NOT EXISTS tp3 DOUBLE PRECISION;
    ALTER TABLE entry_signals ADD COLUMN IF NOT EXISTS stop_why TEXT;
    ALTER TABLE entry_signals ADD COLUMN IF NOT EXISTS tp_why TEXT[];
  `,
}];

let ready: Promise<void> | null = null;
export function signalsSchema(): Promise<void> {
  if (ready) return ready;
  ready = migrate(MIGRATIONS).then(() => {}, (e) => { ready = null; throw e; });
  return ready;
}

/** Signals kept this long; the paper log keeps its graded TRADEs for good. */
export const SIGNALS_KEEP_DAYS = 365;

/**
 * Write every WAIT and TRADE read once, and move `last_seen` on those already
 * written. Returns how many were new.
 */
export async function recordSignals(
  reads: readonly MethodRead[], nowMs: number,
  /** The market now -- written on a signal's first sighting only, so it is the price when it appeared. */
  prices: { ltp?: number | null; index?: number | null } = {},
): Promise<number> {
  await signalsSchema();
  let fresh = 0;
  for (const r of reads) {
    if ((r.state !== 'WAIT' && r.state !== 'TRADE') || r.dir === null || r.triggerTime === null) continue;
    if (r.mode === 'single' && !SINGLE_TFS.includes(r.tf)) continue; // 1m is view-only: never a signal
    const p = r.state === 'TRADE' ? r.plan : null;
    const res = await rows<{ inserted: boolean }>(
      `INSERT INTO entry_signals (method, mode, tf, dir, state, trigger_at, first_seen, last_seen, score, reason,
                                  entry_lo, entry_hi, stop, tp1, rr, gates_off, ltp, index_price, tp2, tp3, stop_why, tp_why)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21)
       ON CONFLICT (method, mode, tf, dir, trigger_at, state) DO UPDATE SET last_seen = EXCLUDED.last_seen
       RETURNING (xmax = 0) AS inserted`,
      [r.id, r.mode, r.tf, r.dir === 'long' ? 1 : -1, r.state, r.triggerTime, nowMs, r.score, r.reason,
        p?.entryLo ?? null, p?.entryHi ?? null, p?.stop ?? null, p?.tp1 ?? null, p?.rr ?? null,
        r.gates.filter((g) => !g.enabled).map((g) => g.key), prices.ltp ?? null, prices.index ?? null,
        p?.tp2 ?? null, p?.tp3 ?? null, p?.why?.stop ?? null, p?.why ? [p.why.tp1, p.why.tp2, p.why.tp3] : null],
    );
    if (res[0]?.inserted) fresh += 1;
  }
  return fresh;
}

/** Drop signals older than the keep period. Returns how many went. */
export async function pruneSignals(nowMs: number, keepDays = SIGNALS_KEEP_DAYS): Promise<number> {
  await signalsSchema();
  const res = await query('DELETE FROM entry_signals WHERE last_seen < $1', [nowMs - keepDays * 86_400_000]);
  return res.rowCount ?? 0;
}

export type SignalRow = {
  method: string; mode: 'mtf' | 'single'; tf: Tf; dir: 1 | -1; state: 'WAIT' | 'TRADE';
  triggerAt: number; firstSeen: number; lastSeen: number; score: number | null; reason: string;
  entryLo: number | null; entryHi: number | null; stop: number | null; tp1: number | null; rr: number | null;
  gatesOff: string[];
  /** The method's number and name, for the screen. */
  n: number | null; name: string;
  /** The market when it was first seen: the perpetual's last trade, Delta's BTC index. */
  ltp: number | null; indexPrice: number | null;
  /**
   * What became of a TRADE in the paper log: open (waiting for price), filled,
   * tp1, stop, timeout, expired -- with the fill, the exit and R.
   * Null for a WAIT, or a TRADE the log has not written.
   */
  outcome: SignalOutcome | null;
  /** The rest of the plan: TP2, TP3, and why the stop and each target are where they are (null on rows before 1 Oct 2026). */
  tp2: number | null; tp3: number | null;
  why: { stop: string | null; tp1: string | null; tp2: string | null; tp3: string | null } | null;
  /** When the trigger bar closed (epoch s) -- the earliest the signal could be known. */
  barCloseAt: number;
  /** How long after that close the server first saw it (ms): the recorder runs each minute + 3 s. */
  seenAfterMs: number;
  /** The Telegram alert for it, if one was tried: when (epoch ms) and whether it went. */
  alert: { at: number; status: 'sent' | 'failed' } | null;
};

export type SignalOutcome = {
  status: string; fillPrice: number | null; exitPrice: number | null; exitAt: number | null; rNet: number | null;
  /** The 1m bar the fill came in (epoch s), and until when it could have (fill window). */
  filledAt: number | null; fillBy: number;
  /** When a filled trade is closed on time if nothing else came first (epoch s). */
  timeoutAt: number | null;
  /** The zone's near edge, where a resting limit fills, and how many points better the fill was (opened inside). */
  fillEdge: number; fillBetterPts: number | null;
  /** The level the exit was aimed at (stop or TP1), how many points past it, and why: at the level, a gap, or time. */
  exitLevel: number | null; exitPastPts: number | null; exitWhy: 'level' | 'gap' | 'time' | null;
  /** TGT1 / TGT2 / TGT3: when each was reached (the 1m bar, epoch s), null if not (yet). */
  tp1At: number | null; tp2At: number | null; tp3At: number | null;
  /** After TP1, the runner with its stop at breakeven: still running, or how it ended. */
  runner: 'running' | 'done' | null; runnerEnd: 'be' | 'tp2' | 'tp3' | 'timeout' | null;
};


/** The setup's paper-log row: the outcome the screen shows, with its times and how the exit stood against the plan. */
function outcomeOf(r: Record<string, unknown>, tf: Tf): SignalOutcome {
  const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
  const dir = Number(r.e_dir) === 1 ? 1 : -1;
  const fx = fillExitOf({
    dir, status: String(r.e_status), entryLo: Number(r.e_lo), entryHi: Number(r.e_hi), stop: Number(r.e_stop), tp1: Number(r.e_tp1),
    fillPrice: num(r.e_fill), exitPrice: num(r.e_exit),
  });
  const filledAt = num(r.e_filled_at);
  return {
    status: String(r.e_status), fillPrice: num(r.e_fill), exitPrice: num(r.e_exit), exitAt: num(r.e_exit_at), rNet: num(r.e_r),
    filledAt, fillBy: fillByOf(Number(r.e_trigger), Number(r.e_first_seen), tf),
    timeoutAt: filledAt === null ? null : timeoutAtOf(filledAt, tf),
    fillEdge: fx.edge, fillBetterPts: fx.fillBetterPts, exitLevel: fx.level, exitPastPts: fx.pastPts, exitWhy: fx.why,
    tp1At: num(r.e_tp1_at), tp2At: num(r.e_tp2_at), tp3At: num(r.e_tp3_at),
    runner: (r.e_runner as SignalOutcome['runner']) ?? null, runnerEnd: (r.e_runner_end as SignalOutcome['runnerEnd']) ?? null,
  };
}

export type SignalQuery = {
  limit?: number; offset?: number;
  mode?: string; tf?: string; state?: string; since?: number;
  /** 1 BUY, -1 SELL. */
  dir?: number;
  /** Only TRADEs still in play: waiting at the zone or filled, not yet out (TP1, stop or time-out). */
  live?: boolean;
  /** Column to sort by, newest / highest first unless `asc`. */
  sort?: SignalSort;
  asc?: boolean;
};

/** Sortable columns, by name: a fixed list, never the caller's text in the SQL. */
const ORDER_OF = (col: string, xs: readonly string[]) => `array_position(ARRAY[${xs.map((x) => `'${x}'`).join(', ')}]::text[], ${col})`;
/**
 * Every column of the history's table, by name, to its SQL: a fixed list,
 * never the caller's text. Some are two keys (a way and its timeframe).
 * The method sorts by its number, a timeframe by its length.
 */
const SORT_SQL = {
  time: ['s.first_seen'],
  method: [ORDER_OF('s.method', METHODS.map((m) => m.id))],
  way: ['s.mode', ORDER_OF('s.tf', ['1m', '3m', '5m', '15m', '30m', '1h', '4h'])],
  signal: ['s.state', 's.dir'],
  ltp: ['s.ltp'],
  entry: ['s.entry_lo'],
  sl: ['s.stop'],
  tp1: ['s.tp1'], tp2: ['s.tp2'], tp3: ['s.tp3'],
  fill: ['e.fill_price'],
  exit: ['e.exit_price'],
  result: ['(e.exit_price - e.fill_price) * e.dir'],
  score: ['s.score'],
  stood: ['s.last_seen - s.first_seen'],
  rr: ['s.rr'],
} as const satisfies Record<string, readonly string[]>;
export type SignalSort = keyof typeof SORT_SQL;
export const isSignalSort = (x: unknown): x is SignalSort => typeof x === 'string' && Object.hasOwn(SORT_SQL, x);

/** The latest signals, newest first, optionally one way, timeframe or state, or since a moment; each TRADE with its outcome. */
export async function recentSignals(q: SignalQuery = {}): Promise<SignalRow[]> {
  return (await signalPage(q)).signals;
}

/**
 * One page of the history and the number matching the filters, for the
 * screen's table: `limit` rows from `offset`, sorted by a fixed column.
 */
/**
 * Over every signal matching the filters (not just the page): TRADEs, how many
 * reached TP1 and the points they made, how many hit the stop and the points
 * they lost, and the net in points and R -- each from the fill to the exit.
 */
export type SignalSummary = {
  trades: number; tp1: number; tp1Pts: number; stops: number; slPts: number; timeouts: number; timeoutPts: number;
  /** Target pts - SL pts + time-out pts, exactly (each trade to the whole point). */
  netPts: number; open: number;
  /** How many runners went on to reach TGT2, and TGT3. */
  tp2: number; tp3: number;
};

export async function signalPage(q: SignalQuery = {}): Promise<{ signals: SignalRow[]; total: number; summary: SignalSummary }> {
  // The history reads the paper log beside it (a TRADE's outcome): both tables first, whatever ran at boot.
  await Promise.all([signalsSchema(), entrySchema(), alertsSchema()]);
  const where: string[] = [];
  const args: Param[] = [];
  if (q.mode) { args.push(q.mode); where.push(`s.mode = $${args.length}`); }
  if (q.tf) { args.push(q.tf); where.push(`s.tf = $${args.length}`); }
  if (q.state) { args.push(q.state); where.push(`s.state = $${args.length}`); }
  if (q.dir === 1 || q.dir === -1) { args.push(q.dir); where.push(`s.dir = $${args.length}`); }
  if (q.since) { args.push(q.since); where.push(`s.first_seen >= $${args.length}`); }
  // In play: waiting, filled, or a runner after TP1 still out for TP2/TP3.
  if (q.live) where.push(`(e.status IN ('open', 'filled') OR e.runner = 'running')`);
  const filter = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const JOIN = `LEFT JOIN entry_setups e ON s.state = 'TRADE' AND e.method = s.method AND e.mode = s.mode AND e.tf = s.tf
                                AND e.dir = s.dir AND e.trigger_at = s.trigger_at`;
  // Points from the fill to the exit, in the trade's favour: (exit - fill) x direction, each trade to the
  // whole point as the rows show it -- so the totals add up exactly: net = target pts - SL pts + time-out pts.
  const pts = 'round(((e.exit_price - e.fill_price) * e.dir)::numeric)';
  const [agg] = await rows<Record<string, string | null>>(
    `SELECT count(*) AS n,
            count(*) FILTER (WHERE s.state = 'TRADE') AS trades,
            count(*) FILTER (WHERE e.status = 'tp1') AS tp1, coalesce(sum(${pts}) FILTER (WHERE e.status = 'tp1'), 0) AS tp1_pts,
            count(*) FILTER (WHERE e.status = 'stop') AS stops, coalesce(-sum(${pts}) FILTER (WHERE e.status = 'stop'), 0) AS sl_pts,
            count(*) FILTER (WHERE e.status = 'timeout') AS timeouts, coalesce(sum(${pts}) FILTER (WHERE e.status = 'timeout'), 0) AS timeout_pts,
            count(*) FILTER (WHERE e.tp2_at IS NOT NULL) AS tp2, count(*) FILTER (WHERE e.tp3_at IS NOT NULL) AS tp3,
            coalesce(sum(${pts}) FILTER (WHERE e.status IN ('tp1', 'stop', 'timeout')), 0) AS net_pts,
            count(*) FILTER (WHERE e.status IN ('open', 'filled')) AS open
       FROM entry_signals s ${JOIN} ${filter}`,
    args,
  );
  const n = Number(agg?.n ?? 0);
  const summary: SignalSummary = {
    trades: Number(agg?.trades ?? 0), tp1: Number(agg?.tp1 ?? 0), tp1Pts: Number(agg?.tp1_pts ?? 0),
    stops: Number(agg?.stops ?? 0), slPts: Number(agg?.sl_pts ?? 0), timeouts: Number(agg?.timeouts ?? 0),
    timeoutPts: Number(agg?.timeout_pts ?? 0), netPts: Number(agg?.net_pts ?? 0), open: Number(agg?.open ?? 0),
    tp2: Number(agg?.tp2 ?? 0), tp3: Number(agg?.tp3 ?? 0),
  };
  const cols = SORT_SQL[q.sort && isSignalSort(q.sort) ? q.sort : 'time'];
  const order = `${cols.map((c) => `${c} ${q.asc ? 'ASC' : 'DESC'} NULLS LAST`).join(', ')}, s.first_seen DESC, s.id DESC`;
  args.push(Math.min(500, Math.max(1, q.limit ?? 100)));
  const lim = args.length;
  args.push(Math.max(0, Math.floor(q.offset ?? 0)));
  const off = args.length;
  const rs = await rows<Record<string, unknown>>(
    `SELECT s.*, e.status AS e_status, e.fill_price AS e_fill, e.exit_price AS e_exit, e.exit_at AS e_exit_at, e.r_net AS e_r,
            e.dir AS e_dir, e.entry_lo AS e_lo, e.entry_hi AS e_hi, e.stop AS e_stop, e.tp1 AS e_tp1,
            e.filled_at AS e_filled_at, e.first_seen AS e_first_seen, e.trigger_at AS e_trigger,
            e.tp1_at AS e_tp1_at, e.tp2_at AS e_tp2_at, e.tp3_at AS e_tp3_at, e.runner AS e_runner, e.runner_end AS e_runner_end,
            al.at AS al_at, al.status AS al_status
       FROM entry_signals s ${JOIN}
       -- The first alert tried for this setup, if any (entry_alert_log_by_setup).
       LEFT JOIN LATERAL (
         SELECT a.at, a.status FROM entry_alert_log a
          WHERE s.state = 'TRADE' AND a.method = s.method AND a.mode = s.mode AND a.tf = s.tf AND a.dir = s.dir AND a.trigger_at = s.trigger_at
          ORDER BY a.at LIMIT 1
       ) al ON true
       ${filter} ORDER BY ${order} LIMIT $${lim} OFFSET $${off}`,
    args,
  );
  const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
  const signals = rs.map((r) => ({
    method: String(r.method), mode: r.mode as SignalRow['mode'], tf: r.tf as Tf, dir: Number(r.dir) as 1 | -1, state: r.state as SignalRow['state'],
    triggerAt: Number(r.trigger_at), firstSeen: Number(r.first_seen), lastSeen: Number(r.last_seen),
    score: num(r.score), reason: String(r.reason),
    entryLo: num(r.entry_lo), entryHi: num(r.entry_hi), stop: num(r.stop), tp1: num(r.tp1), rr: num(r.rr),
    gatesOff: (r.gates_off as string[] | null) ?? [],
    ltp: num(r.ltp), indexPrice: num(r.index_price),
    n: METHODS.find((m) => m.id === r.method)?.n ?? null,
    name: METHODS.find((m) => m.id === r.method)?.name ?? String(r.method),
    outcome: r.e_status ? outcomeOf(r, r.tf as Tf) : null,
    tp2: num(r.tp2), tp3: num(r.tp3),
    why: r.stop_why === null && r.tp_why === null ? null : {
      stop: (r.stop_why as string | null) ?? null,
      tp1: (r.tp_why as (string | null)[] | null)?.[0] ?? null,
      tp2: (r.tp_why as (string | null)[] | null)?.[1] ?? null,
      tp3: (r.tp_why as (string | null)[] | null)?.[2] ?? null,
    },
    barCloseAt: Number(r.trigger_at) + TF_SEC[r.tf as Tf],
    seenAfterMs: Number(r.first_seen) - (Number(r.trigger_at) + TF_SEC[r.tf as Tf]) * 1000,
    alert: r.al_at === null || r.al_at === undefined ? null : { at: Number(r.al_at), status: r.al_status as 'sent' | 'failed' },
  }));
  return { signals, total: n, summary };
}

/**
 * The paper log's clock for each TRADE on the board -- waiting for its fill
 * (and until when), in the trade (since when, and when it times out), or out --
 * with when its alert went. Keyed by setup (`clockKey`). One query.
 */
export async function setupClocks(reads: readonly MethodRead[]): Promise<Map<string, SetupClock>> {
  const trades = reads.filter((r) => r.state === 'TRADE' && r.triggerTime !== null && r.dir !== null);
  const out = new Map<string, SetupClock>();
  if (!trades.length) return out;
  await Promise.all([entrySchema(), alertsSchema()]);
  const rs = await rows<Record<string, unknown>>(
    `SELECT e.method, e.mode, e.tf, e.dir, e.trigger_at, e.status, e.first_seen, e.filled_at, e.fill_price, e.exit_at, e.exit_price,
            e.tp1_at, e.tp2_at, e.tp3_at, e.runner, e.runner_end,
            (SELECT min(a.at) FROM entry_alert_log a
              WHERE a.method = e.method AND a.mode = e.mode AND a.tf = e.tf AND a.dir = e.dir AND a.trigger_at = e.trigger_at) AS alert_at
       FROM entry_setups e WHERE e.trigger_at = ANY($1::bigint[])`,
    [[...new Set(trades.map((r) => r.triggerTime!))]],
  );
  const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
  for (const x of rs) {
    const tf = x.tf as Tf;
    const filledAt = num(x.filled_at);
    out.set(clockKey(String(x.method), String(x.mode), tf, Number(x.dir), Number(x.trigger_at)), {
      status: String(x.status), firstSeen: Number(x.first_seen), fillBy: fillByOf(Number(x.trigger_at), Number(x.first_seen), tf),
      filledAt, fillPrice: num(x.fill_price), timeoutAt: filledAt === null ? null : timeoutAtOf(filledAt, tf),
      exitAt: num(x.exit_at), exitPrice: num(x.exit_price), alertAt: num(x.alert_at),
      tp1At: num(x.tp1_at), tp2At: num(x.tp2_at), tp3At: num(x.tp3_at),
      runner: (x.runner as SetupClock['runner']) ?? null, runnerEnd: (x.runner_end as SetupClock['runnerEnd']) ?? null,
    });
  }
  return out;
}

export const clockKey = (method: string, mode: string, tf: string, dir: number, triggerAt: number) => `${method}|${mode}|${tf}|${dir}|${triggerAt}`;
export const clockKeyOf = (r: MethodRead) => clockKey(r.id, r.mode, r.tf, r.dir === 'long' ? 1 : -1, r.triggerTime ?? 0);

/** At most this many rows in one download: a year of every signal on every timeframe is well under it. */
export const EXPORT_MAX_ROWS = 20_000;

/** Every signal matching the filters, in the table's order -- not just a page -- up to EXPORT_MAX_ROWS. */
export async function exportSignals(q: SignalQuery): Promise<{ rows: SignalRow[]; total: number }> {
  const out: SignalRow[] = [];
  let total = 0;
  for (let offset = 0; offset < EXPORT_MAX_ROWS; offset += 500) {
    const p = await signalPage({ ...q, limit: 500, offset });
    total = p.total;
    out.push(...p.signals);
    if (p.signals.length < 500) break;
  }
  return { rows: out.slice(0, EXPORT_MAX_ROWS), total };
}

/** "2026-10-01 14:33:05", IST: a date-time Excel reads as one. */
const istOf = (ms: number | null) => (ms === null ? '' : new Date(ms + 5.5 * 3_600_000).toISOString().slice(0, 19).replace('T', ' '));

/**
 * A field as CSV: quoted when it holds a comma, a quote or a line break (quotes
 * doubled); and text that Excel would run as a formula (=, +, -, @ first) led
 * with an apostrophe, so a reason or a label can never become one.
 */
const cell = (v: string | number | null | undefined): string => {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') return Number.isFinite(v) ? String(Math.round(v * 100) / 100) : '';
  const s = /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** The history's columns, one line per signal; numbers raw (no separators), times IST. */
const CSV_COLUMNS: [string, (s: SignalRow) => string | number | null][] = [
  ['signal_time_ist', (s) => istOf(s.firstSeen)],
  ['method_no', (s) => s.n],
  ['method', (s) => s.name],
  ['way', (s) => (s.mode === 'mtf' ? 'with timeframe' : 'without timeframe')],
  ['tf', (s) => s.tf],
  ['signal', (s) => `${s.state === 'WAIT' ? 'WAIT ' : ''}${s.dir === 1 ? 'BUY' : 'SELL'}`],
  ['gates_off', (s) => s.gatesOff.join(' ')],
  ['ltp', (s) => s.ltp],
  ['index', (s) => s.indexPrice],
  ['bar_close_ist', (s) => istOf(s.barCloseAt * 1000)],
  ['seen_after_s', (s) => Math.round(s.seenAfterMs / 1000)],
  ['alert_ist', (s) => istOf(s.alert?.at ?? null)],
  ['alert', (s) => s.alert?.status ?? ''],
  ['entry_lo', (s) => s.entryLo],
  ['entry_hi', (s) => s.entryHi],
  ['sl', (s) => s.stop],
  ['sl_why', (s) => s.why?.stop ?? ''],
  ['tgt1', (s) => s.tp1],
  ['tgt1_why', (s) => s.why?.tp1 ?? ''],
  ['tgt1_hit_ist', (s) => istOf(s.outcome?.tp1At != null ? s.outcome.tp1At * 1000 : null)],
  ['tgt2', (s) => s.tp2],
  ['tgt2_why', (s) => s.why?.tp2 ?? ''],
  ['tgt2_hit_ist', (s) => istOf(s.outcome?.tp2At != null ? s.outcome.tp2At * 1000 : null)],
  ['tgt3', (s) => s.tp3],
  ['tgt3_why', (s) => s.why?.tp3 ?? ''],
  ['tgt3_hit_ist', (s) => istOf(s.outcome?.tp3At != null ? s.outcome.tp3At * 1000 : null)],
  ['status', (s) => s.outcome?.status ?? (s.state === 'WAIT' ? 'waited' : '')],
  ['fill', (s) => s.outcome?.fillPrice ?? null],
  ['fill_ist', (s) => istOf(s.outcome?.filledAt != null ? s.outcome.filledAt * 1000 : null)],
  ['fill_better_pts', (s) => s.outcome?.fillBetterPts ?? null],
  ['exit', (s) => s.outcome?.exitPrice ?? null],
  ['exit_ist', (s) => istOf(s.outcome?.exitAt != null ? s.outcome.exitAt * 1000 : null)],
  ['exit_by', (s) => ({ tp1: 'TGT', stop: 'SL', timeout: 'time' } as Record<string, string>)[s.outcome?.status ?? ''] ?? ''],
  ['exit_past_level_pts', (s) => s.outcome?.exitPastPts ?? null],
  ['result_pts', (s) => (s.outcome?.fillPrice != null && s.outcome.exitPrice !== null ? Math.round((s.outcome.exitPrice - s.outcome.fillPrice) * s.dir) : null)],
  ['result_r', (s) => s.outcome?.rNet ?? null],
  ['runner', (s) => s.outcome?.runner === 'running' ? 'running' : s.outcome?.runnerEnd ?? ''],
  ['rr', (s) => s.rr],
  ['quality', (s) => s.score],
  ['stood_min', (s) => Math.round((s.lastSeen - s.firstSeen) / 60_000)],
  ['reason', (s) => s.reason],
];

/** The history as a CSV that opens cleanly in Excel: a BOM (so UTF-8 reads as UTF-8), CRLF lines. */
export function signalsCsv(rows: readonly SignalRow[]): string {
  const lines = [CSV_COLUMNS.map(([h]) => h).join(','), ...rows.map((s) => CSV_COLUMNS.map(([, f]) => cell(f(s))).join(','))];
  return `﻿${lines.join('\r\n')}\r\n`;
}
