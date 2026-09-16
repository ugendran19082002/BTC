import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ADD_DEFAULTS, parseAddBody, toAddRequest } from '../../src/http/add-body.js';

/**
 * A person's add, checked before it reaches the engine.
 *
 * The money gates are the engine's; this is only what makes sure a number
 * reaches them. The thing that must not happen is a floor lower than the price
 * the person typed -- an add "at 9.50" that walks to 7 is not the add they
 * asked for.
 */
const ok = (b: Parameters<typeof parseAddBody>[0]) => {
  const r = parseAddBody(b);
  assert.equal(r.ok, true, r.ok ? '' : r.problems.join(' | '));
  return r.ok ? r.add : null!;
};
const bad = (b: Parameters<typeof parseAddBody>[0]) => {
  const r = parseAddBody(b);
  assert.equal(r.ok, false);
  return r.ok ? [] : r.problems;
};

test('the least that is needed: a trade and a whole number of lots', () => {
  const a = ok({ tradeId: 't1', lots: 100 });
  assert.equal(a.lots, 100);
  assert.equal(a.limitPrice, null, 'no price means start at the offer');
  assert.equal(a.chaseSeconds, ADD_DEFAULTS.chaseSeconds);
  assert.equal(a.timeoutMs, ADD_DEFAULTS.timeoutMin * 60_000);
});

test('[critical] an add works for an hour unless it is told otherwise', () => {
  // Five minutes was the old default, unasked and unshown on the sheet: long
  // enough for the chase and nothing else, when the whole point of an add by
  // hand is "sell more of this if the price comes back to me".
  assert.equal(ADD_DEFAULTS.timeoutMin, 60);
  assert.equal(ok({ tradeId: 't1', lots: 100 }).timeoutMs, 3_600_000);
  assert.equal(ok({ tradeId: 't1', lots: 100, timeoutMin: 15 }).timeoutMs, 900_000, 'and a shorter one is still allowed');
});

test('[critical] every objection at once, not one per round trip', () => {
  const p = bad({ tradeId: '', lots: 0, limitPrice: -1, chaseSeconds: 999, timeoutMin: 0 });
  assert.equal(p.length, 5, p.join(' | '));
});

test('lots: whole, at least one, and numbers that arrived as strings are fine', () => {
  assert.equal(ok({ tradeId: 't1', lots: '25' }).lots, 25);
  assert.match(bad({ tradeId: 't1', lots: 2.5 })[0]!, /whole number/);
  assert.match(bad({ tradeId: 't1', lots: 'ten' })[0]!, /whole number/);
  assert.match(bad({ tradeId: 't1', lots: -3 })[0]!, /at least 1/);
});

test('a price is optional, and if given must be above zero', () => {
  assert.equal(ok({ tradeId: 't1', lots: 1, limitPrice: '9.5' }).limitPrice, 9.5);
  assert.equal(ok({ tradeId: 't1', lots: 1, limitPrice: null }).limitPrice, null);
  assert.match(bad({ tradeId: 't1', lots: 1, limitPrice: 0 })[0]!, /above zero/);
  assert.match(bad({ tradeId: 't1', lots: 1, limitPrice: 'abc' })[0]!, /above zero/);
});

test('the chase and the window have bounds', () => {
  assert.equal(ok({ tradeId: 't1', lots: 1, chaseSeconds: 0 }).chaseSeconds, 0, 'zero rests where it started');
  assert.match(bad({ tradeId: 't1', lots: 1, chaseSeconds: -1 })[0]!, /0 to 600/);
  assert.match(bad({ tradeId: 't1', lots: 1, chaseSeconds: 601 })[0]!, /0 to 600/);
  assert.equal(ok({ tradeId: 't1', lots: 1, timeoutMin: 0.5 }).timeoutMs, 30_000);
  assert.match(bad({ tradeId: 't1', lots: 1, timeoutMin: 241 })[0]!, /at most 240/);
});

test('[critical] a typed price is the floor -- never sold under what was asked', () => {
  const r = toAddRequest(ok({ tradeId: 't1', lots: 10, limitPrice: 9.5 }), 9.5, 0.15);
  assert.equal(r.floorPrice, 9.5);
  assert.equal(r.limitPrice, 9.5);
  assert.deepEqual(r.source, { manual: true });
});

test('starting at the offer, the floor is the bid the route hands in', () => {
  // The walk may reach the bid, not pass it: the bid is what the route passes
  // as the start price's floor when nothing was typed.
  const r = toAddRequest(ok({ tradeId: 't1', lots: 10 }), 9.9, 0.15);
  assert.equal(r.limitPrice, 9.9);
  assert.equal(r.floorPrice, 9.9, 'with no bid given the start is its own floor');
});
