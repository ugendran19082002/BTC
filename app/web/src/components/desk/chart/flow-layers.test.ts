import { describe, expect, it } from 'vitest';
import type { Bar } from '@/lib/smc/types';
import { bigTradeScene, profileScene, volumeProfile } from './flow-layers';

const bar = (time: number, low: number, high: number, volume: number): Bar => ({ time, open: low, high, low, close: high, volume });

describe('the volume profile', () => {
  it('[critical] spreads each candle over its range, and finds the busiest price', () => {
    // Most of the volume trades 100-110; one thin candle runs to 200.
    const bars = [bar(0, 100, 110, 900), bar(300, 100, 110, 900), bar(600, 100, 200, 100)];
    const p = volumeProfile(bars, 0, 2, 10)!;
    expect(p.total).toBe(1_900);
    expect(p.bins.reduce((a, b) => a + b.v, 0)).toBeCloseTo(1_900, 6);
    expect(p.poc).toBeGreaterThanOrEqual(100);
    expect(p.poc).toBeLessThan(110);
    expect(p.val).toBe(100);
  });

  it('[critical] the value area holds at least 70% of the volume, grown from the POC', () => {
    const bars = Array.from({ length: 40 }, (_, i) => bar(i * 300, 100 + (i % 10) * 5, 105 + (i % 10) * 5, i % 10 === 4 ? 1_000 : 100));
    const p = volumeProfile(bars, 0, 39, 20)!;
    const inside = p.bins.filter((b) => b.value).reduce((a, b) => a + b.v, 0);
    expect(inside / p.total).toBeGreaterThanOrEqual(0.7);
    expect(p.vah).toBeGreaterThan(p.poc);
    expect(p.val).toBeLessThan(p.poc);
    // Contiguous: no gap inside the value area.
    const idx = p.bins.map((b, k) => (b.value ? k : -1)).filter((k) => k >= 0);
    expect(idx[idx.length - 1]! - idx[0]! + 1).toBe(idx.length);
  });

  it('reads only the bars asked for, and nothing without volume', () => {
    const bars = [bar(0, 100, 110, 0), bar(300, 500, 510, 50)];
    expect(volumeProfile(bars, 0, 0)).toBeNull();
    expect(volumeProfile(bars, 1, 1)!.val).toBe(500);
  });

  it('draws POC, VAH and VAL as levels from the first bar in view, labelled with the price', () => {
    const p = volumeProfile([bar(0, 100, 110, 10), bar(300, 105, 120, 10)], 0, 1, 10)!;
    const items = profileScene(p, 7.4);
    expect(items[0]!.t).toBe('profile');
    const labels = items.flatMap((i) => (i.t === 'line' ? [[i.x1, i.label]] : []));
    expect(labels.map(([x]) => x)).toEqual([7, 7, 7]);
    expect(labels.map(([, l]) => String(l).split(' ')[0])).toEqual(['POC', 'VAH', 'VAL']);
  });
});

describe('big trades', () => {
  const bars = [bar(1_000, 100, 110, 1), bar(1_300, 100, 110, 1), bar(1_600, 100, 110, 1)];

  it('[critical] puts each order on its candle, across it by the time within, coloured by the aggressor', () => {
    const items = bigTradeScene([
      { at: 1_000_000, side: 'buy', price: 105, size: 500 },   // the first candle's open
      { at: 1_450_000, side: 'sell', price: 101, size: 500 },  // halfway through the second
    ], bars, 300, 500);
    expect(items.map((i) => (i.t === 'bubble' ? [i.x, i.y, i.side] : null))).toEqual([[-0.5, 105, 'buy'], [1, 101, 'sell']]);
  });

  it('[critical] leaves out what is under the filter and what is off the chart', () => {
    const items = bigTradeScene([
      { at: 1_100_000, side: 'buy', price: 105, size: 499 },
      { at: 900_000, side: 'buy', price: 105, size: 5_000 },
      { at: 1_900_000, side: 'buy', price: 105, size: 5_000 },
      { at: 1_700_000, side: 'buy', price: 105, size: 500 },
    ], bars, 300, 500);
    expect(items).toHaveLength(1);
  });

  it('a bigger order is a bigger bubble, and only the biggest few carry their size', () => {
    const trades = [500, 1_000, 4_000, 8_000].map((size, k) => ({ at: 1_000_000 + k * 1_000, side: 'buy' as const, price: 105, size }));
    const items = bigTradeScene(trades, bars, 300, 500).flatMap((i) => (i.t === 'bubble' ? [i] : []));
    const r = items.map((i) => i.r);
    expect([...r].sort((a, b) => a - b)).toEqual(r);
    expect(items.map((i) => i.label ?? null)).toEqual([null, 'Buy 1.0 BTC', 'Buy 4.0 BTC', 'Buy 8.0 BTC']);
  });
});
