import { describe, expect, it } from 'vitest';
import { volRegime } from '@/lib/vol-regime';

describe('the volatility regime', () => {
  const walk = (n: number, range: (i: number) => number) =>
    Array.from({ length: n }, (_, i) => ({ time: i * 300, open: 100, high: 100 + range(i) / 2, low: 100 - range(i) / 2, close: 100, volume: 1 }));

  it('[critical] the latest ATR against its median: expanding, quiet, normal', () => {
    expect(volRegime(walk(100, (i) => (i < 80 ? 10 : 40)))!.label).toBe('expanding');
    expect(volRegime(walk(100, (i) => (i < 80 ? 10 : 2)))!.label).toBe('quiet');
    const flat = volRegime(walk(100, () => 10))!;
    expect(flat.label).toBe('normal');
    expect(flat.atr).toBeCloseTo(10, 6);
  });

  it('says nothing under thirty candles', () => {
    expect(volRegime(walk(20, () => 10))).toBeNull();
  });
});
