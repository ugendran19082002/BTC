import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ttlCache } from '../../src/http/ttl-cache.js';

test('[critical] one read per key within its time; a new read after it', async () => {
  let t = 0;
  let reads = 0;
  const cache = ttlCache<number>(5_000, () => t);
  const load = async () => ++reads;
  assert.equal(await cache('a', load), 1);
  t = 4_999;
  assert.equal(await cache('a', load), 1, 'still fresh');
  assert.equal(await cache('b', load), 2, 'another key is its own read');
  t = 5_000;
  assert.equal(await cache('a', load), 3, 'stale: read again');
});

test('[critical] requests during a read share it, and a failure is not kept', async () => {
  let reads = 0;
  const cache = ttlCache<number>(60_000, () => 0);
  let release!: (v: number) => void;
  const slow = () => { reads++; return new Promise<number>((r) => { release = r; }); };
  const a = cache('k', slow);
  const b = cache('k', slow);
  release(7);
  assert.deepEqual([await a, await b, reads], [7, 7, 1]);

  const failing = ttlCache<number>(60_000, () => 0);
  await assert.rejects(failing('k', async () => { throw new Error('db down'); }));
  assert.equal(await failing('k', async () => 9), 9, 'the next request reads again');
});
