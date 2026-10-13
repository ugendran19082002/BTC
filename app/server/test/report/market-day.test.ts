import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PATTERNS, RULES, candles, classify, dayStats, sessionDayOf, sessionDays, sessionOf, zigzagOf, type MinuteBar } from '../../src/report/market-day.js';

/**
 * An expiry day's figures and its name (13 Oct 2026): the day's bounds, the zigzag, the ATR and its place among
 * the days before, and each family of names on a day drawn to be that shape. The shapes are drawn, not sampled:
 * a path through a few points, a small steady wobble on it, a minute at a time.
 */

const IST = 5.5 * 3_600_000;
const at = (iso: string) => Date.parse(`${iso}+05:30`);

/** A whole expiry day (1,440 minutes) along a path of [share of the day, price]; `wobble` is the size of the minute-to-minute noise. */
function day(path: [number, number][], wobble = 8, minutes = 1_440): MinuteBar[] {
  const from = sessionOf('2026-10-07').from;
  const bars: MinuteBar[] = [];
  for (let i = 0; i < minutes; i++) {
    const x = i / (minutes - 1);
    let k = 0;
    while (k < path.length - 2 && x > path[k + 1]![0]) k++;
    const [x0, p0] = path[k]!, [x1, p1] = path[k + 1]!;
    const mid = p0 + (p1 - p0) * (x1 === x0 ? 1 : Math.min(1, Math.max(0, (x - x0) / (x1 - x0))));
    const close = mid + wobble * Math.sin(i * 1.7);
    bars.push({ at: from + i * 60_000, high: close + wobble / 2, low: close - wobble / 2, close });
  }
  return bars;
}
const named = (path: [number, number][], wobble?: number, prior: number[] = []) => {
  const s = dayStats(day(path, wobble), prior)!;
  return { s, ...classify(s) };
};

test('[critical] an expiry day runs from 5:30 PM IST to 5:30 PM IST, and is named for the day it ends on', () => {
  const s = sessionOf('2026-10-13');
  assert.equal(s.from, at('2026-10-12T17:30:00'));
  assert.equal(s.to, at('2026-10-13T17:30:00'));
  assert.equal(s.to - s.from, 86_400_000);
  assert.equal(sessionDayOf(at('2026-10-12T17:30:00')), '2026-10-13', 'the settlement minute opens the next day');
  assert.equal(sessionDayOf(at('2026-10-12T17:29:59')), '2026-10-12');
  assert.equal(sessionDayOf(at('2026-10-13T00:10:00')), '2026-10-13', 'after midnight it is still the same expiry');
  assert.equal(sessionDayOf(at('2026-10-13T17:29:00')), '2026-10-13');
  assert.deepEqual(sessionDays('2026-09-29', '2026-10-02'), ['2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02']);
  assert.equal(IST, 19_800_000);
});

test('the twenty names: the owner\'s own numbers, each once, each in a family', () => {
  assert.deepEqual(PATTERNS.map((p) => p.id), Array.from({ length: 20 }, (_, i) => i + 1));
  assert.equal(new Set(PATTERNS.map((p) => p.key)).size, 20);
  assert.equal(PATTERNS.find((p) => p.id === 16)!.key, 'REVERSAL_ZIGZAG');
  assert.equal(PATTERNS.find((p) => p.id === 20)!.meaning, 'Sudden large movement');
  assert.ok(PATTERNS.every((p) => ['up', 'down', 'range', 'turn'].includes(p.family)));
});

test('candles open where the one before closed, and hold the minutes\' highs and lows', () => {
  const t0 = at('2026-10-12T17:30:00');
  const c = candles([
    { at: t0, high: 101, low: 99, close: 100 }, { at: t0 + 60_000, high: 105, low: 100, close: 104 },
    { at: t0 + 300_000, high: 108, low: 103, close: 107 },
  ], 300);
  assert.deepEqual(c, [{ at: t0, open: 100, high: 105, low: 99, close: 104 }, { at: t0 + 300_000, open: 104, high: 108, low: 103, close: 107 }]);
});

test('[critical] the zigzag: a turn is counted only when the price comes the threshold back from the leg\'s extreme', () => {
  const p = (xs: number[]) => xs.map((price, i) => ({ at: i, price }));
  // up 300, a dip of 90 (not a turn at 100), on to 400, down 250 (a turn), up 120 to the end
  assert.deepEqual(zigzagOf(p([0, 150, 300, 210, 400, 300, 150, 270]), 100), [[0, 0], [4, 400], [6, 150], [7, 270]]);
  assert.deepEqual(zigzagOf(p([10, 12, 9, 11]), 100), [[0, 10], [3, 11]], 'nothing reaches the threshold: one leg, open to close');
  assert.deepEqual(zigzagOf([], 100), []);
});

test('[critical] the figures: high and low with their points, the range, the net, and the zigzag\'s total', () => {
  // 84,000 up to 85,000, back to 84,400, up to 85,600: three legs of 1,000, 600 and 1,200
  const s = dayStats(day([[0, 84_000], [0.4, 85_000], [0.6, 84_400], [1, 85_600]], 0))!;
  assert.equal(s.bars, 1_440);
  assert.equal(s.open, 84_000); assert.equal(s.close, 85_600);
  assert.equal(s.high, 85_600); assert.equal(s.low, 84_000);
  assert.equal(s.rangePts, 1_600); assert.equal(s.netPts, 1_600);
  assert.ok(Math.abs(s.rangePct - 1_600 / 84_000) < 1e-4);
  assert.equal(s.upPts, 1_600); assert.equal(s.downPts, 0);
  assert.equal(s.dirShare, 1);
  assert.equal(s.zigzag.thresholdPts, 210, '0.25% of the open');
  assert.equal(s.zigzag.swings, 2, 'two turns: three legs');
  assert.ok(Math.abs(s.zigzag.totalPts - 2_800) < 60, `the path walked: ${s.zigzag.totalPts}`);
  assert.ok(Math.abs(s.zigzag.maxDownPts - 600) < 30 && Math.abs(s.zigzag.maxUpPts - 1_200) < 30);
  assert.ok(Math.abs(s.pathRatio - 1.75) < 0.05);
  assert.ok(Math.abs(s.counterShare - 0.375) < 0.02, 'the 600-pt pullback over the 1,600 range');
  assert.equal(s.line.length, 48, 'the day as 48 half-hour closes');
  assert.equal(dayStats(day([[0, 84_000], [1, 84_100]], 0, 59)), null, 'under an hour of tape is not a day');
});

test('[critical] ATR, its percentile among the days before, volatility expansion and candle expansion', () => {
  // a steady climb of 960 pts: every 15-minute candle the same 10 pts
  const calm = dayStats(day([[0, 84_000], [1, 84_960]], 0))!;
  assert.ok(Math.abs(calm.atr - 10) < 0.5, `ATR ${calm.atr}`);
  assert.ok(Math.abs(calm.candleExpansion - 1) < 0.1, 'no candle stands out');
  assert.equal(calm.atrPercentile, null); assert.equal(calm.volExpansion, null, 'no days before: nothing to rank it against');
  assert.equal(dayStats(day([[0, 84_000], [1, 84_960]], 0), [5, 6, 7, 8])!.atrPercentile, null, 'four days before are too few');
  const ranked = dayStats(day([[0, 84_000], [1, 84_960]], 0), [4, 6, 8, 12, 14, 16, 20, 20, 5, 5])!;
  assert.equal(ranked.atrPercentile, 50, 'five of the ten days before had an ATR at or under it');
  assert.ok(Math.abs(ranked.volExpansion! - 10 / ((16 + 20 + 20 + 5 + 5) / 5)) < 0.01, 'against the mean of the five days before');
  // the same climb with one 15-minute candle of 600 pts in it
  const jolt = dayStats(day([[0, 84_000], [0.5, 84_480], [0.5 + 15 / 1_440, 85_080], [1, 85_560]], 0))!;
  assert.ok(jolt.candleExpansion > 20, `the candle is many times a usual one: ${jolt.candleExpansion}`);
  assert.ok(jolt.bigCandle.pts > 500 && jolt.bigCandle.up);
});

test('[critical] trend days: clean, zigzag and high zigzag by the pullbacks -- up and down alike', () => {
  const clean = named([[0, 84_000], [1, 85_500]]);
  assert.equal(clean.key, 'UP_TREND_CLEAN', clean.why);
  assert.match(clean.why, /Closed 1,5\d\d pts up \(1\.\d\d%\)/);
  const pullbacks = named([[0, 84_000], [0.3, 85_000], [0.45, 84_400], [0.75, 85_600], [0.85, 85_100], [1, 85_900]]);
  assert.equal(pullbacks.key, 'UP_TREND_ZIGZAG', pullbacks.why);
  const wild = named([[0, 84_000], [0.2, 85_400], [0.4, 84_100], [0.6, 85_500], [0.8, 84_500], [1, 85_600]]);
  assert.equal(wild.key, 'UP_TREND_HIGH_ZIGZAG', wild.why);
  assert.equal(named([[0, 85_500], [1, 84_000]]).key, 'DOWN_TREND_CLEAN');
  assert.equal(named([[0, 85_900], [0.3, 84_900], [0.45, 85_500], [0.75, 84_300], [0.85, 84_800], [1, 84_000]]).key, 'DOWN_TREND_ZIGZAG');
  assert.equal(named([[0, 85_600], [0.2, 84_200], [0.4, 85_500], [0.6, 84_100], [0.8, 85_100], [1, 84_000]]).key, 'DOWN_TREND_HIGH_ZIGZAG');
});

test('[critical] a trend that pauses, one that breaks on, and one that loses strength', () => {
  const paused = named([[0, 84_000], [0.5, 85_500], [1, 85_450]]);
  assert.equal(paused.key, 'UPTREND_RANGE', paused.why);
  assert.equal(named([[0, 85_500], [0.5, 84_000], [1, 84_050]]).key, 'DOWNTREND_RANGE');
  const brokeOn = named([[0, 84_000], [0.3, 84_600], [0.36, 84_560], [0.66, 84_640], [1, 85_500]]);
  assert.equal(brokeOn.key, 'UPTREND_BREAKOUT', brokeOn.why);
  assert.equal(named([[0, 85_500], [0.3, 84_900], [0.36, 84_940], [0.66, 84_860], [1, 84_000]]).key, 'DOWNTREND_BREAKDOWN');
  const tired = named([[0, 84_000], [0.6, 86_000], [1, 85_100]]);
  assert.equal(tired.key, 'TREND_EXHAUSTION', tired.why);
  assert.match(tired.why, /gave 4\d% of it back/);
});

test('[critical] the events: a tight start that breaks, and one candle that is most of the day', () => {
  const squeeze = named([[0, 84_000], [0.3, 84_150], [0.6, 84_050], [0.8, 85_300], [1, 85_600]]);
  assert.equal(squeeze.key, 'COMPRESSION_BREAKOUT', squeeze.why);
  // 540 minutes in is a 15-minute boundary: the whole fall is one candle
  const spike = named([[0, 84_000], [0.375, 84_100], [0.375 + 15 / 1_440, 82_700], [0.7, 83_400], [1, 83_900]]);
  assert.equal(spike.key, 'VOLATILITY_SPIKE', spike.why);
  assert.ok(spike.s.bigCandle.pctOfPrice >= RULES.spikeCandlePct && !spike.s.bigCandle.up);
});

test('[critical] days that end near where they began: low volatility, reversal, failed break, wide, choppy, zigzag, clean', () => {
  // quiet: ranked against the days before when there are enough, by its own narrow range when there are not
  const busy = [200, 210, 190, 220, 230, 205, 215];
  assert.equal(named([[0, 84_000], [0.5, 84_250], [1, 84_050]], 4, busy).key, 'RANGE_LOW_VOLATILITY');
  assert.equal(named([[0, 84_000], [0.5, 84_250], [1, 84_050]], 4).key, 'RANGE_LOW_VOLATILITY', 'no days before: a range under 1.2% of the price');
  const lively = [2, 3, 2, 3, 2, 3];
  const v = named([[0, 84_000], [0.5, 81_700], [1, 84_100]], 8, lively);
  assert.equal(v.key, 'REVERSAL_ZIGZAG', v.why);
  assert.match(v.why, /Went 2,3\d\d pts down from the open, turned/);
  const failed = named([[0, 84_000], [0.15, 84_900], [0.3, 84_100], [0.6, 85_300], [1, 84_500]], 8, lively);
  assert.equal(failed.key, 'FALSE_BREAKOUT_RANGE', failed.why);
  const wide = named([[0, 85_000], [0.25, 86_300], [0.5, 83_900], [0.75, 86_200], [1, 84_700]], 8, lively);
  assert.equal(wide.key, 'RANGE_WIDE_ZIGZAG', wide.why);
  const zig = (turns: number, amp: number): [number, number][] => Array.from({ length: turns + 1 }, (_, i) => [i / turns, 84_000 + (i % 2 ? amp : 0)] as [number, number]);
  assert.equal(named(zig(8, 1_200), 8, lively).key, 'SIDEWAYS_CHOPPY');
  assert.equal(named(zig(4, 1_200), 8, lively).key, 'RANGE_ZIGZAG');
  assert.equal(named([[0, 84_000], [0.25, 85_300], [1, 84_200]], 8, lively).key, 'RANGE_CLEAN');
});
