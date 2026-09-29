import { describe, expect, it } from 'vitest';
import type { Bar } from '@/lib/smc/types';
import { runTrend } from '@/lib/trend/breakout';
import { trendScene } from './trend-layer';

const H = 3600;
const hbar = (i: number, close: number): Bar => ({ time: i * H, open: close, high: close + 10, low: close - 10, close, volume: 1 });
/** 30 flat hours, then a breakout that is still running. */
const hours = [...Array.from({ length: 30 }, (_, i) => hbar(i, 100)), ...Array.from({ length: 6 }, (_, i) => hbar(30 + i, 120 + i * 15))];
/** The chart's 5m candles over the last 12 hours. */
const bars: Bar[] = Array.from({ length: 144 }, (_, k) => ({ time: 24 * H + k * 300, open: 150, high: 160, low: 140, close: 150, volume: 1 }));

describe('the trend plan on the chart', () => {
  it('[critical] the open trade: entry, initial stop and trail, placed at the 1H close that made them, as lines only', () => {
    const st = runTrend(hours);
    expect(st.open).not.toBeNull();
    const items = trendScene(st, hours, H, bars);
    expect(items.every((i) => i.t === 'line' || i.t === 'path')).toBe(true);
    const entry = items.find((i) => i.t === 'line' && i.label?.startsWith('TREND LONG'));
    expect(entry?.t === 'line' && entry.x1).toBe((31 * H - 24 * H) / 300); // the close of the 30th hour
    expect(entry?.t === 'line' && entry.label).toContain('1H breakout');
    expect(items.some((i) => i.t === 'line' && i.label?.startsWith('Trend stop'))).toBe(true);
    expect(items.some((i) => i.t === 'line' && i.label?.startsWith('Trend trail'))).toBe(true);
  });

  it('draws nothing before the chart starts, and nothing without candles', () => {
    expect(trendScene(runTrend(hours), hours, H, [])).toEqual([]);
    const items = trendScene(runTrend(hours), hours, H, bars);
    for (const i of items) {
      if (i.t === 'path') for (const [x] of i.points) expect(x).toBeGreaterThanOrEqual(0);
    }
  });
});
