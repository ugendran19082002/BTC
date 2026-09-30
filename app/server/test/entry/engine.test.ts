import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Candle } from '../../src/market/delta.js';
import { entryBoard, readMethod, rrAfterFees, timeframeRows, MIN_RR } from '../../src/entry/engine.js';
import { METHODS } from '../../src/entry/methods.js';
import type { EntryContext, Frames } from '../../src/entry/types.js';
import { ctxOf, path, wave } from './bars.js';

/**
 * The engine, one fact at a time.
 *
 * A 5m breakout is built to be a TRADE on its own timeframe -- a close over the
 * 20-bar high on four times the volume, a stop 2.2 ATR away, an ask wall far
 * enough above for R:R 3.7 after fees -- and each case changes one thing and
 * says which state that must give, and why. TEST.md's rule throughout: a box
 * only when every critical confirmation holds.
 */

const BREAKOUT = METHODS.find((m) => m.id === 'breakout')!;
const MOMENTUM = METHODS.find((m) => m.id === 'momentum')!;

function breakoutBars(o: { volume?: number } = {}): Candle[] {
  const bars = path(wave(60, 84_000, 40, 10));
  const t = bars[bars.length - 1]!.time;
  bars.push({ time: t + 300, open: 84_125, high: 84_205, low: 84_120, close: 84_200, volume: o.volume ?? 400 });
  return bars;
}

/** Now = just after the last 5m candle closed. */
const nowAfter = (bars: readonly Candle[], lagSec = 5) => (bars[bars.length - 1]!.time + 300 + lagSec) * 1000;

function single(over: Partial<EntryContext> = {}, bars = breakoutBars()): EntryContext {
  return ctxOf({
    now: nowAfter(bars),
    frames: { '5m': bars },
    walls: [{ side: 'ask', price: 84_900, size: 5_000 }],
    ...over,
  });
}

test('[critical] a breakout with room to its target is a TRADE on its own timeframe, with a box', () => {
  const r = readMethod(BREAKOUT, 'single', '5m', single());
  assert.equal(r.state, 'TRADE', r.reason);
  assert.equal(r.dir, 'long');
  assert.ok(r.plan);
  assert.equal(r.plan.tp1, 84_900);
  assert.match(r.plan.tpWhy[0]!, /ask wall 84,900/);
  assert.ok(r.plan.rr >= MIN_RR);
  assert.ok(r.plan.stop < 84_120, 'the stop sits past the breakout candle, with a buffer');
});

test('[critical] a step not yet there is WAIT, says which, and draws no box', () => {
  const r = readMethod(BREAKOUT, 'single', '5m', single({}, breakoutBars({ volume: 100 })));
  assert.equal(r.state, 'WAIT');
  assert.match(r.reason, /waiting for 5m: volume/);
  assert.equal(r.plan, null, 'TEST.md: no entry / SL / TP until every confirmation holds');
});

test('[critical] no room to a target is NO TRADE, even with every step green -- 2R does not clear the fees here', () => {
  const r = readMethod(BREAKOUT, 'single', '5m', single({ walls: [] }));
  assert.equal(r.state, 'NO_TRADE');
  assert.equal(r.gates.find((g) => !g.ok)?.key, 'rr');
  assert.match(r.reason, /after fees -- no room/);
});

test('[critical] stale candles are NO TRADE', () => {
  const bars = breakoutBars();
  const r = readMethod(BREAKOUT, 'single', '5m', single({ now: nowAfter(bars, 3_600) }, bars));
  assert.equal(r.state, 'NO_TRADE');
  assert.equal(r.gates.find((g) => !g.ok)?.key, 'data');
});

test('big-move risk pointing the other way is NO TRADE', () => {
  const r = readMethod(BREAKOUT, 'single', '5m', single({ bigMove: { band: 'high', direction: -0.6 } }));
  assert.equal(r.gates.find((g) => !g.ok)?.key, 'big-move');
});

test('fifteen minutes before settlement is NO TRADE', () => {
  const r = readMethod(BREAKOUT, 'single', '5m', single({
    options: { spot: 84_200, atmIv: 0.4, emDay: 2_000, callWall: null, putWall: null, maxPain: null, toSettleSec: 600 },
  }));
  assert.equal(r.gates.find((g) => !g.ok)?.key, 'settle');
});

test('a wide spread is NO TRADE', () => {
  const r = readMethod(BREAKOUT, 'single', '5m', single({ spreadPct: 0.2 }));
  assert.equal(r.gates.find((g) => !g.ok)?.key, 'spread');
});

test('nothing forming, or too few candles, says so', () => {
  const flat = path(wave(70));
  assert.equal(readMethod(BREAKOUT, 'single', '5m', ctxOf({ now: nowAfter(flat), frames: { '5m': flat } })).reason, 'nothing forming');
  assert.match(readMethod(BREAKOUT, 'single', '5m', ctxOf({ frames: { '5m': flat.slice(0, 30) } })).reason, /not enough 5m candles/);
});

test('[critical] momentum that is already extended is not chased', () => {
  // Six bars already running away from the average, then the displacement.
  const bars = path([...wave(60, 84_000, 20, 10), 84_060, 84_120, 84_180, 84_240, 84_300, 84_360]);
  const t = bars[bars.length - 1]!.time;
  bars.push({ time: t + 300, open: 84_360, high: 84_705, low: 84_355, close: 84_700, volume: 900 });
  const r = readMethod(MOMENTUM, 'single', '5m', single({ walls: [{ side: 'ask', price: 88_000, size: 1 }] }, bars));
  assert.equal(r.state, 'NO_TRADE');
  assert.match(r.reason, /extended: opened .* ATR from the 20 EMA -- not chased/);
});

// ------------------------------------------------------------ with the timeframe chain

/**
 * A trend on a higher timeframe, drifting `drift` a bar -- below the entry, so
 * its swing highs are not resistance just over it (which the engine rightly
 * reads as no room).
 */
const htf = (step: number, drift: number) => path(wave(80, 80_000, 40, 10, drift), { step });

function withChain(o: { h1?: number; h4?: number; bull3m?: boolean } = {}): EntryContext {
  const five = breakoutBars();
  const nowSec = five[five.length - 1]!.time + 300 + 5;
  const one = path([84_180, 84_185, 84_190, 84_195], { step: 60, t0: nowSec - 5 - 4 * 60, w: 2 });
  const three = path(o.bull3m === false ? [84_200, 84_190] : [84_180, 84_195], { step: 180, t0: nowSec - 5 - 2 * 180, w: 2 });
  const frames: Frames = {
    '4h': htf(14_400, o.h4 ?? 6), '1h': htf(3_600, o.h1 ?? 6), '30m': htf(1_800, 6), '15m': htf(900, 6),
    '5m': five, '3m': three, '1m': one,
  };
  return ctxOf({ now: nowSec * 1000, frames, walls: [{ side: 'ask', price: 84_900, size: 5_000 }] });
}

test('[critical] with the timeframe chain: every timeframe agreeing is a TRADE, the chain in TEST.md order', () => {
  const r = readMethod(BREAKOUT, 'mtf', '5m', withChain());
  assert.equal(r.state, 'TRADE', r.reason);
  assert.equal(r.tf, '5m', 'the entry is read on 5m with the chain');
  assert.deepEqual([...new Set(r.steps.map((s) => s.tf))], ['4h', '1h', '30m', '15m', '5m', '3m', '1m']);
  assert.equal(r.alignment, 100);
});

test('[critical] with the timeframe chain: 1H and 4H both against is NO TRADE', () => {
  const r = readMethod(BREAKOUT, 'mtf', '5m', withChain({ h1: -6, h4: -6 }));
  assert.equal(r.state, 'NO_TRADE');
  assert.match(r.reason, /1H and 4H are both down/);
});

test('with the timeframe chain: a 3m candle the wrong way is WAIT for the confirmation', () => {
  const r = readMethod(BREAKOUT, 'mtf', '5m', withChain({ bull3m: false }));
  assert.equal(r.state, 'WAIT');
  assert.match(r.reason, /3m: confirmation/);
});

test('[critical] without the chain the higher timeframes are not read: the same 1H/4H downtrend does not block it', () => {
  const ctx = withChain({ h1: -6, h4: -6 });
  const r = readMethod(BREAKOUT, 'single', '5m', ctx);
  assert.notEqual(r.gates.find((g) => g.key === 'htf')?.ok, false);
  assert.equal(r.steps.every((s) => s.tf === '5m'), true);
});

// ------------------------------------------------------------ the board

test('[critical] the board is 24 reads: the twelve methods with the chain, then the twelve without', () => {
  const board = entryBoard(withChain());
  assert.equal(board.length, 24);
  assert.deepEqual(board.slice(0, 12).map((r) => [r.n, r.mode]), METHODS.map((m) => [m.n, 'mtf']));
  assert.deepEqual(board.slice(12).map((r) => [r.n, r.mode]), METHODS.map((m) => [m.n, 'single']));
});

test('[critical] the score is quality out of 100, and what is not recorded is said, not counted', () => {
  const r = readMethod(BREAKOUT, 'single', '5m', single());
  assert.equal(r.scoreParts.reduce((s, p) => s + p.max, 0), 100);
  assert.ok(r.score !== null && r.score <= 100);
  assert.equal(r.scoreParts.find((p) => p.name === 'Footprint')?.got, null);
  assert.equal(r.scoreParts.find((p) => p.name === 'Probability')?.got, null);
});

test('R:R counts the taker fee on the way in and on the way out', () => {
  assert.ok(Math.abs(rrAfterFees(100, 99, 102) - (2 - 0.0005 * 202) / (1 + 0.0005 * 202)) < 1e-12);
});

test('the timeframe rows: each of the chain\'s seven, its trend and what its swings did', () => {
  const rows = timeframeRows(withChain({ h1: -6 }));
  assert.deepEqual(rows.map((r) => r.tf), ['4h', '1h', '30m', '15m', '5m', '3m', '1m']);
  assert.deepEqual([rows[0]!.label, rows[0]!.structure], ['Bullish', 'HH / HL']);
  assert.deepEqual([rows[1]!.label, rows[1]!.structure], ['Bearish', 'LH / LL']);
  assert.equal(rows[6]!.label, 'Not read', 'four 1m candles are not enough to read');
});
