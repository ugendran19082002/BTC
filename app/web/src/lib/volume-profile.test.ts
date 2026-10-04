import { describe, expect, it } from 'vitest';
import type { Bar } from '@/lib/smc/types';
import { volumeProfile } from '@/lib/volume-profile';

/** Volume at price: the measurement the profile study runs on (the chart's own profile layer went on 4 Oct 2026). */
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
    const one = volumeProfile(bars, 1, 1)!;
    expect(one.total).toBe(50);
    expect(one.val).toBeGreaterThanOrEqual(500);
    expect(one.vah).toBeLessThanOrEqual(510);
  });
});

describe('the profile, split by the aggressor', () => {
  it('[critical] each bin carries the buying of the candles over it, where their split was recorded', () => {
    const bars = [bar(0, 100, 110, 1_000), bar(300, 100, 110, 1_000), bar(600, 120, 130, 500)];
    const share = [0.8, 0.4, null];
    const p = volumeProfile(bars, 0, 2, 3, (i) => share[i]!)!;
    const low = p.bins[0]!; // 100-110: both of the first two candles
    expect(low.known).toBeCloseTo(2_000, 6);
    expect(low.buy / low.known).toBeCloseTo(0.6, 9);
    const high = p.bins[2]!; // 120-130: the third, not recorded
    expect(high.known).toBe(0);
    expect(high.v).toBeCloseTo(500, 6);
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
});
