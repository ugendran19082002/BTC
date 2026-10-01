import type pg from 'pg';
import { getPool } from '../db/pool.js';
import { migrate, type Migration } from '../db/migrate.js';
import { METHODS } from './methods.js';
import { entrySchema } from './paper.js';
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
