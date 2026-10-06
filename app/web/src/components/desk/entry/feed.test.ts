import { describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useEntryFeed } from './feed';
import type { Candle } from '@/types/desk';

/**
 * The entry charts' candles by timeframe. Anything past 1h was folded to 4h bars -- right while 4h was the only
 * one, and a 2h chart drawn from 4h candles once 2h joined (6 Oct 2026).
 */
const H = 3_600;
const T0 = 1_790_035_200;                     // on every timeframe's grid
const hour = (i: number): Candle => ({ time: T0 + i * H, open: 100 + i, high: 110 + i, low: 90 + i, close: 101 + i, volume: 10 });
const HOURS = Array.from({ length: 8 }, (_, i) => hour(i));

vi.mock('@/api/desk', () => ({
  getCandles: (tf: string) => Promise.resolve({ bars: tf === '1h' ? HOURS : [] }),
}));

describe('the entry charts', () => {
  it('[critical] 2h is two hourly candles to a bar, 4h four: each its own length', async () => {
    const { result } = renderHook(() => useEntryFeed({ bars5m: [] }, ['2h', '4h']));
    await waitFor(() => expect(result.current('1h').bars.length).toBeGreaterThan(0));
    const two = result.current('2h').bars;
    const four = result.current('4h').bars;
    expect(two.map((b) => b.time - T0)).toEqual([0, 2 * H, 4 * H, 6 * H]);
    expect(four.map((b) => b.time - T0)).toEqual([0, 4 * H]);
    // A 2h bar opens with its first hour and closes with its second; its high and low are the pair's.
    expect([two[0]!.open, two[0]!.close, two[0]!.high, two[0]!.low, two[0]!.volume]).toEqual([100, 102, 111, 90, 20]);
    expect(result.current('2h').loading).toBe(false);
  });
});
