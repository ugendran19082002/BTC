import type { DatabaseSync } from 'node:sqlite';

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
 * Two rules for anyone adding one:
 *   - **never edit a migration that has shipped.** It has already run
 *     somewhere; editing it changes what that database has and what a fresh one
 *     gets, and the two silently diverge. Add another.
 *   - **ids are permanent.** They are the memory. Renaming one re-runs it.
 */
export type Migration = {
  /** Unique and permanent. Conventionally `NNN-what-it-does`. */
  id: string;
  /** SQL, or a function for anything SQL alone cannot express. */
  up: string | ((db: DatabaseSync) => void);
};

const LEDGER = `
CREATE TABLE IF NOT EXISTS migrations (
  id         TEXT PRIMARY KEY,
  applied_at INTEGER NOT NULL
);
`;

/** Ids that ran this time. Empty means the database was already current. */
export function migrate(db: DatabaseSync, migrations: readonly Migration[]): string[] {
  db.exec(LEDGER);
  const done = new Set(
    (db.prepare('SELECT id FROM migrations').all() as { id: string }[]).map((r) => r.id),
  );

  const seen = new Set<string>();
  for (const m of migrations) {
    if (seen.has(m.id)) throw new Error(`two migrations share the id "${m.id}"`);
    seen.add(m.id);
  }

  const applied: string[] = [];
  for (const m of migrations) {
    if (done.has(m.id)) continue;
    db.exec('BEGIN');
    try {
      if (typeof m.up === 'string') db.exec(m.up);
      else m.up(db);
      db.prepare('INSERT INTO migrations (id, applied_at) VALUES (?, ?)').run(m.id, Date.now());
      db.exec('COMMIT');
      applied.push(m.id);
    } catch (e) {
      db.exec('ROLLBACK');
      // Loud and fatal. A half-migrated database under a trading engine is
      // worse than one that refuses to start.
      throw new Error(`migration "${m.id}" failed: ${(e as Error).message}`, { cause: e });
    }
  }
  return applied;
}

/** Which migrations a database has, oldest first. For diagnostics. */
export function appliedMigrations(db: DatabaseSync): { id: string; appliedAt: number }[] {
  db.exec(LEDGER);
  return (
    db.prepare('SELECT id, applied_at FROM migrations ORDER BY applied_at, id').all() as
      { id: string; applied_at: number }[]
  ).map((r) => ({ id: r.id, appliedAt: r.applied_at }));
}

/** True when a column is already on a table. For writing idempotent adds. */
export function hasColumn(db: DatabaseSync, table: string, column: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return rows.some((r) => r.name === column);
}
