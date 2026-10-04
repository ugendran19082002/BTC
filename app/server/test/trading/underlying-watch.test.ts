import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rig, ceProduct, peProduct, planFor, quote } from './harness.js';
import { underlyingHit, type TradePlan } from '../../src/trading/engine.js';
import {
  UnderlyingWatch, watchedOf, WATCH_LIST_MAX_AGE_MS, WATCH_PRICE_STALE_MS, WATCH_RETRY_MS, type WatchedTrade,
} from '../../src/trading/underlying-watch.js';

/**
 * The fast watch on a signal trade's SL and TGT (4 Oct 2026).
 *
 * The levels were judged inside the poll, and the open trades were polled one
 * after another, so a stop waited behind every other trade's round trips: the
 * perp was a median 10 points past the level when the desk acted, and five
 * trades stopped together were closed over 19 seconds. The watch looks at the
 * perp alone, several times a second, and hands a trade to the engine the
 * moment it is through.
 */

const PE = peProduct().symbol;
const CE = ceProduct().symbol;
const up = (stop: number, target: number | null = 86_000) => ({ dir: 1 as const, stop, target });

// ----------------------------------------------------------------- the question

test('[critical] a level is reached at it or through it, the stop before the target, each way', () => {
  assert.equal(underlyingHit(up(84_000), 84_000.5), null, 'a BUY above its stop');
  assert.equal(underlyingHit(up(84_000), 84_000), 'stop', 'at it');
  assert.equal(underlyingHit(up(84_000), 83_900), 'stop');
  assert.equal(underlyingHit(up(84_000), 86_000), 'target');
  assert.equal(underlyingHit({ dir: -1, stop: 86_000, target: 84_000 }, 85_999), null, 'a SELL under its stop');
  assert.equal(underlyingHit({ dir: -1, stop: 86_000, target: 84_000 }, 86_010), 'stop');
  assert.equal(underlyingHit({ dir: -1, stop: 86_000, target: 84_000 }, 83_990), 'target');
  assert.equal(underlyingHit({ dir: 1, stop: null, target: 86_000 }, 10), null, 'no stop set: only the target');
  assert.equal(underlyingHit({ dir: 1, stop: 85_000, target: 85_000 }, 85_000), 'stop', 'both at once: the stop');
});

// ------------------------------------------------------------ the watch, alone

function alone(trades: WatchedTrade[]) {
  const clock = { now: 1_000_000 };
  const perp = { price: 85_000, at: 0 };
  const exits: string[] = [];
  let reads = 0;
  let hold: Promise<void> | null = null;
  const w = new UnderlyingWatch({
    open: async () => { reads++; return trades; },
    price: () => ({ price: perp.price, at: perp.at || clock.now }),
    exit: async (id) => { exits.push(id); if (hold) await hold; },
    now: () => clock.now,
  });
  w.note(trades);
  return { w, clock, perp, exits, reads: () => reads, holdExits: (p: Promise<void>) => { hold = p; } };
}
const t = (tradeId: string, symbol: string, stop: number, target: number | null = 86_000): WatchedTrade => ({ tradeId, symbol, underlying: up(stop, target) });

test('[critical] between the levels the watch does nothing, reads nothing and waits for nothing', async () => {
  const { w, exits, reads } = alone([t('a', PE, 84_000), t('b', PE, 84_500)]);
  for (let i = 0; i < 50; i++) assert.deepEqual(w.tick(), []);
  await w.settle();
  assert.deepEqual(exits, []);
  assert.equal(reads(), 0, 'the loop handed the list over; the journal is not asked');
});

test('[critical] every trade through its level is handed over on the same look -- not one a pass', async () => {
  const { w, perp, exits } = alone([t('a', PE, 84_600), t('b', PE, 84_650), t('c', CE, 84_700), t('d', PE, 84_000)]);
  perp.price = 84_550;
  assert.deepEqual(w.tick(), ['a', 'b', 'c'], 'three are through at 84,550; the fourth is not');
  await w.settle();
  assert.deepEqual([...exits].sort(), ['a', 'b', 'c']);
});

test('[critical] one contract is closed one trade after another; another contract does not wait for it', async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const { w, perp, exits, holdExits } = alone([t('a', PE, 84_600), t('b', PE, 84_650), t('c', CE, 84_700)]);
  holdExits(gate);
  perp.price = 84_000;
  w.tick();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual([...exits].sort(), ['a', 'c'], 'the first on each contract is with the engine; the second put waits its turn');
  release();
  await w.settle();
  assert.deepEqual(exits.filter((x) => x !== 'c'), ['a', 'b'], 'the puts in order');
});

test('[critical] a trade handed over is not handed over again on every look; it is tried again after a while if it is still there', async () => {
  const { w, clock, perp, exits } = alone([t('a', PE, 84_600)]);
  perp.price = 84_000;
  assert.deepEqual(w.tick(), ['a']);
  for (let i = 0; i < 10; i++) { clock.now += 200; w.note([t('a', PE, 84_600)]); assert.deepEqual(w.tick(), []); }
  await w.settle();
  assert.deepEqual(exits, ['a'], 'once, while the engine has it');
  clock.now += WATCH_RETRY_MS;
  w.note([t('a', PE, 84_600)]);
  assert.deepEqual(w.tick(), ['a'], 'still open and still through: handed over again');
  await w.settle();
});

test('[critical] a stale or missing perp price hands nothing over', () => {
  const { w, clock, perp } = alone([t('a', PE, 84_600)]);
  perp.price = 80_000;
  perp.at = clock.now - WATCH_PRICE_STALE_MS - 1;
  assert.deepEqual(w.tick(), [], 'a price from long ago is not a reason to close');
  perp.at = 0; perp.price = 0;
  assert.deepEqual(w.tick(), [], 'nor is no price');
});

test('the journal is read only when the loop has not handed a list over for a while, and one read at a time', async () => {
  const { w, clock, reads } = alone([t('a', PE, 84_600)]);
  clock.now += WATCH_LIST_MAX_AGE_MS + 1;
  w.tick(); w.tick(); w.tick();
  await w.settle();
  assert.equal(reads(), 1, 'three looks on a stale list: one read');
  w.tick();
  await w.settle();
  assert.equal(reads(), 1, 'fresh again: none');
});

test('a price source or an exit that throws cannot reach the timer', async () => {
  const w = new UnderlyingWatch({
    open: async () => { throw new Error('db down'); },
    price: () => { throw new Error('tape down'); },
    exit: async () => { throw new Error('exchange down'); },
  });
  assert.deepEqual(w.tick(), []);
  await w.settle();
});

// ------------------------------------------------------ against the real engine

/** `n` short puts on one contract and one short call, each from its own signal, all filled; the perp at 85,000. */
async function desk(stops: number[]) {
  const perp = { price: 85_000, at: 0 };
  const r = rig({
    products: [peProduct(), ceProduct()],
    quotes: [quote(PE, 100.5, 101), quote(CE, 100.5, 101)],
    underlying: () => ({ price: perp.price, at: perp.at || r.now() }),
  });
  const ids: string[] = [];
  for (const [i, stop] of stops.entries()) {
    const plan: TradePlan = {
      ...planFor(peProduct(), { lots: 2, stopPrice: 300, takeProfitPrice: 1 }),
      tradeId: `put-${i}`,
      // Each its own signal, so the desk holds them side by side on one contract.
      signal: { method: 'bos', n: 6, name: 'BOS', mode: 'single', tf: '5m', dir: 1, triggerTime: 1_700_000_000 + i * 300 },
      underlying: { dir: 1, stop, target: 86_000, source: 'BTC perp' },
    };
    await r.engine.open(plan);
    await r.engine.poll(plan.tradeId);
    ids.push(plan.tradeId);
  }
  const watch = new UnderlyingWatch({
    open: async () => watchedOf(await r.store.all()),
    price: () => ({ price: perp.price, at: perp.at || r.now() }),
    exit: (id) => r.engine.exitOnUnderlying(id),
    now: () => r.now(),
  });
  watch.note(watchedOf(await r.store.all()));
  return { r, perp, ids, watch };
}
const exitsOf = (r: Awaited<ReturnType<typeof desk>>['r'], id: string) => r.store.peek(id)!.events.filter((e) => e.t === 'exit_submitted') as { reason?: string }[];

test('[critical] five trades stopped together are all bought back from one look, with no poll in between -- and each says why', async () => {
  const { r, perp, ids, watch } = await desk([84_600, 84_620, 84_640, 84_660, 84_100]);
  assert.equal(watchedOf(await r.store.all()).length, 5, 'all five are watched');
  perp.price = 84_590;
  assert.deepEqual(watch.tick(), ids.slice(0, 4), 'four are through their stop at 84,590');
  await watch.settle();
  for (const id of ids.slice(0, 4)) {
    assert.equal(r.store.peek(id)!.state.position, 0, `${id} is flat`);
    const ex = exitsOf(r, id);
    assert.equal(ex.length, 1, 'bought back once');
    assert.match(ex[0]!.reason ?? '', /BTC perp at 84,590\.00 reached the signal's stop/);
  }
  assert.equal(r.store.peek(ids[4]!)!.state.position, -2, 'the fifth, with its stop at 84,100, is still in');
  assert.equal(exitsOf(r, ids[4]!).length, 0);
});

test('[critical] the watch and the poll on the same trade make one close between them, whichever is first', async () => {
  const { r, perp, ids, watch } = await desk([84_600]);
  const id = ids[0]!;
  perp.price = 84_500;
  // Both at once: the poll is queued first, the watch's exit behind it.
  const polled = r.engine.poll(id);
  watch.tick();
  await Promise.all([polled, watch.settle()]);
  assert.equal(r.store.peek(id)!.state.position, 0);
  assert.equal(exitsOf(r, id).length, 1, 'one close, not two');
  // And the other way round, on a fresh look after it is flat: nothing more.
  await r.engine.exitOnUnderlying(id);
  await r.engine.poll(id);
  assert.equal(exitsOf(r, id).length, 1);
});

test('[critical] the engine checks again: a hit the watch saw that is gone when its turn comes closes nothing', async () => {
  const { r, perp, ids } = await desk([84_600]);
  const id = ids[0]!;
  perp.price = 85_000;                       // back inside before the engine looks
  assert.equal((await r.engine.exitOnUnderlying(id))?.position, -2, 'still in');
  assert.equal(exitsOf(r, id).length, 0);
  perp.price = 84_000; perp.at = 1;          // through, but the price is stale
  assert.equal((await r.engine.exitOnUnderlying(id))?.position, -2, 'a stale price closes nothing');
});

test('[critical] the target is booked the same way, and a trade with no perp levels is never watched', async () => {
  const { r, perp, ids, watch } = await desk([84_600]);
  const plain = { ...planFor(ceProduct(), { lots: 3, stopPrice: 300, takeProfitPrice: 1 }), tradeId: 'ticket-1' };
  await r.engine.open(plain);
  await r.engine.poll(plain.tradeId);
  watch.note(watchedOf(await r.store.all()));
  assert.deepEqual(watchedOf(await r.store.all()).map((x) => x.tradeId), [ids[0]], 'the ticket trade is not on the list');
  perp.price = 86_010;
  assert.deepEqual(watch.tick(), [ids[0]]);
  await watch.settle();
  assert.match(exitsOf(r, ids[0]!)[0]!.reason ?? '', /reached the signal's target 86,000\.00/);
  assert.equal(r.store.peek('ticket-1')!.state.position, -3, 'and it is left alone');
});

test('a closed trade leaves the list at the next read, and a working entry is not on it yet', async () => {
  const { r, perp, ids, watch } = await desk([84_600, 84_000]);
  perp.price = 84_500;
  watch.tick();
  await watch.settle();
  r.advance(WATCH_LIST_MAX_AGE_MS + 1);
  watch.tick();
  await watch.settle();
  assert.deepEqual(watchedOf(await r.store.all()).map((x) => x.tradeId), [ids[1]], 'only the one still in');
});
