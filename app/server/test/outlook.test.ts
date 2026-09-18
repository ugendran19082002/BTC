import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LEAN_AT, OUTLOOK_HORIZONS, outlook, quantileShare, rowAt, timeframeScore,
} from '../src/domain/outlook.js';
import type { HorizonRow } from '../src/domain/forecast.js';
import type { MarketRead, TimeframeRead } from '../src/market/moves.js';

/**
 * Where BTC could be at each horizon.
 *
 * The property this file exists to protect: **the card never invents a
 * direction.** The desk measured it over 105,119 windows — the chance BTC
 * finishes higher is 49.4% at five minutes and 50.6% at twelve hours, and never
 * leaves 48–52%. So a horizon carries a *band*, which is measured and useful,
 * and a *score* from its own indicators, which is a reading of the tape and is
 * labelled as one. There is no "DOWN 52%" anywhere, because that number would
 * be made up.
 */

/** A measured row shaped like the real table: quantiles of the signed return, in percent. */
const horizon = (minutes: number, p68: number, pUp = 0.5): HorizonRow => ({
  minutes,
  label: `${minutes}m`,
  windows: 105_119,
  moveMedian: p68 * 0.6,
  moveP68: p68,
  moveP95: p68 * 3,
  moveWorst: p68 * 8,
  rangeMedian: p68,
  rangeP68: p68 * 1.4,
  rangeP95: p68 * 3,
  pUp,
  pUpTrend: pUp,
  sampleDays: 364,
  // 101 percentiles of a symmetric distribution whose 84th percentile is p68.
  quantiles: Array.from({ length: 101 }, (_, i) => {
    const z = (i - 50) / 34;          // ±1 at the 16th and 84th percentile
    return z * p68;
  }),
});

const HORIZONS: HorizonRow[] = [
  horizon(5, 0.092, 0.4942),
  horizon(15, 0.159, 0.4952),
  horizon(60, 0.316, 0.5004),
  horizon(240, 0.649, 0.5026),
  horizon(720, 1.257, 0.5062),
];

const tf = (t: string, over: Partial<TimeframeRead> = {}): TimeframeRead => ({
  tf: t as TimeframeRead['tf'],
  bars: 200, close: 75_820,
  ema9: null, ema21: null, ema50: null,
  rsi14: null, rsiSlope: null, adx14: null, vwap: null, vwapDistPct: null,
  structure: 0, atrPct: 1, trend: 0, label: 'flat',
  ...over,
});
const up = (t: string) => tf(t, {
  ema9: 103, ema21: 101, ema50: 99, rsi14: 66, rsiSlope: 3, structure: 1, vwapDistPct: 1.1, adx14: 28,
});
const down = (t: string) => tf(t, {
  ema9: 97, ema21: 99, ema50: 101, rsi14: 34, rsiSlope: -3, structure: -1, vwapDistPct: -1.1, adx14: 28,
});

const market = (timeframes: TimeframeRead[]): MarketRead => ({
  spot: 75_820, return24h: 0.25, dailyRsiPrior: 50,
  timeframes, agreement: 0, regime: 'mixed', realisedVol: 40,
  moves: [], max24hRangeUsd: null, max24hRangePct: null, volume: [],
  high24h: null, low24h: null,
});

const snap = { spot: 75_820, atmIv: 0.30, hoursToExpiry: 9.6 };
const run = (timeframes: TimeframeRead[] = []) =>
  outlook({ snap, market: market(timeframes), horizons: HORIZONS });

// ------------------------------------------------------------- the bands

test('[critical] the implied band is S × IV × √(t/365d), per horizon', () => {
  const o = run();
  const five = o.rows.find((r) => r.label === '5m')!;
  const want = 75_820 * 0.3 * Math.sqrt(5 / (365 * 24 * 60));
  assert.ok(Math.abs(five.impliedUsd! - want) < 1e-6, `${five.impliedUsd} vs ${want}`);
  assert.ok(Math.abs(five.low! - (75_820 - want)) < 1e-6);
  assert.ok(Math.abs(five.high! - (75_820 + want)) < 1e-6);
});

test('[critical] the band widens with the square root of time, not with time', () => {
  const o = run();
  const one = o.rows.find((r) => r.label === '1h')!.impliedUsd!;
  const four = o.rows.find((r) => r.label === '4h')!.impliedUsd!;
  assert.ok(Math.abs(four / one - 2) < 1e-9, `4h should be twice 1h, got ${four / one}`);
});

test('no volatility to price it with leaves the band absent, not zero', () => {
  const o = outlook({ snap: { ...snap, atmIv: null }, market: market([]), horizons: HORIZONS });
  const row = o.rows.find((r) => r.label === '1h')!;
  assert.equal(row.impliedUsd, null);
  assert.equal(row.low, null);
  assert.equal(row.inside, null, 'and nothing can be said about what falls inside it');
});

test('[critical] every horizon the panel shows is covered, and the weights sum to one', () => {
  const o = run();
  for (const h of OUTLOOK_HORIZONS) {
    assert.ok(o.rows.some((r) => r.label === h.label), `missing ${h.label}`);
  }
  const total = OUTLOOK_HORIZONS.reduce((a, h) => a + h.weight, 0);
  assert.ok(Math.abs(total - 1) < 1e-9, `${total}`);
});

test('a horizon the measured table does not carry is stretched by √t, not dropped', () => {
  // 30m sits between the 15m and 60m rows; the table has neither 30 nor 1440.
  const o = run();
  const half = o.rows.find((r) => r.label === '30m')!;
  const day = o.rows.find((r) => r.label === '24h')!;
  assert.ok(half.measured68Pct !== null && half.measured68Pct > 0);
  assert.ok(day.measured68Pct !== null && day.measured68Pct > half.measured68Pct!);
  const nearest = rowAt(HORIZONS, 30)!;
  assert.ok(Math.abs(nearest.moveP68 - 0.159 * Math.sqrt(30 / 15)) < 1e-9);
});

// --------------------------------------------------- implied against measured

test('[critical] the implied band is scored against what actually happened', () => {
  const o = run();
  const row = o.rows.find((r) => r.label === '1h')!;
  assert.ok(row.inside !== null && row.below !== null && row.above !== null);
  assert.ok(Math.abs(row.inside! + row.below! + row.above! - 1) < 1e-9, 'the three add to one');
});

test('[critical] a market pricing more move than history gives contains more of it', () => {
  const rich = outlook({ snap: { ...snap, atmIv: 0.9 }, market: market([]), horizons: HORIZONS });
  const cheap = outlook({ snap: { ...snap, atmIv: 0.1 }, market: market([]), horizons: HORIZONS });
  const at = (o: ReturnType<typeof outlook>) => o.rows.find((r) => r.label === '1h')!.inside!;
  assert.ok(at(rich) > at(cheap), `${at(rich)} vs ${at(cheap)}`);
  assert.ok(at(rich) > 0.68, 'a band three times the usual move contains far more than two thirds');
});

test('the quantile walk is monotone and bounded', () => {
  const q = HORIZONS[2]!.quantiles;
  assert.equal(quantileShare(q, -99), 0);
  assert.equal(quantileShare(q, 99), 1);
  assert.ok(Math.abs(quantileShare(q, 0)! - 0.5) < 0.02, 'the median return is nil');
  assert.ok(quantileShare(q, 0.1)! > quantileShare(q, -0.1)!);
  assert.equal(quantileShare([], 0), null);
});

// ------------------------------------------------------------ the direction

test('[critical] a horizon with no bars carries no direction, and says why', () => {
  // 30m, 2h, 6h and 12h are not series the desk fetches. Inventing a reading
  // for them would be the one thing this card must not do.
  const o = run([up('1h')]);
  const half = o.rows.find((r) => r.label === '30m')!;
  assert.equal(half.score, null);
  assert.equal(half.lean, null);
  assert.match(half.why, /no bars at this horizon/);
  assert.ok(half.impliedUsd !== null, 'and it still carries its band');
});

test('[critical] the measured coin flip is carried, so nobody adds a forecast later', () => {
  const o = run();
  assert.ok(o.directionEdgePts !== null && o.directionEdgePts < 1,
    `the measured direction never gets ${o.directionEdgePts} points from a coin flip`);
  for (const r of o.rows) {
    if (r.pUp === null) continue;
    assert.ok(r.pUp > 0.48 && r.pUp < 0.52, `${r.label}: ${r.pUp}`);
  }
});

test('[critical] a timeframe reads its own indicators, and the 1h card agrees with the 1h input', () => {
  const rising = timeframeScore(up('1h'));
  const falling = timeframeScore(down('1h'));
  assert.ok(rising.score! > LEAN_AT);
  assert.ok(falling.score! < -LEAN_AT);
  assert.match(rising.why, /EMAs rising/);
  assert.match(rising.why, /RSI 66/);
  assert.match(rising.why, /higher highs/);
  assert.equal(timeframeScore(undefined).score, null);
});

test('[critical] the consensus weights the horizons it could read, and renormalises', () => {
  // Only 1h and 4h have bars here: 0.15 and 0.15 of the declared weights.
  const o = run([up('1h'), up('4h')]);
  assert.equal(o.scored, 2);
  assert.ok(o.consensus! > LEAN_AT, `${o.consensus}`);
  const mixed = run([up('1h'), down('4h')]);
  assert.ok(Math.abs(mixed.consensus!) < LEAN_AT, `one each way is no consensus: ${mixed.consensus}`);
});

test('nothing readable is no consensus, rather than zero', () => {
  const o = run();
  assert.equal(o.consensus, null);
  assert.equal(o.scored, 0);
  assert.match(o.agreement, /no timeframe could be read/);
});

test('the agreement counts the timeframes, and says which way', () => {
  const o = run([up('5m'), up('15m'), up('1h'), down('4h'), tf('1d', { ema9: 100, ema21: 100, ema50: 100 })]);
  assert.equal(o.bullish, 3);
  assert.equal(o.bearish, 1);
  assert.equal(o.flat, 1);
  assert.match(o.agreement, /3 of 5 bullish, 1 flat/);
});

// -------------------------------------------------------------- settlement

test('[critical] the horizon that matters is the one left on the contract', () => {
  const o = run([up('1h')]);
  const last = o.rows.at(-1)!;
  assert.equal(last.isExpiry, true);
  assert.match(last.label, /to settlement · 9\.6h/);
  assert.equal(last.minutes, Math.round(9.6 * 60));
  // 9.6 hours of implied move, not twelve and not twenty-four
  const want = 75_820 * 0.3 * Math.sqrt((9.6 * 60) / (365 * 24 * 60));
  assert.ok(Math.abs(last.impliedUsd! - want) < 1e-6);
});

test('a contract already settled adds no settlement row', () => {
  const o = outlook({ snap: { ...snap, hoursToExpiry: 0 }, market: market([]), horizons: HORIZONS });
  assert.ok(!o.rows.some((r) => r.isExpiry));
});

test('no measured table at all still gives the implied bands', () => {
  const o = outlook({ snap, market: market([up('1h')]), horizons: [] });
  const row = o.rows.find((r) => r.label === '1h')!;
  assert.ok(row.impliedUsd !== null);
  assert.equal(row.measured68Pct, null);
  assert.equal(row.inside, null);
  assert.equal(o.sampleWindows, null);
  assert.ok(row.score !== null, 'and the tape can still be read');
});

/**
 * The figure that actually varies across the row.
 *
 * Below/inside/above are near-constant by construction — the implied band and
 * the measured one both scale with √t, so their ratio hardly moves. Measured on
 * 16 September: 68.1% inside at five minutes and 63.3% at twelve hours, which
 * is not a row of nine informative numbers. The two bands against each other
 * *are* informative: 1.00 at five minutes, 0.88 at twelve hours.
 */
test('[critical] implied against measured is what moves, and it is carried', () => {
  const o = run();
  const five = o.rows.find((r) => r.label === '5m')!;
  const twelve = o.rows.find((r) => r.label === '12h')!;
  // Both are the implied band over the measured 68% band.
  assert.ok(Math.abs(five.richness! - five.impliedUsd! / 75_820 * 100 / five.measured68Pct!) < 1e-9);
  assert.ok(five.richness! > twelve.richness!, `${five.richness} should exceed ${twelve.richness}`);
  // and the near-constancy of the three shares is the reason it is needed
  assert.ok(Math.abs(five.inside! - twelve.inside!) < 0.1, 'the shares barely move');
});

test('rich, fair and cheap are named at the thresholds', () => {
  const at = (iv: number) => outlook({ snap: { ...snap, atmIv: iv }, market: market([]), horizons: HORIZONS })
    .rows.find((r) => r.label === '1h')!;
  assert.equal(at(0.3).priced, 'fair', 'the implied band matching history is fair');
  assert.equal(at(0.9).priced, 'rich');
  assert.equal(at(0.1).priced, 'cheap');
});

test('nothing to compare against is not a ratio', () => {
  const noIv = outlook({ snap: { ...snap, atmIv: null }, market: market([]), horizons: HORIZONS });
  assert.equal(noIv.rows[0]!.richness, null);
  assert.equal(noIv.rows[0]!.priced, null);
  const noHistory = outlook({ snap, market: market([]), horizons: [] });
  assert.equal(noHistory.rows[0]!.richness, null);
});

test('[critical] the score\'s parts add up to the score, and say what each is', () => {
  const r = timeframeScore(up('1h'));
  const sum = r.factors.reduce((a, f) => a + f.contribution, 0);
  assert.ok(Math.abs(sum - r.score!) < 1e-12, `${sum} vs ${r.score}`);
  assert.deepEqual(r.factors.map((f) => f.label), ['EMA (9/21/50)', 'RSI (14)', 'Swing structure', 'Price vs VWAP']);
  assert.ok(r.factors.find((f) => f.key === 'ema')!.contribution > 0, 'rising EMAs push up');
  assert.deepEqual(timeframeScore(undefined).factors, []);
  // a horizon with no bars carries no parts
  assert.deepEqual(run([up('1h')]).rows.find((x) => x.label === '30m')!.factors, []);
});

