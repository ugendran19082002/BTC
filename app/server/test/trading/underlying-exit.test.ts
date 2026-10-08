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
  assert.match(why.reason ?? '', /BTC perp at 84,000\.00 reached the signal's stop 84,000\.00/);
});

test('[critical] the perp at the target books it', async () => {
  const { r, perp, id } = await shortPut();
  perp.price = 86_050;
  const s = await r.engine.poll(id);
  assert.equal(s?.position, 0);
  assert.match((r.store.peek(id)!.events.find((e) => e.t === 'exit_submitted') as { reason?: string }).reason ?? '', /target 86,000\.00/);
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

/* ---------------------------------------------- a touch between two looks (8 Oct 2026) --- */

/*
 * 5 Oct 11:49: the perp printed 85,997.50 through a SELL signal's stop at 85,990.79 and was back inside within the
 * second. The desk asked only whether the *last* trade was through when the trade's turn came, so the stop closed
 * nothing, and the trade stayed open 28 minutes more. A level that trades is reached.
 */
import { underlyingTouched, UNDERLYING_LOOKBACK_MS, type PerpRange } from '../../src/trading/engine.js';

test('[critical] the pure question: the last trade, or any trade since, at or through a level -- the stop first', () => {
  const sell = { dir: -1 as const, stop: 85_990.79, target: 85_354 };
  const range = (high: number, low: number): PerpRange => ({ high, highAt: 1_000, low, lowAt: 2_000 });
  // 5 Oct: the high touched the stop, the last trade is back inside.
  assert.deepEqual(underlyingTouched(sell, { price: 85_958, at: 3_000 }, range(85_997.5, 85_950)), { hit: 'stop', price: 85_997.5, at: 1_000 });
  assert.equal(underlyingTouched(sell, { price: 85_958, at: 3_000 }, range(85_990, 85_950)), null, 'short of the level by a dollar: nothing');
  assert.equal(underlyingTouched(sell, { price: 85_958, at: 3_000 }, null), null, 'no tape: only the last trade, as before');
  // A BUY is the mirror: its stop is under it, reached by the low.
  const buy = { dir: 1 as const, stop: 84_000, target: 86_000 };
  assert.deepEqual(underlyingTouched(buy, { price: 84_500, at: 3_000 }, range(84_600, 83_999)), { hit: 'stop', price: 83_999, at: 2_000 });
  assert.deepEqual(underlyingTouched(buy, { price: 85_500, at: 3_000 }, range(86_000, 85_400)), { hit: 'target', price: 86_000, at: 1_000 });
  // A stretch that reached both is a stop: the safe reading, as `underlyingHit` reads them.
  assert.equal(underlyingTouched(buy, { price: 85_000, at: 3_000 }, range(86_100, 83_900))!.hit, 'stop');
  // The last trade itself through wins, with its own price and time.
  assert.deepEqual(underlyingTouched(buy, { price: 83_950, at: 3_000 }, range(84_600, 83_900)), { hit: 'stop', price: 83_950, at: 3_000 });
});

/** A short call from a SELL signal, its perp extremes whatever `tape` says. */
async function shortCall(stop = 85_990.79, target = 85_354) {
  const perp = { price: 85_747.5, at: 0 };
  const tape: { range: PerpRange | null; asked: number[] } = { range: null, asked: [] };
  const r = rig({
    products: [peProduct(), ceProduct()],
    quotes: [quote(PE, 100.5, 101), quote(CE, 100.5, 101)],
    underlying: () => ({ price: perp.price, at: perp.at || r.now() }),
    underlyingRange: (since) => { tape.asked.push(since); return tape.range; },
  });
  const plan = { ...planFor(ceProduct(), { lots: 5, stopPrice: 300, takeProfitPrice: 1 }), underlying: { dir: -1 as const, stop, target, source: 'BTC perp' } };
  await r.engine.open(plan);
  await r.engine.poll(plan.tradeId);
  return { r, perp, tape, id: plan.tradeId };
}

test('[critical] 5 Oct again: a print through the stop that came back before the look still buys the call back, and says when it traded', async () => {
  const { r, perp, tape, id } = await shortCall();
  assert.equal(r.store.peek(id)!.state.position, -5);
  perp.price = 85_958;                                                   // back inside now
  tape.range = { high: 85_997.5, highAt: r.now() - 4_000, low: 85_950, lowAt: r.now() - 2_000 };
  await r.engine.poll(id);
  const rec = r.store.peek(id)!;
  const exit = rec.events.find((e) => e.t === 'exit_submitted') as { reason?: string } | undefined;
  assert.ok(exit, 'closed on this look, not 28 minutes later');
  assert.match(exit!.reason!, /^BTC perp at 85,997\.50 reached the signal's stop 85,990\.79 \(traded \d\d:\d\d:\d\d IST; 85,958\.00 now\)$/);
});

test('[critical] never a print from before the option filled, nor one older than the look-back', async () => {
  const { r, perp, tape, id } = await shortCall();
  const filled = r.store.peek(id)!.state.fills.find((f) => f.role === 'entry')!.ts;
  perp.price = 85_800;
  tape.range = null;
  await r.engine.poll(id);
  assert.ok(tape.asked.length > 0);
  for (const since of tape.asked) {
    assert.ok(since >= filled, 'the window starts no earlier than the fill');
    assert.ok(since >= r.now() - UNDERLYING_LOOKBACK_MS - 5_000, 'and reaches back no further than the look-back');
  }
  assert.equal(r.store.peek(id)!.state.position, -5, 'between the levels: nothing');
});

test('[critical] the fast watch hands the print it saw with the trade; a stale feed still closes nothing', async () => {
  const { r, perp, id } = await shortCall();
  perp.price = 85_958;                                                   // back inside when the engine looks
  await r.engine.exitOnUnderlying(id, { price: 86_005, at: r.now() });   // after the fill, as a real print is
  assert.match((r.store.peek(id)!.events.find((e) => e.t === 'exit_submitted') as { reason: string }).reason, /BTC perp at 86,005\.00 reached the signal's stop/);

  const stale = await shortCall();
  stale.perp.price = 86_100; stale.perp.at = 1;                          // through, but the feed stopped long ago
  await stale.r.engine.exitOnUnderlying(stale.id, { price: 86_100, at: stale.r.now() });
  assert.equal(stale.r.store.peek(stale.id)!.state.position, -5, 'no fresh last trade: nothing is acted on');
  // A print handed over from before the fill is not this trade's.
  const early = await shortCall();
  early.perp.price = 85_800;
  await early.r.engine.exitOnUnderlying(early.id, { price: 86_100, at: 0 });
  assert.equal(early.r.store.peek(early.id)!.state.position, -5);
});
