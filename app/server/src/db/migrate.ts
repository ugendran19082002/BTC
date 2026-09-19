import type pg from 'pg';
import { getPool } from './pool.js';

/**
 * Schema changes that run once and are remembered.
 *
 * `CREATE TABLE IF NOT EXISTS` on every start is fine right up to the first
 * time a table has to *change* — a column added, an index dropped, a value
 * backfilled — because none of those are expressible as "if not exists". At
 * that point you either run the change on every boot and hope it is harmless,
 * or you run it by hand on one machine and forget the other.
 *
 * So: an ordered list, each with an id, each applied inside a transaction, each
 * recorded when it succeeds. A migration that has run is skipped; a migration
 * that fails rolls back and stops the boot, because starting a trading engine
 * against a half-migrated database is worse than not starting.
 *
 * One database, several schemas, one ledger: `public.schema_migrations` holds
 * every id whichever schema it touched, so `/api/health` can say in one list
 * what this database has had done to it.
 *
 * Two boots at once — a deploy restarting the API while the old one is still
 * up, two test files starting together — take an advisory lock first, so one
 * runs the list and the other finds it done. SQLite's file lock used to do
 * this for free; PostgreSQL has to be asked.
 *
 * Two rules for anyone adding one:
 *   - **never edit a migration that has shipped.** It has already run
 *     somewhere; editing it changes what that database has and what a fresh one
 *     gets, and the two silently diverge. Add another.
 *   - **ids are permanent.** They are the memory. Renaming one re-runs it.
 */
export type Migration = {
  /** Unique and permanent. Conventionally `<schema>-NNN-what-it-does`. */
  id: string;
  /** SQL (several statements are fine), or a function for anything SQL alone cannot express. */
  up: string | ((client: pg.PoolClient) => Promise<void>);
};

const LEDGER = `
CREATE TABLE IF NOT EXISTS public.schema_migrations (
  id         TEXT   PRIMARY KEY,
  applied_at BIGINT NOT NULL
);
`;

/** One key for the whole process family; any constant would do, as long as it is this one. */
const LOCK_KEY = 0x6274_6364; // 'btcd'

/** Ids that ran this time. Empty means the database was already current. */
export async function migrate(migrations: readonly Migration[]): Promise<string[]> {
  const seen = new Set<string>();
  for (const m of migrations) {
    if (seen.has(m.id)) throw new Error(`two migrations share the id "${m.id}"`);
    seen.add(m.id);
  }

  const client = await getPool().connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);
    try {
      await client.query(LEDGER);
      const done = new Set(
        (await client.query<{ id: string }>('SELECT id FROM public.schema_migrations')).rows.map((r) => r.id),
      );

      const applied: string[] = [];
      for (const m of migrations) {
        if (done.has(m.id)) continue;
        await client.query('BEGIN');
        try {
          if (typeof m.up === 'string') await client.query(m.up);
          else await m.up(client);
          await client.query(
            'INSERT INTO public.schema_migrations (id, applied_at) VALUES ($1, $2)',
            [m.id, Date.now()],
          );
          await client.query('COMMIT');
          applied.push(m.id);
        } catch (e) {
          await client.query('ROLLBACK');
          // Loud and fatal. A half-migrated database under a trading engine is
          // worse than one that refuses to start.
          throw new Error(`migration "${m.id}" failed: ${(e as Error).message}`, { cause: e });
        }
      }
      return applied;
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]);
    }
  } finally {
    client.release();
  }
}

/** Which migrations the database has, oldest first. For diagnostics and `/api/health`. */
export async function appliedMigrations(): Promise<{ id: string; appliedAt: number }[]> {
  const pool = getPool();
  await pool.query(LEDGER);
  const r = await pool.query<{ id: string; applied_at: string }>(
    'SELECT id, applied_at FROM public.schema_migrations ORDER BY applied_at, id',
  );
  return r.rows.map((x) => ({ id: x.id, appliedAt: Number(x.applied_at) }));
}

/** True when a column is already on a table. For writing idempotent adds. */
export async function hasColumn(client: pg.PoolClient, schema: string, table: string, column: string): Promise<boolean> {
  const r = await client.query(
    `SELECT 1 FROM information_schema.columns
      WHERE table_schema = $1 AND table_name = $2 AND column_name = $3`,
    [schema, table, column],
  );
  return (r.rowCount ?? 0) > 0;
}
