import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  OptionStopWatch, STOP_WATCH_BOARD_STALE_MS, STOP_WATCH_QUOTA_HARD_PCT, STOP_WATCH_QUOTA_PCT, STOP_WATCH_RECHECK_MS, stopWatchedOf, type StopWatchDeps, type StopWatched,
} from '../../src/trading/stop-watch.js';
import { STOP_CONFIRM_FAST_MS, STOP_CONFIRM_MS, STOP_RUN_SHARE, backstopFor, closeLimitFor, type TradeRecord } from '../../src/trading/engine.js';
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

type StandDown = Parameters<NonNullable<StopWatchDeps['onStandDown']>>[0];
function watch(o: { used?: () => number } = {}) {
  const downs: StandDown[] = [];
  let now = T0;
  let board: { at: number; asks: Map<string, number> } | null = { at: T0, asks: new Map() };
  const calls: { symbol: string; ids: string[]; at: number }[] = [];
  let answer: (symbol: string, ids: readonly string[]) => Promise<readonly string[]> = async () => [];
  const w = new OptionStopWatch({
    asks: () => board, quotaUsedPct: o.used ?? (() => 0), now: () => now, onStandDown: (why) => downs.push(why),
    check: (symbol, ids) => { calls.push({ symbol, ids: [...ids], at: now }); return answer(symbol, ids); },
  });
  return {
    w, calls, downs,
    /** The board as of now: each contract's offer. */
    offers(asks: Record<string, number>) { board = { at: now, asks: new Map(Object.entries(asks)) }; },
    noBoard() { board = null; },
    advance(ms: number) { now += ms; },
    answerWith(fn: typeof answer) { answer = fn; },
  };
}
const t = (tradeId: string, symbol: string, stop: number, run?: number): StopWatched => ({ tradeId, symbol, stop, ...(run === undefined ? {} : { run }) });

test('[critical] which trades are watched: a short holding contracts, with a stop judged on the offer, not already closing', () => {
  // A run is the offer half way from the stop to the backstop at Delta, as the engine reads it.
  const run = 164 + (backstopFor(164, 100) - 164) * STOP_RUN_SHARE;
  const rec = (id: string, o: { position?: number; phase?: string; stop?: number | null; monitorOn?: 'ltp' | 'close' } = {}) => ({
    plan: { symbol: CE, stopPrice: o.stop === undefined ? 164 : o.stop, monitorOn: o.monitorOn },
    state: { tradeId: id, position: o.position ?? -16, phase: o.phase ?? 'protected', entryAvgPrice: 100 },
  }) as unknown as TradeRecord;
  assert.deepEqual(stopWatchedOf([
    rec('a'), rec('ltp', { monitorOn: 'ltp' }),
    rec('no-stop', { stop: null }), rec('on-close', { monitorOn: 'close' }), rec('flat', { position: 0 }), rec('long', { position: 5 }),
    rec('closing', { phase: 'exit_pending' }), rec('unknown', { phase: 'entry_unknown' }),
  ]), [{ tradeId: 'a', symbol: CE, stop: 164, run }, { tradeId: 'ltp', symbol: CE, stop: 164, run }]);
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

test('[critical] while the offer stays at the stop the engine is asked again every second: the stop\'s seconds are acted on the moment they are up', async () => {
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
  assert.deepEqual(asked, Array.from({ length: 19 }, (_, s) => s), `every ${STOP_WATCH_RECHECK_MS / 1000} s, so the look at ${STOP_CONFIRM_MS / 1000} s is the close`);
});

test('[critical] back under the stop: one more look, so the engine forgets its count -- and then it is left alone', async () => {
  const x = watch();
  x.w.note([t('a', CE, 164), t('b', CE, 160)]);
  x.offers({ [CE]: 165 });
  assert.deepEqual(x.w.tick(), ['a', 'b']);
  await x.w.settle();
  x.advance(1_000);
  x.offers({ [CE]: 162 });                        // under a's stop, still over b's
  assert.deepEqual(x.w.tick(), ['a', 'b'], 'a is looked at once more, to clear its count; b is still at its stop, asked again each second');
  await x.w.settle();
  x.advance(1_000);
  assert.deepEqual(x.w.tick(), ['b'], 'a is under its stop and was told so: left alone');
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

test('[critical] 19 Oct 2026: Delta\'s quota past the soft line -- a stop in a run is still looked at; one only at its level waits for the loop, and that is said once', async () => {
  let used = STOP_WATCH_QUOTA_PCT;
  const x = watch({ used: () => used });
  // P-82400 at 3:52 PM: stops at 42 and 48, runs at 56 and 64; the offer at 75.9 -- and one stop at 70, not yet a run.
  x.w.note([t('a', PE, 42, 56), t('b', PE, 48, 64), t('c', PE, 70, 85)]);
  x.offers({ [PE]: 75.9 });
  assert.deepEqual(x.w.tick(), ['a', 'b'], 'the runs are handed over, closed at once by the engine');
  assert.deepEqual(x.calls.map((c) => c.ids), [['a', 'b']]);
  assert.equal(x.downs.length, 1, 'the one at its level, passed over, is said');
  assert.deepEqual([x.downs[0]!.kind, x.downs[0]!.atStop, x.downs[0]!.usedPct], ['quota', 1, STOP_WATCH_QUOTA_PCT]);
  await x.w.settle();
  x.advance(STOP_WATCH_RECHECK_MS);
  x.offers({ [PE]: 75.9 });
  x.w.tick();
  assert.equal(x.downs.length, 1, 'once an episode, not every second');
  // Under the line again: the episode is over, and the next stand-down is said afresh.
  used = 10;
  await x.w.settle();
  x.advance(STOP_WATCH_RECHECK_MS);
  x.offers({ [PE]: 75.9 });
  assert.deepEqual(x.w.tick(), ['a', 'b', 'c'], 'every stop at its level, as before');
  used = STOP_WATCH_QUOTA_HARD_PCT;
  await x.w.settle();
  x.advance(STOP_WATCH_RECHECK_MS);
  x.offers({ [PE]: 75.9 });
  assert.deepEqual(x.w.tick(), [], 'at the hard line: nothing read at all');
  assert.equal(x.downs.length, 2);
  assert.equal(x.downs[1]!.atStop, 3);
});

test('a board gone stale is said once while it lasts -- the loop alone is judging the stops', () => {
  const x = watch();
  x.w.note([t('a', CE, 164)]);
  x.offers({ [CE]: 100 });
  x.advance(STOP_WATCH_BOARD_STALE_MS + 1);
  x.w.tick();
  x.advance(1_000);
  x.w.tick();
  assert.equal(x.downs.length, 1);
  assert.deepEqual([x.downs[0]!.kind, x.downs[0]!.boardAgeMs], ['board', STOP_WATCH_BOARD_STALE_MS + 1]);
  x.offers({ [CE]: 100 });
  x.w.tick();
  x.advance(STOP_WATCH_BOARD_STALE_MS + 1);
  x.w.tick();
  assert.equal(x.downs.length, 2, 'fresh again in between: a new episode');
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
/** The book's offer moved; the mark stays under every stop unless said, so the offer alone is what is judged. */
const offer = (r: Awaited<ReturnType<typeof book>>['r'], symbol: string, bid: number, ask: number, mark = 100) => r.ex.tick(quote(symbol, bid, ask, { ts: r.now(), mark }));

test('[critical] the engine\'s check for one contract: the count starts at the first look and the close is at the first look its seconds on', async () => {
  const { r, state } = await book();
  offer(r, CE, 111, 112);                          // through ce-1's stop of 110; ce-2's is 120; the put is untouched
  assert.deepEqual(await r.engine.checkStops(CE, ['ce-1', 'ce-2']), [], 'the first look starts the count and closes nothing');
  assert.equal((await state('ce-1')).position, -10);
  for (const s of [1, 2]) {
    r.advance(1_000); offer(r, CE, 111, 112);
    assert.deepEqual(await r.engine.checkStops(CE, ['ce-1', 'ce-2']), [], `${s} s: still counting`);
  }
  r.advance(1_000); offer(r, CE, 111, 112);
  assert.deepEqual(await r.engine.checkStops(CE, ['ce-1', 'ce-2']), ['ce-1'], 'three seconds: closed, and said to be over');
  const closed = (await r.store.get('ce-1'))!;
  assert.equal(closed.state.position, 0);
  const why = closed.events.find((e) => e.t === 'exit_submitted') as { reason?: string } | undefined;
  assert.equal(why?.reason, 'stop reached: the offer held at 112 (stop 110) for 3 s');
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
  offer(r, PE, 115, 116);                         // through the 110 stop, short of a run
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

// ------------------------------------------------------------------ a run, not a stray quote (13 Oct 2026)

test('[critical] the offer and the mark both through the stop: closed at the first look (21 Oct 2026, the SL first)', async () => {
  const { r, state } = await book();
  assert.equal(STOP_CONFIRM_FAST_MS, 0);
  offer(r, CE, 111, 112, 111.5);                   // ce-1's stop is 110: the offer and the mark agree
  assert.deepEqual(await r.engine.checkStops(CE, ['ce-1']), ['ce-1'], 'no wait');
  const why = (await r.store.get('ce-1'))!.events.find((e) => e.t === 'exit_submitted') as { reason?: string };
  assert.equal(why.reason, 'stop reached: the offer at 112 and the mark at 111.5 both through the stop 110');
  assert.equal((await state('ce-2')).position, -10, 'ce-2\'s stop of 120 is not reached');
});

test('[critical] the mark alone through the stop, the offer under it, is not a stop: a mark prints prices nothing trades at', async () => {
  const { r, state } = await book();
  for (let s = 0; s <= 30; s += 3) {
    offer(r, CE, 104, 105, 140);
    await r.engine.checkStops(CE, ['ce-1']);
    r.advance(3_000);
  }
  assert.equal((await state('ce-1')).position, -10);
  // and the offer through with the mark under it is the offer alone: its own seconds, unbroken
  offer(r, CE, 111, 112, 100);
  assert.deepEqual(await r.engine.checkStops(CE, ['ce-1']), [], 'the mark is under: no fast close');
  r.advance(STOP_CONFIRM_MS - 1_000); offer(r, CE, 111, 112, 100);
  assert.deepEqual(await r.engine.checkStops(CE, ['ce-1']), [], 'not yet its seconds');
  r.advance(1_000); offer(r, CE, 111, 112, 100);
  assert.deepEqual(await r.engine.checkStops(CE, ['ce-1']), ['ce-1'], 'the offer held its seconds: closed');
});

test('[critical] a run -- the offer half way from the stop to the backstop -- is closed at the first look', async () => {
  const { r, state } = await book();
  const rec = (await r.store.get('ce-1'))!;
  const back = backstopFor(110, rec.state.entryAvgPrice);
  const half = Math.ceil(110 + (back - 110) * 0.5);
  offer(r, CE, half - 1, half);                    // the mark under the stop: the run alone decides
  assert.deepEqual(await r.engine.checkStops(CE, ['ce-1']), ['ce-1'], 'no fifteen seconds: the backstop would buy at the market first');
  const why = (await r.store.get('ce-1'))!.events.find((e) => e.t === 'exit_submitted') as { reason?: string };
  assert.match(why.reason!, new RegExp(`^stop reached: the offer at ${half} is 50% of the way from the stop 110 to the backstop ${back}`));
  assert.equal((await state('ce-2')).position, -10, 'ce-2 is judged by its own stop and backstop');
});

test('[critical] a stop\'s close is a buy limit 15% through the offer it was judged on -- what it cannot fill is sent again at the market', async () => {
  assert.equal(closeLimitFor(200, 0.1), 230);
  assert.equal(closeLimitFor(2, 0.1), 2.5, 'five ticks at least');
  assert.equal(closeLimitFor(171.3, 0.5), 197, 'up to the tick: 196.995 is 197');

  const { r, state } = await book();
  // Only 4 are offered within the cap; the rest of the book is far above it.
  r.ex.configure({ slippageLadder: [{ price: 112, size: 4 }, { price: 140, size: 50 }] });
  offer(r, CE, 111, 112, 111.5);
  await r.engine.checkStops(CE, ['ce-1']);
  r.advance(STOP_CONFIRM_FAST_MS); offer(r, CE, 111, 112, 111.5);
  await r.engine.checkStops(CE, ['ce-1']);
  const rec = (await r.store.get('ce-1'))!;
  const exit = rec.events.find((e) => e.t === 'exit_submitted') as { clientOrderId: string };
  const order = await r.ex.getOrderByClientId(exit.clientOrderId);
  assert.equal(order?.type, 'limit');
  assert.equal(order?.limitPrice, closeLimitFor(112, 0.1));
  assert.equal(rec.state.position, -6, 'four filled inside the cap; nothing bought at 140');
  // the follow-up: what is left goes at the market and the trade is closed
  r.advance(4_000); offer(r, CE, 111, 112, 111.5);
  await r.engine.poll('ce-1');
  r.advance(4_000);
  await r.engine.poll('ce-1');
  assert.equal((await state('ce-1')).position, 0, 'the rest at the market: the close still happens');
});

/**
 * Every trade of one contract at its stop closed together, not one after another (21 Oct 2026). On 19 Oct fifteen
 * trades on the P-82400 at stops of 39-48 were closed seven seconds apart: the first filled at 49, the fifteenth at
 * 56, two minutes on. The venue is made slow here -- each order and each cancel takes a while to answer -- and how
 * many are in flight at once is counted.
 */
function slowVenue(r: Awaited<ReturnType<typeof book>>['r']) {
  const live = { place: 0, cancel: 0 }, most = { place: 0, cancel: 0 };
  const later = () => new Promise((done) => setTimeout(done, 15));
  const place = r.ex.placeOrder.bind(r.ex), cancel = r.ex.cancelOrder.bind(r.ex);
  r.ex.placeOrder = async (...a: Parameters<typeof place>) => {
    if (a[0].role !== 'exit') return place(...a);
    live.place++; most.place = Math.max(most.place, live.place);
    try { await later(); return await place(...a); } finally { live.place--; }
  };
  r.ex.cancelOrder = async (...a: Parameters<typeof cancel>) => {
    live.cancel++; most.cancel = Math.max(most.cancel, live.cancel);
    try { await later(); return await cancel(...a); } finally { live.cancel--; }
  };
  return most;
}

test('[critical] the trades of one contract at their stops are closed together: every buy-back in flight at once', async () => {
  const r = rig({ products: [ceProduct()], quotes: [quote(CE, 100.5, 101)], limits: { allowPyramiding: true } });
  const ids = ['a', 'b', 'c', 'd', 'e'];
  for (const id of ids) {
    assert.equal((await r.engine.open(planFor(ceProduct(), { tradeId: id, stopPrice: 110, lots: 10 }))).ok, true);
    await r.engine.poll(id);
  }
  r.ex.tick(quote(CE, 111, 112, { ts: r.now(), mark: 100 }));
  assert.deepEqual(await r.engine.checkStops(CE, ids), [], 'the count starts');
  r.advance(STOP_CONFIRM_MS); r.ex.tick(quote(CE, 111, 112, { ts: r.now(), mark: 100 }));
  const most = slowVenue(r as never);
  assert.deepEqual(await r.engine.checkStops(CE, ids), ids, 'every one closed, in the order asked');
  assert.equal(most.place, ids.length, 'all five buy-backs in flight together');
  for (const id of ids) {
    const rec = (await r.store.get(id))!;
    assert.equal(rec.state.position, 0, id);
    // its own two legs off the book, each written once, before its buy-back
    const kinds = rec.events.map((e) => (e.t === 'sibling_cancelled' ? `off:${e.role}` : e.t));
    assert.ok(kinds.indexOf('off:take_profit') >= 0 && kinds.indexOf('off:stop_loss') >= 0, `${id}: both legs off`);
    assert.ok(kinds.indexOf('off:stop_loss') < kinds.indexOf('exit_submitted') && kinds.indexOf('off:take_profit') < kinds.indexOf('exit_submitted'), `${id}: before the buy-back`);
  }
});

test('[critical] a close takes its target and its backstop off together, then buys back: the two cancels overlap', async () => {
  const { r } = await book();
  const most = slowVenue(r);
  await r.engine.closeNow('ce-1', 'manual exit');
  assert.equal((await r.store.get('ce-1'))!.state.position, 0);
  assert.equal(most.cancel, 2, 'target and backstop cancelled at the same time');
  const ev = (await r.store.get('ce-1'))!.events.filter((e) => e.t === 'sibling_cancelled').map((e) => (e as { role: string }).role);
  assert.deepEqual(ev, ['take_profit', 'stop_loss'], 'written in their order, once each');
});
