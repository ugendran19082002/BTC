import type { Bar } from '@/lib/smc/types';
import type { FlowBar } from '@/api/desk';
import { C, type SceneItem } from './scene';

/**
 * The order-flow layers, in the scene's data coordinates (bar index, price):
 *
 * - **Volume profile** of the candles in view: volume at each price, with the
 *   point of control (POC, the busiest price) and the value area (VAH / VAL,
 *   the 70% of volume around it), and the high- and low-volume nodes (HVN /
 *   LVN): where price was accepted, and the thin areas it tends to cross
 *   quickly. Candles do not say where inside their range
 *   they traded, so each candle's volume is spread evenly over its high-low --
 *   the usual approximation without tick data.
 * - **Big trades**: each large taker order as a bubble on its candle at its
 *   own price, green for a buyer lifting the offer, red for a seller hitting
 *   the bid, its area in proportion to its size.
 *
 * - **Delta / CVD**: each candle's taker buying minus selling, and its running
 *   sum through the UTC day, for the pane under the price.
 *
 * None of these is a signal on its own; they are context, measured later.
 * Pure: the primitive turns these into pixels.
 */

export type VolumeProfile = {
  bins: { lo: number; hi: number; v: number; value: boolean }[];
  poc: number;
  vah: number;
  val: number;
  total: number;
  /** High- and low-volume nodes, bin mid prices, most pronounced first (at most three each). */
  hvn: number[];
  lvn: number[];
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
  const { hvn, lvn } = nodes(v, poc);
  const mid = (k: number) => min + (k + 0.5) * step;
  return {
    bins: v.map((vol, k) => ({ lo: min + k * step, hi: min + (k + 1) * step, v: vol, value: k >= a && k <= z })),
    poc: mid(poc),
    vah: min + (z + 1) * step,
    val: min + a * step,
    total,
    hvn: hvn.map(mid),
    lvn: lvn.map(mid),
  };
}

/**
 * Nodes on the profile smoothed over three bins, so one noisy bin is not a
 * node. HVN: a peak of at least half the tallest, not the POC itself. LVN: a
 * valley under a third of the tallest with a peak at least twice as tall on
 * both sides -- thin, between two areas of acceptance.
 */
function nodes(v: readonly number[], poc: number): { hvn: number[]; lvn: number[] } {
  const n = v.length;
  const s = v.map((_, k) => (v[Math.max(0, k - 1)]! + v[k]! + v[Math.min(n - 1, k + 1)]!) / 3);
  const top = Math.max(...s);
  const hvn: number[] = [];
  const lvn: number[] = [];
  for (let k = 1; k < n - 1; k++) {
    if (s[k]! > s[k - 1]! && s[k]! >= s[k + 1]! && s[k]! >= top * 0.5 && Math.abs(k - poc) > 1) hvn.push(k);
    if (s[k]! < s[k - 1]! && s[k]! <= s[k + 1]! && s[k]! <= top / 3) {
      const left = Math.max(...s.slice(0, k));
      const right = Math.max(...s.slice(k + 1));
      if (left >= 2 * s[k]! && right >= 2 * s[k]!) lvn.push(k);
    }
  }
  return {
    hvn: hvn.sort((a, b) => s[b]! - s[a]!).slice(0, 3),
    lvn: lvn.sort((a, b) => s[a]! - s[b]!).slice(0, 3),
  };
}

const fmt = (p: number) => Math.round(p).toLocaleString('en-US');

/**
 * The profile as a right-anchored histogram, and its POC / VAH / VAL as levels
 * from the first bar in view -- plus, given the last price, the low-volume node
 * nearest it: the thin area price is likeliest to cross fast.
 */
export function profileScene(p: VolumeProfile, from: number, last?: number): SceneItem[] {
  const max = Math.max(...p.bins.map((b) => b.v));
  const x1 = Math.max(0, Math.floor(from));
  const lvn = last === undefined ? undefined : [...p.lvn].sort((a, b) => Math.abs(a - last) - Math.abs(b - last))[0];
  return [
    ...(lvn === undefined ? [] : [{
      t: 'line' as const, layer: 'profile' as const, x1, x2: 'right' as const, y: lvn, color: '#38bdf8', dash: 'dot' as const,
      label: `LVN ${fmt(lvn)}`, labelAt: 'end' as const, labelSide: 'above' as const, priority: 45, faint: true,
    }]),
    { t: 'profile', layer: 'profile', bins: p.bins, max, poc: p.poc, hvn: p.hvn, lvn: p.lvn },
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
 * Large taker orders as bubbles centred on the candles they printed in, at
 * their price. `min` is the smallest drawn (contracts). Each carries its size
 * against the biggest shown -- the 98th percentile, so one outlier does not
 * shrink the rest to dots -- and the few biggest are labelled with it.
 */
export function bigTradeScene(trades: readonly BigTrade[], bars: readonly Bar[], tfSec: number, min: number): SceneItem[] {
  if (!bars.length || !trades.length) return [];
  const first = bars[0]!.time;
  const end = bars[bars.length - 1]!.time + tfSec;
  const shown = trades.filter((t) => t.size >= min && t.at / 1000 >= first && t.at / 1000 < end);
  const bySize = shown.map((t) => t.size).sort((a, b) => a - b);
  const top = bySize[Math.min(bySize.length - 1, Math.floor(bySize.length * 0.98))] ?? min;
  const labelFrom = bySize[Math.max(0, bySize.length - 5)] ?? Infinity;
  const out: SceneItem[] = [];
  let i = 0;
  for (const t of shown) {
    const sec = t.at / 1000;
    while (i < bars.length - 1 && bars[i + 1]!.time <= sec) i++;
    out.push({
      t: 'bubble', layer: 'bigtrades', x: i, y: t.price,
      rel: Math.sqrt(Math.min(1, t.size / top)),
      side: t.side,
      label: t.size >= labelFrom && t.size >= 2 * min ? `${t.side === 'buy' ? 'Buy' : 'Sell'} ${btc(t.size)}` : undefined,
      priority: 34,
    });
  }
  return out;
}

/** A candle's flow counts as whole when every one of its minutes was recorded (the forming one: every minute so far). */
function whole(b: FlowBar, tfSec: number, nowSec: number): boolean {
  const expected = Math.max(1, Math.min(tfSec / 60, Math.floor((nowSec - b.time) / 60) + 1));
  return b.minutes >= expected;
}

/**
 * The flow pane's two series: delta per candle (green net buying, red net
 * selling, faded where minutes are missing) and CVD, the running delta from
 * the start of the UTC day -- the same day the VWAP uses. A candle with no
 * recorded minute has no point: a gap in the record is not a flat market.
 */
export function deltaSeries(flow: readonly FlowBar[], tfSec: number, nowSec: number) {
  const delta: { time: number; value: number; color: string }[] = [];
  const cvd: { time: number; value: number }[] = [];
  let day = -1;
  let run = 0;
  for (const b of flow) {
    const d = b.buy - b.sell;
    const today = Math.floor(b.time / 86_400);
    if (today !== day) { day = today; run = 0; }
    run += d;
    const full = whole(b, tfSec, nowSec);
    delta.push({ time: b.time, value: d, color: d >= 0 ? (full ? 'rgba(38,161,123,0.8)' : 'rgba(38,161,123,0.3)') : (full ? 'rgba(226,80,79,0.8)' : 'rgba(226,80,79,0.3)') });
    cvd.push({ time: b.time, value: run });
  }
  return { delta, cvd };
}

export type FlowRead = { delta: number; buyPct: number | null; trades: number; velocity: number | null; whole: boolean };

/** One candle's flow for the readout: delta, the buyers' share, trades, and its trade rate against the twenty candles before it. */
export function flowRead(flow: readonly FlowBar[], time: number, tfSec: number, nowSec: number): FlowRead | null {
  const i = flow.findIndex((b) => b.time === time);
  if (i < 0) return null;
  const b = flow[i]!;
  const total = b.buy + b.sell;
  const before = flow.slice(Math.max(0, i - 20), i).filter((x) => whole(x, tfSec, nowSec));
  const avg = before.length >= 5 ? before.reduce((a, x) => a + x.trades, 0) / before.length : null;
  // The forming candle's rate is scaled to a whole candle, or it would always read slow.
  const elapsed = Math.min(tfSec, Math.max(1, nowSec - b.time));
  const rate = b.trades * (tfSec / elapsed);
  return { delta: b.buy - b.sell, buyPct: total > 0 ? b.buy / total : null, trades: b.trades, velocity: avg ? rate / avg : null, whole: whole(b, tfSec, nowSec) };
}
