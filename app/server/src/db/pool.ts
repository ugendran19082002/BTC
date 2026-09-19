import pg from 'pg';
import { config } from '../config.js';

/**
 * The one connection pool to the desk's database.
 *
 * Every store in the process -- trades, strategies, sign-in, the error log,
 * open-interest history -- talks to the same PostgreSQL database through this
 * pool, one schema each. One pool, because the alternative is each store
 * holding its own connections and the process quietly using five times the
 * connections it needs; and because a test that wants to end cleanly has one
 * thing to close.
 *
 * `DATABASE_URL` is read from `config`, once, so a stack trace or a log line
 * can never pick the password out of `process.env` after the fact. The pool is
 * built on first use rather than at import, so a module that merely imports a
 * store (a test, the auth CLI) does not open a connection it will not use.
 */

let pool: pg.Pool | null = null;

/** Values a query may be handed. Objects are sent as JSON. */
export type Param = string | number | boolean | null | Date | Buffer | object;

const options = (): pg.PoolConfig => {
  if (!config.databaseUrl) {
    throw new Error(
      'DATABASE_URL is not set. The desk keeps its trades, sign-in, settings and error log in '
      + 'PostgreSQL; see docs/DB-INVENTORY.md and app/server/.env.example.',
    );
  }
  return {
    connectionString: config.databaseUrl,
    application_name: 'btc-desk-api',
    // A desk this size never needs more; a leak shows up as exhaustion here
    // rather than as a database that has quietly run out of slots.
    max: 8,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    // A statement that runs longer than this is a bug, not a slow query: the
    // largest table the desk writes has a few thousand rows.
    statement_timeout: 15_000,
    // An idle connection must not keep the process alive: the server has a
    // listening socket for that, and a test file that forgot to close the pool
    // would otherwise sit for `idleTimeoutMillis` before it could exit.
    allowExitOnIdle: true,
  };
};

export function getPool(): pg.Pool {
  if (pool) return pool;
  pool = new pg.Pool(options());
  // A connection dropped by the server while idle is not the process's
  // fault, and not fatal; the next query takes a fresh one.
  pool.on('error', () => {});
  return pool;
}

/** Run one statement on any connection in the pool. */
export async function query<R extends pg.QueryResultRow = pg.QueryResultRow>(
  sql: string,
  params: readonly Param[] = [],
): Promise<pg.QueryResult<R>> {
  return getPool().query<R>(sql, params as unknown[]);
}

/** The rows of one statement. */
export async function rows<R extends pg.QueryResultRow = pg.QueryResultRow>(
  sql: string,
  params: readonly Param[] = [],
): Promise<R[]> {
  return (await query<R>(sql, params)).rows;
}

/** The first row of one statement, or null. */
export async function one<R extends pg.QueryResultRow = pg.QueryResultRow>(
  sql: string,
  params: readonly Param[] = [],
): Promise<R | null> {
  return (await query<R>(sql, params)).rows[0] ?? null;
}

/**
 * Run `fn` inside one transaction on one connection.
 *
 * Commits when `fn` resolves, rolls back when it throws, and always returns the
 * connection. Nested calls are the caller's problem: pass the client down.
 */
export async function tx<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch { /* the connection is gone; release reports it */ }
    throw e;
  } finally {
    client.release();
  }
}

/**
 * Close every connection. For tests, and for a process shutting down.
 *
 * The next `getPool()` opens a new pool, so a test file can close at the end
 * of its own run without touching the others.
 */
export async function closePool(): Promise<void> {
  const p = pool;
  pool = null;
  if (p) await p.end();
}
