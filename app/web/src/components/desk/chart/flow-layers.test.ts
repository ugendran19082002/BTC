import { describe, expect, it } from 'vitest';
import type { Bar } from '@/lib/smc/types';
import { bigTradeScene, deltaSeries, flowRead, heatScene, profileScene, volumeProfile } from './flow-layers';

const bar = (time: number, low: number, high: number, volume: number): Bar => ({ time, open: low, high, low, close: high, volume });

describe('the book heatmap', () => {
  const bars = [bar(1_000, 100, 110, 1), bar(1_300, 100, 110, 1), bar(1_600, 100, 110, 1)];

  it('[critical] puts each column on the candle it belongs to, none where there is no candle, colour capped at the 95th percentile', () => {
    const cells = (n: number) => Array.from({ length: n }, (_, k) => [k, k + 1] as [number, number]);
    const items = heatScene([{ time: 1_300, cells: cells(20) }, { time: 9_999, cells: [[1, 5_000]] }], 25, [], bars, 300);
    const heat = items.find((i) => i.t === 'heat');
    expect(heat?.t === 'heat' && heat.cols.map((c) => c.x)).toEqual([1]);
    expect(heat?.t === 'heat' && heat.cap).toBe(20);
  });

  it('[critical] draws each persistent wall from where it began, labelled with side, price, size and how long', () => {
    const items = heatScene([], 25, [{ side: 'ask', price: 84_212.5, size: 12_400, minutes: 10 }], bars, 300);
    const line = items.find((i) => i.t === 'line');
    expect(line?.t === 'line' && [line.x1, line.x2, line.y]).toEqual([0, 'right', 84_212.5]);
    expect(line?.t === 'line' && line.label).toBe('Ask wall 84,213 · 12 BTC · 10m');
  });
});

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
    const one = volumeProfile(bars, 1, 1)!;
    expect(one.total).toBe(50);
    expect(one.val).toBeGreaterThanOrEqual(500);
    expect(one.vah).toBeLessThanOrEqual(510);
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

  it('[critical] puts each order on its candle at its price, coloured by the aggressor', () => {
    const items = bigTradeScene([
      { at: 1_000_000, side: 'buy', price: 105, size: 500 },   // the first candle's open
      { at: 1_450_000, side: 'sell', price: 101, size: 500 },  // halfway through the second
    ], bars, 300, 500);
    expect(items.map((i) => (i.t === 'bubble' ? [i.x, i.y, i.side] : null))).toEqual([[0, 105, 'buy'], [1, 101, 'sell']]);
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

  it('[critical] size is relative: area in proportion to the biggest shown, which is full size; largest drawn first', () => {
    const trades = [500, 1_000, 4_000].map((size, k) => ({ at: (1_000 + k * 300) * 1_000, side: 'buy' as const, price: 105, size }));
    const items = bigTradeScene(trades, bars, 300, 500).flatMap((i) => (i.t === 'bubble' ? [i] : []));
    expect(items.map((i) => i.rel)).toEqual([4_000, 1_000, 500].map((s) => Math.sqrt(s / 4_000)));
    expect(items.map((i) => i.label?.split(' · ')[0] ?? null)).toEqual(['Buy 4.0 BTC', 'Buy 1.0 BTC', null]);
  });

  it('[critical] a candle\'s big buys are one bubble and its big sells another, with total, count, price range and dollars', () => {
    const items = bigTradeScene([
      { at: 1_000_000, side: 'buy', price: 110, size: 600 },
      { at: 1_010_000, side: 'buy', price: 110.02, size: 900 },
      { at: 1_020_000, side: 'sell', price: 110.01, size: 700 },
      { at: 1_030_000, side: 'buy', price: 104, size: 500 },
    ], bars, 300, 500).flatMap((i) => (i.t === 'bubble' ? [i] : []));
    expect(items).toHaveLength(2);
    const merged = items.find((i) => i.side === 'buy')!;
    expect(merged.y).toBeCloseTo((600 * 110 + 900 * 110.02 + 500 * 104) / 2_000, 6);
    expect(merged.tip).toContain('2.0 BTC');
    expect(merged.tip).toContain('3 orders');
    expect(merged.tip).toContain('(104–110)');
    expect(merged.tip).toContain('$');
  });
});

describe('volume nodes', () => {
  it('[critical] finds a thin area between two areas of acceptance, and a second peak apart from the POC', () => {
    // Two humps -- 100-110 heavy, 130-140 lighter -- with almost nothing traded between.
    const bars = [
      ...Array.from({ length: 10 }, (_, i) => bar(i * 300, 100, 110, 1_000)),
      ...Array.from({ length: 6 }, (_, i) => bar((10 + i) * 300, 130, 140, 1_000)),
      bar(16 * 300, 110, 130, 20),
    ];
    const p = volumeProfile(bars, 0, 16, 40)!;
    expect(p.poc).toBeLessThan(110);
    expect(p.hvn.some((h) => h > 130 && h < 140)).toBe(true);
    expect(p.lvn.length).toBeGreaterThan(0);
    expect(p.lvn[0]!).toBeGreaterThan(110);
    expect(p.lvn[0]!).toBeLessThan(130);
  });

  it('labels the low-volume node nearest the last price', () => {
    const bars = [
      ...Array.from({ length: 10 }, (_, i) => bar(i * 300, 100, 110, 1_000)),
      ...Array.from({ length: 6 }, (_, i) => bar((10 + i) * 300, 130, 140, 1_000)),
      bar(16 * 300, 110, 130, 20),
    ];
    const p = volumeProfile(bars, 0, 16, 40)!;
    const lines = profileScene(p, 0, 125).flatMap((i) => (i.t === 'line' ? [i.label ?? ''] : []));
    expect(lines.some((l) => l.startsWith('LVN '))).toBe(true);
  });
});

describe('delta and CVD', () => {
  const day = 1_790_000_000 - (1_790_000_000 % 86_400); // a UTC midnight
  const fb = (time: number, buy: number, sell: number, minutes = 5, trades = 10) => ({ time, buy, sell, trades, minutes });

  it('[critical] delta is taker buying minus selling; CVD runs through the UTC day and starts again at midnight', () => {
    const { delta, cvd } = deltaSeries([fb(day - 600, 10, 0), fb(day - 300, 0, 4), fb(day, 3, 1), fb(day + 300, 1, 2)], 300, day + 10_000);
    expect(delta.map((d) => d.value)).toEqual([10, -4, 2, -1]);
    expect(cvd.map((c) => c.value)).toEqual([10, 6, 2, 1]);
  });

  it('[critical] a candle with minutes missing is drawn faded, not as a full reading', () => {
    const { delta } = deltaSeries([fb(day, 5, 1, 5), fb(day + 300, 5, 1, 2)], 300, day + 10_000);
    expect(delta[0]!.color).toContain('0.8');
    expect(delta[1]!.color).toContain('0.3');
  });

  it('the forming candle is whole with the minutes so far, and its pace is scaled to a whole candle', () => {
    const flow = [...Array.from({ length: 10 }, (_, i) => fb(day + i * 300, 1, 1, 5, 100)), fb(day + 3_000, 4, 1, 1, 50)];
    const r = flowRead(flow, day + 3_000, 300, day + 3_000 + 30)!; // 30 s in: 50 trades is 500 a candle
    expect(r.whole).toBe(true);
    expect(r.delta).toBe(3);
    expect(r.buyPct).toBeCloseTo(0.8);
    expect(r.velocity).toBeCloseTo(5);
  });

  it('says nothing of a candle it has no flow for, and gives no pace without five candles before', () => {
    expect(flowRead([fb(day, 1, 1)], day + 300, 300, day + 1_000)).toBeNull();
    expect(flowRead([fb(day, 1, 1)], day, 300, day + 1_000)!.velocity).toBeNull();
  });
});
