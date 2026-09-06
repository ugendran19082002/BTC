import { test } from 'node:test';
import assert from 'node:assert/strict';
import { directionalLean, MIN_LOTS_PER_SIDE, MAX_LOTS_PER_SIDE, SKEW_THRESHOLD_PCT } from '../src/recommend.js';
import { summarize, type TradeDay } from '../src/backtest.js';
import { maxLots } from '../src/score.js';
import type { MarketRead, TimeframeRead } from '../src/market.js';

function marketWith(return24h: number, ema9: number, ema21: number): MarketRead {
  const daily: TimeframeRead = {
    tf: '1d', bars: 200, close: 80_000, ema9, ema21, ema50: null,
    rsi14: 50, atrPct: 2, trend: ema9 > ema21 ? 1 : -1,
    label: ema9 > ema21 ? 'rising' : 'falling',
  };
  return {
    spot: 80_000, return24h, dailyRsiPrior: 50, timeframes: [daily],
    agreement: daily.trend, regime: 'mixed', realisedVol: 50,
    moves: [], max24hRangeUsd: null, max24hRangePct: null,
  };
}

test('a big move leans on its own, without needing the trend to agree', () => {
  assert.equal(directionalLean(marketWith(3, 100, 200)).lean, 1, 'up 3% leans up');
  assert.equal(directionalLean(marketWith(-3, 200, 100)).lean, -1, 'down 3% leans down');
});

test('a small move only leans when the daily trend agrees with it', () => {
  assert.equal(directionalLean(marketWith(0.5, 200, 100)).lean, 1, 'small up + rising');
  assert.equal(directionalLean(marketWith(0.5, 100, 200)).lean, 0, 'small up + falling');
  assert.equal(directionalLean(marketWith(-0.5, 100, 200)).lean, -1, 'small down + falling');
  assert.equal(directionalLean(marketWith(-0.5, 200, 100)).lean, 0, 'small down + rising');
});

test('exactly at the threshold the trend still has to agree', () => {
  const at = SKEW_THRESHOLD_PCT;
  assert.equal(directionalLean(marketWith(at, 100, 200)).lean, 0, 'at the line, trend disagrees');
  assert.equal(directionalLean(marketWith(at + 0.01, 100, 200)).lean, 1, 'just past it, alone');
});

test('no market data means no lean, not a guess', () => {
  assert.equal(directionalLean(null).lean, 0);
});

test('every lean carries a reason a person can read', () => {
  for (const m of [marketWith(3, 100, 200), marketWith(0.5, 200, 100), marketWith(0, 100, 200)]) {
    const { reason } = directionalLean(m);
    assert.ok(reason.length > 20, 'reason should be a sentence');
    assert.ok(/24 hours/.test(reason), 'reason should name its input');
  }
});

test('one side can never carry the whole book', () => {
  assert.ok(MIN_LOTS_PER_SIDE >= 1);
  assert.ok(MAX_LOTS_PER_SIDE < 10, 'a ten-lot book must not all land on one side');
  assert.ok(MIN_LOTS_PER_SIDE < MAX_LOTS_PER_SIDE);
});

const day = (date: string, pnlUsd: number, cum: number): TradeDay => ({
  date, weekday: 1, spot: 80_000, settle: 80_000, legs: [],
  pnlUsd, pnlInr: pnlUsd * 85, cum,
});

test('the summary counts wins, losses and the worst day correctly', () => {
  const s = summarize([day('2025-01-01', 1, 1), day('2025-01-02', -3, -2), day('2025-01-03', 2, 0)]);
  assert.equal(s.days, 3);
  assert.equal(s.wins, 2);
  assert.equal(s.losses, 1);
  assert.equal(s.worstDayUsd, -3);
  assert.equal(s.worstDate, '2025-01-02');
  assert.equal(s.totalUsd, 0);
});

test('drawdown is measured from the peak, not from zero', () => {
  // up to 10, down to 4, back to 7: the drawdown is 6, not 3
  const s = summarize([day('a', 10, 10), day('b', -6, 4), day('c', 3, 7)]);
  assert.equal(s.maxDrawdownUsd, 6);
});

test('a run with no losses reports an infinite profit factor, not a divide by zero', () => {
  const s = summarize([day('a', 1, 1), day('b', 2, 3)]);
  assert.equal(s.profitFactor, Infinity);
  assert.equal(s.grossLoss, 0);
});

test('an empty run does not throw', () => {
  const s = summarize([]);
  assert.equal(s.days, 0);
  assert.equal(s.winPct, 0);
  assert.equal(s.totalUsd, 0);
});

test('rupees track dollars at the stated rate', () => {
  const s = summarize([day('a', 2, 2)]);
  assert.equal(s.totalInr, 170); // 1 USD = 85 INR
});

test('sizing floors rather than rounds, so margin is never overcommitted', () => {
  assert.equal(maxLots(10), 20);
  assert.equal(maxLots(10.4), 20);
  assert.equal(maxLots(0.4), 0);
});

import { allocateLots } from '../src/recommend.js';

test('the two sides always add up to exactly the lots you asked for', () => {
  for (const total of [1, 2, 3, 5, 7, 10, 13, 20, 100]) {
    for (const [wc, wp] of [[0.5, 0.5], [0.3, 0.7], [0.7, 0.3], [0.2, 0.8]] as const) {
      const { ce, pe } = allocateLots(total, wc, wp);
      assert.equal(ce + pe, total, `${total} lots at ${wc}/${wp} became ${ce}+${pe}`);
      assert.ok(ce >= 0 && pe >= 0, 'no negative side');
    }
  }
});

test('a ten lot book at 30/70 is three and seven', () => {
  assert.deepEqual(allocateLots(10, 0.3, 0.7), { ce: 3, pe: 7 });
  assert.deepEqual(allocateLots(10, 0.7, 0.3), { ce: 7, pe: 3 });
  assert.deepEqual(allocateLots(10, 0.5, 0.5), { ce: 5, pe: 5 });
});

test('the per-side cap moves a lot across, it does not create one', () => {
  const { ce, pe } = allocateLots(20, 0.05, 0.95);
  assert.equal(ce + pe, 20, 'total preserved');
  assert.ok(ce >= 2, 'the thin side still gets the floor');
});

test('tiny books do not break the floor rule', () => {
  assert.equal(allocateLots(1, 0.3, 0.7).ce + allocateLots(1, 0.3, 0.7).pe, 1);
  assert.equal(allocateLots(2, 0.3, 0.7).ce + allocateLots(2, 0.3, 0.7).pe, 2);
  assert.deepEqual(allocateLots(0, 0.5, 0.5), { ce: 0, pe: 0 });
});
