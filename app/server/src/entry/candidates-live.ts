import type { Candle } from '../market/delta.js';
import type { Candidate } from './candidates.js';
import type { DetectInput, Setup, TargetSpec } from './methods.js';
import type { EntryContext } from './types.js';
import { bearish, bullish, pivots, range } from './prims.js';

/**
 * Research candidates that need the desk's live data -- the perpetual's tape
 * per minute, its mark and index, the funding rate, the option board -- which
 * was not recorded for 2024-26, so they cannot be replayed (scripts/
 * methods-study.ts). They run on the research track instead: read every
 * minute beside the twelve, paper-logged, never alerted, for a week or more
 * of forward evidence (owner, 1 Oct 2026). With the data missing -- the tape
 * down, no option board -- each says nothing rather than guessing.
 *
 * Numbers are the owner's research list (docs/research/entry-concepts.md).
 */

const last = (bars: readonly Candle[]) => bars[bars.length - 1]!;
const prev = (bars: readonly Candle[]) => bars[bars.length - 2]!;
const turned = (b: Candle, p: Candle, dir: 1 | -1) => (dir === 1 ? bullish(b) && b.close > p.high : bearish(b) && b.close < p.low);
const atClose = (b: Candle, dir: 1 | -1, a: number, w = 0.25): [number, number] => (dir === 1 ? [b.close - w * a, b.close] : [b.close, b.close + w * a]);
const hiOf = (xs: readonly Candle[]) => Math.max(...xs.map((b) => b.high));
const loOf = (xs: readonly Candle[]) => Math.min(...xs.map((b) => b.low));
const fmt = (p: number) => Math.round(p).toLocaleString('en-US');
const FRESH_MS = 30_000;

/** Each bar's tape, from the minutes inside it: delta (buy − sell), volume, and the large prints' net. Null where the tape is missing. */
export function barFlow(bars: readonly Candle[], ctx: EntryContext): ({ delta: number; volume: number; large: number } | null)[] {
  const tf = bars.length > 1 ? bars[1]!.time - bars[0]!.time : 60;
  const per = Math.max(1, Math.round(tf / 60));
  const byMin = new Map(ctx.flow.map((m) => [m.time, m]));
  return bars.map((b) => {
    let delta = 0, volume = 0, large = 0, got = 0;
    for (let k = 0; k < per; k++) {
      const m = byMin.get(b.time + k * 60);
      if (!m) continue;
      got++; delta += m.buy - m.sell; volume += m.buy + m.sell; large += m.largeBuy - m.largeSell;
    }
    return got >= Math.ceil(per * 0.8) ? { delta, volume, large } : null;
  });
}

// ------------------------------------------------------------------ tape
/** 24. CVD divergence: price makes a lower low (higher high) while the tape's cumulative delta does not -- then turns. */
const cvdDivergence = ({ bars, a, ctx }: DetectInput): Setup | null => {
  const look = bars.slice(-30), fl = barFlow(look, ctx);
  if (fl.some((f) => f === null)) return null;
  let c = 0;
  const cvd = fl.map((f) => (c += f!.delta));
  const b = last(look);
  for (const dir of [1, -1] as const) {
    const ps = pivots(look.slice(0, -1), dir === 1 ? 'low' : 'high').slice(-2);
    if (ps.length < 2) continue;
    const [p1, p2] = ps as [typeof ps[0], typeof ps[0]];
    const priceFurther = dir === 1 ? p2.price < p1.price : p2.price > p1.price;
    const cvdHolds = dir === 1 ? cvd[p2.i]! > cvd[p1.i]! : cvd[p2.i]! < cvd[p1.i]!;
    if (!priceFurther || !cvdHolds || !turned(b, prev(look), dir)) continue;
    return {
      dir,
      steps: [{ label: `price a ${dir === 1 ? 'lower low' : 'higher high'}, cumulative delta not`, ok: true }, { label: 'turned', ok: true }],
      zone: atClose(b, dir, a), stop: p2.price, triggerTime: b.time,
    };
  }
  return null;
};

/** 25. Delta divergence: a new 20-bar extreme made on weak delta, then a turn back. */
const deltaDivergence = ({ bars, a, ctx }: DetectInput): Setup | null => {
  const look = bars.slice(-22), fl = barFlow(look, ctx);
  const p = prev(look), b = last(look), fp = fl[fl.length - 2], prior = fl.slice(-12, -2);
  if (!fp || prior.some((f) => f === null)) return null;
  const ref = look.slice(0, -2);
  for (const dir of [1, -1] as const) {
    const newExtreme = dir === -1 ? p.high > hiOf(ref) : p.low < loOf(ref);
    const strongest = Math.max(...prior.map((f) => -dir * f!.delta));
    if (!newExtreme || !(-dir * fp.delta < 0.5 * strongest) || !turned(b, p, dir)) continue;
    return {
      dir,
      steps: [{ label: `a new 20-bar ${dir === -1 ? 'high' : 'low'} on weak delta`, ok: true }, { label: 'turned', ok: true }],
      zone: atClose(b, dir, a), stop: dir === -1 ? p.high : p.low, triggerTime: b.time,
    };
  }
  return null;
};

/** 27. Exhaustion: a 2-ATR bar on a delta climax (twice the usual), no further progress, then a turn against it. */
const exhaustion = ({ bars, a, ctx }: DetectInput): Setup | null => {
  const look = bars.slice(-24), fl = barFlow(look, ctx);
  if (fl.slice(-24).some((f) => f === null)) return null;
  const usual = fl.slice(0, -4).reduce((s, f) => s + Math.abs(f!.delta), 0) / Math.max(1, fl.length - 4);
  for (let k = look.length - 4; k < look.length - 1; k++) {
    const x = look[k]!, f = fl[k]!;
    if (!(range(x) >= 2 * a && Math.abs(f.delta) >= 2 * usual)) continue;
    const d: 1 | -1 = x.close > x.open ? 1 : -1, dir = (-d) as 1 | -1;
    const after = look.slice(k + 1);
    const stalled = d === 1 ? hiOf(after) <= x.high : loOf(after) >= x.low;
    const b = last(look);
    if (!stalled || !turned(b, prev(look), dir)) continue;
    return {
      dir,
      steps: [{ label: `a ${(range(x) / a).toFixed(1)} ATR bar on a delta climax`, ok: true }, { label: 'no further progress, turned', ok: true }],
      zone: atClose(b, dir, a), stop: d === 1 ? x.high : x.low, triggerTime: b.time,
    };
  }
  return null;
};

/** 66. Big-print follow-through: the bar's large-print net three times the usual, closed past the bar before in its direction. */
const bigPrint = ({ bars, a, ctx }: DetectInput): Setup | null => {
  const look = bars.slice(-22), fl = barFlow(look, ctx), f = fl[fl.length - 1], prior = fl.slice(0, -1);
  if (!f || prior.some((x) => x === null) || f.large === 0) return null;
  const usual = prior.reduce((s, x) => s + Math.abs(x!.large), 0) / prior.length;
  const dir: 1 | -1 = f.large > 0 ? 1 : -1, b = last(look), p = prev(look);
  if (!(Math.abs(f.large) >= 3 * Math.max(usual, 1)) || !(dir === 1 ? b.close > p.high : b.close < p.low)) return null;
  return {
    dir,
    steps: [{ label: `large prints ${dir === 1 ? 'bought' : 'sold'}, ${(Math.abs(f.large) / Math.max(usual, 1)).toFixed(1)}x the usual`, ok: true }, { label: 'closed through the bar before', ok: true }],
    zone: atClose(b, dir, a), stop: dir === 1 ? b.low : b.high, triggerTime: b.time,
  };
};

/** 67 / 68. Velocity: three bars trading three times the usual volume, one-sided, through the 20-bar extreme. */
const velocity = ({ bars, a, ctx }: DetectInput): Setup | null => {
  const look = bars.slice(-33), fl = barFlow(look, ctx);
  if (fl.some((f) => f === null)) return null;
  const now3 = fl.slice(-3).reduce((s, f) => s + f!.volume, 0), usual3 = (fl.slice(0, -3).reduce((s, f) => s + f!.volume, 0) / (fl.length - 3)) * 3;
  const net = fl.slice(-3).reduce((s, f) => s + f!.delta, 0), b = last(look), ref = look.slice(-23, -1);
  const dir: 1 | -1 | 0 = net > 0 && b.close > hiOf(ref) ? 1 : net < 0 && b.close < loOf(ref) ? -1 : 0;
  if (dir === 0 || !(now3 >= 3 * usual3)) return null;
  return {
    dir,
    steps: [{ label: `volume ${(now3 / usual3).toFixed(1)}x the usual, ${dir === 1 ? 'bought' : 'sold'}`, ok: true }, { label: 'through the 20-bar extreme', ok: true }],
    zone: atClose(b, dir, a), stop: dir === 1 ? loOf(look.slice(-3)) : hiOf(look.slice(-3)), triggerTime: b.time,
  };
};

/** 70. CVD regime shift: the tape's cumulative delta turns (12 bars against the 12 before) and price closes the new way through the last six bars. */
const cvdShift = ({ bars, a, ctx }: DetectInput): Setup | null => {
  const look = bars.slice(-24), fl = barFlow(look, ctx);
  if (fl.some((f) => f === null)) return null;
  const before = fl.slice(0, 12).reduce((s, f) => s + f!.delta, 0), now = fl.slice(12).reduce((s, f) => s + f!.delta, 0);
  const dir: 1 | -1 | 0 = before < 0 && now > 0 ? 1 : before > 0 && now < 0 ? -1 : 0;
  const b = last(look), six = look.slice(-7, -1);
  if (dir === 0 || !(Math.abs(now) >= Math.abs(before)) || !(dir === 1 ? b.close > hiOf(six) : b.close < loOf(six))) return null;
  return {
    dir,
    steps: [{ label: `cumulative delta turned ${dir === 1 ? 'up' : 'down'}`, ok: true }, { label: 'price closed the new way', ok: true }],
    zone: atClose(b, dir, a), stop: dir === 1 ? loOf(six) : hiOf(six), triggerTime: b.time,
  };
};

// ------------------------------------------------------------------ the perpetual against its index, its mark, its funding
const fresh = (ctx: EntryContext, at: number | undefined) => at !== undefined && ctx.now - at <= FRESH_MS;

/** 47. Basis: the perpetual 0.08% or more from the BTC index, and turning back toward it -- convergence. */
const basis = ({ bars, a, ctx }: DetectInput): Setup | null => {
  const q = ctx.quote, l = ctx.ltp;
  if (!q?.index || !l || !fresh(ctx, q.at) || !fresh(ctx, l.at)) return null;
  const pct = (100 * (l.price - q.index)) / q.index, b = last(bars);
  const dir: 1 | -1 | 0 = pct >= 0.08 ? -1 : pct <= -0.08 ? 1 : 0;
  if (dir === 0 || !turned(b, prev(bars), dir)) return null;
  return {
    dir,
    steps: [{ label: `basis ${pct >= 0 ? '+' : ''}${pct.toFixed(3)}% (perp − index)`, ok: true }, { label: 'turning back toward the index', ok: true }],
    zone: atClose(b, dir, a), stop: dir === 1 ? loOf(bars.slice(-3)) : hiOf(bars.slice(-3)), triggerTime: b.time,
    targets: [{ price: q.index, why: `index ${fmt(q.index)}` }],
  };
};

/** 49. Mark divergence: the last trade 0.08% or more from the mark price -- back toward the mark. */
const markDivergence = ({ bars, a, ctx }: DetectInput): Setup | null => {
  const q = ctx.quote, l = ctx.ltp;
  if (!q?.mark || !l || !fresh(ctx, q.at) || !fresh(ctx, l.at)) return null;
  const pct = (100 * (l.price - q.mark)) / q.mark, b = last(bars);
  const dir: 1 | -1 | 0 = pct >= 0.08 ? -1 : pct <= -0.08 ? 1 : 0;
  if (dir === 0) return null;
  return {
    dir,
    steps: [{ label: `last trade ${pct.toFixed(3)}% from the mark`, ok: true }],
    zone: atClose(b, dir, a), stop: dir === 1 ? loOf(bars.slice(-3)) : hiOf(bars.slice(-3)), triggerTime: b.time,
    targets: [{ price: q.mark, why: `mark ${fmt(q.mark)}` }],
  };
};

/** 31. Funding against price: funding stretched one way (0.02% a period or more), a new 20-bar extreme that way, then a turn -- crowded positioning. */
const fundingDivergence = ({ bars, a, ctx }: DetectInput): Setup | null => {
  const f = ctx.quote?.funding;
  if (f === null || f === undefined || !fresh(ctx, ctx.quote?.at)) return null;
  const ref = bars.slice(-24, -3), recent = bars.slice(-3), b = last(bars);
  const dir: 1 | -1 | 0 = f >= 0.02 && hiOf(recent) > hiOf(ref) ? -1 : f <= -0.02 && loOf(recent) < loOf(ref) ? 1 : 0;
  if (dir === 0 || !turned(b, prev(bars), dir)) return null;
  return {
    dir,
    steps: [{ label: `funding ${f.toFixed(4)}% -- ${f > 0 ? 'longs' : 'shorts'} crowded`, ok: true }, { label: 'a new extreme, then a turn', ok: true }],
    zone: atClose(b, dir, a), stop: dir === -1 ? hiOf(recent) : loOf(recent), triggerTime: b.time,
  };
};

// ------------------------------------------------------------------ the option board
/** 52. OI wall break and retest: a close through the call (put) wall, held, retested, held again -- continuation. */
const wallBreak = ({ bars, a, ctx }: DetectInput): Setup | null => {
  const o = ctx.options;
  if (!o) return null;
  const since = bars.slice(-8, -2), b = last(bars), retest = bars.slice(-3);
  for (const [dir, wall] of [[1, o.callWall], [-1, o.putWall]] as const) {
    if (wall === null) continue;
    const broke = since.some((x) => (dir === 1 ? x.close > wall : x.close < wall));
    const held = bars.slice(-6).every((x) => (dir === 1 ? x.close > wall - 0.1 * a : x.close < wall + 0.1 * a));
    const back = retest.some((x) => (dir === 1 ? x.low <= wall + 0.15 * a : x.high >= wall - 0.15 * a));
    if (!broke || !held || !back || !(dir === 1 ? bullish(b) : bearish(b))) continue;
    return {
      dir,
      steps: [{ label: `closed through the ${dir === 1 ? 'call' : 'put'} wall ${fmt(wall)}`, ok: true }, { label: 'retested it and held', ok: true }],
      zone: atClose(b, dir, a), stop: dir === 1 ? loOf(retest) : hiOf(retest), triggerTime: b.time,
    };
  }
  return null;
};

/** 35. Expected-move edge: price at the day's expected-move boundary (from the 17:30 IST settlement), exhausted, turning back. */
const emEdge = ({ bars, a, ctx }: DetectInput): Setup | null => {
  const o = ctx.options;
  if (!o || o.emDay === null) return null;
  const b = last(bars), noon = b.time - (b.time % 86_400) + 12 * 3600, anchorT = b.time >= noon ? noon : noon - 86_400;
  const anchor = bars.find((x) => x.time >= anchorT);
  if (!anchor) return null;
  const up = anchor.open + o.emDay, dn = anchor.open - o.emDay, recent = bars.slice(-3);
  const dir: 1 | -1 | 0 = hiOf(recent) >= up - 0.1 * a && b.close < up ? -1 : loOf(recent) <= dn + 0.1 * a && b.close > dn ? 1 : 0;
  if (dir === 0 || !turned(b, prev(bars), dir)) return null;
  return {
    dir,
    steps: [{ label: `at the expected-move ${dir === -1 ? 'top' : 'bottom'} ${fmt(dir === -1 ? up : dn)}`, ok: true }, { label: 'turned back', ok: true }],
    zone: atClose(b, dir, a), stop: dir === -1 ? hiOf(recent) : loOf(recent), triggerTime: b.time,
    targets: [{ price: anchor.open, why: `settlement price ${fmt(anchor.open)}` }],
  };
};

/** 60. Expiry pin: in the last two hours before settlement, price away from max pain turns toward it. */
const expiryPin = ({ bars, a, ctx }: DetectInput): Setup | null => {
  const o = ctx.options;
  if (!o || o.maxPain === null || o.toSettleSec === null || !(o.toSettleSec > 600 && o.toSettleSec <= 7_200)) return null;
  const b = last(bars), away = b.close - o.maxPain;
  if (!(Math.abs(away) >= 0.6 * a && Math.abs(away) <= 4 * a)) return null;
  const dir: 1 | -1 = away > 0 ? -1 : 1;
  if (!turned(b, prev(bars), dir)) return null;
  return {
    dir,
    steps: [{ label: `${Math.round(o.toSettleSec! / 60)} min to settlement, ${fmt(Math.abs(away))} pts from max pain ${fmt(o.maxPain)}`, ok: true }, { label: 'turning toward it', ok: true }],
    zone: atClose(b, dir, a), stop: dir === 1 ? loOf(bars.slice(-3)) : hiOf(bars.slice(-3)), triggerTime: b.time,
    targets: [{ price: o.maxPain, why: `max pain ${fmt(o.maxPain)}` }],
  };
};

const tgt = (tp1: TargetSpec['tp1'], tp2: TargetSpec['tp2']): TargetSpec => ({ tp1, tp2 });

/** The live-data candidates, by the owner's numbers. */
export const LIVE_CANDIDATES: readonly Candidate[] = [
  { id: 'cvd-divergence', n: 24, name: 'CVD divergence', family: 'flow', sl: 'the divergent swing', targets: tgt('nearest', 'next'), detect: cvdDivergence },
  { id: 'delta-divergence', n: 25, name: 'Delta divergence', family: 'flow', sl: 'the weak-delta extreme', targets: tgt('nearest', 'next'), detect: deltaDivergence },
  { id: 'exhaustion', n: 27, name: 'Exhaustion reversal', family: 'flow', sl: 'the climax bar\'s extreme', targets: tgt('nearest', 'next'), detect: exhaustion },
  { id: 'funding-divergence', n: 31, name: 'Funding + price divergence', family: 'flow', sl: 'the new extreme', targets: tgt('nearest', 'next'), detect: fundingDivergence },
  { id: 'em-edge', n: 35, name: 'Expected-move edge reaction', family: 'flow', sl: 'the edge touch extreme', targets: tgt('own', 'next'), detect: emEdge },
  { id: 'basis', n: 47, name: 'Basis divergence (perp vs index)', family: 'flow', sl: 'the turn extreme', targets: tgt('own', 'next'), detect: basis },
  { id: 'mark-divergence', n: 49, name: 'Mark-perp divergence', family: 'flow', sl: 'the turn extreme', targets: tgt('own', 'next'), detect: markDivergence },
  { id: 'wall-break', n: 52, name: 'OI wall break & retest', family: 'flow', sl: 'the retest extreme', targets: tgt('nearest', 'oi'), detect: wallBreak },
  { id: 'expiry-pin', n: 60, name: 'Expiry pin / max-pain magnet', family: 'flow', sl: 'the turn extreme', targets: tgt('own', 'next'), detect: expiryPin },
  { id: 'big-print', n: 66, name: 'Big-print follow-through', family: 'flow', sl: 'the print bar\'s far end', targets: tgt('nearest', 'next'), detect: bigPrint },
  { id: 'velocity', n: 67, name: 'Trade velocity / aggression spike', family: 'flow', sl: 'the spike\'s far end', targets: tgt('nearest', 'next'), detect: velocity },
  { id: 'cvd-shift', n: 70, name: 'CVD regime shift', family: 'flow', sl: 'the six-bar extreme', targets: tgt('nearest', 'next'), detect: cvdShift },
];
