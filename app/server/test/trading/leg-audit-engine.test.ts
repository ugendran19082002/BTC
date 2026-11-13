import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LEG_AUDIT_MIN_AGE_MS, LegAudit } from '../../src/trading/leg-audit.js';
import { FillWake } from '../../src/trading/fill-wake.js';
import { clientId } from '../../src/trading/engine.js';
import { ceProduct, planFor, quote, rig } from './harness.js';

/*
 * The audit on the engine, with the paper venue as Delta (13 Nov 2026): a target Delta took off the book is found by
 * the audit's next look, the trade is woken through the fill wake, and that one poll puts the target back -- no loop
 * pass, no socket message. A trade whose exits rest is never touched.
 */

const CE = ceProduct().symbol;
const turn = () => new Promise((r) => setImmediate(r));

function onEngine() {
  const r = rig({ quotes: [quote(CE, 19, 20)] });
  const w = new FillWake({ poll: (id) => r.engine.poll(id), quotaUsedPct: () => 0, now: () => r.now() });
  const a = new LegAudit({
    book: () => r.ex.getRestingBook(), open: () => r.store.open() as never,
    wake: (id) => { w.nudge(id); }, quotaUsedPct: () => 0, now: () => r.now(),
  });
  const orders = async (role: 'take_profit' | 'stop_loss', tradeId: string) =>
    (await r.ex.getOpenOrders(CE)).filter((o) => o.clientOrderId?.startsWith(clientId(tradeId, role).slice(0, -1)));
  const run = async () => { for (let i = 0; i < 12; i++) { w.tick(); await turn(); await turn(); } };
  return { r, w, a, orders, run };
}
const plan = () => planFor(ceProduct(), { lots: 1, stopPrice: 60, takeProfitPrice: 2, entry: { type: 'limit', limitPrice: 19, timeoutMs: 0, marketFallback: false, chase: null } });

test('[critical] a target Delta took off: found by the audit, the trade woken, the target back on the book from that one poll', async () => {
  const { r, w, a, orders, run } = onEngine();
  const p = plan();
  const opened = await r.engine.open(p);
  assert.equal(opened.ok, true, JSON.stringify(opened));
  r.ex.tick(quote(CE, 19, 20, { ts: r.now() }));
  await r.engine.poll(p.tradeId);
  assert.equal(r.store.peek(p.tradeId)!.state.position, -1);
  const [tp] = await orders('take_profit', p.tradeId);
  assert.ok(tp, 'a target rests');
  r.advance(LEG_AUDIT_MIN_AGE_MS + 1_000);
  assert.deepEqual(await a.look(), [], 'everything on the book: nothing woken');

  await r.ex.cancelOrder({ orderId: tp.orderId });        // Delta took it off, and no socket said so
  assert.deepEqual(await orders('take_profit', p.tradeId), []);
  assert.deepEqual(await a.look(), [p.tradeId]);
  assert.equal(w.counts.nudged, 1);
  r.ex.tick(quote(CE, 19, 20, { ts: r.now() }));
  await run();
  const back = await orders('take_profit', p.tradeId);
  assert.equal(back.length, 1, 'a target rests again');
  assert.notEqual(back[0]!.orderId, tp.orderId);
  assert.equal(r.store.peek(p.tradeId)!.state.position, -1, 'still short: nothing else changed');
  assert.deepEqual(r.swallowed, []);
  r.advance(1_000);
  assert.deepEqual(await a.look(), [], 'and the audit is satisfied');
});

test('[critical] a stop Delta took off: the same, and the stop is the one looked for first', async () => {
  const { r, a, orders, run } = onEngine();
  const p = plan();
  await r.engine.open(p);
  r.ex.tick(quote(CE, 19, 20, { ts: r.now() }));
  await r.engine.poll(p.tradeId);
  const [sl] = await orders('stop_loss', p.tradeId);
  const [tp] = await orders('take_profit', p.tradeId);
  await r.ex.cancelOrder({ orderId: sl!.orderId });
  await r.ex.cancelOrder({ orderId: tp!.orderId });
  r.advance(LEG_AUDIT_MIN_AGE_MS + 1_000);
  assert.deepEqual(await a.look(), [p.tradeId]);
  assert.equal(a.counts.missingStop, 1);
  assert.equal(a.counts.missingTarget, 0);
  r.ex.tick(quote(CE, 19, 20, { ts: r.now() }));
  await run();
  assert.equal((await orders('stop_loss', p.tradeId)).length, 1, 'a stop rests again');
  assert.equal((await orders('take_profit', p.tradeId)).length, 1, 'and the target');
});
