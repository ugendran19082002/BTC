import type pg from 'pg';
import { getPool, rows } from '../db/pool.js';
import { migrate, type Migration } from '../db/migrate.js';
import { METHODS } from './methods.js';
import { entrySchema } from './paper.js';
import type { Tf } from './types.js';
import { SINGLE_TFS } from './engine.js';
import { alertsSchema } from './alerts.js';
import { signalsSchema } from './signals.js';

/**
 * The methods, in the database too (owner, 1 Oct 2026: "methods db side handle
 * best practice"). `entry_methods` holds every method the desk reads -- its id,
 * its number on the screen (1-81), its research number, name and group --
 * written from methods.ts on every start, so a query on the database alone can
 * say which method a signal was and in what order they go.
 *
 * The signals, the paper setups and the alert log can only name a method in it
 * (foreign keys). A method the code no longer has is never deleted -- its rows
 * are history -- but marked retired: `active` false and no number, so the
 * numbers 1-81 stay one series. Code is the source of truth; this table follows.
 */

const MIGRATIONS: Migration[] = [{
  id: 'entry-019-methods',
  up: async (client) => {
    await client.query(`
      CREATE TABLE IF NOT EXISTS entry_methods (
        id        TEXT    PRIMARY KEY,
        n         INTEGER,
        code      TEXT,
        ref       TEXT,
        name      TEXT    NOT NULL,
        grp       TEXT    NOT NULL,
        active    BOOLEAN NOT NULL,
        synced_at BIGINT  NOT NULL,
        -- Checked at commit: a renumbering moves numbers between methods inside one sync.
        CONSTRAINT entry_methods_n_once UNIQUE (n) DEFERRABLE INITIALLY DEFERRED,
        CONSTRAINT entry_methods_numbered CHECK (active = (n IS NOT NULL))
      );
    `);
    await syncWith(client);
    // A method named in the history but not in the code: kept, retired, so every row still has its method.
    await client.query(`
      INSERT INTO entry_methods (id, name, grp, active, synced_at)
      SELECT method, method, 'retired', false, $1
        FROM (SELECT DISTINCT method FROM entry_signals
              UNION SELECT DISTINCT method FROM entry_setups
              UNION SELECT DISTINCT method FROM entry_alert_log) AS named
      ON CONFLICT (id) DO NOTHING;
    `, [Date.now()]);
    await client.query(`
      ALTER TABLE entry_signals   ADD CONSTRAINT entry_signals_method_fk   FOREIGN KEY (method) REFERENCES entry_methods (id);
      ALTER TABLE entry_setups    ADD CONSTRAINT entry_setups_method_fk    FOREIGN KEY (method) REFERENCES entry_methods (id);
      ALTER TABLE entry_alert_log ADD CONSTRAINT entry_alert_log_method_fk FOREIGN KEY (method) REFERENCES entry_methods (id);
    `);
  },
}];

/** The code's methods into the table: each one active with its number; any other one retired. */
async function syncWith(client: pg.PoolClient): Promise<void> {
  const ms = METHODS.map((m) => ({ id: m.id, n: m.n, code: m.code ?? String(m.n), ref: m.ref ?? null, name: m.name, grp: m.group }));
  const at = Date.now();
  await client.query(`
    UPDATE entry_methods SET active = false, n = NULL, code = NULL, synced_at = $2
     WHERE active AND NOT (id = ANY ($1::text[]));
  `, [ms.map((m) => m.id), at]);
  await client.query(`
    INSERT INTO entry_methods (id, n, code, ref, name, grp, active, synced_at)
    SELECT id, n, code, ref, name, grp, true, $2 FROM jsonb_to_recordset($1::jsonb)
      AS x (id TEXT, n INTEGER, code TEXT, ref TEXT, name TEXT, grp TEXT)
    ON CONFLICT (id) DO UPDATE SET n = EXCLUDED.n, code = EXCLUDED.code, ref = EXCLUDED.ref, name = EXCLUDED.name,
      grp = EXCLUDED.grp, active = true, synced_at = EXCLUDED.synced_at
    WHERE (entry_methods.n, entry_methods.code, entry_methods.ref, entry_methods.name, entry_methods.grp, entry_methods.active)
      IS DISTINCT FROM (EXCLUDED.n, EXCLUDED.code, EXCLUDED.ref, EXCLUDED.name, EXCLUDED.grp, true);
  `, [JSON.stringify(ms), at]);
}

/** Write the code's methods into the table, in one transaction. */
async function syncMethods(): Promise<void> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    try {
      await syncWith(client);
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    }
  } finally {
    client.release();
  }
}

let ready: Promise<void> | null = null;
/** After the tables that name a method; before anything writes to them (index.ts awaits it at start). */
export function methodsSchema(): Promise<void> {
  if (ready) return ready;
  ready = Promise.all([entrySchema(), alertsSchema(), signalsSchema()])
    .then(() => migrate(MIGRATIONS))
    .then(() => syncMethods())
    .then(() => {}, (e) => { ready = null; throw e; });
  return ready;
}

/** One method's line in the report: its signals, how its closed trades went, in points and R. */
export type MethodReportRow = {
  n: number | null; method: string; name: string;
  signals: number; trades: number; wins: number; losses: number; winPct: number | null;
  profitPts: number; lossPts: number; netPts: number; profitR: number; lossR: number; netR: number;
};
export type MethodReportSection = {
  mode: 'mtf' | 'single'; label: string; rows: MethodReportRow[]; total: MethodReportRow;
  /** Of the signals counted, how many were taken with a hard gate switched off. */
  gatesOffSignals: number;
};
export type MethodReport = {
  /** With the timeframe chain, then without it (every timeframe, or `tf` alone). */
  sections: MethodReportSection[];
  /** Without the chain, one section per timeframe: the screen's tabs, read in the same pass. */
  singleByTf: Partial<Record<Tf, MethodReportSection>>;
};

/**
 * The report (owner, 1 Oct 2026: "two sections, 81 + 81: win rate, trades, win,
 * loss, profit, loss, net"): every active method, with the timeframe chain and
 * without it, one line each -- a method with no signal yet still has its line.
 * Without the chain it is also given per timeframe ("a tab each, and All").
 *
 * A trade is a setup that filled and closed (TP1, stop, time-out); a win closed
 * above its fill, a loss at or under it. Points run from the fill to the exit in
 * the trade's favour; R is points over the risk to the stop. No fees.
 *
 * Every signal counts by default, as in the signal history: the owner trades
 * the board with gates switched off, and leaving those setups out emptied the
 * report (1 Oct 2026). `everyGate` keeps only setups taken with every hard
 * gate on -- the rules as designed, as `entryRecord`'s totals count them.
 * `tf` narrows the section without the chain to one timeframe; with the chain
 * the entry is always 5m. `range` keeps the signals first seen inside it.
 */
export async function methodReport(
  tf: Tf | null = null,
  everyGate = false,
  /** Signals first seen in [from, to), epoch ms -- the day a signal appeared is its day. Null: all of them. */
  range: { from: number; to: number } | null = null,
): Promise<MethodReport> {
  await entrySchema();
  await methodsSchema();
  const methods = await rows<{ id: string; n: number | null; name: string }>(
    'SELECT id, n, name FROM entry_methods WHERE active ORDER BY n, id');
  // One pass: every (method, way, timeframe) that has a setup, its signals and its closed trades.
  const xs = await rows<Record<string, string | number | null>>(
    `SELECT method, mode, tf,
            count(*) AS signals,
            count(*) FILTER (WHERE cardinality(gates_off) > 0) AS gates_off,
            count(*) FILTER (WHERE status IN ('tp1', 'stop', 'timeout')) AS trades,
            count(*) FILTER (WHERE status IN ('tp1', 'stop', 'timeout') AND r_net > 0) AS wins,
            count(*) FILTER (WHERE status IN ('tp1', 'stop', 'timeout') AND r_net <= 0) AS losses,
            coalesce(sum((exit_price - fill_price) * dir) FILTER (WHERE status IN ('tp1', 'stop', 'timeout') AND (exit_price - fill_price) * dir > 0), 0) AS profit_pts,
            coalesce(-sum((exit_price - fill_price) * dir) FILTER (WHERE status IN ('tp1', 'stop', 'timeout') AND (exit_price - fill_price) * dir <= 0), 0) AS loss_pts,
            coalesce(sum(r_net) FILTER (WHERE status IN ('tp1', 'stop', 'timeout') AND r_net > 0), 0) AS profit_r,
            coalesce(-sum(r_net) FILTER (WHERE status IN ('tp1', 'stop', 'timeout') AND r_net <= 0), 0) AS loss_r
       FROM entry_setups
      WHERE (NOT $1::boolean OR cardinality(gates_off) = 0)
        AND ($2::bigint IS NULL OR first_seen >= $2) AND ($3::bigint IS NULL OR first_seen < $3)
      GROUP BY method, mode, tf`,
    [everyGate, range?.from ?? null, range?.to ?? null],
  );
  const num = (v: string | number | null | undefined) => Number(v ?? 0);
  type Sums = Omit<MethodReportRow, 'n' | 'method' | 'name' | 'winPct' | 'netPts' | 'netR'>;
  const KEYS = ['signals', 'trades', 'wins', 'losses', 'profitPts', 'lossPts', 'profitR', 'lossR'] as const;
  const zero = (): Sums => ({ signals: 0, trades: 0, wins: 0, losses: 0, profitPts: 0, lossPts: 0, profitR: 0, lossR: 0 });
  const lineOf = (n: number | null, method: string, name: string, v: Sums): MethodReportRow => ({
    n, method, name, ...v,
    winPct: v.trades > 0 ? (100 * v.wins) / v.trades : null,
    netPts: v.profitPts - v.lossPts, netR: v.profitR - v.lossR,
  });
  const LABEL = { mtf: 'With the timeframe chain', single: 'Without the timeframe chain' } as const;
  const sectionOf = (mode: 'mtf' | 'single', keep: (tf: string) => boolean): MethodReportSection => {
    const by = new Map<string, Sums>();
    let gatesOffSignals = 0;
    for (const x of xs) {
      if (x.mode !== mode || !keep(String(x.tf))) continue;
      const acc = by.get(String(x.method)) ?? zero();
      acc.signals += num(x.signals); acc.trades += num(x.trades); acc.wins += num(x.wins); acc.losses += num(x.losses);
      acc.profitPts += num(x.profit_pts); acc.lossPts += num(x.loss_pts); acc.profitR += num(x.profit_r); acc.lossR += num(x.loss_r);
      by.set(String(x.method), acc);
      gatesOffSignals += num(x.gates_off);
    }
    const lines = methods.map((m) => lineOf(m.n === null ? null : Number(m.n), m.id, m.name, by.get(m.id) ?? zero()));
    const sums = zero();
    for (const l of lines) for (const k of KEYS) sums[k] += l[k];
    return { mode, label: LABEL[mode], rows: lines, total: lineOf(null, 'all', `All ${lines.length} methods`, sums), gatesOffSignals };
  };
  return {
    sections: [sectionOf('mtf', () => true), sectionOf('single', (t) => tf === null || t === tf)],
    singleByTf: Object.fromEntries(SINGLE_TFS.map((t) => [t, sectionOf('single', (x) => x === t)])),
  };
}

const IST_MS = 5.5 * 3_600_000;
const DAY_MS = 86_400_000;
const ISO_DAY = /^(\d{4}-\d{2}-\d{2})$/;
const ISO_MINUTE = /^(\d{4}-\d{2}-\d{2})T([01]\d|2[0-3]):([0-5]\d)$/;

/** An IST day or minute as epoch ms of its start, and how long it lasts; null when malformed or no such day. */
function istMoment(v: string): { at: number; span: number } | null {
  const day = ISO_DAY.exec(v), minute = ISO_MINUTE.exec(v);
  const d = day?.[1] ?? minute?.[1];
  if (!d) return null;
  const midnight = Date.parse(`${d}T00:00:00Z`);
  if (!Number.isFinite(midnight) || new Date(midnight).toISOString().slice(0, 10) !== d) return null;
  if (day) return { at: midnight - IST_MS, span: DAY_MS };
  return { at: midnight - IST_MS + (Number(minute![2]) * 60 + Number(minute![3])) * 60_000, span: 60_000 };
}

/**
 * IST days (`YYYY-MM-DD`) or minutes (`YYYY-MM-DDTHH:MM`) as the half-open window
 * [from, the end of `to`) in epoch ms -- `to` counts whole: to a day, all of it;
 * to 17:30, up to 17:31. Null when neither is given. Missing one, malformed, a
 * day that does not exist, or `from` after `to`: an error in words.
 */
export function istDayRange(from?: string, to?: string): { from: number; to: number } | null | { error: string } {
  if (!from && !to) return null;
  if (!from || !to) return { error: 'from and to go together: IST days (YYYY-MM-DD) or minutes (YYYY-MM-DDTHH:MM)' };
  const a = istMoment(from), b = istMoment(to);
  if (!a || !b) return { error: 'from and to must be IST days (YYYY-MM-DD) or minutes (YYYY-MM-DDTHH:MM) that exist' };
  // Against the END of \`to\`: "today 08:45 to today" (the whole of today) is a range, though 08:45 is after
  // the day's first minute -- compared with its start, the screen's 8:45 AM to 11:59 PM was refused (2 Oct 2026).
  if (a.at >= b.at + b.span) return { error: 'from must be on or before to' };
  return { from: a.at, to: b.at + b.span };
}
