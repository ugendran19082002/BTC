import { test } from 'node:test';
import assert from 'node:assert/strict';
import { orderBody } from '../../src/trading/exchange/delta.js';
import { clientId } from '../../src/trading/engine.js';
import type { PlaceOrderRequest } from '../../src/trading/types.js';

/**
 * The exact JSON that reaches Delta.
 *
 * The first live order this desk sent came back `bad_schema` three times, and
 * there was nothing to look at: no field name in the reply and no way to see
 * the body without placing another real order. These are checked against the
 * request Delta documents, field for field, so the next schema change is a
 * failing test rather than a rejected trade.
 *
 * Delta's own documented example:
 *
 *   {
 *     "product_id": 27,
 *     "product_symbol": "BTCUSD",
 *     "limit_price": "59000",
 *     "size": 10,
 *     "side": "buy",
 *     "order_type": "limit_order",
 *     "stop_order_type": "stop_loss_order",
 *     "stop_price": "56000",
 *     "time_in_force": "gtc",
 *     "reduce_only": false,
 *     "client_order_id": "my_signal_345212"
 *   }
 */

const req = (over: Partial<PlaceOrderRequest> = {}): PlaceOrderRequest => ({
  clientOrderId: clientId('C-BTC-82000-090926-1757349123456', 'entry'),
  symbol: 'C-BTC-82000-090926',
  productId: 27,
  side: 'sell',
  type: 'limit',
  size: 2,
  limitPrice: 27,
  role: 'entry',
  ...over,
});

test('a limit entry sends exactly the documented fields', () => {
  assert.deepEqual(orderBody(req()), {
    product_id: 27,
    size: 2,
    side: 'sell',
    order_type: 'limit_order',
    time_in_force: 'gtc',
    reduce_only: false,
    client_order_id: '909261757349123456E0',
    limit_price: '27',
  });
});

test('product_id travels alone', () => {
  // the docs call product_symbol "an alternative to product_id", which reads as
  // a one-of; sending both is the kind of thing a schema rejects
  assert.equal('product_symbol' in orderBody(req()), false);
  assert.equal(typeof orderBody(req()).product_id, 'number');
});

test('reduce_only is a boolean and is always present', () => {
  // the string "true" is what bad_schema comes back for
  assert.strictEqual(orderBody(req()).reduce_only, false);
  assert.strictEqual(orderBody(req({ reduceOnly: true })).reduce_only, true);
});

test('prices are strings, so precision survives the wire', () => {
  assert.strictEqual(orderBody(req({ limitPrice: 27.1 })).limit_price, '27.1');
  assert.strictEqual(
    orderBody(req({ type: 'stop_market', stopPrice: 223.9, limitPrice: undefined })).stop_price,
    '223.9',
  );
});

test('size is a whole number of contracts, not a string', () => {
  assert.strictEqual(typeof orderBody(req()).size, 'number');
  assert.strictEqual(orderBody(req({ size: 10 })).size, 10);
});

test('a market order carries no limit price', () => {
  const body = orderBody(req({ type: 'market', limitPrice: undefined }));
  assert.equal(body.order_type, 'market_order');
  assert.equal('limit_price' in body, false);
});

test('a stop is a market order with a trigger, watched on the mark', () => {
  const body = orderBody(req({
    type: 'stop_market', stopPrice: 223.9, limitPrice: undefined,
    reduceOnly: true, role: 'stop_loss',
  }));
  assert.equal(body.order_type, 'market_order', 'a stop that cannot fill is not a stop');
  assert.equal(body.stop_order_type, 'stop_loss_order');
  assert.equal(body.stop_price, '223.9');
  // options are thin: the last trade can be minutes stale, the mark cannot
  assert.equal(body.stop_trigger_method, 'mark_price');
  assert.equal(body.reduce_only, true);
});

test('every value is a type Delta accepts, on every order shape', () => {
  const shapes: PlaceOrderRequest[] = [
    req(),
    req({ type: 'market', limitPrice: undefined }),
    req({ type: 'stop_market', stopPrice: 100, limitPrice: undefined, reduceOnly: true }),
    req({ reduceOnly: true, side: 'buy', role: 'take_profit' }),
  ];
  for (const shape of shapes) {
    for (const [key, value] of Object.entries(orderBody(shape))) {
      assert.ok(
        ['string', 'number', 'boolean'].includes(typeof value),
        `${key} is a ${typeof value}; Delta takes strings, numbers and booleans`,
      );
      assert.notEqual(value, null, `${key} is null`);
      assert.notEqual(value, undefined, `${key} is undefined`);
    }
  }
});

test('the client order id looks like the one in the docs', () => {
  // "my_signal_345212" -- short, no punctuation beyond an underscore
  const id = orderBody(req()).client_order_id as string;
  assert.match(id, /^[A-Za-z0-9_]{1,32}$/, `"${id}" would be refused`);
});

test('the four roles never collide on one trade', () => {
  const t = 'P-BTC-76400-090926-1757349123456';
  const ids = (['entry', 'take_profit', 'stop_loss', 'exit'] as const).map((r) => clientId(t, r));
  assert.equal(new Set(ids).size, 4);
  for (const id of ids) assert.match(id, /^[A-Za-z0-9]+$/);
});
