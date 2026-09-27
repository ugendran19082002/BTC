import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  levelUnder, modeGap, LEVEL_MODE_LABEL, DEFAULT_LEVEL_MODE, LIVE_LEVEL_MODE,
} from '../../src/domain/level-mode.js';
import { levelsFrom, LEVEL_BARS } from '../../src/domain/market-state.js';
import { confirmedBreaks } from '../../src/domain/break-risk.js';
import { measuredFor, LIVE_POLICY } from '../../src/domain/momentum-signal.js';
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

/** A clean peak in the middle: a fractal swing high two bars either side. */
function withSwing(): Candle[] {
  const out: Candle[] = [];
  const shape = [
    84_000, 84_050, 84_100, 84_150, 84_900, 84_200, 84_150, 84_100, 84_050, 84_000,
    83_980, 83_990, 84_010, 84_020, 84_030, 84_040, 84_050, 84_060, 84_070, 84_080,
    84_090, 84_100, 84_110, 84_120, 84_130,
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

describe('the live mode and the measured record cannot drift apart', () => {
  test('[critical] the live mode is one the study has actually graded', () => {
    /*
     * The whole point. If `LIVE_LEVEL_MODE` is changed without re-running
     * `momentum-study.ts` for it, every timeframe loses its measured record and
     * this fails — loudly, here, rather than silently on the screen.
     */
    const graded = (['5m', '15m', '30m', '1h'] as const)
      .map((tf) => measuredFor(tf, LIVE_POLICY, LIVE_LEVEL_MODE))
      .filter((m) => m !== null);
    assert.ok(
      graded.length > 0,
      `No timeframe has a measured record for LIVE_LEVEL_MODE="${LIVE_LEVEL_MODE}". `
      + 'Re-run `npx tsx src/backtest/momentum-study.ts` for that mode, or put the mode back.',
    );
  });

  test('[critical] every measured row it returns says which mode it came from', () => {
    const m = measuredFor('5m', LIVE_POLICY, LIVE_LEVEL_MODE);
    if (!m) return;
    assert.equal(m.mode, LIVE_LEVEL_MODE);
    assert.ok(m.modeLabel.length > 10);
  });

  test('[critical] asking for an ungraded mode returns null, never the other mode\'s row', () => {
    const other = LIVE_LEVEL_MODE === 'rolling' ? 'swing' : 'rolling';
    const m = measuredFor('5m', LIVE_POLICY, other);
    // Either the study graded it too (fine, and it must say so), or null.
    if (m !== null) assert.equal(m.mode, other, 'a row from the wrong mode was returned');
  });

  test('the live mode is the documented default until something is measured to beat it', () => {
    assert.equal(LIVE_LEVEL_MODE, DEFAULT_LEVEL_MODE);
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
