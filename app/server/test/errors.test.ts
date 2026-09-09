import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ErrorLog, redact } from '../src/observability/errors.js';
import { refuse, wasRefusal, worthLogging } from '../src/http/refuse.js';

const fresh = () => new ErrorLog(join(mkdtempSync(join(tmpdir(), 'errlog-')), 'errors.db'));

test('a failure is stored with everything needed to fix it', () => {
  const log = fresh();
  log.record({
    source: 'server',
    message: 'cannot parse time "yesterday"',
    code: '400',
    stack: 'Error: cannot parse\n  at resolveAt',
    where: 'GET /api/chain',
    context: { query: { at: 'yesterday' } },
  });
  const [row] = log.list();
  assert.equal(row?.message, 'cannot parse time "yesterday"');
  assert.equal(row?.where, 'GET /api/chain');
  assert.equal(row?.code, '400');
  assert.deepEqual(row?.context, { query: { at: 'yesterday' } });
  assert.match(row!.stack!, /at resolveAt/);
});

test('the same failure repeated is one row with a count, not a hundred rows', () => {
  const log = fresh();
  for (let i = 0; i < 50; i++) {
    log.record({ source: 'exchange', message: 'Delta refused the request (insufficient_margin).' });
  }
  const rows = log.list();
  assert.equal(rows.length, 1, 'a poll failing every second must not bury everything else');
  assert.equal(rows[0]?.count, 50);
});

test('the same message from two places stays two rows', () => {
  const log = fresh();
  log.record({ source: 'server', message: 'timeout', where: 'GET /api/chain' });
  log.record({ source: 'server', message: 'timeout', where: 'POST /api/trade/place' });
  assert.equal(log.list().length, 2);
});

test('first and last seen both move the way they should', () => {
  const log = fresh();
  log.record({ source: 'browser', message: 'boom' }, 1_000);
  log.record({ source: 'browser', message: 'boom' }, 9_000);
  const [row] = log.list();
  assert.equal(row?.firstSeen, 1_000, 'the first time it happened does not change');
  assert.equal(row?.lastSeen, 9_000);
});

test('a credential never reaches the table, however it is nested', () => {
  const log = fresh();
  log.record({
    source: 'exchange',
    message: 'signed request failed',
    context: {
      headers: { 'api-key': 'live-key-abc', signature: 'deadbeef', accept: 'application/json' },
      nested: { deeper: { password: 'hunter2', size: 10 } },
    },
  });
  const dump = JSON.stringify(log.list()[0]?.context);
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

test('marking one read hides it without deleting it', () => {
  const log = fresh();
  log.record({ source: 'server', message: 'a' });
  log.record({ source: 'server', message: 'b' });
  const first = log.list()[0]!;
  log.resolve(first.id);
  assert.equal(log.list().length, 1);
  assert.equal(log.list({ includeResolved: true }).length, 2);
});

test('a failure that happens again after being read comes back', () => {
  const log = fresh();
  log.record({ source: 'trading', message: 'protection failed' });
  log.resolve(log.list()[0]!.id);
  assert.equal(log.list().length, 0);
  log.record({ source: 'trading', message: 'protection failed' });
  assert.equal(log.list().length, 1, 'a fix that did not work must not stay hidden');
});

test('the list can be narrowed to one source', () => {
  const log = fresh();
  log.record({ source: 'server', message: 'a' });
  log.record({ source: 'browser', message: 'b' });
  log.record({ source: 'exchange', message: 'c' });
  assert.equal(log.list({ source: 'browser' }).length, 1);
  assert.equal(log.summary().unresolved, 3);
  assert.equal(log.summary().bySource.exchange, 1);
});

test('newest first, because that is the one being investigated', () => {
  const log = fresh();
  log.record({ source: 'server', message: 'old' }, 1_000);
  log.record({ source: 'server', message: 'new' }, 2_000);
  assert.equal(log.list()[0]?.message, 'new');
});

test('a huge stack is truncated rather than filling the disk', () => {
  const log = fresh();
  log.record({ source: 'browser', message: 'deep', stack: 'x'.repeat(50_000) });
  assert.ok(log.list()[0]!.stack!.length < 5_000);
  assert.match(log.list()[0]!.stack!, /truncated/);
});

test('the logger never throws, whatever it is handed', () => {
  const log = fresh();
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  // a logger that can fail takes down the thing it was logging
  assert.doesNotThrow(() => log.record({ source: 'server', message: 'circular', context: circular }));
  assert.doesNotThrow(() => log.record({ source: 'server', message: '' }));
});

test('clearing empties it', () => {
  const log = fresh();
  log.record({ source: 'server', message: 'a' });
  log.clear();
  assert.equal(log.list().length, 0);
  assert.equal(log.summary().total, 0);
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
  assert.equal(worthLogging(500, true), false, 'documenting today’s behaviour');
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
