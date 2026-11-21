import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NO_STOP_BATCH_MS, NoStopBatch, type NoStopItem } from '../../src/notify/no-stop-batch.js';
import { noStopBatchAlert, PROBLEM_REPEAT_MS, type Alert } from '../../src/notify/messages.js';

/** "NO STOP-LOSS" for several trades at once, said once (21 Nov 2026: 17 messages in 23 seconds at 09:01). */

function rig() {
  let now = Date.parse('2026-11-21T09:01:30+05:30');
  const sent: Alert[] = [];
  let pending: (() => void) | null = null;
  const b = new NoStopBatch<{ symbol: string }>({
    notify: (a) => sent.push(a),
    many: (items, at) => ({ key: `many:${at}`, text: `${items.length} trades` }),
    now: () => now,
    schedule: (fn) => { pending = fn; return 0 as unknown as ReturnType<typeof setTimeout>; },
  });
  const item = (id: string): NoStopItem<{ symbol: string }> => ({ tradeId: id, alert: { key: `${id}:problem:no-stop`, text: `one ${id}` }, plan: { symbol: 'P' }, held: 2, short: true, alarm: 'refused' });
  return { b, sent, item, fire: () => { const f = pending; pending = null; f?.(); }, later: (ms: number) => { now += ms; } };
}

test('[critical] seventeen in the same seconds are one message; one alone goes out as it was', () => {
  const r = rig();
  for (let i = 0; i < 17; i++) r.b.add(r.item(`T${i}`));
  assert.equal(r.sent.length, 0, `held ${NO_STOP_BATCH_MS} ms first`);
  r.fire();
  assert.deepEqual(r.sent.map((a) => a.text), ['17 trades']);
  r.later(60_000);
  r.b.add(r.item('X'));
  r.fire();
  assert.deepEqual(r.sent.at(-1), { key: 'X:problem:no-stop', text: 'one X' });
});

test('[critical] a trade already said is not said again inside the repeat time -- a retry whose words change included', () => {
  const r = rig();
  r.b.add(r.item('A')); r.fire();
  r.later(5_000);
  r.b.add(r.item('A')); r.b.add(r.item('A'));
  r.fire();
  assert.equal(r.sent.length, 1);
  r.later(PROBLEM_REPEAT_MS);
  r.b.add(r.item('A')); r.fire();
  assert.equal(r.sent.length, 2, 'a reminder once the quarter hour is up');
});

test('the one message: how many, each contract with its trades and size, and why', () => {
  const plan = (strike: number) => ({ symbol: `P-BTC-${strike}-211126`, optionSide: 'PE', expect: { underlying: 'BTC', strike, expiryTs: 1_795_250_000 } }) as never;
  const a = noStopBatchAlert({ mode: 'live', account: 'High', deskUrl: null } as never, [
    { plan: plan(57200), held: 2, short: true, alarm: 'Delta refused the request (immediate_execution_stop_order).' },
    { plan: plan(57200), held: 2, short: true, alarm: 'x' },
    { plan: plan(57000), held: 2, short: true, alarm: 'x' },
  ], Date.parse('2026-11-21T09:01:35+05:30'));
  assert.match(a.text, /NO STOP-LOSS · 3 trades/);
  assert.match(a.text, /2 trades, short <b>4<\/b>/);
  assert.match(a.text, /1 trade, short <b>2<\/b>/);
  assert.match(a.text, /immediate_execution_stop_order/);
  assert.match(a.text, /closes at the market what it cannot protect/);
  assert.equal(a.repeatAfterMs, PROBLEM_REPEAT_MS);
});
