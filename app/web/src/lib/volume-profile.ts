import type { Bar } from '@/lib/smc/types';

/**
 * Volume at price over a run of candles: the point of control (POC, the busiest
 * price), the value area (VAH / VAL, the 70% of volume around it) and the high-
 * and low-volume nodes. Candles do not say where inside their range they
 * traded, so each candle's volume is spread evenly over its high-low -- the
 * usual approximation without tick data.
 *
 * The chart drew this as a layer until 4 Oct 2026; the measurement stays for
 * the study that tested it (`scripts/profile-study.ts`: the POC is no magnet,
 * the 80% rule no edge). Pure.
 */

export type VolumeProfile = {
  /** `buy`: the taker-buy share of `known`, the volume whose candles' split was recorded. */
  bins: { lo: number; hi: number; v: number; value: boolean; buy: number; known: number }[];
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

/**
 * Volume at price over bars `from`..`to` (inclusive), in `nBins` equal steps.
 * With `buyShare` (a candle's taker-buy share of its volume, null where not
 * recorded), each bin also carries how much of it was buying -- the candle's
 * share spread over its range like its volume. Null with no volume.
 */
export function volumeProfile(bars: readonly Bar[], from: number, to: number, nBins = 48, buyShare?: (i: number) => number | null): VolumeProfile | null {
  const lo = Math.max(0, Math.floor(from));
  const hi = Math.min(bars.length - 1, Math.ceil(to));
  if (hi < lo) return null;
  let min = Infinity;
  let max = -Infinity;
  for (let i = lo; i <= hi; i++) { min = Math.min(min, bars[i]!.low); max = Math.max(max, bars[i]!.high); }
  if (!(max > min)) return null;
  const step = (max - min) / nBins;
  const v = new Array<number>(nBins).fill(0);
  const buy = new Array<number>(nBins).fill(0);
  const known = new Array<number>(nBins).fill(0);
  let total = 0;
  for (let i = lo; i <= hi; i++) {
    const b = bars[i]!;
    if (!(b.volume > 0)) continue;
    total += b.volume;
    const share = buyShare?.(i) ?? null;
    const add = (k: number, vol: number) => {
      v[k]! += vol;
      if (share !== null) { known[k]! += vol; buy[k]! += vol * share; }
    };
    const range = b.high - b.low;
    const first = Math.min(nBins - 1, Math.floor((b.low - min) / step));
    const last = Math.min(nBins - 1, Math.floor((b.high - min) / step));
    if (range <= 0 || first === last) { add(first, b.volume); continue; }
    for (let k = first; k <= last; k++) {
      const overlap = Math.min(b.high, min + (k + 1) * step) - Math.max(b.low, min + k * step);
      if (overlap > 0) add(k, b.volume * (overlap / range));
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
    bins: v.map((vol, k) => ({ lo: min + k * step, hi: min + (k + 1) * step, v: vol, value: k >= a && k <= z, buy: buy[k]!, known: known[k]! })),
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
