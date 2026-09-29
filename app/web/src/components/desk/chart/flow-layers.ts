import type { Bar } from '@/lib/smc/types';
import { C, type SceneItem } from './scene';

/**
 * The order-flow layers, in the scene's data coordinates (bar index, price):
 *
 * - **Volume profile** of the candles in view: volume at each price, with the
 *   point of control (POC, the busiest price) and the value area (VAH / VAL,
 *   the 70% of volume around it). Candles do not say where inside their range
 *   they traded, so each candle's volume is spread evenly over its high-low --
 *   the usual approximation without tick data.
 * - **Big trades**: each large taker order as a bubble at its own time and
 *   price, green for a buyer lifting the offer, red for a seller hitting the
 *   bid, its area in proportion to its size.
 *
 * Pure: the primitive turns these into pixels.
 */

export type VolumeProfile = {
  bins: { lo: number; hi: number; v: number; value: boolean }[];
  poc: number;
  vah: number;
  val: number;
  total: number;
};

/** The share of volume the value area holds, by convention. */
const VALUE_AREA = 0.7;

/** Volume at price over bars `from`..`to` (inclusive), in `nBins` equal steps. Null with no volume. */
export function volumeProfile(bars: readonly Bar[], from: number, to: number, nBins = 48): VolumeProfile | null {
  const lo = Math.max(0, Math.floor(from));
  const hi = Math.min(bars.length - 1, Math.ceil(to));
  if (hi < lo) return null;
  let min = Infinity;
  let max = -Infinity;
  for (let i = lo; i <= hi; i++) { min = Math.min(min, bars[i]!.low); max = Math.max(max, bars[i]!.high); }
  if (!(max > min)) return null;
  const step = (max - min) / nBins;
  const v = new Array<number>(nBins).fill(0);
  let total = 0;
  for (let i = lo; i <= hi; i++) {
    const b = bars[i]!;
    if (!(b.volume > 0)) continue;
    total += b.volume;
    const range = b.high - b.low;
    const first = Math.min(nBins - 1, Math.floor((b.low - min) / step));
    const last = Math.min(nBins - 1, Math.floor((b.high - min) / step));
    if (range <= 0 || first === last) { v[first]! += b.volume; continue; }
    for (let k = first; k <= last; k++) {
      const overlap = Math.min(b.high, min + (k + 1) * step) - Math.max(b.low, min + k * step);
      if (overlap > 0) v[k]! += b.volume * (overlap / range);
    }
  }
  if (!(total > 0)) return null;
  let poc = 0;
  for (let k = 1; k < nBins; k++) if (v[k]! > v[poc]!) poc = k;
  // The value area grows from the POC one step at a time, towards the busier neighbour.
  let a = poc;
  let z = poc;
  let inside = v[poc]!;
  while (inside < VALUE_AREA * total && (a > 0 || z < nBins - 1)) {
    const down = a > 0 ? v[a - 1]! : -1;
    const up = z < nBins - 1 ? v[z + 1]! : -1;
    if (up >= down) inside += v[++z]!; else inside += v[--a]!;
  }
  return {
    bins: v.map((vol, k) => ({ lo: min + k * step, hi: min + (k + 1) * step, v: vol, value: k >= a && k <= z })),
    poc: min + (poc + 0.5) * step,
    vah: min + (z + 1) * step,
    val: min + a * step,
    total,
  };
}

const fmt = (p: number) => Math.round(p).toLocaleString('en-US');

/** The profile as a right-anchored histogram, and its POC / VAH / VAL as levels from the first bar in view. */
export function profileScene(p: VolumeProfile, from: number): SceneItem[] {
  const max = Math.max(...p.bins.map((b) => b.v));
  const x1 = Math.max(0, Math.floor(from));
  return [
    { t: 'profile', layer: 'profile', bins: p.bins, max, poc: p.poc },
    { t: 'line', layer: 'profile', x1, x2: 'right', y: p.poc, color: C.poc, dash: 'dash', label: `POC ${fmt(p.poc)}`, labelAt: 'end', labelSide: 'above', priority: 62 },
    { t: 'line', layer: 'profile', x1, x2: 'right', y: p.vah, color: C.muted, dash: 'dot', label: `VAH ${fmt(p.vah)}`, labelAt: 'end', labelSide: 'above', priority: 46, faint: true },
    { t: 'line', layer: 'profile', x1, x2: 'right', y: p.val, color: C.muted, dash: 'dot', label: `VAL ${fmt(p.val)}`, labelAt: 'end', labelSide: 'below', priority: 46, faint: true },
  ];
}

export type BigTrade = { at: number; side: 'buy' | 'sell'; price: number; size: number };

/** Contracts per BTC on Delta's BTCUSD perpetual. */
const CONTRACTS_PER_BTC = 1_000;
const btc = (contracts: number) => {
  const b = contracts / CONTRACTS_PER_BTC;
  return `${b >= 10 ? b.toFixed(0) : b.toFixed(1)} BTC`;
};

/**
 * Large taker orders as bubbles on the candles they printed in, placed across
 * the candle by the time within it. `min` is the smallest drawn (contracts);
 * the bubble's area goes with its size, and the few biggest in the set are
 * labelled with it.
 */
export function bigTradeScene(trades: readonly BigTrade[], bars: readonly Bar[], tfSec: number, min: number): SceneItem[] {
  if (!bars.length || !trades.length) return [];
  const first = bars[0]!.time;
  const end = bars[bars.length - 1]!.time + tfSec;
  const shown = trades.filter((t) => t.size >= min && t.at / 1000 >= first && t.at / 1000 < end);
  const labelFrom = [...shown].sort((a, b) => b.size - a.size).slice(0, 5).at(-1)?.size ?? Infinity;
  const out: SceneItem[] = [];
  let i = 0;
  for (const t of shown) {
    const sec = t.at / 1000;
    while (i < bars.length - 1 && bars[i + 1]!.time <= sec) i++;
    const within = Math.min(0.999, Math.max(0, (sec - bars[i]!.time) / tfSec));
    out.push({
      t: 'bubble', layer: 'bigtrades', x: i - 0.5 + within, y: t.price,
      r: Math.min(26, 4 + 5 * Math.sqrt(t.size / min - 1 + 0.2)),
      side: t.side,
      label: t.size >= labelFrom && t.size >= 2 * min ? `${t.side === 'buy' ? 'Buy' : 'Sell'} ${btc(t.size)}` : undefined,
      priority: 34,
    });
  }
  return out;
}
