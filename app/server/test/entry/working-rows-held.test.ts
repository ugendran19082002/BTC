import { after, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { closePool, query, rows } from '../../src/db/pool.js';
import { entrySchema, workingRows } from '../../src/entry/paper.js';
import { bumpDataVersion } from '../../src/entry/version.js';

/**
 * The live grader's working rows are held until the entry tables are next
 * written (4 Oct 2026): 528 rows were read every second for an answer that
 * changes only on a write, and every write moves the data version.
 */
after(() => closePool());
beforeEach(async () => { await entrySchema(); await query('TRUNCATE entry_setups RESTART IDENTITY CASCADE'); bumpDataVersion(); });

const insert = (trigger: number, status = 'open') => query(
  `INSERT INTO entry_setups (method, mode, tf, dir, trigger_at, first_seen, entry_lo, entry_hi, stop, tp1, rr, status, graded_to)
   VALUES ('bos', 'single', '5m', 1, $1, $2, 84900, 85000, 84600, 85500, 2, $3, $1)`, [trigger, trigger * 1000, status]);

test('[critical] between writes the rows are the held ones; the write that changes them is seen on the next ask', async () => {
  await insert(1_790_000_000);
  bumpDataVersion();                               // as the recorder does after its insert
  const first = await workingRows();
  assert.equal(first.length, 1);

  // Something written behind the version's back would not be seen -- which is why every writer moves it.
  await insert(1_790_000_300);
  assert.equal((await workingRows()).length, 1, 'same version: the held answer, no read');
  bumpDataVersion();
  assert.equal((await workingRows()).length, 2, 'the version moved: read again');

  await query(`UPDATE entry_setups SET status = 'stop' WHERE trigger_at = 1790000000`);
  bumpDataVersion();
  const now = await workingRows();
  assert.deepEqual(now.map((r) => r.triggerAt), [1_790_000_300], 'a graded row leaves the working set');
  const real = await rows<{ n: number }>(`SELECT count(*)::int AS n FROM entry_setups WHERE status IN ('open', 'filled') OR runner = 'running'`);
  assert.equal(now.length, real[0]!.n, 'exactly what the table holds');
});

test('[critical] each caller gets its own copies: a grader changing a row cannot change the next caller\'s', async () => {
  await insert(1_790_000_600);
  bumpDataVersion();
  const a = await workingRows();
  a[0]!.status = 'filled';
  a.pop();
  const b = await workingRows();
  assert.equal(b.length, 1);
  assert.equal(b[0]!.status, 'open');
});
