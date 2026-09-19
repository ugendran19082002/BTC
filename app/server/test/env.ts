/**
 * Every test process gets a database of its own, and it is never the desk's.
 *
 * Preloaded with `--import` so it runs before any test module is evaluated,
 * which is the whole point: four test files used to set `ERROR_DB` themselves,
 * and every other file that made the exchange refuse an order wrote the
 * refusal into the desk's real `errors.db`. Two rows in the live log with 72
 * folded occurrences between them turned out to be `client_order_id:
 * "abc123E0"` — a fixture — and a stack ending in `node:assert`.
 *
 * That is worse than untidy. The error log is the one place a real failure is
 * supposed to be findable, and a suite that files 3 more refusals into it on
 * every run is how a real one gets scrolled past.
 *
 * Now: `deploy/test-db.sh up` runs a throwaway PostgreSQL on 127.0.0.1:5433,
 * and this file creates `btc_test_<random>` inside it, points `DATABASE_URL`
 * there, and drops it when the process ends. `node --test` runs each file in
 * its own process, so each file gets its own database and none can see
 * another's rows. `TEST_PG_URL` overrides where the server is.
 *
 * `??=` rather than `=`, so a test file that wants its own path still gets it.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import pg from 'pg';

// Still needed while the SQLite stores are being replaced schema by schema.
const dir = mkdtempSync(join(tmpdir(), 'btc-desk-test-'));
process.env.ERROR_DB ??= join(dir, 'errors.db');
process.env.TRADE_DB ??= join(dir, 'trades.db');
process.env.AUTH_DB ??= join(dir, 'auth.db');
process.env.MARKET_DB ??= join(dir, 'market.db');

const ADMIN_URL = process.env.TEST_PG_URL ?? 'postgres://postgres:postgres@127.0.0.1:5433/postgres';
const name = `btc_test_${randomBytes(6).toString('hex')}`;

const admin = new pg.Client({ connectionString: ADMIN_URL, connectionTimeoutMillis: 5_000 });
try {
  await admin.connect();
} catch (e) {
  console.error(
    `\ntest/env.ts: no PostgreSQL at ${ADMIN_URL.replace(/:[^:@/]+@/, ':***@')} — `
    + `run \`deploy/test-db.sh up\` first (or set TEST_PG_URL).\n`,
  );
  throw e;
}
await admin.query(`CREATE DATABASE ${name}`);
await admin.end();

const url = new URL(ADMIN_URL);
url.pathname = `/${name}`;
process.env.DATABASE_URL = url.toString();

// Drop it on the way out. `beforeExit` rather than `exit` because dropping is
// async; the pool is closed first because PostgreSQL will not drop a database
// with a connection open on it.
let dropping = false;
process.on('beforeExit', () => {
  if (dropping) return;
  dropping = true;
  void (async () => {
    try {
      const { closePool } = await import('../src/db/pool.js');
      await closePool();
      const c = new pg.Client({ connectionString: ADMIN_URL });
      await c.connect();
      await c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await c.end();
    } catch (e) {
      console.error(`test/env.ts: could not drop ${name}: ${(e as Error).message}`);
    }
  })();
});
