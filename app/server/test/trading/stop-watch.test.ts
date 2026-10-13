import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OptionStopWatch, STOP_WATCH_BOARD_STALE_MS, STOP_WATCH_QUOTA_PCT, STOP_WATCH_RECHECK_MS, stopWatchedOf, type StopWatched } from '../../src/trading/stop-watch.js';
import { STOP_CONFIRM_MS, type TradeRecord } from '../../src/trading/engine.js';
import { ceProduct, peProduct, planFor, quote, rig, T0 } from './harness.js';

/**
 * The fast watch on a sold option's own stop (13 Oct 2026).
 *
 * The stop is "the offer at or above it for fifteen seconds", and it was looked at once a pass of the loop: with
 * fifty trades open, 35 seconds at the median and 83 at worst. The watch holds the board the desk has in memory
 * against every stop once a second and hands a trade at its stop to the engine's own check -- at once, and every
 * few seconds while it stays there. Held here: who it hands over and when; and, on the real engine, that the
 * fifteen seconds are now fifteen.
 */

const CE = 'C-BTC-80000-080926', PE = 'P-BTC-77000-080926';

function watch(o: { used?: () => number } = {}) {
  let now = T0;
  let board: { at: number; asks: Map<string, number> } | null = { at: T0, asks: new Map() };
  const calls: { symbol: string; ids: string[]; at: number }[] = [];
  let answer: (symbol: string, ids: readonly string[]) => Promise<readonly string[]> = async () => [];
  const w = new OptionStopWatch({
    asks: () => board, quotaUsedPct: o.used ?? (() => 0), now: () => now,
    check: (symbol, ids) => { calls.push({ symbol, ids: [...ids], at: now }); return answer(symbol, ids); },
  });
  return {
    w, calls,
    /** The board as of now: each contract's offer. */
    offers(asks: Record<string, number>) { board = { at: now, asks: new Map(Object.entries(asks)) }; },
    noBoard() { board = null; },
    advance(ms: number) { now += ms; },
    answerWith(fn: typeof answer) { answer = fn; },
  };
}
const t = (tradeId: string, symbol: string, stop: number): StopWatched => ({ tradeId, symbol, stop });

test('[critical] which trades are watched: a short holding contracts, with a stop judged on the offer, not already closing', () => {
  const rec = (id: string, o: { position?: number; phase?: string; stop?: number | null; monitorOn?: 'ltp' | 'close' } = {}) => ({
    plan: { symbol: CE, stopPrice: o.stop === undefined ? 164 : o.stop, monitorOn: o.monitorOn },
    state: { tradeId: id, position: o.position ?? -16, phase: o.phase ?? 'protected' },
  }) as unknown as TradeRecord;
  assert.deepEqual(stopWatchedOf([
    rec('a'), rec('ltp', { monitorOn: 'ltp' }),
    rec('no-stop', { stop: null }), rec('on-close', { monitorOn: 'close' }), rec('flat', { position: 0 }), rec('long', { position: 5 }),
    rec('closing', { phase: 'exit_pending' }), rec('unknown', { phase: 'entry_unknown' }),
  ]), [{ tradeId: 'a', symbol: CE, stop: 164 }, { tradeId: 'ltp', symbol: CE, stop: 164 }]);
});

test('[critical] a trade whose offer is at its stop is handed to the engine at once -- one call a contract, whoever holds it', () => {
  const x = watch();
  x.w.note([t('a', CE, 164), t('b', CE, 176), t('c', CE, 164), t('p', PE, 50)]);
  x.offers({ [CE]: 163.9, [PE]: 20 });
  assert.deepEqual(x.w.tick(), [], 'under every stop: nobody is asked about');
  x.offers({ [CE]: 164, [PE]: 20 });
  assert.deepEqual(x.w.tick(), ['a', 'c'], 'at the stop is reached; the 176 stop on the same contract is not');
  assert.deepEqual(x.calls, [{ symbol: CE, ids: ['a', 'c'], at: T0 }]);
});

test('[critical] while the offer stays at the stop the engine is asked again every few seconds: fifteen seconds are acted on at fifteen', async () => {
  const x = watch();
  x.w.note([t('a', CE, 164)]);
  x.offers({ [CE]: 170 });
  const asked: number[] = [];
  for (let s = 0; s <= 18; s++) {
    x.offers({ [CE]: 170 });
    if (x.w.tick().length) asked.push(s);
    await x.w.settle();
    x.advance(1_000);
  }
  assert.deepEqual(asked, [0, 3, 6, 9, 12, 15, 18], `every ${STOP_WATCH_RECHECK_MS / 1000} s, so the first look after ${STOP_CONFIRM_MS / 1000} s is at 15`);
});

test('[critical] back under the stop: one more look, so the engine forgets its count -- and then it is left alone', async () => {
  const x = watch();
  x.w.note([t('a', CE, 164), t('b', CE, 160)]);
  x.offers({ [CE]: 165 });
  assert.deepEqual(x.w.tick(), ['a', 'b']);
  await x.w.settle();
  x.advance(1_000);
  x.offers({ [CE]: 162 });                        // under a's stop, still over b's
  assert.deepEqual(x.w.tick(), ['a'], 'a is looked at once more, to clear its count; b was asked about a second ago');
  await x.w.settle();
  x.advance(1_000);
  assert.deepEqual(x.w.tick(), [], 'a is under its stop and was told so');
  x.advance(1_000);
  assert.deepEqual(x.w.tick(), ['b'], 'b is still at its stop: asked again three seconds after the first time');
});

test('[critical] a trade the engine says is over is not asked about again, before the loop has even read the book', async () => {
  const x = watch();
  x.w.note([t('a', CE, 164), t('b', CE, 164)]);
  x.offers({ [CE]: 170 });
  x.answerWith(async () => ['a']);                 // the engine closed a; b is still counting
  x.w.tick();
  await x.w.settle();
  assert.equal(x.w.size, 1);
  x.advance(STOP_WATCH_RECHECK_MS);
  assert.deepEqual(x.w.tick(), ['b']);
});

test('[critical] it never stacks a check on a contract, never throws, and steps aside when it has nothing sound to go on', async () => {
  const x = watch();
  x.w.note([t('a', CE, 164)]);
  x.offers({ [CE]: 170 });
  let release!: () => void;
  x.answerWith(() => new Promise((r) => { release = () => r([]); }));
  assert.deepEqual(x.w.tick(), ['a']);
  x.advance(STOP_WATCH_RECHECK_MS);
  assert.deepEqual(x.w.tick(), [], 'the first check has not answered: not asked again');
  release();
  await x.w.settle();
  x.answerWith(async () => { throw new Error('exchange down'); });
  assert.deepEqual(x.w.tick(), ['a'], 'a check that fails is tried again the next time');
  await x.w.settle();

  // a board that is not there, or has not been refreshed: the loop alone carries on
  const y = watch();
  y.w.note([t('a', CE, 164)]);
  y.noBoard();
  assert.deepEqual(y.w.tick(), []);
  y.offers({ [CE]: 170 });
  y.advance(STOP_WATCH_BOARD_STALE_MS + 1);
  assert.deepEqual(y.w.tick(), [], 'a board ten seconds old decides nothing');
  y.offers({ [CE]: 170 });
  assert.deepEqual(y.w.tick(), ['a']);
  // Delta's quota nearly used: no quotes are read for it
  const z = watch({ used: () => STOP_WATCH_QUOTA_PCT });
  z.w.note([t('a', CE, 164)]);
  z.offers({ [CE]: 170 });
  assert.deepEqual(z.w.tick(), []);
  // a contract missing from the board is not a stop reached
  const m = watch();
  m.w.note([t('a', CE, 164)]);
  m.offers({ [PE]: 500 });
  assert.deepEqual(m.w.tick(), []);
  assert.deepEqual(watch().w.tick(), [], 'nothing open: nothing looked at');
});

// ------------------------------------------------------------------ on the real engine

/** Two shorts on the call and one on the put, filled and protected. */
async function book() {
  // Several trades on one contract, as the strategies hold them: each signal's order is a trade of its own.
  const r = rig({ products: [ceProduct(), peProduct()], quotes: [quote(CE, 100.5, 101), quote(PE, 100.5, 101)], limits: { allowPyramiding: true } });
  for (const [id, product, stop] of [['ce-1', ceProduct(), 110], ['ce-2', ceProduct(), 120], ['pe-1', peProduct(), 110]] as const) {
    const res = await r.engine.open(planFor(product, { tradeId: id, stopPrice: stop, lots: 10 }));
    assert.equal(res.ok, true, JSON.stringify(res));
    await r.engine.poll(id);
  }
  const state = async (id: string) => (await r.store.get(id))!.state;
  for (const id of ['ce-1', 'ce-2', 'pe-1']) assert.equal((await state(id)).position, -10, id);
  return { r, state };
}
const offer = (r: Awaited<ReturnType<typeof book>>['r'], symbol: string, bid: number, ask: number) => r.ex.tick(quote(symbol, bid, ask, { ts: r.now() }));

test('[critical] the engine\'s check for one contract: the count starts at the first look and the close is at the first look fifteen seconds on', async () => {
  const { r, state } = await book();
  offer(r, CE, 111, 112);                          // through ce-1's stop of 110; ce-2's is 120; the put is untouched
  assert.deepEqual(await r.engine.checkStops(CE, ['ce-1', 'ce-2']), [], 'the first look starts the count and closes nothing');
  assert.equal((await state('ce-1')).position, -10);
  for (const s of [3, 6, 9, 12]) {
    r.advance(3_000); offer(r, CE, 111, 112);
    assert.deepEqual(await r.engine.checkStops(CE, ['ce-1', 'ce-2']), [], `${s} s: still counting`);
  }
  r.advance(3_000); offer(r, CE, 111, 112);
  assert.deepEqual(await r.engine.checkStops(CE, ['ce-1', 'ce-2']), ['ce-1'], 'fifteen seconds: closed, and said to be over');
  const closed = (await r.store.get('ce-1'))!;
  assert.equal(closed.state.position, 0);
  const why = closed.events.find((e) => e.t === 'exit_submitted') as { reason?: string } | undefined;
  assert.equal(why?.reason, 'stop reached: the offer held at 112 (stop 110) for 15 s');
  assert.equal((await state('ce-2')).position, -10, 'the same contract under its own stop is left alone');
  assert.equal((await state('pe-1')).position, -10);
  assert.deepEqual(await r.engine.checkStops(CE, ['ce-1']), ['ce-1'], 'asked again about a closed trade: over, nothing done');
});

test('[critical] the fifteen seconds must run unbroken: an offer back under the stop clears the count', async () => {
  const { r, state } = await book();
  offer(r, CE, 111, 112);
  await r.engine.checkStops(CE, ['ce-1']);
  r.advance(9_000); offer(r, CE, 108, 109);        // back under 110
  await r.engine.checkStops(CE, ['ce-1']);
  r.advance(9_000); offer(r, CE, 111, 112);        // eighteen seconds after the first look -- but only just back
  assert.deepEqual(await r.engine.checkStops(CE, ['ce-1']), []);
  assert.equal((await state('ce-1')).position, -10, 'not closed: the count began again');
  r.advance(STOP_CONFIRM_MS); offer(r, CE, 111, 112);
  assert.deepEqual(await r.engine.checkStops(CE, ['ce-1']), ['ce-1']);
});

test('[critical] one quote for the contract, every trade on it judged by its own stop; a stale or missing quote closes nothing', async () => {
  const { r, state } = await book();
  let reads = 0;
  const real = r.ex.getQuote.bind(r.ex);
  r.ex.getQuote = async (symbol: string) => { reads++; return real(symbol); };
  offer(r, CE, 125, 126);                          // through both calls' stops
  await r.engine.checkStops(CE, ['ce-1', 'ce-2', 'pe-1']);
  assert.equal(reads, 1, 'one read, however many trades');
  r.advance(STOP_CONFIRM_MS); offer(r, CE, 125, 126);
  assert.deepEqual(await r.engine.checkStops(CE, ['ce-1', 'ce-2', 'pe-1']), ['ce-1', 'ce-2', 'pe-1'], 'both calls closed; the put is another contract\'s and is not this check\'s to watch');
  assert.equal((await state('ce-1')).position, 0); assert.equal((await state('ce-2')).position, 0);
  assert.equal((await state('pe-1')).position, -10, 'the put was not touched');

  // a quote from before the feed went quiet is not evidence about now
  offer(r, PE, 125, 126);
  await r.engine.checkStops(PE, ['pe-1']);
  r.advance(60_000);                               // no new quote for a minute
  assert.deepEqual(await r.engine.checkStops(PE, ['pe-1']), []);
  assert.equal((await state('pe-1')).position, -10);
  r.ex.getQuote = async () => { throw new Error('ticker down'); };
  assert.deepEqual(await r.engine.checkStops(PE, ['pe-1']), [], 'no quote: nothing done, nothing thrown');
});

test('[critical] the watch and the engine together: a stop reached is closed fifteen seconds later, with the loop not polling at all', async () => {
  const { r, state } = await book();
  const board = { at: r.now(), asks: new Map<string, number>() };
  const w = new OptionStopWatch({
    asks: () => board, quotaUsedPct: () => 0, now: () => r.now(),
    check: (symbol, ids) => r.engine.checkStops(symbol, ids),
  });
  const open = await r.store.open();
  w.note(stopWatchedOf(open));
  assert.equal(w.size, 3);
  let closedAt: number | null = null;
  const began = r.now();
  for (let s = 0; s <= 20 && closedAt === null; s++) {
    offer(r, CE, 111, 112); board.at = r.now(); board.asks.set(CE, 112); board.asks.set(PE, 101);
    w.tick();
    await w.settle();
    if ((await state('ce-1')).position === 0) closedAt = r.now();
    r.advance(1_000);
  }
  assert.equal(closedAt, began + STOP_CONFIRM_MS, 'closed at fifteen seconds, not at the loop\'s next turn');
  assert.equal(w.size, 2, 'and no longer watched');
  assert.equal((await state('ce-2')).position, -10);
});
