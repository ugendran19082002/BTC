import { describe, expect, it } from 'vitest';
import type { PriceChange } from '@/api/desk';
import { points, priceMoves, signedPct, signedPoints, windowLabel } from '@/lib/price-change';

const row = (minutes: number | null, then: number | null, now = 83_774, mark: PriceChange['mark'] = null): PriceChange =>
  ({ minutes, mark, at: 1_000, then, pts: then === null ? null : now - then, pct: then === null ? null : (now / then - 1) * 100 });

describe('price changes on the phone', () => {
  it('[critical] each window says from what, to what, how far and which way; the marks come apart from the windows', () => {
    const { windows, marks } = priceMoves({ spot: 83_774, rows: [row(1, 83_785), row(30, 84_991), row(240, 83_500), row(null, 84_254, 83_774, 'entry'), row(null, 86_211, 83_774, 'dayStart')] });
    expect(windows.map((m) => [m.label, m.from, m.to, Math.round(m.pts!), m.way])).toEqual([['1m', 83_785, 83_774, -11, 'down'], ['30m', 84_991, 83_774, -1_217, 'down'], ['4h', 83_500, 83_774, 274, 'up']]);
    expect(marks.map((m) => [m.label, m.from, m.way])).toEqual([['Since entry', 84_254, 'down'], ['Last settlement', 86_211, 'down']]);
    // the bars: each move against the largest on the screen, the settlement's 2,437
    expect(marks[1]!.share).toBe(1);
    expect(windows[1]!.share).toBeCloseTo(1_217 / 2_437, 6);
    expect(new Set([...windows, ...marks].map((m) => m.key)).size).toBe(5);
  });

  it('where the candles do not reach there is no figure, no bar, and no way', () => {
    const { windows } = priceMoves({ spot: 83_774, rows: [row(720, null), row(5, 83_774.3)] });
    expect(windows[0]).toMatchObject({ from: null, to: 83_774, pts: null, pct: null, way: 'flat', share: 0 });
    // under half a point is no move to speak of
    expect(windows[1]!.way).toBe('flat');
  });

  it('nothing read yet: no rows', () => {
    expect(priceMoves(null)).toEqual({ windows: [], marks: [] });
    expect(priceMoves({ spot: null, rows: [] })).toEqual({ windows: [], marks: [] });
  });

  it('the words and the figures', () => {
    expect([1, 5, 30, 60, 120, 720].map((m) => windowLabel({ minutes: m, mark: null }))).toEqual(['1m', '5m', '30m', '1h', '2h', '12h']);
    expect(points(83_774.4)).toBe('83,774');
    expect(points(null)).toBe('—');
    expect(signedPoints(-1_216.7)).toBe('−1,217');
    expect(signedPoints(274.2)).toBe('+274');
    expect(signedPoints(-0.3)).toBe('0');
    expect(signedPct(-1.4321)).toBe('−1.43%');
    expect(signedPct(0.004)).toBe('0.00%');
    expect(signedPct(null)).toBe('—');
  });
});
