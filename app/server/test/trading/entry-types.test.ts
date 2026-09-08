import { test } from 'node:test';
import assert from 'node:assert/strict';
import { orderBody } from '../../src/trading/exchange/delta.js';
import { crossesSpread } from '../../src/trading/engine.js';
import type { PlaceOrderRequest } from '../../src/trading/types.js';

/**
 * What the four price buttons actually send.
 *
 * There are only two order types underneath -- `market_order` and
 * `limit_order`. The four buttons are four ways of choosing the limit price,
 * and the difference that matters between them is not the price but whether
 * the order crosses the spread or rests on it.
 *
 *   market  no limit price          crosses, fills now, pays the spread
 *   bid     limit at the bid        crosses, fills now, pays the spread
 *   ask     limit at the offer      rests, earns the spread, may never fill
 *   set     limit at your price     rests or crosses, depending where you put it
 *
 * These pin that mapping, so a change to the ticket that quietly turns a
 * resting order into a crossing one is a failing test rather than a worse fill.
 */

const BOOK = { bid: 17, ask: 19 };

const entry = (limitPrice: number | undefined): PlaceOrderRequest => ({
  clientOrderId: 'abc123E0',
  symbol: 'C-BTC-81000-090926',
  productId: 27,
  side: 'sell',
  type: limitPrice === undefined ? 'market' : 'limit',
  size: 1,
  limitPrice,
  role: 'entry',
});

const kind = (limitPrice: number | undefined) =>
  crossesSpread('sell', limitPrice === undefined ? 'market' : 'limit', limitPrice ?? null, BOOK)
    ? 'crosses'
    : 'rests';

test('market sends a market order and crosses', () => {
  const body = orderBody(entry(undefined));
  assert.equal(body.order_type, 'market_order');
  assert.equal('limit_price' in body, false);
  assert.equal(kind(undefined), 'crosses');
});

test('bid sends a limit at the bid, which fills at once', () => {
  const body = orderBody(entry(BOOK.bid));
  assert.equal(body.order_type, 'limit_order');
  assert.equal(body.limit_price, '17');
  // at or through the touch, so it is taken immediately and pays the spread
  assert.equal(kind(BOOK.bid), 'crosses');
});

test('ask sends a limit at the offer, which rests', () => {
  const body = orderBody(entry(BOOK.ask));
  assert.equal(body.order_type, 'limit_order');
  assert.equal(body.limit_price, '19');
  assert.equal(kind(BOOK.ask), 'rests');
});

test('set rests above the bid and crosses at or below it', () => {
  assert.equal(kind(25), 'rests', 'above the offer: further out, still resting');
  assert.equal(kind(18), 'rests', 'inside the spread: still nobody to take it');
  assert.equal(kind(17), 'crosses');
  assert.equal(kind(10), 'crosses', 'below the bid: taken instantly at the bid');
});

test('every entry is good-till-cancelled and never reduce-only', () => {
  for (const price of [undefined, BOOK.bid, BOOK.ask, 25]) {
    const body = orderBody(entry(price));
    assert.equal(body.time_in_force, 'gtc');
    assert.equal(body.reduce_only, false, 'an entry opens a position, it never reduces one');
  }
});

test('an exit is the mirror: buy, reduce-only, and a stop watches the mark', () => {
  const stop = orderBody({
    ...entry(undefined),
    side: 'buy', type: 'stop_market', stopPrice: 40, reduceOnly: true, role: 'stop_loss',
  });
  assert.equal(stop.order_type, 'market_order', 'a stop that cannot fill is not a stop');
  assert.equal(stop.stop_order_type, 'stop_loss_order');
  assert.equal(stop.stop_trigger_method, 'mark_price');
  assert.equal(stop.reduce_only, true);

  const target = orderBody({
    ...entry(1.1), side: 'buy', reduceOnly: true, role: 'take_profit',
  });
  assert.equal(target.order_type, 'limit_order');
  assert.equal(target.limit_price, '1.1');
  assert.equal(target.reduce_only, true);
});

/**
 * Things Delta accepts that this desk does not send.
 *
 * Listed as assertions rather than prose so the day one is added, the test that
 * says "we do not do this" fails and has to be updated deliberately.
 */
test('post_only is not sent, so a resting order can still be crossed into', () => {
  // post_only would make "rest at the offer" a guarantee: the exchange rejects
  // the order rather than let it take liquidity. Worth having on the ask
  // button, and written up in docs/TODO.md.
  assert.equal('post_only' in orderBody(entry(BOOK.ask)), false);
});

test('ioc is not offered, so there is no fill-what-you-can-now option', () => {
  // time_in_force: ioc fills whatever is available and cancels the rest --
  // a gentler market order for a thin book
  assert.equal(orderBody(entry(BOOK.bid)).time_in_force, 'gtc');
});

test('a stop is only ever an exit, never a way in', () => {
  // stop_order_type on an entry would be "sell when it reaches X". The desk
  // has no such button, and nothing sends one.
  const body = orderBody(entry(BOOK.ask));
  assert.equal('stop_order_type' in body, false);
  assert.equal('trail_amount' in body, false);
});
