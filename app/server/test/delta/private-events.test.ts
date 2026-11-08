import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fillOf, orderOf, OrderProgressBook, SeenIds, SeqTracker } from '../../src/delta/private-events.js';
import { privateWsOf } from '../../src/config.js';

/**
 * Delta's private socket, read (delta/private-events.ts). The samples are Delta's own, from its docs
 * (docs/delta/document.md, "Private Channels"), with a BTC option's symbol.
 */

const fill = (over: Record<string, unknown> = {}) => ({
  type: 'v2/user_trades', sy: 'C-BTC-99000-091126', f: '1234-abcd-qwer-3456', R: 'normal', u: 1998, o: 3283999,
  S: 'sell', s: 2, p: '17.5', po: -2, r: 'maker', c: 'desk-abc', t: 1685794274866438, se: 4, ...over,
});
const order = (over: Record<string, unknown> = {}) => ({
  type: 'orders', action: 'update', reason: 'fill', symbol: 'C-BTC-99000-091126', product_id: 27, order_id: 1234,
  client_order_id: 'desk-abc', size: 10, unfilled_size: 6, average_fill_price: '17.5', limit_price: '17.5', side: 'sell',
  cancellation_reason: null, stop_order_type: null, bracket_order: false, state: 'open', seq_no: 1, timestamp: 1594105083998848, ...over,
});

test('[critical] a v2/user_trades message becomes a fill, field for field, in contracts and milliseconds', () => {
  const f = fillOf(fill());
  assert.ok(f);
  assert.equal(f.fillId, '1234-abcd-qwer-3456');
  assert.equal(f.orderId, '3283999', 'Delta\'s order id, as the journal keeps it (a string)');
  assert.equal(f.clientOrderId, 'desk-abc');
  assert.equal(f.symbol, 'C-BTC-99000-091126');
  assert.equal(f.side, 'sell');
  assert.equal(f.size, 2);
  assert.equal(f.price, 17.5);
  assert.equal(f.positionAfter, -2);
  assert.equal(f.reason, 'normal');
  assert.equal(f.exchAt, 1685794274866, 'microseconds to milliseconds');
  assert.equal(f.seq, 4);
});

test('a fill missing what a fill needs is no fill', () => {
  assert.equal(fillOf(fill({ f: undefined })), null, 'no fill id');
  assert.equal(fillOf(fill({ o: undefined })), null, 'no order');
  assert.equal(fillOf(fill({ s: 0 })), null, 'no size');
  assert.equal(fillOf(fill({ p: 'x' })), null, 'no price');
  assert.equal(fillOf(fill({ S: 'hold' })), null, 'no side');
  assert.equal(fillOf(fill({ t: undefined })), null, 'no time');
  assert.equal(fillOf({ ...fill(), type: 'user_trades' }), null, 'the older channel is not read');
  assert.equal(fillOf({ type: 'heartbeat' }), null);
});

test('[critical] an order update: filled is size less unfilled; a snapshot is not an update', () => {
  const o = orderOf(order());
  assert.ok(o);
  assert.equal(o.orderId, '1234');
  assert.equal(o.filled, 4);
  assert.equal(o.unfilled, 6);
  assert.equal(o.state, 'open');
  assert.equal(o.reason, 'fill');
  assert.equal(o.exchAt, 1594105083998);
  assert.equal(orderOf({ ...order(), action: 'snapshot' }), null);
  assert.equal(orderOf(order({ unfilled_size: 11 })), null, 'more unfilled than ordered is unreadable');
  assert.equal(orderOf(order({ state: 'weird' })), null);
});

test('[critical] sequence: next, duplicate, gap with how many were missed, and Delta restarting its count', () => {
  const s = new SeqTracker();
  assert.deepEqual(s.check('fills|A', 4), { kind: 'first' });
  assert.deepEqual(s.check('fills|A', 5), { kind: 'next' });
  assert.deepEqual(s.check('fills|A', 5), { kind: 'duplicate' });
  assert.deepEqual(s.check('fills|A', 3), { kind: 'duplicate' }, 'late, already past');
  assert.deepEqual(s.check('fills|A', 9), { kind: 'gap', missing: 3 });
  assert.deepEqual(s.check('fills|A', 1), { kind: 'reset' }, 'Delta\'s count starts again after its restart');
  assert.deepEqual(s.check('fills|A', 2), { kind: 'next' });
  assert.deepEqual(s.check('fills|B', 7), { kind: 'first' }, 'per symbol');
  assert.deepEqual(s.check('fills|B', null), { kind: 'none' });
});

test('[critical] a fill id is taken once however often it comes, and the oldest are let go past the limit', () => {
  const seen = new SeenIds(3);
  assert.equal(seen.add('a'), true);
  assert.equal(seen.add('a'), false);
  seen.add('b'); seen.add('c'); seen.add('d');
  assert.equal(seen.size, 3);
  assert.equal(seen.add('a'), true, 'past the limit, the oldest is forgotten');
  assert.equal(seen.add('d'), false);
});

test('[critical] a partial fill is partial: filled only when Delta says nothing is left', () => {
  const book = new OrderProgressBook();
  assert.equal(book.apply(orderOf(order({ unfilled_size: 10, reason: null, action: 'create' }))!), 'new');
  assert.equal(book.get('1234')!.status, 'open');
  assert.equal(book.apply(orderOf(order({ unfilled_size: 6, seq_no: 2 }))!), 'progress');
  assert.equal(book.get('1234')!.status, 'partial');
  assert.equal(book.get('1234')!.filled, 4);
  // Closed by Delta with nothing left: filled.
  assert.equal(book.apply(orderOf(order({ unfilled_size: 0, state: 'closed', seq_no: 3 }))!), 'progress');
  assert.equal(book.get('1234')!.status, 'filled');
});

test('[critical] an order update older than one read is dropped: filled never goes back, a finished order never reopens', () => {
  const book = new OrderProgressBook();
  book.apply(orderOf(order({ unfilled_size: 2 }))!);
  assert.equal(book.apply(orderOf(order({ unfilled_size: 6 }))!), 'stale', 'would un-fill four contracts');
  assert.equal(book.get('1234')!.filled, 8);
  book.apply(orderOf(order({ unfilled_size: 0, state: 'closed' }))!);
  assert.equal(book.get('1234')!.status, 'filled');
  assert.equal(book.apply(orderOf(order({ unfilled_size: 0, state: 'closed' }))!), 'unchanged', 'the same news twice');
  // A cancel, then the "open" that was sent before it, arriving late: the order stays cancelled.
  book.apply(orderOf(order({ order_id: 77, unfilled_size: 10, state: 'cancelled', action: 'delete' }))!);
  assert.equal(book.apply(orderOf(order({ order_id: 77, unfilled_size: 10, state: 'open', action: 'create' }))!), 'stale');
  assert.equal(book.get('77')!.status, 'cancelled');
});

test('a cancelled order that had filled part is partial-cancelled, not filled; an edit may change its size', () => {
  const book = new OrderProgressBook();
  book.apply(orderOf(order({ unfilled_size: 10, action: 'create' }))!);
  assert.equal(book.apply(orderOf(order({ size: 12, unfilled_size: 12 }))!), 'progress', 'a resize');
  book.apply(orderOf(order({ size: 12, unfilled_size: 9 }))!);
  book.apply(orderOf(order({ size: 12, unfilled_size: 9, state: 'cancelled', action: 'delete', cancellation_reason: 'cancelled_by_user' }))!);
  assert.equal(book.get('1234')!.status, 'partial-cancelled');
  assert.equal(book.get('1234')!.filled, 3);
});

test('[critical] DELTA_PRIVATE_WS: unset, shadow or on is shadow; off, or anything misspelt, opens nothing', () => {
  assert.equal(privateWsOf(undefined), 'shadow');
  assert.equal(privateWsOf(''), 'shadow');
  assert.equal(privateWsOf(' Shadow '), 'shadow');
  for (const on of ['on', 'ON', '1', 'true', 'yes']) assert.equal(privateWsOf(on), 'shadow', `${on} is on (the owner wrote "on", 8 Nov 2026)`);
  assert.equal(privateWsOf('false'), 'off');
  assert.equal(privateWsOf('no'), 'off');
  assert.equal(privateWsOf('off'), 'off');
  assert.equal(privateWsOf('0'), 'off');
  assert.equal(privateWsOf('shadwo'), 'off');
  assert.equal(privateWsOf('primary'), 'off', 'there is no primary mode yet');
});
