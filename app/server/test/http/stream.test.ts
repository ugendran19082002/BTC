import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StreamHub, sseFrame } from '../../src/http/stream.js';

/**
 * The pushed desk.
 *
 * Two things the hub must do and one it must not: hand a new listener the
 * current picture at once, write to everyone when something changes, and
 * never write a tick that says what the last one said.
 */

test('[critical] a frame is sent once per change, not once per tick', () => {
  const got: string[] = [];
  const hub = new StreamHub();
  hub.add({ write: (c) => got.push(c) });
  assert.equal(hub.publish('spot', { spot: 77_000 }), true);
  assert.equal(hub.publish('spot', { spot: 77_000 }), false);
  assert.equal(hub.publish('spot', { spot: 77_000 }), false);
  assert.equal(hub.publish('spot', { spot: 77_010 }), true);
  assert.deepEqual(got, [sseFrame('spot', { spot: 77_000 }), sseFrame('spot', { spot: 77_010 })]);
});

test('[critical] a listener that arrives late sees the current picture at once', () => {
  const hub = new StreamHub();
  hub.publish('spot', { spot: 77_000 });
  hub.publish('status', { mode: 'paper' });
  hub.publish('spot', { spot: 77_020 });
  const got: string[] = [];
  hub.add({ write: (c) => got.push(c) });
  assert.equal(got.length, 2, 'one frame per event, the latest of each');
  assert.ok(got.includes(sseFrame('spot', { spot: 77_020 })));
  assert.ok(got.includes(sseFrame('status', { mode: 'paper' })));
});

test('a listener that has gone is dropped rather than taking the tick down', () => {
  const hub = new StreamHub();
  const alive: string[] = [];
  hub.add({ write: () => { throw new Error('EPIPE'); } });
  hub.add({ write: (c) => alive.push(c) });
  assert.equal(hub.size, 2);
  hub.publish('spot', { spot: 1 });
  assert.equal(hub.size, 1);
  assert.equal(alive.length, 1);
});

test('the frame is the SSE wire format, one line of JSON', () => {
  assert.equal(sseFrame('spot', { spot: 1 }), 'event: spot\ndata: {"spot":1}\n\n');
});

test('the keep-alive is an event the page can hear, not a comment only the proxy sees', () => {
  const got: string[] = [];
  const hub = new StreamHub();
  hub.add({ write: (c) => got.push(c) });
  hub.ping(5);
  assert.deepEqual(got, ['event: ping\ndata: {"at":5}\n\n']);
});

/** The route, end to end: the gate applies, and a signed-in tab gets frames. */
const dir = mkdtempSync(join(tmpdir(), 'stream-'));
process.env.TRADE_DB = join(dir, 'trades.db');
process.env.ERROR_DB = join(dir, 'errors.db');
process.env.CHAIN_DB = join(dir, 'chain.db');
process.env.DELTA_LIVE_TRADING = '0';
const { hashPassword, COOKIE } = await import('../../src/http/session.js');
const { buildApp } = await import('../../src/http/app.js');
const { AuthService } = await import('../../src/auth/service.js');
const { AuthStore } = await import('../../src/auth/store.js');
const { Secrets } = await import('../../src/auth/secrets.js');
const { tradingService } = await import('../../src/trading/service.js');

type App = Awaited<ReturnType<typeof buildApp>>;
let app: App;
let base = '';
const store = new AuthStore(join(dir, 'auth.db'));
store.seedUser('desk', hashPassword('correct horse battery'), Date.now());
store.createSession({ token: 'full-session-token', stage: 'full', now: Date.now(), ttlMs: 3_600_000, ip: null, userAgent: null });
before(async () => {
  app = await buildApp({ auth: new AuthService({ store, secrets: new Secrets('test-secret'), now: Date.now }) });
  // No exchange in a test: the price the stream publishes is canned.
  const real = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
    String(input).includes('delta.exchange')
      ? Promise.resolve(new Response(JSON.stringify({ success: true, result: { spot_price: '77000' } })))
      : real(input, init)) as typeof fetch;
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  base = typeof addr === 'object' && addr ? `http://127.0.0.1:${addr.port}` : '';
});
after(async () => { tradingService().stop(); await app.close(); });

test('[critical] the stream is behind the gate like every other route', async () => {
  const r = await fetch(`${base}/api/stream`);
  assert.equal(r.status, 401);
});

test('[critical] a signed-in tab gets an event stream with the status in it', async () => {
  const ctl = new AbortController();
  const r = await fetch(`${base}/api/stream`, {
    headers: { cookie: `${COOKIE}=${encodeURIComponent('full-session-token')}` },
    signal: ctl.signal,
  });
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type') ?? '', /text\/event-stream/);
  assert.equal(r.headers.get('x-accel-buffering'), 'no');
  const reader = r.body!.getReader();
  let text = '';
  const deadline = Date.now() + 5_000;
  while (!text.includes('event: status') && Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    text += Buffer.from(value).toString();
  }
  ctl.abort();
  assert.match(text, /^retry: 2000/);
  assert.match(text, /event: status\ndata: \{"mode":"paper"/);
  assert.match(text, /event: spot\ndata: \{"spot":77000\}/);
  assert.match(text, /event: board\ndata: \{"at":/);
});
