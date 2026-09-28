import { describe, expect, it } from 'vitest';
import { aggregate, closedBars, trendTimeline } from './context';
import { runSmc } from './engine';
import type { Bar } from './types';

const T0 = Date.UTC(2026, 8, 21) / 1000;
const b = (t: number, o: number, h: number, l: number, c: number): Bar => ({ time: t, open: o, high: h, low: l, close: c, volume: 1 });

describe('closed candles only', () => {
  it('[critical] drops the candle still forming', () => {
    const bars = [b(T0, 1, 2, 0, 1), b(T0 + 300, 1, 2, 0, 1)];
    expect(closedBars(bars, 300, T0 + 599)).toHaveLength(1);
    expect(closedBars(bars, 300, T0 + 600)).toHaveLength(2);
  });
});

describe('aggregate', () => {
  it('folds whole buckets and leaves a half-built one out', () => {
    const five = Array.from({ length: 5 }, (_, i) => b(T0 + i * 300, 10 + i, 12 + i, 9 + i, 11 + i));
    const out = aggregate(five, 300, 900);
    expect(out).toEqual([{ time: T0, open: 10, high: 14, low: 9, close: 13, volume: 3 }]);
  });
});

describe('trendTimeline', () => {
  it('[critical] a break is not the trend until its candle has closed', () => {
    const rows: [number, number, number, number][] = [
      [100, 102, 99, 101], [101, 104, 100, 103], [103, 106, 102, 105], [105, 110, 104, 106],
      [106, 107, 101, 102], [102, 103, 97, 98], [98, 99, 95, 97], [97, 100, 96, 99], [99, 102, 98, 101],
      [101, 108, 100, 107], [107, 113, 106, 112],
    ];
    const bars = rows.map(([o, h, l, c], i) => b(T0 + i * 3600, o, h, l, c));
    const at = trendTimeline(runSmc(bars, { tfSec: 3600 }), bars, 3600);
    const breakBarClose = T0 + 11 * 3600;
    expect(at(breakBarClose - 1)).toBeNull();
    expect(at(breakBarClose)).toBe('bull');
  });
});
