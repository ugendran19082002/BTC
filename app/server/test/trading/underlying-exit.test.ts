import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rig, ceProduct, peProduct, planFor, quote } from './harness.js';
import type { TradePlan } from '../../src/trading/engine.js';

/**
 * Exits on the underlying (2 Oct 2026, signal strategies). A signal's SL and
 * TGT are BTC-perpetual levels; the option is sold to ride the signal and is
 * bought back at the market the moment the perp's last trade reaches either.
 * A BUY is a short put (wins as BTC rises), a SELL a short call.
 */

const PE = peProduct().symbol;
const CE = ceProduct().symbol;

/** A short put from a BUY signal: perp stop 84,000, target 86,000; the perp's price is whatever `perp.price` says. */
async function shortPut(under: TradePlan['underlying'] | null = { dir: 1, stop: 84_000, target: 86_000, source: 'BTC perp' }) {
  const perp = { price: 85_000, at: 0 };
  const r = rig({
    products: [peProduct(), ceProduct()],
    quotes: [quote(PE, 100.5, 101), quote(CE, 100.5, 101)],
    underlying: () => ({ price: perp.price, at: perp.at || r.now() }),
  });
  const plan = { ...planFor(peProduct(), { lots: 10, stopPrice: 300, takeProfitPrice: 1 }), ...(under ? { underlying: under } : {}) };
  await r.engine.open(plan);
  await r.engine.poll(plan.tradeId);
  return { r, perp, id: plan.tradeId };
}

test('[critical] between the levels nothing happens; the perp at the stop buys the put back at the market', async () => {
  const { r, perp, id } = await shortPut();
  assert.equal((await r.engine.poll(id))?.position, -10, 'in the trade at 85,000');
  perp.price = 84_000;
  const s = await r.engine.poll(id);
  assert.equal(s?.position, 0, 'closed when the perp reached 84,000');
  const why = r.store.peek(id)!.events.find((e) => e.t === 'exit_submitted') as { reason?: string };
  assert.match(why.reason ?? '', /BTC perp at 84000 reached the signal's stop 84000/);
});

test('[critical] the perp at the target books it', async () => {
  const { r, perp, id } = await shortPut();
  perp.price = 86_050;
  const s = await r.engine.poll(id);
  assert.equal(s?.position, 0);
  assert.match((r.store.peek(id)!.events.find((e) => e.t === 'exit_submitted') as { reason?: string }).reason ?? '', /target 86000/);
});

test('[critical] a SELL is the mirror: a short call stopped as the perp rises, booked as it falls', async () => {
  const perp = { price: 85_000 };
  const r = rig({ products: [ceProduct()], quotes: [quote(CE, 100.5, 101)], underlying: () => ({ price: perp.price, at: r.now() }) });
  const plan = { ...planFor(ceProduct(), { lots: 10, stopPrice: 300, takeProfitPrice: 1 }), underlying: { dir: -1 as const, stop: 86_000, target: 84_000, source: 'BTC perp' } };
  await r.engine.open(plan);
  await r.engine.poll(plan.tradeId);
  perp.price = 85_900;
  assert.equal((await r.engine.poll(plan.tradeId))?.position, -10, 'under the 86,000 stop: still in');
  perp.price = 86_000;
  assert.equal((await r.engine.poll(plan.tradeId))?.position, 0, 'at the stop: out');
});

test('[critical] a stale or missing perp price closes nothing -- the premium backstop at Delta is still there', async () => {
  const { r, perp, id } = await shortPut();
  perp.price = 83_000;
  perp.at = 1;                                  // a price from long ago
  assert.equal((await r.engine.poll(id))?.position, -10, 'stale: not acted on');
  const resting = await r.ex.getOpenOrders(PE);
  assert.ok(resting.some((o) => o.type === 'stop_limit' && o.reduceOnly), 'and the premium stop rests at Delta');
});

test('a trade without underlying levels is not touched by them', async () => {
  const { r, perp, id } = await shortPut(null);
  perp.price = 50_000;
  assert.equal((await r.engine.poll(id))?.position, -10);
});

test('the levels travel on the plan, so a restart carries on watching them', async () => {
  const { r, id } = await shortPut();
  assert.deepEqual(r.store.peek(id)!.plan.underlying, { dir: 1, stop: 84_000, target: 86_000, source: 'BTC perp' });
});

test('[critical] the perp to the point: where it was as the option filled in, and as it was bought back -- and the times', async () => {
  const { r, perp, id } = await shortPut();
  const inState = r.store.peek(id)!.state;
  assert.equal(inState.perpEntry, 85_000, 'the perp as the entry filled');
  const entryFill = inState.fills.find((f) => f.role === 'entry')!;
  assert.ok(entryFill.ts > 0, 'and when');
  perp.price = 86_010;
  await r.engine.poll(id);
  const out = r.store.peek(id)!.state;
  assert.equal(out.position, 0);
  assert.equal(out.perpEntry, 85_000, 'the entry point is kept');
  assert.equal(out.perpExit, 86_010, 'the perp as the exit filled');
  assert.ok(out.fills.filter((f) => f.role !== 'entry').every((f) => f.ts >= entryFill.ts));
});

test('a trade without perp exits records no perp points', async () => {
  const { r, id } = await shortPut(null);
  assert.equal(r.store.peek(id)!.state.perpEntry ?? null, null);
});
