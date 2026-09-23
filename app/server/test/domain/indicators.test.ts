import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  clv, efficiencyRatio, ema, indicators, logReturn, macd, mean, percentileOf,
  relevantIndicators, roc, simpleReturn, stdev, zScore, type IndicatorInput,
} from '../../src/domain/indicators.js';
import type { Candle } from '../../src/market/delta.js';

let t = 0;
const c = (open: number, high: number, low: number, close: number, volume = 100): Candle =>
  ({ time: ++t, open, high, low, close, volume });

// ------------------------------------------------------------------ formulas

test('returns, simple and log', () => {
  assert.equal(simpleReturn(110, 100), 0.1);
  assert.equal(simpleReturn(100, 0), null, 'nothing divides by a zero price');
  assert.equal(Math.round(logReturn(110, 100)! * 10_000) / 10_000, 0.0953);
  assert.equal(logReturn(0, 100), null);
});

test('rate of change is measured over n bars, not since the beginning', () => {
  const closes = [100, 101, 102, 103, 110];
  assert.equal(Math.round(roc(closes, 4)! * 100) / 100, 10);
  assert.equal(Math.round(roc(closes, 1)! * 100) / 100, 6.8);
  assert.equal(roc([100], 4), null, 'not enough bars to look back that far');
});

test('close location is +1 on the high and -1 on the low', () => {
  assert.equal(clv(c(100, 110, 100, 110)), 1);
  assert.equal(clv(c(100, 110, 100, 100)), -1);
  assert.equal(clv(c(100, 110, 100, 105)), 0);
  assert.equal(clv(c(100, 100, 100, 100)), null, 'a bar with no range has no location');
});

test('mean, standard deviation, z-score and percentile', () => {
  const xs = [2, 4, 4, 4, 5, 5, 7, 9];
  assert.equal(mean(xs), 5);
  assert.equal(Math.round(stdev(xs)! * 100) / 100, 2.14);
  assert.equal(Math.round(zScore(xs, 9)! * 100) / 100, 1.87);
  assert.equal(percentileOf(xs, 5), 0.75);
  assert.equal(zScore([3, 3, 3], 3), null, 'nothing varies, so nothing is unusual');
  assert.equal(stdev([1]), null);
  assert.equal(percentileOf([], 1), null);
});

test('[critical] the efficiency ratio separates a trend from the same ground covered twice', () => {
  // Ten bars straight up: every step was progress.
  const straight = Array.from({ length: 11 }, (_, i) => 100 + i);
  assert.equal(efficiencyRatio(straight), 1);
  // Ten bars up and down between the same two prices: none of it was.
  const chop = Array.from({ length: 11 }, (_, i) => (i % 2 ? 101 : 100));
  assert.equal(efficiencyRatio(chop), 0);
  assert.equal(efficiencyRatio([100, 100, 100]), null, 'too few bars');
});

test('EMA and MACD', () => {
  assert.equal(ema([1, 2, 3], 5), null, 'not enough points for the period');
  assert.equal(ema([2, 2, 2, 2, 2], 5), 2);
  // A straight line is the case that catches a careless test: the MACD line
  // settles to a constant, so the signal catches it and the histogram is nil.
  const straight = Array.from({ length: 60 }, (_, i) => 100 + i);
  assert.ok(macd(straight)!.macd > 0, 'a market going up has a positive MACD line');
  assert.ok(Math.abs(macd(straight)!.histogram) < 0.2, 'a constant line is not momentum');
  // A market accelerating away is: the line rises and the signal lags it.
  const accelerating = Array.from({ length: 60 }, (_, i) => 100 * 1.01 ** i);
  assert.ok(macd(accelerating)!.histogram > 0, 'the line is pulling away from its signal');
  assert.equal(macd([1, 2, 3]), null);
});

// ---------------------------------------------------------------- the card

const input = (over: Partial<IndicatorInput> = {}): IndicatorInput => ({
  bars: Array.from({ length: 60 }, (_, i) => c(100 + i, 101 + i, 99 + i, 100.5 + i)),
  rsi14: 62, adx14: 28, atrPct: 0.42, vwapDistPct: 0.12, emaFast: 86_500, emaSlow: 86_300,
  volumeRatio: 1.8, cvdSlope: 120, aggressorBuyPct: 58, oiChangePct: 2.1, ...over,
});

test('[critical] each reading carries its own words, not only a number', () => {
  const all = indicators(input());
  const by = (k: string) => all.find((i) => i.key === k)!;
  assert.equal(by('rsi').text, '62');
  assert.equal(by('rsi').read, 'Bullish');
  assert.equal(by('volume').text, '1.8x');
  assert.equal(by('volume').read, 'Increasing');
  assert.equal(by('cvd').read, 'Buyers');
  assert.equal(by('aggressor').text, '58% buy');
  assert.equal(by('oi').text, '+2.1%');
  assert.equal(by('ema').read, 'Bullish');
});

test('RSI reads as overbought and oversold at the ends, not only bullish and bearish', () => {
  const at = (rsi14: number) => indicators(input({ rsi14 })).find((i) => i.key === 'rsi')!;
  assert.equal(at(78).read, 'Overbought');
  assert.equal(at(78).bias, 'BEARISH');
  assert.equal(at(22).read, 'Oversold');
  assert.equal(at(22).bias, 'BULLISH');
  assert.equal(at(50).read, 'Neutral');
  assert.equal(at(50).gauge, 0.5);
});

test('a reading that could not be taken says so rather than showing a zero', () => {
  const none = indicators(input({ rsi14: null, cvdSlope: null }));
  const rsi = none.find((i) => i.key === 'rsi')!;
  assert.equal(rsi.value, null);
  assert.equal(rsi.text, '—');
  assert.equal(rsi.read, 'No reading');
  assert.equal(rsi.gauge, null);
});

test('[critical] the card shows the readings that decide the state it is in', () => {
  const all = indicators(input());
  const watching = relevantIndicators(all, 'WATCH').map((i) => i.key);
  assert.equal(watching.length, 6, 'six, not everything');
  for (const want of ['volume', 'cvd', 'aggressor']) {
    assert.ok(watching.includes(want), `${want} decides a level being tested: ${watching.join(', ')}`);
  }
  // In a range the question is different: is this range about to end?
  const ranging = relevantIndicators(all, 'RANGE').map((i) => i.key);
  assert.ok(ranging.includes('atr') && ranging.includes('adx'), ranging.join(', '));
});

test('an unmeasured reading does not take a slot from one that could be measured', () => {
  const all = indicators(input({ cvdSlope: null, aggressorBuyPct: null }));
  const shown = relevantIndicators(all, 'WATCH');
  assert.equal(shown.length, 6);
  assert.ok(shown.every((i) => i.value !== null), shown.map((i) => `${i.key}=${i.value}`).join(', '));
});

test('IV − RV is on the card only when the desk has both', () => {
  assert.ok(!indicators(input()).some((i) => i.key === 'ivrv'));
  const withIv = indicators(input({ ivRvPts: -14.2 })).find((i) => i.key === 'ivrv')!;
  assert.equal(withIv.text, '-14.2 pts');
  assert.equal(withIv.read, 'Options cheap');
});
