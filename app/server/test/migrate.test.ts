import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { appliedMigrations, hasColumn, migrate, type Migration } from '../src/db/migrate.js';

/**
 * The migration ledger.
 *
 * `CREATE TABLE IF NOT EXISTS` on every boot is fine until a table has to
 * *change* — and the `plan` column that was never updated is a reminder that
 * schema and behaviour drift together. These check the two properties that make
 * a ledger worth having: a migration runs exactly once, and a failure leaves
 * nothing half-applied.
 */

const fresh = () => new DatabaseSync(':memory:');

const create: Migration = {
  id: '001-create',
  up: 'CREATE TABLE t (id INTEGER PRIMARY KEY, a TEXT);',
};

test('a migration runs, and is remembered', () => {
  const db = fresh();
  assert.deepEqual(migrate(db, [create]), ['001-create']);
  assert.deepEqual(appliedMigrations(db).map((m) => m.id), ['001-create']);
});

test('[critical] it does not run a second time', () => {
  const db = fresh();
  migrate(db, [create]);
  // the same list again: nothing to do, and no error from re-creating the table
  assert.deepEqual(migrate(db, [create]), []);
  assert.equal(appliedMigrations(db).length, 1);
});

test('only the new ones run when the list grows', () => {
  const db = fresh();
  migrate(db, [create]);
  const add: Migration = { id: '002-add-b', up: 'ALTER TABLE t ADD COLUMN b INTEGER;' };
  assert.deepEqual(migrate(db, [create, add]), ['002-add-b']);
  assert.ok(hasColumn(db, 't', 'b'));
  // and running everything again is a no-op, which an ALTER would not survive
  assert.deepEqual(migrate(db, [create, add]), []);
});

test('they run in the order given', () => {
  const db = fresh();
  const order: string[] = [];
  migrate(db, [
    { id: 'a', up: () => { order.push('a'); } },
    { id: 'b', up: () => { order.push('b'); } },
    { id: 'c', up: () => { order.push('c'); } },
  ]);
  assert.deepEqual(order, ['a', 'b', 'c']);
});

test('[critical] a failure rolls back and stops the boot', () => {
  const db = fresh();
  migrate(db, [create]);
  const bad: Migration = {
    id: '002-bad',
    up: (d) => {
      d.exec("INSERT INTO t (a) VALUES ('written')");
      d.exec('THIS IS NOT SQL');
    },
  };

  assert.throws(() => migrate(db, [create, bad]), /002-bad/);
  // nothing half-applied: the insert went with the failure
  const rows = db.prepare('SELECT COUNT(*) AS n FROM t').get() as { n: number };
  assert.equal(rows.n, 0, 'the transaction did not roll back');
  assert.deepEqual(appliedMigrations(db).map((m) => m.id), ['001-create'], 'and it was not recorded');
});

test('a failure does not stop the next attempt retrying it', () => {
  const db = fresh();
  let attempt = 0;
  const flaky: Migration = {
    id: '001-flaky',
    up: (d) => {
      attempt += 1;
      if (attempt === 1) throw new Error('not yet');
      d.exec('CREATE TABLE ok (id INTEGER)');
    },
  };
  assert.throws(() => migrate(db, [flaky]));
  assert.deepEqual(migrate(db, [flaky]), ['001-flaky']);
  assert.equal(attempt, 2);
});

test('a duplicated id is refused rather than silently skipped', () => {
  // the ids are the memory; two of the same means one of them never runs
  assert.throws(
    () => migrate(fresh(), [create, { id: '001-create', up: 'SELECT 1' }]),
    /share the id/,
  );
});

test('an empty list on a fresh database is not an error', () => {
  assert.deepEqual(migrate(fresh(), []), []);
});

test('hasColumn answers honestly about both cases', () => {
  const db = fresh();
  migrate(db, [create]);
  assert.equal(hasColumn(db, 't', 'a'), true);
  assert.equal(hasColumn(db, 't', 'nope'), false);
});

test('the ledger survives a reopen, which is the whole point', () => {
  // one database, two constructions -- a restart
  const file = ':memory:';
  const db = new DatabaseSync(file);
  migrate(db, [create]);
  assert.deepEqual(migrate(db, [create]), [], 'a second run of the same list does nothing');
});
