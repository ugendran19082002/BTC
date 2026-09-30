import type { Candle } from '../market/delta.js';

/**
 * The price-action pieces the twelve entry methods are built from.
 *
 * Pure and closed-bar only: every function here reads the candles it is given
 * and nothing else, and callers give it closed candles, so a reading never
 * appears on a forming bar and vanishes when it closes. A swing is only a swing
 * once the bars after it exist (`PIVOT_K` either side) -- the newest swing is
 * always a few bars old, which is the price of not looking ahead.
 */

/** Bars either side a swing high must top (a swing low, undercut) to count. */
export const PIVOT_K = 2;

export type Pivot = { i: number; price: number; time: number };

export const body = (b: Candle) => Math.abs(b.close - b.open);
export const range = (b: Candle) => b.high - b.low;
export const bullish = (b: Candle) => b.close > b.open;
export const bearish = (b: Candle) => b.close < b.open;

/** Wilder's average true range. Null with too few bars. */
export function atr(bars: readonly Candle[], n = 14): number | null {
  if (bars.length < n + 1) return null;
  let sum = 0;
  for (let i = bars.length - n; i < bars.length; i++) {
    const b = bars[i]!;
    const p = bars[i - 1]!;
    sum += Math.max(b.high - b.low, Math.abs(b.high - p.close), Math.abs(b.low - p.close));
  }
  return sum / n;
}

/** Exponential moving average of the closes, the last value. */
export function ema(bars: readonly Candle[], n: number): number | null {
  if (bars.length < n) return null;
  const k = 2 / (n + 1);
  let e = bars.slice(0, n).reduce((a, b) => a + b.close, 0) / n;
  for (let i = n; i < bars.length; i++) e = bars[i]!.close * k + e * (1 - k);
  return e;
}

/** Fractal swing highs or lows, oldest first, only those with `k` bars after them. */
export function pivots(bars: readonly Candle[], which: 'high' | 'low', k = PIVOT_K): Pivot[] {
  const out: Pivot[] = [];
  for (let i = k; i < bars.length - k; i++) {
    const v = which === 'high' ? bars[i]!.high : bars[i]!.low;
    let ok = true;
    for (let j = i - k; j <= i + k && ok; j++) {
      if (j === i) continue;
      const w = which === 'high' ? bars[j]!.high : bars[j]!.low;
      if (which === 'high' ? w >= v : w <= v) ok = false;
    }
    if (ok) out.push({ i, price: v, time: bars[i]!.time });
  }
  return out;
}

/**
 * Which way a timeframe is going: +1, −1 or 0.
 *
 * Two readings must agree -- the EMA stack (close over EMA 20 over EMA 50) and
 * the swings (a higher high and a higher low) -- or it is 0. One reading alone
 * calls a trend on every wiggle.
 */
export function trendOf(bars: readonly Candle[]): -1 | 0 | 1 {
  const e20 = ema(bars, 20);
  const e50 = ema(bars, 50);
  const last = bars[bars.length - 1];
  if (e20 === null || e50 === null || !last) return 0;
  const hs = pivots(bars, 'high').slice(-2);
  const ls = pivots(bars, 'low').slice(-2);
  const swingUp = hs.length === 2 && ls.length === 2 && hs[1]!.price > hs[0]!.price && ls[1]!.price > ls[0]!.price;
  const swingDown = hs.length === 2 && ls.length === 2 && hs[1]!.price < hs[0]!.price && ls[1]!.price < ls[0]!.price;
  if (last.close > e20 && e20 > e50 && swingUp) return 1;
  if (last.close < e20 && e20 < e50 && swingDown) return -1;
  return 0;
}

/** A displacement bar: a body of at least `atrs` ATRs, mostly body. */
export function isDisplacement(b: Candle, a: number | null, atrs = 1.2): boolean {
  return a !== null && a > 0 && body(b) >= atrs * a && range(b) > 0 && body(b) / range(b) >= 0.6;
}

/** The newest bar's volume against the median of the `n` before it. */
export function rvol(bars: readonly Candle[], n = 20): number | null {
  if (bars.length < n + 1) return null;
  const prior = bars.slice(-n - 1, -1).map((b) => b.volume).sort((a, b) => a - b);
  const med = prior[Math.floor(prior.length / 2)]!;
  return med > 0 ? bars[bars.length - 1]!.volume / med : null;
}

export type Sweep = { dir: 1 | -1; level: number; extreme: number; i: number; time: number };

/**
 * The newest liquidity sweep in the last `look` bars.
 *
 * Bullish: a bar trades under a swing low that stood before it and closes back
 * above it -- the stops under the low were taken and the price did not stay.
 * Bearish is the mirror, over a swing high.
 */
export function lastSweep(bars: readonly Candle[], look = 6): Sweep | null {
  const lows = pivots(bars, 'low');
  const highs = pivots(bars, 'high');
  for (let i = bars.length - 1; i >= Math.max(0, bars.length - look); i--) {
    const b = bars[i]!;
    const low = [...lows].reverse().find((p) => p.i < i - PIVOT_K && b.low < p.price && b.close > p.price);
    const high = [...highs].reverse().find((p) => p.i < i - PIVOT_K && b.high > p.price && b.close < p.price);
    if (low) return { dir: 1, level: low.price, extreme: b.low, i, time: b.time };
    if (high) return { dir: -1, level: high.price, extreme: b.high, i, time: b.time };
  }
  return null;
}

export type Break = { dir: 1 | -1; level: number; i: number; time: number };

/**
 * The newest close through a swing, in the last `look` bars.
 *
 * `dir` +1 is a close above the most recent swing high that stood before the
 * bar; −1, below the most recent swing low. Whether that is a BOS (with the
 * trend) or an MSS / CHoCH (against it) is the caller's reading of the trend.
 */
export function lastBreak(bars: readonly Candle[], look = 5): Break | null {
  const highs = pivots(bars, 'high');
  const lows = pivots(bars, 'low');
  for (let i = bars.length - 1; i >= Math.max(1, bars.length - look); i--) {
    const b = bars[i]!;
    const p = bars[i - 1]!;
    const h = [...highs].reverse().find((x) => x.i < i);
    const l = [...lows].reverse().find((x) => x.i < i);
    if (h && b.close > h.price && p.close <= h.price) return { dir: 1, level: h.price, i, time: b.time };
    if (l && b.close < l.price && p.close >= l.price) return { dir: -1, level: l.price, i, time: b.time };
  }
  return null;
}

export type Zone = { dir: 1 | -1; lo: number; hi: number; i: number; time: number };

/**
 * Fair-value gaps from the last `look` bars that price has not closed through.
 *
 * Bullish: the bar two back topped out under the newest bar's low, and the bar
 * between them was a displacement -- a gap the move left behind. Newest first.
 */
export function openFvgs(bars: readonly Candle[], look = 30): Zone[] {
  const a = atr(bars);
  const out: Zone[] = [];
  for (let i = Math.max(2, bars.length - look); i < bars.length; i++) {
    const x = bars[i - 2]!;
    const mid = bars[i - 1]!;
    const z = bars[i]!;
    if (!isDisplacement(mid, a, 1)) continue;
    let zone: Zone | null = null;
    if (x.high < z.low) zone = { dir: 1, lo: x.high, hi: z.low, i: i - 1, time: mid.time };
    if (x.low > z.high) zone = { dir: -1, lo: z.high, hi: x.low, i: i - 1, time: mid.time };
    if (!zone) continue;
    const later = bars.slice(i + 1);
    const closedThrough = later.some((b) => (zone!.dir === 1 ? b.close < zone!.lo : b.close > zone!.hi));
    if (!closedThrough) out.push(zone);
  }
  return out.reverse();
}

/**
 * Order blocks: the last opposite candle before a displacement that broke a
 * swing. Bullish -- the last down candle before a bullish displacement that
 * closed over a swing high. Its range is the zone. Newest first, untouched by
 * a close through the far side.
 */
export function orderBlocks(bars: readonly Candle[], look = 40): Zone[] {
  const a = atr(bars);
  const highs = pivots(bars, 'high');
  const lows = pivots(bars, 'low');
  const out: Zone[] = [];
  for (let i = Math.max(1, bars.length - look); i < bars.length; i++) {
    const d = bars[i]!;
    if (!isDisplacement(d, a)) continue;
    const up = bullish(d);
    const swing = up ? [...highs].reverse().find((p) => p.i < i) : [...lows].reverse().find((p) => p.i < i);
    if (!swing || (up ? d.close <= swing.price : d.close >= swing.price)) continue;
    let j = i - 1;
    while (j >= 0 && (up ? !bearish(bars[j]!) : !bullish(bars[j]!))) j--;
    if (j < 0) continue;
    const ob = bars[j]!;
    const zone: Zone = { dir: up ? 1 : -1, lo: ob.low, hi: ob.high, i: j, time: ob.time };
    const later = bars.slice(i + 1);
    if (!later.some((b) => (zone.dir === 1 ? b.close < zone.lo : b.close > zone.hi))) out.push(zone);
  }
  return out.reverse();
}

/** VWAP of the bars since the desk's day began (00:00 UTC, 05:30 IST), and how far the close is from it in standard deviations. */
export function vwapBand(bars: readonly Candle[]): { vwap: number; z: number | null } | null {
  const last = bars[bars.length - 1];
  if (!last) return null;
  const dayStart = last.time - (last.time % 86_400);
  const day = bars.filter((b) => b.time >= dayStart);
  if (day.length < 5) return null;
  let pv = 0;
  let v = 0;
  for (const b of day) {
    const tp = (b.high + b.low + b.close) / 3;
    pv += tp * (b.volume || 1);
    v += b.volume || 1;
  }
  const vwap = pv / v;
  const dev = day.map((b) => b.close - vwap);
  const sd = Math.sqrt(dev.reduce((a, x) => a + x * x, 0) / dev.length);
  return { vwap, z: sd > 0 ? (last.close - vwap) / sd : null };
}

/** How directly price travelled over `n` bars: 1 is a straight line, 0 is chop. */
export function efficiency(bars: readonly Candle[], n = 20): number | null {
  if (bars.length < n + 1) return null;
  const xs = bars.slice(-n - 1).map((b) => b.close);
  const net = Math.abs(xs[xs.length - 1]! - xs[0]!);
  let path = 0;
  for (let i = 1; i < xs.length; i++) path += Math.abs(xs[i]! - xs[i - 1]!);
  return path > 0 ? net / path : null;
}

/** Highest high and lowest low of the `n` bars before the newest. */
export function donchian(bars: readonly Candle[], n = 20): { hi: number; lo: number } | null {
  if (bars.length < n + 1) return null;
  const prior = bars.slice(-n - 1, -1);
  return { hi: Math.max(...prior.map((b) => b.high)), lo: Math.min(...prior.map((b) => b.low)) };
}
