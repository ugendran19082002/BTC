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
