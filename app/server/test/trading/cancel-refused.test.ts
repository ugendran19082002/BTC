import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { DeltaExchange } from '../../src/trading/exchange/delta.js';

/**
 * A cancel Delta refused is not a cancel (22 Oct 2026): only a refusal that says the order is not on the book means it
 * is gone. An `expired_signature` on 13:51 was a cancel never made, and read as made.
 */
const real = globalThis.fetch;
afterEach(() => { globalThis.fetch = real; });
const refusing = (code: string) => {
  globalThis.fetch = (async () => new Response(JSON.stringify({ success: false, error: { code } }), { status: 400, headers: { 'content-type': 'application/json' } })) as typeof fetch;
};
const cancel = () => new DeltaExchange({ key: 'k', secret: 's' }).cancelOrder({ orderId: '1622173985', productId: 111 });

test('[critical] refused for a reason that is not "gone": thrown, so the caller checks rather than replaces', async () => {
  for (const code of ['expired_signature', 'bad_schema', 'unauthorized', 'invalid_api_key']) {
    refusing(code);
    await assert.rejects(cancel(), code);
  }
});

test('[critical] refused because the order is not on the book: the state wanted, taken as done', async () => {
  for (const code of ['open_order_not_found', 'order_not_found', 'order_already_filled', 'order_already_cancelled']) {
    refusing(code);
    await assert.doesNotReject(cancel(), code);
  }
});
