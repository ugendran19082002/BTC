import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rig, ceProduct, planFor, quote, type Rig } from './harness.js';
import { ownsClientId } from '../../src/trading/engine.js';
import { OrderRejected, SubmitTimeout } from '../../src/trading/exchange/port.js';

/**
 * A close Delta refused, with the trade's exits already taken off for it (30 Oct 2026, 10:41:48): the buy-back was
 * refused `immediate_liquidation`, and the position sat with no stop at Delta until the next poll put the backstop back
 * at 10:41:54. A refusal is an answer -- nothing was placed -- so the exits go back on at once, in the same turn.
 */

const CE = ceProduct().symbol;
const stops = async (r: Rig, tradeId: string) =>
  (await r.ex.getOpenOrders(CE)).filter((o) => o.reduceOnly && o.stopPrice !== null && ownsClientId(tradeId, o.clientOrderId));

async function sold() {
  const r = rig({ quotes: [quote(CE, 100.5, 101)] });
  const plan = planFor(ceProduct(), { tradeId: 'T', takeProfitPrice: 20, stopPrice: 110 });
  assert.equal((await r.engine.open(plan)).ok, true);
  await r.engine.poll('T');
  await r.engine.poll('T');
  assert.equal((await stops(r, 'T')).length, 1, 'the backstop rests at Delta');
  return r;
}

const refuseExits = (r: Rig, e: () => Error) => {
  const place = r.ex.placeOrder.bind(r.ex);
  r.ex.placeOrder = async (req) => { if (req.role === 'exit') throw e(); return place(req); };
};

test('[critical] a close Delta refused: the backstop is back on before the close returns, not a poll later', async () => {
  const r = await sold();
  refuseExits(r, () => new OrderRejected('immediate_liquidation'));
  const after = await r.engine.closeNow('T', 'stop reached');
  assert.equal(after!.position, -100, 'still short: nothing was closed');
  assert.equal((await stops(r, 'T')).length, 1, 'a stop rests at Delta again');
  assert.ok(after!.protection.stopLoss, 'and the trade holds it');
});

test('[critical] a close with no answer may be working at Delta: no exit is put beside it here -- the poll reads it first', async () => {
  const r = await sold();
  refuseExits(r, () => new SubmitTimeout('no answer to POST /v2/orders'));
  await r.engine.closeNow('T', 'stop reached');
  assert.equal((await stops(r, 'T')).length, 0);
});
