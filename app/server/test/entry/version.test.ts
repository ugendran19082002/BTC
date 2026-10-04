import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { bumpDataVersion, dataVersion, versionCache } from '../../src/entry/version.js';
import { cachedSignalPage, recordSignals } from '../../src/entry/signals.js';
import type { MethodRead } from '../../src/entry/types.js';
import { closePool } from '../../src/db/pool.js';

after(closePool);

test('[critical] one read per key and data version, shared by callers asking at once; a write moves the version and the next read is fresh', async () => {
  const cache = versionCache<number>();
  let reads = 0;
  const read = async () => ++reads;
  const [a, b] = await Promise.all([cache('k', read), cache('k', read)]);
  assert.deepEqual([a, b, reads], [1, 1, 1], 'two pollers, one read');
  assert.equal(await cache('k', read), 1, 'same version: the held answer');
  assert.equal(await cache('other', read), 2, 'another key reads');
  const v = dataVersion();
  bumpDataVersion();
  assert.equal(dataVersion(), v + 1);
  assert.equal(await cache('k', read), 3, 'a write happened: read again');
});

test('a failed read is not kept; anything past its age is read again; only so many are held', async () => {
  const cache = versionCache<number>(2, 1_000);
  let n = 0;
  await assert.rejects(cache('x', async () => { throw new Error('db down'); }));
  assert.equal(await cache('x', async () => ++n), 1, 'the failure was not cached');
  assert.equal(await cache('x', async () => ++n, Date.now() + 5_000), 2, 'older than its age: read again');
  await cache('y', async () => 0); await cache('z', async () => 0);
  assert.equal(await cache('x', async () => 99), 99, 'the oldest went when a third was held');
});

test('[critical] the cached history shows a new signal the moment it is recorded -- recording moves the version', async () => {
  const T = 1_790_400_000;
  const read: MethodRead = {
    id: 'bos', n: 6, name: 'BOS', group: 'breakout', summary: '', mode: 'single', tf: '1h', dir: 'long', state: 'WAIT',
    steps: [], gates: [], plan: null, score: 40, scoreParts: [], alignment: null, reason: 'x', triggerTime: T,
  };
  const q = { tf: '1h', since: (T - 60) * 1000 };
  assert.equal((await cachedSignalPage(q)).total, 0);
  await recordSignals([read], (T + 5) * 1000);
  assert.equal((await cachedSignalPage(q)).total, 1, 'not the held empty answer');
});

test('[critical] a page turn or a sort reads the rows only: the count and the totals are held by the filters, and a new signal still shows at once', async () => {
  const T = 1_790_500_000;
  const read = (i: number): MethodRead => ({
    id: 'bos', n: 6, name: 'BOS', group: 'breakout', summary: '', mode: 'single', tf: '4h', dir: i % 2 ? 'long' : 'short', state: 'WAIT',
    steps: [], gates: [], plan: null, score: 10 * i, scoreParts: [], alignment: null, reason: 'x', triggerTime: T + i * 14_400,
  });
  await recordSignals([1, 2, 3, 4, 5].map(read), (T + 100_000) * 1000);
  const filters = { tf: '4h', since: (T - 60) * 1000 };

  const first = await cachedSignalPage({ ...filters, limit: 2, offset: 0 });
  const second = await cachedSignalPage({ ...filters, limit: 2, offset: 2 });
  const sorted = await cachedSignalPage({ ...filters, limit: 2, offset: 0, sort: 'score', asc: true });
  assert.deepEqual([first.total, second.total, sorted.total], [5, 5, 5], 'the same count on every page');
  assert.equal(second.summary, first.summary, 'the totals are the held answer, not read again');
  assert.equal(sorted.summary, first.summary, 'nor for a sort');
  assert.deepEqual(first.signals.map((s) => s.score), [50, 40], 'newest first');
  assert.deepEqual(second.signals.map((s) => s.score), [30, 20], 'the next page is its own rows');
  assert.deepEqual(sorted.signals.map((s) => s.score), [10, 20], 'and a sort its own order');
  assert.notEqual((await cachedSignalPage({ ...filters, dir: 1, limit: 2 })).summary, first.summary, 'another filter is another count');
  assert.equal((await cachedSignalPage({ ...filters, dir: 1, limit: 2 })).total, 3);

  await recordSignals([read(6)], (T + 100_005) * 1000);
  const after = await cachedSignalPage({ ...filters, limit: 2, offset: 0 });
  assert.equal(after.total, 6, 'a write moves the version: counted again');
  assert.equal(after.signals[0]!.score, 60);
});
