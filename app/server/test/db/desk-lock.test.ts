import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { deskLockOk, takeDeskLock, type DeskLock } from '../../src/db/desk-lock.js';
import { NotTheDesk, signed } from '../../src/delta/signed.js';
import { closePool } from '../../src/db/pool.js';

/**
 * One desk trading at a time (22 Oct 2026, the architecture plan's step 3), on the test database itself: two
 * processes' worth of connections contending for the one lock.
 */

const held: DeskLock[] = [];
/** Takers still waiting when a case fails: let go of what each ends up holding, so the file can end. */
const takers: Promise<DeskLock>[] = [];
after(async () => {
  for (const l of held) await l.release();
  // A case that failed may have left a holder between them: each taker let go of in turn, so the next can finish.
  for (const t of takers) { const l = await Promise.race([t, new Promise<null>((r) => setTimeout(() => r(null), 2_000))]).catch(() => null); await l?.release(); }
  await closePool();
});
const lines = () => {
  const said: string[] = [];
  return { said, log: (msg: string) => { said.push(msg); } };
};
/** A lock taken within `ms`, or the case fails -- never a wait without end; whatever it takes later is let go after. */
const take = (o: Parameters<typeof takeDeskLock>[0], ms = 5_000): Promise<DeskLock> => {
  const t = takeDeskLock(o);
  takers.push(t);
  return Promise.race([t, new Promise<never>((_, no) => setTimeout(() => no(new Error(`not taken within ${ms / 1000} s`)), ms).unref())]);
};
const until = async (ok: () => boolean, what: string, ms = 5_000) => {
  const end = Date.now() + ms;
  while (!ok()) { if (Date.now() > end) throw new Error(`timed out: ${what}`); await new Promise((r) => setTimeout(r, 20)); }
};

test('[critical] the first takes it; a second waits as a standby, trading nothing, until the first lets go -- then it takes over', async () => {
  const a = lines(), b = lines();
  const first = await take({ log: a.log, onLost: () => {}, retryMs: 50 });
  held.push(first);
  assert.equal(first.ok(), true);
  assert.deepEqual(a.said, ['desk lock taken: this process is the one desk trading']);
  let second: DeskLock | null = null;
  const waiting = take({ log: b.log, onLost: () => {}, retryMs: 50 }, 10_000).then((l) => { second = l; held.push(l); });
  await until(() => b.said.length > 0, 'the standby says so');
  assert.match(b.said[0]!, /^desk lock held by another process \(pid \d+, btc-desk-api lock.*\): waiting as a standby/);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(second, null, 'still waiting while the first holds it');
  await first.release();
  await waiting;
  assert.equal(second!.ok(), true, 'taken over once it was free');
  await second!.release();
});

test('[critical] a holder gone silent -- a hung process, a container gone without closing its socket -- is ended, and the lock taken; the old one is told it lost it', async () => {
  let lostWhy: string | null = null;
  // No heartbeat at all: its connection sits idle, as a frozen process's would.
  const frozen = await take({ log: () => {}, onLost: (why) => { lostWhy = why; }, heartbeatMs: 3_600_000 });
  held.push(frozen);
  const b = lines();
  // Not a wait of the server's TCP timeout: taken in seconds, or this fails.
  const next = await take({ log: b.log, onLost: () => {}, retryMs: 50, staleMs: 400 });
  held.push(next);
  assert.ok(b.said.some((s) => /has been silent \d+ s -- ending its session and taking over/.test(s)), b.said.join(' / '));
  assert.equal(next.ok(), true);
  await until(() => lostWhy !== null, 'the old holder hears its connection end');
  assert.equal(frozen.ok(), false);
  await next.release();
});

test('[critical] the fence: no write reaches Delta from a process whose lock is lost or whose heartbeat is stale; a read is let through', async () => {
  // Before any lock is taken -- a test, a script -- writes are not fenced.
  assert.equal(deskLockOk(), true);
  let t = Date.now();
  const lock = await take({ log: () => {}, onLost: () => {}, now: () => t, heartbeatMs: 3_600_000, freshMs: 15_000 });
  held.push(lock);
  assert.equal(deskLockOk(), true);
  t += 15_001;                                     // no heartbeat answered for longer than FRESH_MS
  assert.equal(deskLockOk(), false);
  const creds = { key: 'k', secret: 's' };
  await assert.rejects(signed(creds, { method: 'POST', path: '/v2/orders', body: {} }), NotTheDesk);
  await assert.rejects(signed(creds, { method: 'DELETE', path: '/v2/orders', body: {} }), NotTheDesk);
  await lock.release();
  assert.equal(deskLockOk(), true, 'released on purpose: unarmed again');
});
