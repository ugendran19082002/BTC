import type { Bar } from '@/lib/smc/types';
import type { FlowBar, HeatColumn, Wall } from '@/api/desk';
import type { Leg } from '@/types/desk';
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

const usd = (v: number) => (v >= 1e6 ? `$${(v / 1e6).toFixed(1)}M` : `$${Math.round(v / 1e3)}k`);
const IST_TIME = new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
/** Bubbles on candles older than this are drawn faded: history behind the latest activity. */
const RECENT_BARS = 48;

/**
 * Large taker orders as bubbles centred on the candles they printed in. All
 * of one candle's big buys are one bubble, and all its big sells another, at
 * their volume-weighted price -- so a candle carries at most two, never a
 * stack of circles inside each other; the hover gives the count and the price
 * range. `min` is the smallest order counted (contracts). Each bubble carries
 * its size against the biggest shown -- the 98th percentile, so one outlier
 * does not shrink the rest to dots. Largest first, so a smaller bubble on the
 * same candle is drawn over it and stays visible. The five biggest are
 * labelled with BTC and dollars; older than 48 candles, faded.
 */
export function bigTradeScene(trades: readonly BigTrade[], bars: readonly Bar[], tfSec: number, min: number): SceneItem[] {
  if (!bars.length || !trades.length) return [];
  const first = bars[0]!.time;
  const end = bars[bars.length - 1]!.time + tfSec;
  type Cluster = { x: number; side: 'buy' | 'sell'; size: number; notional: number; count: number; from: number; to: number; lo: number; hi: number };
  const clusters = new Map<string, Cluster>();
  let i = 0;
  for (const t of trades) {
    const sec = t.at / 1000;
    if (t.size < min || sec < first || sec >= end) continue;
    while (i < bars.length - 1 && bars[i + 1]!.time <= sec) i++;
    const key = `${i}:${t.side}`;
    const c = clusters.get(key) ?? clusters.set(key, { x: i, side: t.side, size: 0, notional: 0, count: 0, from: t.at, to: t.at, lo: t.price, hi: t.price }).get(key)!;
    c.lo = Math.min(c.lo, t.price);
    c.hi = Math.max(c.hi, t.price);
    c.size += t.size;
    c.notional += t.size * t.price;
    c.count += 1;
    c.from = Math.min(c.from, t.at);
    c.to = Math.max(c.to, t.at);
  }
  const shown = [...clusters.values()].sort((a, b) => b.size - a.size);
  const bySize = shown.map((c) => c.size).sort((a, b) => a - b);
  const top = bySize[Math.min(bySize.length - 1, Math.floor(bySize.length * 0.98))] ?? min;
  const labelFrom = bySize[Math.max(0, bySize.length - 5)] ?? Infinity;
  return shown.map((c) => {
    const price = c.notional / c.size;
    const dollars = (c.size / CONTRACTS_PER_BTC) * price;
    const who = c.side === 'buy' ? 'Buy' : 'Sell';
    const times = c.from === c.to ? IST_TIME.format(c.from) : `${IST_TIME.format(c.from)}–${IST_TIME.format(c.to)}`;
    return {
      t: 'bubble' as const, layer: 'bigtrades' as const, x: c.x, y: price,
      rel: Math.sqrt(Math.min(1, c.size / top)),
      side: c.side,
      label: c.size >= labelFrom && c.size >= 2 * min ? `${who} ${btc(c.size)} · ${usd(dollars)}${c.count > 1 ? ` ×${c.count}` : ''}` : undefined,
      tip: `${who} ${btc(c.size)} · ${usd(dollars)}${c.count > 1 ? ` · ${c.count} orders` : ''}\n@ ${fmt(price)}${c.hi - c.lo >= 1 ? ` (${fmt(c.lo)}–${fmt(c.hi)})` : ''} · ${times} IST\n${c.side === 'buy' ? 'Taker bought: lifted the offer' : 'Taker sold: hit the bid'}`,
      faint: c.x < bars.length - RECENT_BARS,
      priority: 34,
    };
  });
}

export type BigTradeSummary = { buys: number; sells: number; buyBtc: number; sellBtc: number };

/** Big trades on bars `from`..`to` (inclusive): how many each side, and how much, in BTC. */
export function bigTradeSummary(trades: readonly BigTrade[], bars: readonly Bar[], tfSec: number, min: number, from: number, to: number): BigTradeSummary {
  const lo = bars[Math.max(0, Math.floor(from))]?.time ?? Infinity;
  const hi = (bars[Math.min(bars.length - 1, Math.ceil(to))]?.time ?? -Infinity) + tfSec;
  const out: BigTradeSummary = { buys: 0, sells: 0, buyBtc: 0, sellBtc: 0 };
  for (const t of trades) {
    const sec = t.at / 1000;
    if (t.size < min || sec < lo || sec >= hi) continue;
    if (t.side === 'buy') { out.buys++; out.buyBtc += t.size / CONTRACTS_PER_BTC; } else { out.sells++; out.sellBtc += t.size / CONTRACTS_PER_BTC; }
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

const WALL = '#fde047';

/**
 * The book heatmap and its persistent walls. Columns are placed on the candles
 * whose time they carry (none where there is no candle); colour is capped at
 * the 95th percentile of the cells in the columns given. Walls: a level of at
 * least three times the side's usual resting size, held five minutes running
 * up to now -- a line from where it began, with side, price, size and how
 * long. Resting orders can be pulled; a wall is a place, not a promise.
 */
export function heatScene(cols: readonly HeatColumn[], step: number, walls: readonly Wall[], bars: readonly Bar[], tfSec: number): SceneItem[] {
  if (!bars.length) return [];
  const index = new Map(bars.map((b, i) => [b.time, i]));
  const placed = cols.flatMap((c) => { const x = index.get(c.time); return x === undefined ? [] : [{ x, cells: c.cells }]; });
  const sizes = placed.flatMap((c) => c.cells.map((cell) => cell[1])).sort((a, b) => a - b);
  const cap = sizes[Math.floor(sizes.length * 0.95)] ?? 0;
  const out: SceneItem[] = [];
  if (placed.length && cap > 0) out.push({ t: 'heat', layer: 'heatmap', step, cols: placed, cap });
  const last = bars.length - 1;
  for (const w of walls) {
    out.push({
      t: 'line', layer: 'heatmap', x1: Math.max(0, last - Math.ceil((w.minutes * 60) / tfSec)), x2: 'right', y: w.price, color: WALL, width: 2,
      label: `${w.side === 'bid' ? 'Bid' : 'Ask'} wall ${fmt(w.price)} · ${btc(w.size)} · ${w.minutes}m`, labelAt: 'end', labelSide: w.side === 'bid' ? 'below' : 'above', priority: 72,
    });
  }
  return out;
}

/** Delta India's BTC options: 0.001 BTC a contract. */
const OPTION_CONTRACT_BTC = 0.001;
const CE_COLOR = '#fb923c';
const PE_COLOR = '#2dd4bf';

/**
 * The option board's open interest as levels on price: the three biggest call
 * strikes and the three biggest put strikes within 3% of price, each a dashed
 * line across the chart as thick as its share of the biggest, labelled with
 * its OI and the last hour's change -- calls where sellers are short above,
 * puts where they are short below. And max pain, where the board's buyers
 * would be paid least at settlement. Positioning to watch, not a level that
 * must hold: OI does not say which side of each contract is the seller.
 */
export function strikeScene(legs: readonly Leg[], maxPain: number | null, last: number): SceneItem[] {
  const near = legs.filter((l) => l.oi !== null && l.oi > 0 && Math.abs(l.strike - last) / last <= 0.03);
  const top = (cp: 'C' | 'P') => near.filter((l) => l.cp === cp).sort((a, b) => b.oi! - a.oi!).slice(0, 3);
  const picked = [...top('C'), ...top('P')];
  const maxOi = Math.max(0, ...picked.map((l) => l.oi!));
  const out: SceneItem[] = picked.map((l, i) => {
    const change = l.oiChange ? l.oiChange.change * OPTION_CONTRACT_BTC : null;
    const first = i === 0 || i === top('C').length;
    return {
      t: 'line', layer: 'options', x1: 0, x2: 'right', y: l.strike,
      color: l.cp === 'C' ? CE_COLOR : PE_COLOR, dash: 'dash', width: 1 + 2 * (l.oi! / maxOi),
      label: `${l.cp === 'C' ? 'CE' : 'PE'} ${fmt(l.strike)} · OI ${(l.oi! * OPTION_CONTRACT_BTC).toFixed(0)} BTC${change === null ? '' : ` · ${change >= 0 ? '+' : '−'}${Math.abs(change).toFixed(1)} ${l.oiChange!.overMinutes >= 55 ? '1h' : `${l.oiChange!.overMinutes}m`}`}`,
      labelAt: 'end', labelSide: l.cp === 'C' ? 'above' : 'below', priority: first ? 64 : 48, faint: !first,
    };
  });
  if (maxPain !== null && Math.abs(maxPain - last) / last <= 0.05) {
    out.push({ t: 'line', layer: 'options', x1: 0, x2: 'right', y: maxPain, color: '#c084fc', dash: 'dot', label: `Max pain ${fmt(maxPain)}`, labelAt: 'end', labelSide: 'above', priority: 52 });
  }
  return out;
}

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
