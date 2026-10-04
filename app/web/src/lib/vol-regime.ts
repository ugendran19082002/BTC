import type { Bar } from '@/lib/smc/types';

export type VolRegime = { atr: number; ratio: number; label: 'expanding' | 'normal' | 'quiet' };

/**
 * Is the chart moving more or less than usual: the latest ATR(14) against the
 * median ATR over the candles given. Expanding from 1.3x, quiet under 0.7x --
 * what the stop's ATR buffer and floor are sized from. Null under 30 candles.
 */
export function volRegime(bars: readonly Bar[]): VolRegime | null {
  if (bars.length < 30) return null;
  const atrs: number[] = [];
  let atr = 0;
  for (let i = 1; i < bars.length; i++) {
    const b = bars[i]!;
    const tr = Math.max(b.high - b.low, Math.abs(b.high - bars[i - 1]!.close), Math.abs(b.low - bars[i - 1]!.close));
    atr = i <= 14 ? atr + tr / 14 : (atr * 13 + tr) / 14;
    if (i >= 14) atrs.push(atr);
  }
  const sorted = [...atrs].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)]!;
  if (!(median > 0)) return null;
  const ratio = atr / median;
  return { atr, ratio, label: ratio >= 1.3 ? 'expanding' : ratio <= 0.7 ? 'quiet' : 'normal' };
}
