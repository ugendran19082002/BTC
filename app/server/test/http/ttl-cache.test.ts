import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ttlCache, ttlCacheStale } from '../../src/http/ttl-cache.js';

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

test('[critical] ttlCacheStale: past its time the held answer is given while it is read again; a slow or failed read never makes the poller wait', async () => {
  let t = 0;
  let reads = 0;
  const cache = ttlCacheStale<number>(5_000, 60_000, 30, () => t);
  assert.equal(await cache('a', async () => ++reads), 1, 'a cold key waits for its read');
  t = 4_000;
  assert.equal(await cache('a', async () => ++reads), 1, 'fresh: not read');
  t = 6_000;
  assert.equal(await cache('a', async () => ++reads), 2, 'past its time, a quick read is waited for');
  // A slow read: the held answer now, the new one on the next request.
  t = 12_000;
  let release!: (v: number) => void;
  const slow = () => { reads++; return new Promise<number>((r) => { release = r; }); };
  assert.equal(await cache('a', slow), 2, 'held answer while Delta is slow');
  assert.equal(await cache('a', slow), 2, 'one read in flight, not two');
  assert.equal(reads, 3);
  release(9);
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(await cache('a', slow), 9);
  // A failed read keeps what was held.
  t = 20_000;
  assert.equal(await cache('a', async () => { throw new Error('delta down'); }), 9);
  // Too old to show: waited on, and a failure is the caller's.
  t = 200_000;
  await assert.rejects(cache('a', async () => { throw new Error('delta down'); }));
  assert.equal(await cache('a', async () => 11), 11);
});
