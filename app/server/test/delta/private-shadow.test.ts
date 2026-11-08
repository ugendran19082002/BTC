import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { query, rows, closePool } from '../../src/db/pool.js';
import { SettingsCache } from '../../src/db/settings.js';
import { PgTradeStore } from '../../src/trading/store.js';
import {
  PrivateShadow, privateShadowMetrics, privateShadowSchema, REST_GRACE_MS, SETTLE_MS, SOCKET_GRACE_MS, startPrivateShadow,
  type RestFill,
} from '../../src/delta/private-shadow.js';
import { WATCHDOG_MS, type SocketLike } from '../../src/delta/private-socket.js';

/**
 * The private socket in shadow (delta/private-shadow.ts), on a database of its own: what it keeps, how it compares
 * with the journal the REST path writes, and how it recovers what it could not hear. Fake sockets, a clock the
 * test turns, a REST reader the test answers for.
 */

const credsOf = (id: number) => ({ key: `key-${id}`, secret: `secret-${id}` });

before(async () => {
  // The journal's migrations follow the settings' (trading-001), as at boot.
  await new SettingsCache().load();
  await PgTradeStore.open();
  await privateShadowSchema();
});
beforeEach(async () => {
  await query('DELETE FROM private_ws_fills');
  await query('DELETE FROM trade_events');
  await query('DELETE FROM trades');
});
after(async () => { await closePool(); });

let tradeN = 0;
/** A fill as the REST path writes it into the journal: a trade on an account, and its `fill` event. */
async function journalFill(accountId: number, orderId: string, size: number, at: number): Promise<void> {
  const id = `t-${++tradeN}`;
  await query(
    `INSERT INTO trades (trade_id, symbol, phase, position, plan, state, updated_at, broker_account_id)
     VALUES ($1, 'C-BTC-99000-091126', 'protected', $2, '{}'::jsonb, '{}'::jsonb, $3, $4)`,
    [id, -size, at, accountId],
  );
  await query(
    `INSERT INTO trade_events (trade_id, seq, at, kind, event) VALUES ($1, 0, $2, 'fill', $3)`,
    [id, at, JSON.stringify({ t: 'fill', role: 'entry', side: 'sell', size, price: 17.5, orderId, at })],
  );
}


function harness(o: { accounts?: number[]; reader?: (from: number, to: number) => Promise<RestFill[]>; busy?: () => number } = {}) {
  let t = 1_794_000_000_000;
  const sockets = new Map<number, (SocketLike & { sent: string[] })[]>();
  const logs: string[] = [];
  let accounts = (o.accounts ?? [3]).map((id) => ({ id, creds: credsOf(id) }));
  const readerCalls: { from: number; to: number }[] = [];
  const shadow = new PrivateShadow({
    accounts: () => accounts,
    log: (l) => logs.push(l),
    now: () => t,
    manualTimers: true,
    ...(o.busy ? { busyPct: o.busy } : {}),
    reader: async (_c, from, to) => { readerCalls.push({ from, to }); return o.reader ? o.reader(from, to) : []; },
    connect: (id) => {
      const ws: SocketLike & { sent: string[] } = {
        sent: [], send: (d) => { ws.sent.push(d); }, close: () => {},
        onopen: null, onmessage: null, onclose: null, onerror: null,
      };
      sockets.set(id, [...(sockets.get(id) ?? []), ws]);
      return ws;
    },
  });
  const ws = (id = 3) => sockets.get(id)!.at(-1)!;
  const say = (m: unknown, id = 3) => ws(id).onmessage!({ data: JSON.stringify(m) });
  const goLive = (id = 3) => { ws(id).onopen!({}); say({ type: 'key-auth', success: true, status_code: 200, status: 'authenticated' }, id); };
  const fill = (fillId: string, orderId: string, size: number, id = 3, se?: number) =>
    say({ type: 'v2/user_trades', sy: 'C-BTC-99000-091126', f: fillId, R: 'normal', o: orderId, S: 'sell', s: size, p: '17.5', po: -size, r: 'maker', c: null, t: t * 1_000 - 300_000, ...(se !== undefined ? { se } : {}) }, id);
  const heartbeat = (id = 3) => say({ type: 'heartbeat' }, id);
  /** Time passes, with the socket's heartbeats arriving as they would. */
  const pass = async (ms: number, beating = true) => {
    for (let left = ms; left > 0; left -= 5_000) { t += Math.min(5_000, left); if (beating) for (const id of sockets.keys()) { try { heartbeat(id); } catch { /* closed */ } } }
    await shadow.tick();
  };
  return {
    shadow, ws, say, goLive, fill, pass, logs, readerCalls, sockets,
    now: () => t, set accounts(ids: number[]) { accounts = ids.map((id) => ({ id, creds: credsOf(id) })); },
    rekey: (id: number) => { accounts = accounts.map((a) => (a.id === id ? { id, creds: { key: `new-${id}`, secret: 's' } } : a)); },
    m: (id = 3) => shadow.metrics().find((a) => a.accountId === id)!,
  };
}

test('[critical] a fill is kept once, however often the socket says it -- and again after a restart', async () => {
  const h = harness();
  h.shadow.start();
  h.goLive();
  h.fill('f-1', '501', 2);
  h.fill('f-1', '501', 2);
  await h.shadow.flushed();
  assert.equal(h.m().counts.fills, 1);
  assert.equal(h.m().counts.duplicates, 1);
  assert.equal((await rows('SELECT * FROM private_ws_fills')).length, 1);
  h.shadow.stop();

  // A new process: the same fill delivered again is known by the table, not by memory.
  const h2 = harness();
  h2.shadow.start();
  h2.goLive();
  h2.fill('f-1', '501', 2);
  await h2.shadow.flushed();
  assert.equal(h2.m().counts.fills, 0);
  assert.equal(h2.m().counts.duplicates, 1);
  const kept = await rows<{ order_id: string; size: number; account_id: string }>('SELECT * FROM private_ws_fills');
  assert.equal(kept.length, 1);
  assert.equal(kept[0]!.order_id, '501');
  h2.shadow.stop();
});

test('[critical] the lead: the socket heard the fill 2 s before the journal recorded it', async () => {
  const h = harness();
  h.shadow.start();
  await h.shadow.tick();                       // where the journal stands now
  h.goLive();
  h.fill('f-1', '601', 3);
  await h.shadow.flushed();
  await journalFill(3, '601', 3, h.now() + 2_000);
  await h.pass(2_000);
  const c = h.m().compare;
  assert.equal(c.matched, 1);
  assert.equal(c.leadMs.p50Ms, 2_000);
  assert.equal(c.socketFirst, 1);
  assert.equal(c.restOnly, 0);
  h.shadow.stop();
});

test('[critical] a fill the journal has and the live socket never said is called missed -- after the grace, not before', async () => {
  const h = harness();
  h.shadow.start();
  await h.shadow.tick();
  h.goLive();
  await h.pass(10_000);
  await journalFill(3, '701', 1, h.now());
  await h.pass(REST_GRACE_MS - 10_000);
  assert.equal(h.m().compare.restOnly, 0, 'inside the grace');
  await h.pass(15_000);
  const c = h.m().compare;
  assert.equal(c.restOnly, 1);
  assert.equal(c.discrepancies[0]!.kind, 'restOnly');
  assert.equal(c.discrepancies[0]!.orderId, '701');
  h.shadow.stop();
});

test('a fill made while the socket was down is counted apart: expected, and what recovery is for', async () => {
  const h = harness();
  h.shadow.start();
  await h.shadow.tick();
  h.goLive();
  await h.pass(WATCHDOG_MS + 5_000, false);    // silence: the socket is dropped
  assert.equal(h.m().live, false);
  await journalFill(3, '801', 1, h.now());
  await h.pass(REST_GRACE_MS + 5_000, false);
  const c = h.m().compare;
  assert.equal(c.restOnly, 0);
  assert.equal(c.restOnlyWhileDown, 1);
  h.shadow.stop();
});

test('a socket fill the journal never gets is the socket\'s alone after five minutes (an order from outside the desk)', async () => {
  const h = harness();
  h.shadow.start();
  await h.shadow.tick();
  h.goLive();
  h.fill('f-9', '901', 1);
  await h.shadow.flushed();
  await h.pass(SOCKET_GRACE_MS - 10_000);
  assert.equal(h.m().compare.socketOnly, 0);
  await h.pass(15_000);
  assert.equal(h.m().compare.socketOnly, 1);
  assert.equal(h.m().compare.discrepancies[0]!.kind, 'socketOnly');
  h.shadow.stop();
});

test('[critical] partial fills are summed per order; a size the two disagree on is flagged once both are quiet', async () => {
  const h = harness();
  h.shadow.start();
  await h.shadow.tick();
  h.goLive();
  // Order 1001: two partial fills on the socket, one fill of the same two contracts in the journal -- agreeing.
  h.fill('a', '1001', 1);
  h.fill('b', '1001', 1);
  // Order 1002: the socket heard 2, the journal 3.
  h.fill('c', '1002', 2);
  await h.shadow.flushed();
  await journalFill(3, '1001', 2, h.now() + 1_000);
  await journalFill(3, '1002', 3, h.now() + 1_000);
  await h.pass(SETTLE_MS - 20_000);
  assert.equal(h.m().compare.sizeMismatch, 0, 'not while either may still hear more');
  await h.pass(30_000);
  const c = h.m().compare;
  assert.equal(c.matched, 2);
  assert.equal(c.sizeMismatch, 1, JSON.stringify(c.discrepancies));
  assert.equal(c.discrepancies.find((d) => d.kind === 'sizeMismatch')!.orderId, '1002');
  h.shadow.stop();
});

test('[critical] each account is compared with its own journal only', async () => {
  const h = harness({ accounts: [3, 4] });
  h.shadow.start();
  await h.shadow.tick();
  h.goLive(3); h.goLive(4);
  h.fill('x', '1101', 1, 3);
  await h.shadow.flushed();
  // The same order id's fill, written for account 4: not account 3's.
  await journalFill(4, '1101', 1, h.now());
  await h.pass(SOCKET_GRACE_MS + 10_000);
  assert.equal(h.m(3).compare.matched, 0);
  assert.equal(h.m(3).compare.socketOnly, 1);
  assert.equal(h.m(4).compare.restOnly, 1);
  h.shadow.stop();
});

test('the socket\'s two channels are held to each other: an order\'s filled size against its fills', async () => {
  const h = harness();
  h.shadow.start();
  await h.shadow.tick();
  h.goLive();
  const ord = (unfilled: number, seq: number, extra: Record<string, unknown> = {}) => h.say({
    type: 'orders', action: 'update', reason: 'fill', symbol: 'C-BTC-99000-091126', order_id: 1201, client_order_id: null,
    size: 4, unfilled_size: unfilled, average_fill_price: '17', side: 'sell', state: unfilled ? 'open' : 'closed', seq_no: seq, timestamp: h.now() * 1_000, ...extra,
  });
  ord(4, 1, { action: 'create', reason: null });
  ord(0, 2);
  h.fill('only-3', '1201', 3);
  await h.shadow.flushed();
  await h.pass(SETTLE_MS + 10_000);
  assert.equal(h.m().compare.channelMismatch, 1);
  assert.equal(h.m().counts.orderUpdates, 2);
  h.shadow.stop();
});

test('[critical] sequence gaps, duplicates and stale order updates are counted -- and never applied', async () => {
  const h = harness();
  h.shadow.start();
  h.goLive();
  h.fill('s1', '1301', 1, 3, 10);
  h.fill('s2', '1301', 1, 3, 11);
  h.fill('s2', '1301', 1, 3, 11);    // the same message again
  h.fill('s5', '1301', 1, 3, 14);    // 12 and 13 missed
  await h.shadow.flushed();
  const c = h.m().counts;
  assert.equal(c.fills, 3);
  assert.equal(c.duplicates, 1);
  assert.equal(c.outOfOrder, 1);
  assert.equal(c.gaps, 1);
  assert.equal(c.missingBySeq, 2);
  h.shadow.stop();
});

test('[critical] after a reconnect, Delta\'s REST fills for the outage are read once, and what the socket missed is counted', async () => {
  const h = harness({
    reader: async () => [{ orderId: '1401', size: 2, at: 0 }, { orderId: '1401', size: 1, at: 0 }, { orderId: '1402', size: 5, at: 0 }],
  });
  h.shadow.start();
  h.goLive();
  await h.pass(WATCHDOG_MS + 1_000, false);       // lost
  const downAt = h.m().socket.since;
  await h.pass(2_000, false);                    // the backoff, and a new socket
  h.goLive();
  const liveAt = h.now();
  await h.pass(1_000);
  assert.equal(h.readerCalls.length, 1);
  assert.equal(h.readerCalls[0]!.from, downAt - 5_000, 'from a little before the socket was lost');
  assert.equal(h.readerCalls[0]!.to, liveAt);
  const r = h.m().recovery;
  assert.equal(r.runs, 1);
  assert.equal(r.restFills, 3);
  assert.equal(r.missedOrders, 2);
  assert.equal(r.missedContracts, 8);
  assert.equal(r.last!.why, 'reconnect');
  await h.pass(10_000);
  assert.equal(h.readerCalls.length, 1, 'once');
  h.shadow.stop();
});

test('[critical] a recovery waits while the login\'s quota is busy, and is tried again after a failed read', async () => {
  let busy = 80;
  let fail = true;
  const h = harness({
    busy: () => busy,
    reader: async () => { if (fail) throw new Error('timed out'); return []; },
  });
  h.shadow.start();
  h.goLive();
  await h.pass(WATCHDOG_MS + 1_000, false);
  await h.pass(2_000, false);
  h.goLive();
  await h.pass(1_000);
  assert.equal(h.readerCalls.length, 0, 'the quota is busy: nothing asked');
  assert.ok(h.m().recovery.skippedBusy >= 1);
  busy = 10;
  await h.pass(10_000);
  assert.equal(h.m().recovery.failed, 1);
  assert.ok(h.m().recovery.pending, 'kept for the next look');
  fail = false;
  await h.pass(10_000);
  assert.equal(h.m().recovery.runs, 1);
  assert.equal(h.m().recovery.pending, null);
  h.shadow.stop();
});

test('after a restart, the time since the last fill this account\'s socket kept is recovered -- if it is recent', async () => {
  const h0 = harness();
  await query(
    `INSERT INTO private_ws_fills (account_id, fill_id, order_id, symbol, side, size, price, exch_at, seen_at)
     VALUES (3, 'old', '1', 'X', 'sell', 1, 1, $1, $1)`,
    [h0.now() - 10 * 60_000],
  );
  h0.shadow.start();
  h0.goLive();
  await new Promise((r) => setTimeout(r, 50));   // the look back at the table on the way up
  await h0.pass(1_000);
  assert.equal(h0.readerCalls.length, 1);
  assert.equal(h0.m().recovery.last!.why, 'restart');
  assert.equal(h0.readerCalls[0]!.from, h0.now() - 1_000 - 10 * 60_000 - 5_000);
  h0.shadow.stop();
});

test('one socket per trading account: closed for an account gone, opened again for a new key', async () => {
  const h = harness({ accounts: [3, 4] });
  h.shadow.start();
  assert.equal(h.shadow.metrics().length, 2);
  h.accounts = [3];
  h.shadow.sync();
  assert.deepEqual(h.shadow.metrics().map((a) => a.accountId), [3]);
  const before = h.sockets.get(3)!.length;
  h.rekey(3);
  h.shadow.sync();
  assert.equal(h.sockets.get(3)!.length, before + 1);
  h.shadow.sync();
  assert.equal(h.sockets.get(3)!.length, before + 1, 'the same key: left alone');
  h.shadow.stop();
});

test('DELTA_PRIVATE_WS=off: nothing is started, and the metrics say so', () => {
  assert.equal(startPrivateShadow('off', { accounts: () => { throw new Error('not asked'); }, log: () => {} }), null);
  assert.deepEqual(privateShadowMetrics(), { mode: 'off', since: null, accounts: [] });
});

test('[critical] the shadow can never act: nothing from trading/, and its one REST call is a GET', () => {
  for (const f of ['private-shadow.ts', 'private-socket.ts', 'private-events.ts']) {
    const src = readFileSync(new URL(`../../src/delta/${f}`, import.meta.url), 'utf8');
    assert.equal(/from '\.\.\/trading\//.test(src), false, `${f} imports from trading/`);
    assert.equal(/\bsigned\(/.test(src), false, `${f} calls signed()`);
    for (const call of src.match(/signedPage<[^>]*>\([^)]*\)/g) ?? []) assert.match(call, /method: 'GET'/, `${f}: ${call}`);
    assert.equal(/method: '(POST|PUT|DELETE)'/.test(src), false, `${f} writes to Delta`);
  }
});
