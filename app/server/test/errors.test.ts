import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { DELETED_KEEP_MS, ErrorLog, groupWhere, redact } from '../src/observability/errors.js';
import { refuse, wasRefusal, worthLogging } from '../src/http/refuse.js';
import { closePool, one } from '../src/db/pool.js';

// One database for the file; each case starts it empty. `record()` is
// fire-and-forget, so every read below is preceded by a `flush()`.
const fresh = async () => { const log = new ErrorLog(); await log.ready; await log.clear(); return log; };

after(() => closePool());

test('a failure is stored with everything needed to fix it', async () => {
  const log = await fresh();
  log.record({
    source: 'server',
    message: 'cannot parse time "yesterday"',
    code: '400',
    stack: 'Error: cannot parse\n  at resolveAt',
    where: 'GET /api/chain',
    context: { query: { at: 'yesterday' } },
  });
  await log.flush();
  const [row] = await log.list();
  assert.equal(row?.message, 'cannot parse time "yesterday"');
  assert.equal(row?.where, 'GET /api/chain');
  assert.equal(row?.code, '400');
  assert.deepEqual(row?.context, { query: { at: 'yesterday' } });
  assert.match(row!.stack!, /at resolveAt/);
});

test('the same failure repeated is one row with a count, not a hundred rows', async () => {
  const log = await fresh();
  for (let i = 0; i < 50; i++) {
    log.record({ source: 'exchange', message: 'Delta refused the request (insufficient_margin).' });
  }
  await log.flush();
  const rows = await log.list();
  assert.equal(rows.length, 1, 'a poll failing every second must not bury everything else');
  assert.equal(rows[0]?.count, 50);
});

test('[critical] one trouble across many orders is one row (18 Oct 2026: 98 rows for one Delta outage): the ids come out of a request\'s path, and stay in its context', async () => {
  const log = await fresh();
  for (const id of ['810261792256408342T0', '810261792252806948S0', '810261792252810930T0']) {
    log.record({ source: 'exchange', level: 'warn', message: 'Delta refused the request (http_502).', code: 'http_502', where: `GET /v2/orders/client_order_id/${id}` });
  }
  log.record({ source: 'exchange', message: 'Delta refused the request (market_disrupted_cancel_only_mode).', where: 'POST /v2/products/158471/orders/leverage' });
  log.record({ source: 'exchange', message: 'Delta refused the request (market_disrupted_cancel_only_mode).', where: 'POST /v2/products/158482/orders/leverage' });
  await log.flush();
  const rows = await log.list();
  assert.deepEqual(rows.map((r) => [r.where, r.count]).sort(), [['GET /v2/orders/client_order_id/:id', 3], ['POST /v2/products/:id/orders/leverage', 2]]);
  assert.match(String((rows.find((r) => r.where?.startsWith('GET'))!.context as { where?: string }).where), /^GET \/v2\/orders\/client_order_id\/8102617922/);
  // Only a request's path: a route, a component, a symbol are left as they are.
  assert.equal(groupWhere('trade-alarm'), 'trade-alarm');
  assert.equal(groupWhere('C-BTC-82000-181026'), 'C-BTC-82000-181026');
  assert.equal(groupWhere('GET /v2/orders'), 'GET /v2/orders');
  assert.equal(groupWhere('GET /api/backtest-saves/abc12'), 'GET /api/backtest-saves/abc12', 'four digits or fewer is not an id');
});

test('the same message from two places stays two rows', async () => {
  const log = await fresh();
  log.record({ source: 'server', message: 'timeout', where: 'GET /api/chain' });
  log.record({ source: 'server', message: 'timeout', where: 'POST /api/trade/place' });
  await log.flush();
  assert.equal((await log.list()).length, 2);
});

test('first and last seen both move the way they should', async () => {
  const log = await fresh();
  log.record({ source: 'browser', message: 'boom' }, 1_000);
  log.record({ source: 'browser', message: 'boom' }, 9_000);
  await log.flush();
  const [row] = await log.list();
  assert.equal(row?.firstSeen, 1_000, 'the first time it happened does not change');
  assert.equal(row?.lastSeen, 9_000);
});

test('a credential never reaches the table, however it is nested', async () => {
  const log = await fresh();
  log.record({
    source: 'exchange',
    message: 'signed request failed',
    context: {
      headers: { 'api-key': 'live-key-abc', signature: 'deadbeef', accept: 'application/json' },
      nested: { deeper: { password: 'hunter2', size: 10 } },
    },
  });
  await log.flush();
  const dump = JSON.stringify((await log.list())[0]?.context);
  assert.ok(!dump.includes('live-key-abc'), 'the key is in the log, which is worse than in the env');
  assert.ok(!dump.includes('deadbeef'));
  assert.ok(!dump.includes('hunter2'));
  assert.ok(dump.includes('application/json'), 'the harmless parts survive');
  assert.ok(dump.includes('10'));
});

test('redaction leaves values that are not secrets alone', () => {
  assert.deepEqual(redact({ size: 10, symbol: 'C-BTC-80000' }), { size: 10, symbol: 'C-BTC-80000' });
  assert.deepEqual(redact(null), null);
  assert.deepEqual(redact('plain'), 'plain');
});

test('marking one read hides it without deleting it', async () => {
  const log = await fresh();
  log.record({ source: 'server', message: 'a' });
  log.record({ source: 'server', message: 'b' });
  await log.flush();
  const first = (await log.list())[0]!;
  await log.resolve(first.id);
  assert.equal((await log.list()).length, 1);
  assert.equal((await log.list({ includeResolved: true })).length, 2);
});

test('a failure that happens again after being read comes back', async () => {
  const log = await fresh();
  log.record({ source: 'trading', message: 'protection failed' });
  await log.flush();
  await log.resolve((await log.list())[0]!.id);
  assert.equal((await log.list()).length, 0);
  log.record({ source: 'trading', message: 'protection failed' });
  await log.flush();
  assert.equal((await log.list()).length, 1, 'a fix that did not work must not stay hidden');
});

test('the list can be narrowed to one source', async () => {
  const log = await fresh();
  log.record({ source: 'server', message: 'a' });
  log.record({ source: 'browser', message: 'b' });
  log.record({ source: 'exchange', message: 'c' });
  await log.flush();
  assert.equal((await log.list({ source: 'browser' })).length, 1);
  assert.equal((await log.summary()).unresolved, 3);
  assert.equal((await log.summary()).bySource.exchange, 1);
});

test('newest first, because that is the one being investigated', async () => {
  const log = await fresh();
  log.record({ source: 'server', message: 'old' }, 1_000);
  log.record({ source: 'server', message: 'new' }, 2_000);
  await log.flush();
  assert.equal((await log.list())[0]?.message, 'new');
});

test('a huge stack is truncated rather than filling the disk', async () => {
  const log = await fresh();
  log.record({ source: 'browser', message: 'deep', stack: 'x'.repeat(50_000) });
  await log.flush();
  const [row] = await log.list();
  assert.ok(row!.stack!.length < 5_000);
  assert.match(row!.stack!, /truncated/);
});

test('the logger never throws, whatever it is handed', async () => {
  const log = await fresh();
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  // a logger that can fail takes down the thing it was logging
  assert.doesNotThrow(() => log.record({ source: 'server', message: 'circular', context: circular }));
  assert.doesNotThrow(() => log.record({ source: 'server', message: '' }));
  await log.flush();
  // and what could be kept, was
  assert.equal((await log.list()).length, 1, 'the empty message became "unknown error"');
});

test('[critical] the table is capped, and an unresolved failure is never dropped to make room', async () => {
  const log = await fresh();
  // Two thousand old, resolved rows...
  await one(
    `INSERT INTO errors (fingerprint, source, level, message, first_seen, last_seen, resolved)
     SELECT 'old-' || g, 'server', 'error', 'old ' || g, g, g, TRUE FROM generate_series(1, 2000) g`,
  );
  // ...one unresolved row older than any of them...
  await one(
    `INSERT INTO errors (fingerprint, source, level, message, first_seen, last_seen, resolved)
     VALUES ('keep', 'trading', 'error', 'still broken', 0, 0, FALSE)`,
  );
  // ...and enough new reports to trigger a prune.
  for (let i = 0; i < 50; i++) log.record({ source: 'browser', message: `fresh ${i}` }, 10_000 + i);
  await log.flush();
  const s = await log.summary();
  assert.ok(s.total <= 2_000, `capped: ${s.total}`);
  assert.equal(s.unresolved, 51, 'the old unresolved one and the fifty new ones all survive');
  assert.equal((await log.list({ source: 'trading' }))[0]?.message, 'still broken');
});

test('[critical] deleted from the screen is kept on record (21 Oct 2026: Delete all took what the 13:01 target needed): off the list and the badge, still read back', async () => {
  const log = await fresh();
  log.record({ source: 'trading', message: 'target placed twice' }, 1_000);
  log.record({ source: 'server', message: 'b' }, 1_000);
  log.record({ source: 'server', message: 'c' }, 1_000);
  await log.flush();
  const [one] = await log.list({ source: 'trading' });
  assert.equal(await log.remove(one!.id, 5_000), 1);
  assert.equal(await log.remove(one!.id, 6_000), 0, 'deleted once: the date it went is kept');
  assert.deepEqual((await log.list({ includeResolved: true })).map((r) => r.message).sort(), ['b', 'c']);
  assert.equal(await log.removeAll(7_000), 2);
  assert.deepEqual(await log.list({ includeResolved: true }), []);
  assert.deepEqual(await log.summary(), { total: 0, unresolved: 0, bySource: {} });
  // ...and read back, whole, with when each went.
  const kept = await log.list({ deleted: true });
  assert.equal(kept.length, 3);
  const t = kept.find((r) => r.message === 'target placed twice')!;
  assert.equal(t.deletedAt, 5_000);
  assert.equal(t.source, 'trading');
});

test('[critical] deleted and back: on the screen again, counted from one, from when it came back', async () => {
  const log = await fresh();
  for (let i = 0; i < 70; i++) log.record({ source: 'exchange', message: 'Delta 502' }, 1_000 + i);
  await log.flush();
  await log.removeAll(2_000);
  log.record({ source: 'exchange', message: 'Delta 502' }, 3_000);
  await log.flush();
  const [r] = await log.list();
  assert.equal(r?.count, 1);
  assert.equal(r?.firstSeen, 3_000);
  assert.equal(r?.deletedAt, null);
  assert.equal(r?.resolved, false);
  assert.deepEqual(await log.list({ deleted: true }), []);
});

test('[critical] a deleted row goes after 30 days, not before; one on the screen stays however old', async () => {
  const log = await fresh();
  log.record({ source: 'server', message: 'old, deleted' }, 0);
  log.record({ source: 'server', message: 'new, deleted' }, 0);
  log.record({ source: 'server', message: 'old, on the screen' }, 0);
  await log.flush();
  const rows = await log.list();
  await log.remove(rows.find((r) => r.message === 'old, deleted')!.id, 1_000);
  await log.remove(rows.find((r) => r.message === 'new, deleted')!.id, 2_000);
  // Fifty writes start a prune, at their own time: 30 days and a moment after the first deletion, not the second.
  for (let i = 0; i < 50; i++) log.record({ source: 'browser', message: `fresh ${i}` }, 1_000 + DELETED_KEEP_MS + 500);
  await log.flush();
  assert.deepEqual((await log.list({ deleted: true })).map((r) => r.message), ['new, deleted']);
  assert.ok((await log.list({ source: 'server' })).some((r) => r.message === 'old, on the screen'));
});

test('clearing empties it', async () => {
  const log = await fresh();
  log.record({ source: 'server', message: 'a' });
  await log.clear();
  assert.equal((await log.list()).length, 0);
  assert.equal((await log.summary()).total, 0);
});

// ---------------------------------------------------------------- refusals

/**
 * The log is only worth reading if everything in it needs fixing.
 *
 * This desk says no for a living -- the spread gate, the premium floor, the
 * mode switch refusing to flip with a position open -- and every one of those
 * was writing a row. Three 409s from the mode switch sat in the live log next
 * to nothing else, and the 422 the place route answers on a blocked order would
 * have added one per refusal.
 */
test('a refusal the route meant stays out of the log', () => {
  let sent: number | null = null;
  const reply = { code: (c: number) => { sent = c; } } as never;
  assert.deepEqual(refuse(reply, 422, { ok: false }), { ok: false }, 'the body passes through');
  assert.equal(sent, 422, 'and the status is actually set');
  assert.equal(wasRefusal(reply), true);
  assert.equal(worthLogging(422, wasRefusal(reply)), false);
});

test('an unmarked reply is logged, so forgetting to mark one makes noise rather than silence', () => {
  assert.equal(wasRefusal({} as never), false);
  assert.equal(worthLogging(422, false), true);
  assert.equal(worthLogging(500, false), true);
});

test('[critical] a deliberate 500 is still logged: the mark cannot hide a fault', () => {
  // "I meant to" is a claim about a 4xx. Nothing means to fail.
  assert.equal(worthLogging(500, true), true, 'a 5xx is always a fault, however it happened');
});

test('success is never an error', () => {
  for (const code of [200, 201, 204, 302]) assert.equal(worthLogging(code, false), false);
});

test('not signed in and not found stay out either way', () => {
  // A browser reaches both by ordinary navigation, and they would drown the rest.
  assert.equal(worthLogging(401, false), false);
  assert.equal(worthLogging(404, false), false);
});

test('a bad request from our own screen is still a bug worth seeing', () => {
  // 400 "tradeId is required" means the page sent a broken request.
  assert.equal(worthLogging(400, false), true);
});
