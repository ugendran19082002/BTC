import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import {
  AUTH_REFUSED_MS, AUTH_TIMEOUT_MS, authSignature, BACKOFF_MAX_MS, HANDSHAKE_FAILS_BEFORE_PAUSE, HANDSHAKE_PAUSE_MS,
  MAX_OPENS_PER_WINDOW, PrivateSocket, SENT_TYPES, WATCHDOG_MS, type SocketLike,
} from '../../src/delta/private-socket.js';

/**
 * The private socket's connection (delta/private-socket.ts): signed in as Delta's docs say, subscribed only after,
 * kept alive by its heartbeat, and patient with a Delta that refuses or does not answer. A fake socket and a clock
 * the test turns; nothing reaches the network.
 */

const creds = { key: 'test-key-0001', secret: 'test-secret-do-not-log' };

function harness() {
  let t = 1_794_000_000_000;
  const sockets: (SocketLike & { sent: Record<string, unknown>[]; closed: boolean })[] = [];
  const messages: string[] = [];
  const lives: (number | null)[] = [];
  const downs: number[] = [];
  const logs: string[] = [];
  const s = new PrivateSocket({
    accountId: 3, creds,
    onMessage: (raw) => messages.push(raw),
    onLive: (d) => lives.push(d),
    onDown: (at) => downs.push(at),
    log: (l) => logs.push(l),
    now: () => t,
    manualTimers: true,
    connect: () => {
      const ws: SocketLike & { sent: Record<string, unknown>[]; closed: boolean } = {
        sent: [], closed: false,
        send: (d) => { ws.sent.push(JSON.parse(d) as Record<string, unknown>); },
        close: () => { ws.closed = true; },
        onopen: null, onmessage: null, onclose: null, onerror: null,
      };
      sockets.push(ws);
      return ws;
    },
  });
  const last = () => sockets[sockets.length - 1]!;
  const say = (m: unknown) => last().onmessage!({ data: JSON.stringify(m) });
  const authOk = () => say({ type: 'key-auth', success: true, status_code: 200, status: 'authenticated' });
  const advance = (ms: number) => { t += ms; s.check(); };
  return { s, sockets, last, say, authOk, advance, messages, lives, downs, logs, now: () => t };
}

test('[critical] signs in as Delta\'s docs say: key-auth, the timestamp in seconds as a number, HMAC of GET + ts + /live', () => {
  const h = harness();
  h.s.start();
  h.last().onopen!({});
  const types = h.last().sent.map((m) => m.type);
  assert.deepEqual(types, ['enable_heartbeat', 'key-auth']);
  const auth = h.last().sent[1]!.payload as Record<string, unknown>;
  const ts = Math.floor(h.now() / 1000);
  assert.equal(auth['api-key'], creds.key);
  assert.equal(auth.timestamp, ts, 'a number, not a string');
  assert.equal(auth.signature, authSignature(creds.secret, ts));
  // The docs' own formula, worked here independently.
  assert.equal(auth.signature, createHmac('sha256', creds.secret).update(`GET${ts}/live`).digest('hex'));
});

test('[critical] nothing is subscribed before the sign-in succeeds (Delta refuses that, seen live); after it, orders and v2/user_trades for every contract', () => {
  const h = harness();
  h.s.start();
  h.last().onopen!({});
  assert.equal(h.last().sent.some((m) => m.type === 'subscribe'), false);
  h.authOk();
  const sub = h.last().sent.find((m) => m.type === 'subscribe');
  assert.deepEqual(sub, { type: 'subscribe', payload: { channels: [{ name: 'orders', symbols: ['all'] }, { name: 'v2/user_trades', symbols: ['all'] }] } });
  assert.equal(h.s.health().state, 'live');
  assert.deepEqual(h.lives, [null], 'the first connection: nothing to recover');
});

test('[critical] the socket can only ever send its three kinds of message -- never an order', () => {
  const h = harness();
  h.s.start();
  h.last().onopen!({});
  h.authOk();
  h.say({ type: 'v2/user_trades', f: 'x' });
  h.advance(WATCHDOG_MS);              // a reconnect, and its own sign-in
  h.advance(5_000);
  h.last().onopen?.({});
  h.authOk();
  for (const ws of h.sockets) for (const m of ws.sent) assert.ok((SENT_TYPES as readonly string[]).includes(String(m.type)), `sent ${String(m.type)}`);
});

test('messages before the sign-in, heartbeats and subscription replies are not handed on; everything else is, raw', () => {
  const h = harness();
  h.s.start();
  h.last().onopen!({});
  h.say({ type: 'orders', order_id: 1 });                     // before auth: dropped
  h.authOk();
  h.say({ type: 'heartbeat', ts_origin: 1 });
  h.say({ channels: [{ name: 'orders', symbols: ['all'] }], type: 'subscriptions' });
  h.say({ type: 'v2/user_trades', f: 'abc' });
  assert.equal(h.messages.length, 1);
  assert.match(h.messages[0]!, /abc/);
});

test('a channel Delta will not subscribe is said, once, and kept in the health', () => {
  const h = harness();
  h.s.start();
  h.last().onopen!({});
  h.authOk();
  const refused = { channels: [{ error: 'subscription forbidden on this channel. Unauthorized user', name: 'orders' }], type: 'subscriptions' };
  h.say(refused);
  h.say(refused);
  assert.deepEqual(h.s.health().subscribeErrors, ['orders: subscription forbidden on this channel. Unauthorized user']);
  assert.equal(h.logs.filter((l) => l.includes('would not subscribe')).length, 1);
});

test('[critical] a key Delta refuses is not retried every second: ten minutes, said once, and no subscribe', () => {
  const h = harness();
  h.s.start();
  h.last().onopen!({});
  h.say({ message: 'ApiKey not found', status: 'api_key_not_found', status_code: 404, success: false, type: 'key-auth' });
  const health = h.s.health();
  assert.equal(health.state, 'refused');
  assert.equal(health.lastAuthError, 'api_key_not_found');
  assert.equal(health.nextTryAt, h.now() + AUTH_REFUSED_MS);
  assert.equal(h.last().closed, true);
  assert.equal(h.last().sent.some((m) => m.type === 'subscribe'), false);
  const opened = h.sockets.length;
  h.advance(AUTH_REFUSED_MS - 1_000);
  assert.equal(h.sockets.length, opened, 'not before the ten minutes');
  h.advance(1_000);
  assert.equal(h.sockets.length, opened + 1);
  // Refused again: not said a second time.
  h.last().onopen!({});
  h.say({ status: 'api_key_not_found', status_code: 404, success: false, type: 'key-auth' });
  assert.equal(h.logs.filter((l) => l.includes('refused the key')).length, 1);
  assert.equal(h.s.health().authFailures, 2);
});

test('an expired timestamp (a clock a few seconds out) is the usual short backoff, not the long one', () => {
  const h = harness();
  h.s.start();
  h.last().onopen!({});
  h.say({ status: 'request_expired', status_code: 408, success: false, type: 'key-auth' });
  assert.equal(h.s.health().state, 'waiting');
  assert.ok(h.s.health().nextTryAt! - h.now() <= 1_200);
});

test('[critical] silence past the watchdog is a dead socket: dropped, reconnected, and the outage handed on for recovery', () => {
  const h = harness();
  h.s.start();
  h.last().onopen!({});
  h.authOk();
  const downAt = h.now() + WATCHDOG_MS;
  h.advance(WATCHDOG_MS);
  assert.equal(h.last().closed, true);
  assert.deepEqual(h.downs, [downAt]);
  assert.equal(h.s.isLive(), false);
  h.advance(1_500);                   // the first backoff, at most 1.2 s
  assert.equal(h.sockets.length, 2);
  h.last().onopen!({});
  h.authOk();
  assert.deepEqual(h.lives, [null, downAt], 'live again, and since when it could not hear');
  assert.equal(h.s.health().reconnects, 1);
});

test('heartbeats keep it alive past the watchdog', () => {
  const h = harness();
  h.s.start();
  h.last().onopen!({});
  h.authOk();
  for (let i = 0; i < 20; i++) { h.advance(5_000); h.say({ type: 'heartbeat' }); }
  assert.equal(h.sockets.length, 1);
  assert.equal(h.s.isLive(), true);
});

test('opened but never answered the sign-in: started again after the auth timeout', () => {
  const h = harness();
  h.s.start();
  h.last().onopen!({});
  h.say({ type: 'heartbeat' });
  h.advance(AUTH_TIMEOUT_MS);
  assert.equal(h.last().closed, true);
  assert.equal(h.s.health().state, 'waiting');
});

test('[critical] handshakes that keep failing (a 429 looks like that) wait five minutes, as Delta asks', () => {
  const h = harness();
  h.s.start();
  for (let i = 1; i < HANDSHAKE_FAILS_BEFORE_PAUSE; i++) {
    h.last().onclose!({ code: 1006 });
    assert.ok(h.s.health().nextTryAt! - h.now() < HANDSHAKE_PAUSE_MS);
    h.advance(h.s.health().nextTryAt! - h.now());
  }
  h.last().onclose!({ code: 1006 });
  assert.equal(h.s.health().nextTryAt, h.now() + HANDSHAKE_PAUSE_MS);
  assert.ok(h.logs.some((l) => l.includes('handshakes failed')));
});

test('the backoff doubles to its ceiling, and starts again from the bottom after a socket that stayed up', () => {
  const h = harness();
  h.s.start();
  h.last().onopen!({});
  h.authOk();
  let waits: number[] = [];
  for (let i = 0; i < 8; i++) {
    h.advance(WATCHDOG_MS);
    waits.push(h.s.health().nextTryAt! - h.now());
    h.advance(h.s.health().nextTryAt! - h.now());
    h.last().onopen!({});
    h.say({ type: 'heartbeat' });
    h.authOk();
  }
  assert.ok(waits[0]! <= 1_200 && waits[3]! >= 6_400, `grows: ${waits.join(',')}`);
  assert.ok(Math.max(...waits) <= BACKOFF_MAX_MS * 1.2);
  // Up for a minute and more, then lost: from the bottom again.
  for (let i = 0; i < 15; i++) { h.advance(5_000); h.say({ type: 'heartbeat' }); }
  h.advance(WATCHDOG_MS);
  waits = [h.s.health().nextTryAt! - h.now()];
  assert.ok(waits[0]! <= 1_200, `reset: ${waits[0]}`);
});

test('[critical] however it flaps, no five minutes hold more than twenty opens: Delta\'s limit is 150 for the whole IP', () => {
  const h = harness();
  h.s.start();
  const opened: number[] = [h.now()];
  // Thirty minutes of a socket that opens, says one thing, and is closed -- the worst a flaky link can do.
  while (h.now() - opened[0]! < 30 * 60_000) {
    h.last().onopen?.({});
    h.say({ type: 'heartbeat' });     // a message: a connection lost, not a failed handshake
    h.last().onclose!({ code: 1000 });
    const before = h.sockets.length;
    h.advance(Math.max(1, h.s.health().nextTryAt! - h.now()));
    if (h.sockets.length > before) opened.push(h.now());
  }
  for (const t of opened) {
    const inWindow = opened.filter((x) => x >= t && x < t + 5 * 60_000).length;
    assert.ok(inWindow <= MAX_OPENS_PER_WINDOW, `${inWindow} opens in the five minutes from ${t}`);
  }
});

test('[critical] the secret and the signature are never in a log line', () => {
  const h = harness();
  h.s.start();
  h.last().onopen!({});
  h.say({ status: 'invalid_signature', status_code: 401, success: false, type: 'key-auth' });
  const sig = authSignature(creds.secret, Math.floor(h.now() / 1000));
  for (const l of h.logs) {
    assert.ok(!l.includes(creds.secret), l);
    assert.ok(!l.includes(sig), l);
    assert.ok(!l.includes(creds.key), l);
  }
});

test('stop(): closed, and nothing opens again', () => {
  const h = harness();
  h.s.start();
  h.last().onopen!({});
  h.authOk();
  h.s.stop();
  assert.equal(h.last().closed, true);
  h.advance(10 * 60_000);
  assert.equal(h.sockets.length, 1);
  assert.equal(h.s.health().state, 'stopped');
});
