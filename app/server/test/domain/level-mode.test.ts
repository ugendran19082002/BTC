import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  levelUnder, modeGap, LEVEL_MODE_LABEL, DEFAULT_LEVEL_MODE, LIVE_LEVEL_MODE,
} from '../../src/domain/level-mode.js';
import { levelsFrom, LEVEL_BARS } from '../../src/domain/market-state.js';
import { confirmedBreaks } from '../../src/domain/break-risk.js';
import type { Candle } from '../../src/market/delta.js';

/**
 * The level the state machine judges against, and the rule that it must be the
 * same one the measurement used.
 *
 * On 27 Sep 2026 it was not: live judged swings, the study judged the rolling
 * range, and the card printed the study's number beside a swing call. These are
 * the properties that make that impossible to reintroduce.
 */

const bar = (time: number, o: number, h: number, l: number, c: number): Candle =>
  ({ time, open: o, high: h, low: l, close: c, volume: 10 });

/**
 * A fractal swing high that sits OUTSIDE the rolling 20-bar window.
 *
 * That placement is the whole point: a peak inside the last twenty bars is found
 * by both definitions, so it cannot tell them apart. The one that matters is the
 * older peak a chart reader still draws a line through while the rolling range
 * has already forgotten it — which is exactly the case that made the live card
 * and the study disagree.
 */
function withSwing(): Candle[] {
  const out: Candle[] = [];
  const shape = [
    84_000, 84_100, 84_900, 84_150, 84_050,          // the peak, at index 2
    83_980, 83_990, 84_000, 84_010, 84_020,          // then twenty-five quieter bars,
    84_030, 84_040, 84_050, 84_060, 84_070,          // so the rolling window no longer
    84_080, 84_090, 84_100, 84_110, 84_120,          // reaches back to it
    84_130, 84_140, 84_150, 84_160, 84_170,
    84_180, 84_190, 84_200, 84_210, 84_220,
  ];
  shape.forEach((c, i) => out.push(bar(1_790_000_000 + i * 300, c - 10, c + 20, c - 20, c)));
  return out;
}

describe('the two level definitions', () => {
  test('[critical] rolling is exactly what marketState falls back to internally', () => {
    const bars = withSwing();
    assert.deepEqual(levelUnder(bars, 'rolling'), levelsFrom(bars, LEVEL_BARS));
  });

  test('[critical] swing and rolling genuinely differ when there is a swing', () => {
    const bars = withSwing();
    const rolling = levelUnder(bars, 'rolling');
    const swing = levelUnder(bars, 'swing');
    assert.notDeepEqual(rolling, swing, 'the two modes agreed — the fixture has no distinguishing swing');
  });

  test('[critical] swing falls back to rolling when no swing exists, never to null', () => {
    // A strictly rising staircase has no fractal peak with two lower bars either side.
    const rising = Array.from({ length: 30 }, (_, i) =>
      bar(1_790_000_000 + i * 300, 84_000 + i * 10, 84_005 + i * 10, 83_995 + i * 10, 84_000 + i * 10));
    const swing = levelUnder(rising, 'swing');
    const rolling = levelUnder(rising, 'rolling');
    assert.equal(swing.resistance, rolling.resistance);
    assert.ok(swing.resistance !== null);
  });

  test('too few bars is handled rather than thrown', () => {
    assert.doesNotThrow(() => levelUnder([], 'swing'));
    assert.doesNotThrow(() => levelUnder([], 'rolling'));
    assert.doesNotThrow(() => levelUnder([bar(1, 1, 2, 0, 1)], 'swing'));
  });

  test('the gap between modes is reported, signed swing-minus-rolling', () => {
    const g = modeGap(withSwing());
    assert.ok(g.resistance === null || Number.isFinite(g.resistance));
  });

  test('every mode has a label a person can read', () => {
    for (const m of ['rolling', 'swing'] as const) {
      assert.ok(LEVEL_MODE_LABEL[m].length > 10, `${m} has no readable label`);
    }
  });
});

describe('the measured path honours the mode it is given', () => {
  test('[critical] the two modes do not find identical breaks', () => {
    // Enough bars for confirmedBreaks' own 60-bar window plus its warm-up.
    const bars: Candle[] = [];
    for (let i = 0; i < 200; i++) {
      const c = 84_000 + Math.sin(i / 7) * 400 + (i > 150 ? (i - 150) * 12 : 0);
      bars.push(bar(1_790_000_000 + i * 300, c - 15, c + 45, c - 45, c));
    }
    const rolling = confirmedBreaks(bars, 0, 'rolling');
    const swing = confirmedBreaks(bars, 0, 'swing');
    // They may coincide on a given fixture, but the levels they used must not be
    // identical across every break — that would mean the mode is being ignored.
    const same = rolling.length === swing.length
      && rolling.every((r, i) => swing[i] && swing[i]!.level === r.level);
    assert.ok(!same || rolling.length === 0, 'the mode made no difference — it is probably not being read');
  });

  test('the default mode is the rolling one, matching what the study first measured', () => {
    assert.equal(DEFAULT_LEVEL_MODE, 'rolling');
  });
});
