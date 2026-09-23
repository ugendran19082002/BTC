import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cvdSlopeOf, levelFor, oiFor, regimeOf, voteOf, STATE_TF_MINUTES } from '../../src/market/state-read.js';
import type { MarketRead } from '../../src/market/moves.js';
import type { Candle } from '../../src/market/delta.js';

/*
 * The half of the market-state card that touches the outside world: which
 * reading it borrows from where. The rules themselves are pure and live in
 * test/domain/market-state.test.ts.
 */

const bar = (h: number, l: number, c = (h + l) / 2): Candle =>
  ({ time: 0, open: c, high: h, low: l, close: c, volume: 1 });

const read = (over: Partial<MarketRead> = {}): MarketRead => ({
  spot: 86_500, return24h: null, dailyRsiPrior: null, timeframes: [], agreement: 0,
  regime: 'mixed', realisedVol: null, moves: [], ...over,
} as MarketRead);

test('the regime is translated, not re-measured', () => {
  assert.equal(regimeOf(read({ regime: 'trending up' })), 'TREND_UP');
  assert.equal(regimeOf(read({ regime: 'trending down' })), 'TREND_DOWN');
  assert.equal(regimeOf(read({ regime: 'quiet' })), 'QUIET');
  assert.equal(regimeOf(read({ regime: 'mixed' })), 'RANGE');
  assert.equal(regimeOf(null), null, 'a read that failed is unknown, not a range');
});

test('the timeframe vote is counted off the reads the desk already did', () => {
  const tf = (trend: -1 | 0 | 1) => ({ trend } as MarketRead['timeframes'][number]);
  assert.deepEqual(voteOf(read({ timeframes: [tf(1), tf(1), tf(1), tf(-1), tf(0)] })), { up: 3, down: 1, total: 5 });
  assert.equal(voteOf(read({ timeframes: [] })), null);
  assert.equal(voteOf(null), null);
});

test('[critical] the level is the timeframe’s own swing, and the last twenty bars when there is none', () => {
  const bars = [bar(86_800, 86_200), bar(86_700, 86_300), bar(86_600, 86_400)];
  const withSwing = read({
    timeframes: [{ tf: '15m', resistance: [86_950], support: [86_050] } as MarketRead['timeframes'][number]],
  });
  assert.deepEqual(levelFor(withSwing, '15m', bars), { resistance: 86_950, support: 86_050 });
  // No read for this timeframe: the plain high and low of the bars before the
  // one being formed, which is what the engine would have used anyway.
  assert.deepEqual(levelFor(read(), '15m', bars), { resistance: 86_800, support: 86_200 });
  assert.deepEqual(levelFor(null, '15m', []), { resistance: null, support: null });
});

test('open interest is taken from the window nearest the timeframe’s own bar', () => {
  const rows = [
    { minutes: 5, oiPct: 0.4 }, { minutes: 15, oiPct: 1.1 }, { minutes: 60, oiPct: 2.4 },
  ];
  assert.equal(oiFor(rows, '15m'), 1.1);
  assert.equal(oiFor(rows, '1h'), 2.4);
  assert.equal(oiFor(rows, '4h'), 2.4, 'the nearest there is, when the window asked for is not recorded');
  assert.equal(oiFor([{ minutes: 15, oiPct: null }], '15m'), null);
});

test('the CVD slope is measured over a third of the window, not off its last minute', () => {
  const points = [0, 10, 20, 30, 40, 50, 60].map((cvd) => ({ cvd }));
  // Seven points, so a third back is two: 60 less 40.
  assert.equal(cvdSlopeOf(points), 20);
  assert.equal(cvdSlopeOf([{ cvd: 1 }, { cvd: 2 }]), null, 'too few minutes to have a slope');
});

test('every timeframe the card offers has a length', () => {
  for (const [tf, minutes] of Object.entries(STATE_TF_MINUTES)) {
    assert.ok(minutes > 0, `${tf} has no length`);
  }
});
