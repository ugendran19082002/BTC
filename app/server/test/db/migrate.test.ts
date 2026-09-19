import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { appliedMigrations, hasColumn, migrate, moveToPublic, type Migration } from '../../src/db/migrate.js';
import { closePool, getPool, one, rows } from '../../src/db/pool.js';

/**
 * The ledger under PostgreSQL. Same contract the SQLite one had: run once,
 * remember, stop the boot on failure, retry on the next boot.
 *
 * Each test uses its own schema so the cases cannot see each other's tables;
 * they do share the one ledger, which is what the real database does too.
 */

let n = 0;
const fresh = () => `t${Date.now().toString(36)}${(n++).toString(36)}`;

const table = (schema: string, name: string): Migration => ({
  id: `${schema}-${name}`,
  up: `CREATE SCHEMA IF NOT EXISTS ${schema}; CREATE TABLE ${schema}.${name} (x INTEGER);`,
});

const exists = async (schema: string, name: string) =>
  (await one('SELECT 1 FROM information_schema.tables WHERE table_schema = $1 AND table_name = $2', [schema, name])) !== null;

after(() => closePool());

test('a migration runs, and is remembered', async () => {
  const s = fresh();
  assert.deepEqual(await migrate([table(s, 'a')]), [`${s}-a`]);
  assert.ok(await exists(s, 'a'));
  assert.ok((await appliedMigrations()).some((m) => m.id === `${s}-a`));
});

test('[critical] it does not run a second time', async () => {
  const s = fresh();
  await migrate([table(s, 'a')]);
  // A second run of a CREATE TABLE without IF NOT EXISTS would throw.
  assert.deepEqual(await migrate([table(s, 'a')]), []);
});

test('only the new ones run when the list grows', async () => {
  const s = fresh();
  await migrate([table(s, 'a')]);
  assert.deepEqual(await migrate([table(s, 'a'), table(s, 'b')]), [`${s}-b`]);
  assert.ok(await exists(s, 'b'));
});

test('they run in the order given', async () => {
  const s = fresh();
  const order: string[] = [];
  const m = (id: string): Migration => ({ id: `${s}-${id}`, up: async () => { order.push(id); } });
  await migrate([m('one'), m('two'), m('three')]);
  assert.deepEqual(order, ['one', 'two', 'three']);
});

test('[critical] a failure rolls back and stops the boot', async () => {
  const s = fresh();
  const bad: Migration = {
    id: `${s}-bad`,
    up: `CREATE SCHEMA IF NOT EXISTS ${s}; CREATE TABLE ${s}.half (x INTEGER); SELECT 1/0;`,
  };
  await assert.rejects(() => migrate([table(s, 'a'), bad, table(s, 'c')]), /migration ".*-bad" failed/);
  assert.ok(await exists(s, 'a'), 'the one before it committed');
  assert.ok(!(await exists(s, 'half')), 'its own work was rolled back');
  assert.ok(!(await exists(s, 'c')), 'the one after it never ran');
  const ids = (await appliedMigrations()).map((m) => m.id);
  assert.ok(!ids.includes(`${s}-bad`), 'a failure is not recorded as done');
});

test('a failure does not stop the next attempt retrying it', async () => {
  const s = fresh();
  let attempts = 0;
  const flaky: Migration = {
    id: `${s}-flaky`,
    up: async (c) => {
      attempts++;
      if (attempts === 1) throw new Error('not yet');
      await c.query(`CREATE SCHEMA IF NOT EXISTS ${s}; CREATE TABLE ${s}.ok (x INTEGER)`);
    },
  };
  await assert.rejects(() => migrate([flaky]));
  assert.deepEqual(await migrate([flaky]), [`${s}-flaky`]);
  assert.ok(await exists(s, 'ok'));
});

test('a duplicated id is refused rather than silently skipped', async () => {
  const s = fresh();
  await assert.rejects(() => migrate([table(s, 'a'), table(s, 'a')]), /share the id/);
  assert.ok(!(await exists(s, 'a')), 'nothing ran');
});

test('an empty list is not an error', async () => {
  assert.deepEqual(await migrate([]), []);
});

test('hasColumn answers honestly about both cases', async () => {
  const s = fresh();
  await migrate([{ id: `${s}-cols`, up: `CREATE SCHEMA ${s}; CREATE TABLE ${s}.t (a INTEGER, b TEXT)` }]);
  const c = await getPool().connect();
  try {
    assert.equal(await hasColumn(c, s, 't', 'a'), true);
    assert.equal(await hasColumn(c, s, 't', 'zz'), false);
  } finally {
    c.release();
  }
});

test('the ledger is one table for every schema', async () => {
  const a = fresh();
  const b = fresh();
  await migrate([table(a, 'x')]);
  await migrate([table(b, 'y')]);
  const ids = (await rows<{ id: string }>('SELECT id FROM public.schema_migrations')).map((r) => r.id);
  assert.ok(ids.includes(`${a}-x`) && ids.includes(`${b}-y`));
});

test('two boots at once: one runs the list, the other finds it done', async () => {
  const s = fresh();
  let runs = 0;
  const slow: Migration = {
    id: `${s}-slow`,
    up: async (c) => {
      runs++;
      await new Promise((r) => setTimeout(r, 50));
      await c.query(`CREATE SCHEMA IF NOT EXISTS ${s}; CREATE TABLE ${s}.once (x INTEGER)`);
    },
  };
  const [r1, r2] = await Promise.all([migrate([slow]), migrate([slow])]);
  assert.equal(runs, 1, 'the advisory lock let exactly one through');
  assert.deepEqual([...r1, ...r2], [`${s}-slow`]);
});

test('[critical] moveToPublic moves and renames a table with its rows, index and identity, then drops the empty schema', async () => {
  const s = fresh();
  await migrate([{ id: `${s}-make`, up: `
    CREATE SCHEMA ${s};
    CREATE TABLE ${s}.runs (id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, v TEXT NOT NULL);
    CREATE INDEX ${s}_runs_by_v ON ${s}.runs (v);
    INSERT INTO ${s}.runs (v) VALUES ('a'), ('b');` }]);
  const to = `${s}_runs`;
  await migrate([{ id: `${s}-move`, up: moveToPublic([[`${s}.runs`, to]], [s]) }]);

  assert.deepEqual(await rows(`SELECT id, v FROM public.${to} ORDER BY id`), [{ id: 1, v: 'a' }, { id: 2, v: 'b' }]);
  // the identity carried on from where it was, rather than restarting at 1
  assert.deepEqual(await one(`INSERT INTO public.${to} (v) VALUES ('c') RETURNING id`), { id: 3 });
  assert.ok(await one(`SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = '${s}_runs_by_v'`), 'the index moved too');
  // what carried the old name now carries the new one, so nothing collides in public
  assert.ok(await one(`SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = '${to}_pkey'`), 'runs_pkey renamed');
  assert.equal(await one(`SELECT pg_get_serial_sequence('public.${to}', 'id') AS seq`).then((r) => (r as { seq: string }).seq), `public.${to}_id_seq`);
  assert.equal(await one(`SELECT 1 FROM pg_namespace WHERE nspname = '${s}'`), null, 'the emptied schema is gone');
});

test('moveToPublic is a no-op for a table that is not there, and keeps a schema that still has tables', async () => {
  const s = fresh();
  await migrate([{ id: `${s}-make`, up: `CREATE SCHEMA ${s}; CREATE TABLE ${s}.stays (x INT);` }]);
  await migrate([{ id: `${s}-move`, up: moveToPublic([[`${s}.absent`, `${s}_absent`]], [s]) }]);
  assert.ok(await exists(s, 'stays'), 'untouched');
  assert.ok(await one(`SELECT 1 FROM pg_namespace WHERE nspname = '${s}'`), 'not empty, so not dropped');
});

test('[critical] after boot every desk table is in public, and no desk schema is left', async () => {
  const { SettingsCache } = await import('../../src/db/settings.js');
  const { PgTradeStore } = await import('../../src/trading/store.js');
  const { StrategyStore } = await import('../../src/strategy/store.js');
  const { AuthStore } = await import('../../src/auth/store.js');
  const { ErrorLog } = await import('../../src/observability/errors.js');
  const { marketSchema } = await import('../../src/market/oi-history.js');
  const { analyticsSchema } = await import('../../src/db/analytics-schema.js');
  await new SettingsCache().load(); await PgTradeStore.open(); await StrategyStore.open(new (await import('../../src/db/settings.js')).MemorySettings());
  await AuthStore.open(); await new ErrorLog().ready; await marketSchema(); await analyticsSchema();
  const left = await rows<{ nspname: string }>(
    `SELECT nspname FROM pg_namespace WHERE nspname IN ('trading', 'strategy', 'auth', 'errors', 'market', 'analytics')`,
  );
  assert.deepEqual(left, []);
  const tables = (await rows<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY 1`,
  )).map((r) => r.table_name);
  for (const t of ['settings', 'trades', 'trade_events', 'mtm_samples', 'strategies', 'strategy_runs', 'strategy_adds',
    'strategy_rebalances', 'auth_user', 'auth_sessions', 'auth_recovery_codes', 'auth_limits', 'auth_events', 'errors',
    'oi_snapshots', 'chain_features', 'schema_migrations']) {
    assert.ok(tables.includes(t), `${t} is in public`);
  }
});
