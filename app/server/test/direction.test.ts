import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ADX_FULL, SIDE_BAR, directionScore, emBuffer, inputsOf, momentumScore,
  stackScore, timeframeAgreement, trendStrength, verdict,
} from '../src/domain/direction.js';
import { pBetween, pExpireWorthless } from '../src/domain/probability.js';
import type { MarketRead, TimeframeRead } from '../src/market/moves.js';

/**
 * Is there a side today?
 *
 * The desk showed five windows -- 24h +0.25%, 12h -0.13%, 6h -0.15%, 1h
 * -0.16%, 15m +0.27% -- and left the adding-up to somebody at half past five in
 * the morning. These are the rules that do the adding up, and the property that
 * matters most is the one they were built for: **that board returns no side.**
 *
 * Nothing here decides anything. What the lots do is still the tested 70/30
 * rule in `recommend.ts`; this is the reading beside it.
 */

const tf = (t: string, over: Partial<TimeframeRead> = {}): TimeframeRead => ({
  tf: t as TimeframeRead['tf'],
  bars: 200, close: 75_800,
  ema9: null, ema21: null, ema50: null,
  rsi14: null, rsiSlope: null, adx14: null, vwap: null, vwapDistPct: null,
  structure: 0, atrPct: 1, trend: 0, label: 'flat',
  ...over,
});

/** An EMA stack pointing one way, at the strength a real board has. */
const stack = (t: string, dir: 1 | -1 | 0, over: Partial<TimeframeRead> = {}) =>
  tf(t, dir === 0
    ? { ema9: 100, ema21: 100, ema50: 100, ...over }
    : dir === 1
      ? { ema9: 103, ema21: 101, ema50: 99, ...over }
      : { ema9: 97, ema21: 99, ema50: 101, ...over });

const market = (over: Partial<MarketRead> = {}): MarketRead => ({
  spot: 75_800, return24h: 0, dailyRsiPrior: 50,
  timeframes: [], agreement: 0, regime: 'mixed', realisedVol: 40,
  moves: [], max24hRangeUsd: null, max24hRangePct: null, volume: [],
  high24h: null, low24h: null,
  ...over,
});

/** Every timeframe trending the same way, strongly enough that ADX believes it. */
const oneWay = (dir: 1 | -1, r24: number) => market({
  return24h: r24,
  timeframes: [
    stack('1d', dir, { adx14: 30 }),
    stack('4h', dir, { adx14: 30 }),
    stack('1h', dir, {
      adx14: 32, rsi14: dir === 1 ? 68 : 32, rsiSlope: dir * 4,
      structure: dir, vwapDistPct: dir * 1.2,
    }),
    stack('15m', dir, { adx14: 28, rsi14: dir === 1 ? 65 : 35, rsiSlope: dir * 3 }),
  ],
});

// ------------------------------------------------------------- the inputs

test('[critical] the EMA stack reads full only when both crossings agree', () => {
  assert.equal(stackScore(stack('1h', 1)), 1);
  assert.equal(stackScore(stack('1h', -1)), -1);
  // fast up, slow down: a cross that the longer average has not confirmed
  assert.equal(stackScore(tf('1h', { ema9: 103, ema21: 101, ema50: 102 })), 0.4);
  assert.equal(stackScore(tf('1h', { ema9: 100, ema21: 100, ema50: 100 })), 0);
  assert.equal(stackScore(tf('1h', { ema9: null, ema21: null })), null, 'unreadable is not neutral');
});

test('momentum reads the level and the slope together, not one of them', () => {
  const flat = momentumScore(tf('1h', { rsi14: 50, rsiSlope: 0 }), undefined);
  assert.equal(flat, 0);
  const rising = momentumScore(tf('1h', { rsi14: 50, rsiSlope: 5 }), undefined)!;
  assert.ok(rising > 0, 'an RSI at 50 and rising is not nothing');
  const stretched = momentumScore(tf('1h', { rsi14: 70, rsiSlope: -5 }), undefined)!;
  assert.ok(Math.abs(stretched) < 0.5, 'high but falling is the two cancelling');
  assert.equal(momentumScore(undefined, undefined), null);
});

test('[critical] a missing input is dropped, not counted as neutral', () => {
  // A VWAP the feed did not supply is not a flat market, and treating it as one
  // drags every reading towards the middle.
  const full = directionScore(oneWay(1, 3)).score!;
  const noVwap = directionScore(market({
    return24h: 3,
    timeframes: oneWay(1, 3).timeframes.map((t) => ({ ...t, vwapDistPct: null })),
  })).score!;
  assert.ok(Math.abs(full - noVwap) < 0.05, `${full} vs ${noVwap}`);
  assert.ok(noVwap > SIDE_BAR);
});

test('nothing readable at all is no score, rather than zero', () => {
  assert.equal(directionScore(market({ return24h: null })).score, null);
  assert.equal(directionScore(null).score, null);
});

test('[critical] ADX damps agreement in a market that is going nowhere', () => {
  const quiet = market({
    return24h: 3,
    timeframes: oneWay(1, 3).timeframes.map((t) => ({ ...t, adx14: 10 })),
  });
  const trending = oneWay(1, 3);
  const a = directionScore(quiet).score!;
  const b = directionScore(trending).score!;
  assert.ok(a < b, `quiet ${a} should read weaker than trending ${b}`);
  assert.equal(trendStrength(trending).factor, 1, `ADX ${ADX_FULL}+ is taken at face value`);
  assert.ok(trendStrength(quiet).factor < 0.6);
  assert.equal(trendStrength(market()).factor, 1, 'no ADX to read changes nothing');
});

test('the strongest timeframe sets the strength, not the average of them', () => {
  const one = market({ timeframes: [tf('1h', { adx14: 35 }), tf('4h', { adx14: 8 }), tf('1d', { adx14: 9 })] });
  assert.equal(trendStrength(one).adx, 35);
  assert.equal(trendStrength(one).factor, 1);
});

// ------------------------------------------------------------ the verdict

test('[critical] the 16 September board returns no side', () => {
  // The actual reading that prompted all of this: mixed windows, nothing
  // trending. The whole point of the score is that this is a "wait".
  const mixed = market({
    return24h: 0.25,
    timeframes: [
      stack('1d', 1, { adx14: 12 }),
      tf('4h', { ema9: 100.2, ema21: 100.1, ema50: 100.3, adx14: 11 }),
      stack('1h', -1, { adx14: 13, rsi14: 47, rsiSlope: -0.4, structure: 0, vwapDistPct: -0.08 }),
      stack('15m', 1, { adx14: 10, rsi14: 52, rsiSlope: 0.6 }),
    ],
  });
  const v = verdict({ market: mixed, snap: null });
  assert.equal(v.side, null, `score ${v.score}`);
  assert.equal(v.confirmed, false);
  assert.match(v.summary, /No side/);
});

test('[critical] everything pointing one way, in a market that is moving, names that side', () => {
  const up = verdict({ market: oneWay(1, 3), snap: null });
  assert.equal(up.side, 'bullish');
  assert.ok(up.score! >= SIDE_BAR, `${up.score}`);
  const down = verdict({ market: oneWay(-1, -3), snap: null });
  assert.equal(down.side, 'bearish');
  assert.ok(down.score! <= -SIDE_BAR);
});

test('[critical] a side is named but not confirmed until four of five gates pass', () => {
  // The tape says bullish; nothing else can be read, so the gates cannot pass.
  const v = verdict({ market: oneWay(1, 3), snap: null });
  assert.equal(v.side, 'bullish');
  assert.equal(v.confirmed, false, 'a score alone is not a confirmation');
  assert.match(v.summary, /not confirmed/);

  const full = verdict({
    market: oneWay(1, 3),
    snap: { spot: 75_800, expectedMove: 756 },
    shorts: { ce: 81_600, pe: 73_600 },
    execution: { worstSpreadPct: 0.02, quoteAgeMs: 500, hedged: true },
  });
  assert.equal(full.confirmed, true, JSON.stringify(full.gates, null, 1));
  assert.equal(full.passed, 5);
});

test('[critical] a gate that cannot be read is never a pass', () => {
  const v = verdict({ market: oneWay(1, 3), snap: null });
  const unread = v.gates.filter((g) => g.pass === null);
  assert.ok(unread.length >= 3, 'no strikes, no book: three gates have nothing to read');
  assert.equal(v.passed, v.gates.filter((g) => g.pass === true).length);
  assert.ok(v.readable < 5);
});

test('a strike inside the expected move fails the third gate', () => {
  const near = verdict({
    market: oneWay(1, 3),
    snap: { spot: 75_800, expectedMove: 756 },
    shorts: { ce: 81_600, pe: 75_600 },       // 0.26 expected moves away
    execution: { worstSpreadPct: 0.02, quoteAgeMs: 0, hedged: true },
  });
  const gate = near.gates.find((g) => g.key === 'expectedMove')!;
  assert.equal(gate.pass, false);
  assert.match(gate.why, /0\.26× the expected move/);
  assert.equal(near.passed, 4, 'and four of five is still a confirmation');
  assert.equal(near.confirmed, true);
});

test('[critical] a wide book fails the execution gate, and two failures stop it', () => {
  const v = verdict({
    market: oneWay(1, 3),
    snap: { spot: 75_800, expectedMove: 756 },
    shorts: { ce: 81_600, pe: 75_600 },
    execution: { worstSpreadPct: 0.26, quoteAgeMs: 0, hedged: true },
  });
  assert.equal(v.gates.find((g) => g.key === 'execution')!.pass, false);
  assert.equal(v.passed, 3);
  assert.equal(v.confirmed, false, 'a side with three gates is not a side to trade');
});

test('no hedge where one was wanted fails execution however tight the book', () => {
  const v = verdict({
    market: oneWay(1, 3),
    snap: { spot: 75_800, expectedMove: 756 },
    shorts: { ce: 81_600, pe: 73_600 },
    execution: { worstSpreadPct: 0.01, quoteAgeMs: 0, hedged: false },
  });
  assert.equal(v.gates.find((g) => g.key === 'execution')!.pass, false);
  assert.match(v.gates.find((g) => g.key === 'execution')!.why, /no hedge/);
});

test('the timeframe gate refuses a score that the hierarchy does not back', () => {
  // 24h return alone carries the score; the timeframes are split two and two.
  const split = market({
    return24h: 6,
    timeframes: [stack('1d', 1, { adx14: 30 }), stack('4h', 1, { adx14: 30 }), stack('1h', -1, { adx14: 30 }), stack('15m', -1, { adx14: 30 })],
  });
  const g = timeframeAgreement(split);
  assert.equal(g.agreeing, 2);
  assert.equal(verdict({ market: split, snap: null }).gates.find((x) => x.key === 'timeframes')!.pass, false);
});

test('every input is named and explained, so the number can be argued with', () => {
  const inputs = inputsOf(oneWay(1, 3));
  assert.equal(inputs.length, 7);
  assert.ok(inputs.every((i) => i.why.length > 3), JSON.stringify(inputs));
  assert.match(inputs.find((i) => i.key === 'return24h')!.why, /\+3\.00% against the 2% mark/);
  assert.match(inputs.find((i) => i.key === 'structure')!.why, /higher highs/);
});

// -------------------------------------------------- distance and corridor

test('[critical] the expected-move buffer is the distance a strike really is', () => {
  // 75,819 spot, 74,400 put, ±756 expected: 1.88 expected moves away.
  assert.ok(Math.abs(emBuffer(75_819, 74_400, 756)! - 1.877) < 0.01);
  // and the near strike from the same board is inside it
  assert.ok(emBuffer(75_819, 75_600, 756)! < 0.3);
  assert.equal(emBuffer(75_819, 74_400, null), null, 'no expected move, no buffer');
  assert.equal(emBuffer(75_819, 74_400, 0), null);
});

test('[critical] containment is the corridor, not the two probabilities multiplied', () => {
  const s = 75_800;
  const t = 12 / (365 * 24);
  const v = 0.3;
  const low = 73_600;
  const high = 81_600;
  const between = pBetween(s, low, high, t, v)!;
  // The same fact from the two one-sided answers: 1 - P(put breached) - P(call breached)
  const putSafe = pExpireWorthless('P', s, low, t, v)!;
  const callSafe = pExpireWorthless('C', s, high, t, v)!;
  assert.ok(Math.abs(between - (putSafe + callSafe - 1)) < 1e-9, `${between} vs ${putSafe + callSafe - 1}`);
  // and never their product. Far out, both are so close to 1 that the two
  // agree to four decimals; near the money they do not, and that is where the
  // difference would cost something.
  const near = { low: 75_200, high: 76_400 };
  const nearBetween = pBetween(s, near.low, near.high, t, v)!;
  const nearProduct = pExpireWorthless('P', s, near.low, t, v)! * pExpireWorthless('C', s, near.high, t, v)!;
  assert.ok(Math.abs(nearBetween - nearProduct) > 0.05, `${nearBetween} vs ${nearProduct}`);
  assert.ok(nearBetween < nearProduct, 'the corridor is the stricter question');
});

test('a corridor that is the wrong way round, or unreadable, is not a number', () => {
  const t = 12 / (365 * 24);
  assert.equal(pBetween(75_800, 81_600, 73_600, t, 0.3), 0);
  assert.equal(pBetween(75_800, 73_600, 81_600, 0, 0.3), null);
  assert.equal(pBetween(75_800, 73_600, 81_600, t, 0), null);
});

test('a wider corridor is always at least as likely as a narrower one inside it', () => {
  const t = 12 / (365 * 24);
  const wide = pBetween(75_800, 73_600, 81_600, t, 0.3)!;
  const narrow = pBetween(75_800, 75_000, 76_600, t, 0.3)!;
  assert.ok(wide > narrow, `${wide} vs ${narrow}`);
  assert.ok(wide <= 1 && narrow >= 0);
});
