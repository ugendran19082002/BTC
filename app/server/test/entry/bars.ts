import type { Candle } from '../../src/market/delta.js';
import type { EntryContext } from '../../src/entry/types.js';

/** A day boundary, so VWAP's "since 00:00 UTC" starts at the first bar. */
export const T0 = 1_790_035_200;

/** Candles from closes: each opens at the last close, with a `w` wick either side. */
export function path(closes: readonly number[], o: { step?: number; w?: number; volume?: number; start?: number; t0?: number } = {}): Candle[] {
  const step = o.step ?? 300;
  const w = o.w ?? 5;
  let prev = o.start ?? closes[0]!;
  return closes.map((c, i) => {
    // The close's side gets the full wick and the open's half of one, so two
    // bars never share an extreme by construction (a swing needs a strict one).
    const b = {
      time: (o.t0 ?? T0) + i * step, open: prev, close: c,
      high: Math.max(c + w, prev + w / 2), low: Math.min(c - w, prev - w / 2), volume: o.volume ?? 100,
    };
    prev = c;
    return b;
  });
}

/** `n` closes swinging `amp` around `p` over a `period`-bar cycle, drifting `drift` a bar. */
export const wave = (n: number, p = 84_000, amp = 40, period = 10, drift = 0) =>
  Array.from({ length: n }, (_, i) => Math.round(p + drift * i + amp * Math.sin((2 * Math.PI * i) / period)));

export function ctxOf(over: Partial<EntryContext> = {}): EntryContext {
  return { now: T0 * 1000, frames: {}, flow: [], walls: [], spreadPct: null, options: null, bigMove: null, ...over };
}
