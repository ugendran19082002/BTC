import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FEED_QUIET_MS, FREEZE_ALERT_GAP_MS, FREEZE_ALERT_MS, HEALTH_GRACE_MS, HealthWatch, PRIVATE_DOWN_MS, type HealthProbes,
} from '../../src/observability/health-watch.js';
import type { Alert } from '../../src/notify/messages.js';

/** The desk's health on Telegram (19 Nov 2026): a held thread, a silent feed, a private socket down -- and each back. */

const T0 = Date.parse('2026-11-19T07:00:00+05:30');

function rig(over: Partial<HealthProbes> = {}) {
  let now = T0;
  const sent: Alert[] = [];
  const state = { ticker: T0 as number | null, flow: T0 as number | null, inCharge: true, sockets: [{ accountId: 1, name: 'High', live: true, lastMessageAt: T0 as number | null }] };
  const w = new HealthWatch({
    probes: {
      ticker: () => ({ lastMessageAt: state.ticker }),
      flow: () => ({ lastMessageAt: state.flow }),
      privateSockets: () => state.sockets,
      inCharge: () => state.inCharge,
      ...over,
    },
    notify: (a) => sent.push(a),
    now: () => now,
  });
  /** Time passes with every feed speaking, unless told otherwise. */
  const at = (ms: number, quiet: { ticker?: boolean; flow?: boolean } = {}) => {
    now = T0 + ms;
    if (!quiet.ticker) state.ticker = now;
    if (!quiet.flow) state.flow = now;
  };
  return { w, sent, state, at, now: () => now };
}

test('nothing is said in the first minutes after a start, nor while every feed speaks', () => {
  const r = rig();
  r.at(10_000, { ticker: true });
  r.w.look();
  r.at(HEALTH_GRACE_MS + 60_000);
  r.w.look();
  assert.deepEqual(r.sent, []);
});

test('[critical] option tickers silent two minutes are said once, and their return once, under one key', () => {
  const r = rig();
  r.at(HEALTH_GRACE_MS);
  r.w.look();
  r.at(HEALTH_GRACE_MS + FEED_QUIET_MS - 1_000, { ticker: true });
  r.w.look();
  assert.equal(r.sent.length, 0, 'a minute and a half of quiet is not yet news');
  r.at(HEALTH_GRACE_MS + FEED_QUIET_MS + 1_000, { ticker: true });
  r.w.look();
  r.at(HEALTH_GRACE_MS + FEED_QUIET_MS + 30_000, { ticker: true });
  r.w.look();
  assert.equal(r.sent.length, 1, 'said once, not at every look');
  assert.match(r.sent[0]!.text, /FEED DOWN · Option tickers/);
  assert.match(r.sent[0]!.text, /five seconds are refused/);
  r.at(HEALTH_GRACE_MS + FEED_QUIET_MS + 60_000);
  r.w.look();
  assert.equal(r.sent.length, 2);
  assert.match(r.sent[1]!.text, /FEED BACK · Option tickers/);
  assert.equal(r.sent[0]!.key, r.sent[1]!.key);
});

test('a feed that never spoke is counted quiet from the start', () => {
  const r = rig();
  r.state.flow = null;
  r.at(HEALTH_GRACE_MS, { flow: true });
  r.w.look();
  assert.equal(r.sent.length, 1);
  assert.match(r.sent[0]!.text, /Trade flow/);
  assert.match(r.sent[0]!.text, /since the desk started/);
});

test('[critical] a private socket down a few seconds is not news; down two minutes is, and so is its return', () => {
  const r = rig();
  r.at(HEALTH_GRACE_MS);
  r.state.sockets = [{ accountId: 1, name: 'High', live: false, lastMessageAt: T0 }];
  r.w.look();
  r.at(HEALTH_GRACE_MS + 5_000);
  r.state.sockets = [{ accountId: 1, name: 'High', live: true, lastMessageAt: r.now() }];
  r.w.look();
  assert.equal(r.sent.length, 0, 'a blip and a reconnect, as Medium had at 06:46');
  r.state.sockets = [{ accountId: 1, name: 'High', live: false, lastMessageAt: r.now() }];
  r.w.look();
  r.at(HEALTH_GRACE_MS + 5_000 + PRIVATE_DOWN_MS);
  r.w.look();
  assert.equal(r.sent.length, 1);
  assert.match(r.sent[0]!.text, /FEED DOWN · Private socket · High/);
  r.state.sockets = [{ accountId: 1, name: 'High', live: true, lastMessageAt: r.now() }];
  r.w.look();
  assert.match(r.sent[1]!.text, /FEED BACK · Private socket · High/);
});

test('an account switched off is not reported as a socket down', () => {
  const r = rig();
  r.at(HEALTH_GRACE_MS);
  r.state.sockets = [{ accountId: 1, name: 'High', live: false, lastMessageAt: T0 }];
  r.w.look();
  r.state.sockets = [];
  r.at(HEALTH_GRACE_MS + PRIVATE_DOWN_MS + 1_000);
  r.w.look();
  assert.deepEqual(r.sent, []);
});

test('[critical] a held thread is told once it runs again, every hold in one message, at most one in ten minutes', () => {
  const r = rig();
  r.at(HEALTH_GRACE_MS);
  r.w.noteHold(FREEZE_ALERT_MS - 1, r.now());
  r.w.look();
  assert.equal(r.sent.length, 0, 'under two seconds is the minute line\'s business, not the phone\'s');
  r.w.noteHold(3_400, r.now() - 3_400);
  r.w.look();
  assert.equal(r.sent.length, 1);
  assert.match(r.sent[0]!.text, /TRADING THREAD HELD · 3\.4 s/);
  r.at(HEALTH_GRACE_MS + 60_000);
  r.w.noteHold(2_500, r.now());
  r.w.noteHold(2_100, r.now());
  r.w.look();
  assert.equal(r.sent.length, 1, 'a second message waits out the ten minutes');
  r.at(HEALTH_GRACE_MS + FREEZE_ALERT_GAP_MS);
  r.w.look();
  assert.equal(r.sent.length, 2);
  assert.match(r.sent[1]!.text, /stopped 2 times/);
});

test('[critical] a standby process says nothing: the desk holding the lock does', () => {
  const r = rig();
  r.state.inCharge = false;
  r.at(HEALTH_GRACE_MS + FEED_QUIET_MS + 1_000, { ticker: true, flow: true });
  r.w.noteHold(5_000, r.now());
  r.w.look();
  assert.deepEqual(r.sent, []);
});

test('a probe that throws costs one look, never the process', () => {
  const r = rig({ ticker: () => { throw new Error('socket gone'); } });
  r.at(HEALTH_GRACE_MS + FEED_QUIET_MS);
  assert.doesNotThrow(() => r.w.look());
});
