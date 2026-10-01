import type pg from 'pg';
import { getPool, rows } from '../db/pool.js';
import { migrate, type Migration } from '../db/migrate.js';
import { METHODS } from './methods.js';
import { entrySchema } from './paper.js';
import type { Tf } from './types.js';
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
export type MethodReportSection = { mode: 'mtf' | 'single'; label: string; rows: MethodReportRow[]; total: MethodReportRow };

/**
 * The report (owner, 1 Oct 2026: "two sections, 81 + 81: win rate, trades, win,
 * loss, profit, loss, net"): every active method, with the timeframe chain and
 * without it, one line each -- a method with no signal yet still has its line.
 *
 * A trade is a setup that filled and closed (TP1, stop, time-out); a win closed
 * above its fill, a loss at or under it. Points run from the fill to the exit in
 * the trade's favour; R is points over the risk to the stop. No fees. Setups
 * taken while a hard gate was switched off are left out, as in `entryRecord`.
 * `tf` narrows the section without the chain to one timeframe; with the chain
 * the entry is always 5m.
 */
export async function methodReport(tf: Tf | null = null): Promise<MethodReportSection[]> {
  await entrySchema();
  await methodsSchema();
  const xs = await rows<Record<string, string | number | null>>(
    `WITH closed AS (
       SELECT method, mode, (exit_price - fill_price) * dir AS pts, r_net
         FROM entry_setups
        WHERE status IN ('tp1', 'stop', 'timeout') AND cardinality(gates_off) = 0 AND ($1::text IS NULL OR mode = 'mtf' OR tf = $1)
     ), setups AS (
       SELECT method, mode, count(*) AS signals FROM entry_setups
        WHERE cardinality(gates_off) = 0 AND ($1::text IS NULL OR mode = 'mtf' OR tf = $1)
        GROUP BY method, mode
     ), modes(mode) AS (VALUES ('mtf'), ('single'))
     SELECT x.mode, m.n, m.id AS method, m.name, coalesce(s.signals, 0) AS signals,
            count(c.pts) AS trades,
            count(*) FILTER (WHERE c.r_net > 0) AS wins,
            count(*) FILTER (WHERE c.r_net <= 0) AS losses,
            coalesce(sum(c.pts) FILTER (WHERE c.pts > 0), 0) AS profit_pts,
            coalesce(-sum(c.pts) FILTER (WHERE c.pts <= 0), 0) AS loss_pts,
            coalesce(sum(c.r_net) FILTER (WHERE c.r_net > 0), 0) AS profit_r,
            coalesce(-sum(c.r_net) FILTER (WHERE c.r_net <= 0), 0) AS loss_r
       FROM entry_methods m
      CROSS JOIN modes x
       LEFT JOIN setups s ON s.method = m.id AND s.mode = x.mode
       LEFT JOIN closed c ON c.method = m.id AND c.mode = x.mode
      WHERE m.active
      GROUP BY x.mode, m.n, m.id, m.name, s.signals
      ORDER BY x.mode, m.n`,
    [tf],
  );
  const num = (v: string | number | null | undefined) => Number(v ?? 0);
  const lineOf = (n: number | null, method: string, name: string, v: Omit<MethodReportRow, 'n' | 'method' | 'name' | 'winPct' | 'netPts' | 'netR'>): MethodReportRow => ({
    n, method, name, ...v,
    winPct: v.trades > 0 ? (100 * v.wins) / v.trades : null,
    netPts: v.profitPts - v.lossPts, netR: v.profitR - v.lossR,
  });
  const LABEL = { mtf: 'With the timeframe chain', single: 'Without the timeframe chain' } as const;
  return (['mtf', 'single'] as const).map((mode) => {
    const lines = xs.filter((x) => x.mode === mode).map((x) => lineOf(x.n === null ? null : Number(x.n), String(x.method), String(x.name), {
      signals: num(x.signals), trades: num(x.trades), wins: num(x.wins), losses: num(x.losses),
      profitPts: num(x.profit_pts), lossPts: num(x.loss_pts), profitR: num(x.profit_r), lossR: num(x.loss_r),
    }));
    const sum = (k: 'signals' | 'trades' | 'wins' | 'losses' | 'profitPts' | 'lossPts' | 'profitR' | 'lossR') => lines.reduce((a, l) => a + l[k], 0);
    const total = lineOf(null, 'all', `All ${lines.length} methods`, {
      signals: sum('signals'), trades: sum('trades'), wins: sum('wins'), losses: sum('losses'),
      profitPts: sum('profitPts'), lossPts: sum('lossPts'), profitR: sum('profitR'), lossR: sum('lossR'),
    });
    return { mode, label: LABEL[mode], rows: lines, total };
  });
}
