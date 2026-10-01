import type { Candle } from '../market/delta.js';
import type { EntryContext, Group, MethodId } from './types.js';
import {
  PIVOT_K, body, bullish, bearish, closeLocation, donchian, efficiency, ema, isDisplacement, lastBreak, lastSweep,
  openFvgs, orderBlocks, pivots, range, rvol, trendOf, vwapBand,
} from './prims.js';

/**
 * The twelve entry methods of TEST.md, each as its own trigger chain on one
 * timeframe, to the owner's reference formulas (30 Sep 2026,
 * docs/features/entry-methods-reference.md).
 *
 * A detector reads closed candles and answers: is this method's setup forming
 * here, which way, which of its steps have happened, where would it enter and
 * where is it wrong. It does not decide TRADE / WAIT / NO TRADE -- the engine
 * does, the same way for all twelve, after the gates, the targets and (with the
 * timeframe chain) the other timeframes. Null: nothing forming.
 */

export type Setup = {
  dir: 1 | -1;
  /** The method's own chain, in order. `ok` null: could not be read. */
  steps: { label: string; ok: boolean | null }[];
  /** Where to enter: a zone, low to high. */
  zone: [number, number];
  /** Where the setup is wrong, before the volatility buffer. */
  stop: number;
  /** The bar the setup is anchored to (epoch s): its identity in the log. */
  triggerTime: number;
  /** Targets this method has of its own, nearest first: VWAP then the band past it (10). */
  targets?: { price: number; why: string }[];
  /** A TP3 of its own, used when it lies past TP2: max pain (12). */
  tp3?: { price: number; why: string };
  /** A reason this method must not be taken now, whatever else holds. */
  blocked?: string;
};

export type DetectInput = { bars: readonly Candle[]; a: number; trend: -1 | 0 | 1; ctx: EntryContext };
type Detector = (m: DetectInput) => Setup | null;

/*
 * The thresholds, from the owner's reference formulas (docs/features/entry-methods-reference.md).
 * They are the design, not measurements: the paper log judges them.
 */
/** RVOL a breakout or a momentum bar needs: Volume / SMA(Volume, 20). */
export const RVOL_MIN = 1.5;
/** Where a breakout bar must close in its range (long; short is 1 minus it). */
export const BREAKOUT_CLOSE_LOC = 0.7;
/** Where a momentum bar must close in its range. */
export const MOMENTUM_CLOSE_LOC = 0.75;
/** A momentum bar's body, in ATRs. */
export const MOMENTUM_BODY_ATR = 1.5;
/** Opened this many ATRs from the 20 EMA already: extended, not chased. */
export const MAX_EXTENSION_ATR = 3;
/** How far past a swing a sweep must trade, in ATRs. */
export const SWEEP_BUFFER_ATR = 0.1;
/** Within this many ATRs of a level counts as touching it. */
export const TOUCH_ATR = 0.3;
/** A close past a level by more than this many ATRs has lost it. */
export const HOLD_TOL_ATR = 0.1;
/** Standard deviations from VWAP that count as stretched. */
export const VWAP_SIGMA = 2;
/** Efficiency over 20 bars above this is a trend day: mean reversion is off. */
export const TREND_DAY_ER = 0.6;
/** A retest, a reaction or a stretch must be this recent, in bars. */
export const RECENT_BARS = 3;

const last = (bars: readonly Candle[]) => bars[bars.length - 1]!;
const prev = (bars: readonly Candle[]) => bars[bars.length - 2]!;
/** A zone of `w` ATRs on the side of `px` the trade enters from. */
const near = (px: number, dir: 1 | -1, a: number, w = 0.25): [number, number] =>
  dir === 1 ? [px, px + w * a] : [px - w * a, px];
/** Just behind the close: entering on the bar that signalled. */
const atClose = (b: Candle, dir: 1 | -1, a: number, w = 0.25): [number, number] =>
  dir === 1 ? [b.close - w * a, b.close] : [b.close, b.close + w * a];
const turned = (b: Candle, p: Candle, dir: 1 | -1) =>
  dir === 1 ? bullish(b) && b.close > p.high : bearish(b) && b.close < p.low;
const withDir = (b: Candle, dir: 1 | -1) => (dir === 1 ? bullish(b) : bearish(b));
const wickShare = (b: Candle, dir: 1 | -1) =>
  range(b) > 0 ? (dir === 1 ? Math.min(b.open, b.close) - b.low : b.high - Math.max(b.open, b.close)) / range(b) : 0;
const extremeSince = (bars: readonly Candle[], i: number, dir: 1 | -1) =>
  dir === 1 ? Math.min(...bars.slice(i).map((b) => b.low)) : Math.max(...bars.slice(i).map((b) => b.high));
/** Touching a level from the trade's side, within TOUCH_ATR. */
const touches = (x: Candle, level: number, dir: 1 | -1, a: number) =>
  dir === 1 ? x.low <= level + TOUCH_ATR * a : x.high >= level - TOUCH_ATR * a;
/** Closed on the trade's side of a level. */
const closedBeyond = (x: Candle, level: number, dir: 1 | -1) => (dir === 1 ? x.close > level : x.close < level);
/** Closed through a level against the trade, by more than the tolerance. */
const lostLevel = (x: Candle, level: number, dir: 1 | -1, a: number) =>
  dir === 1 ? x.close < level - HOLD_TOL_ATR * a : x.close > level + HOLD_TOL_ATR * a;
/** A rejection at a level: a wick into it, or a candle closing the trade's way. */
const rejects = (x: Candle, dir: 1 | -1) => wickShare(x, dir) >= 0.3 || withDir(x, dir);
/** The swing on `side` most recently confirmed before bar `i`. */
const swingBefore = (bars: readonly Candle[], side: 'high' | 'low', i: number) =>
  [...pivots(bars, side)].reverse().find((p) => p.i + PIVOT_K < i) ?? null;

/**
 * The perpetual's aggressor delta (buy − sell, contracts) over closed minutes
 * from `fromMin` to `toMin` minutes ago. Null when fewer than `need` of those
 * minutes were recorded -- an unread tape is never read as a quiet one.
 */
function tapeDelta(ctx: EntryContext, fromMin: number, toMin: number, need = 2): number | null {
  const now = Math.floor(ctx.now / 1000);
  const ms = ctx.flow.filter((m) => m.time >= now - fromMin * 60 && m.time < now - toMin * 60);
  return ms.length >= need ? ms.reduce((s, m) => s + m.buy - m.sell, 0) : null;
}
const sign = (v: number | null, dir: 1 | -1) => (v === null ? null : v * dir > 0);

/**
 * 1. Breakout -- Close > RangeHigh20 AND RVOL >= 1.5 AND CloseLocation >= 0.70.
 * Short: Close < RangeLow20, CloseLocation <= 0.30.
 */
const breakout: Detector = ({ bars, a }) => {
  const d = donchian(bars, 20);
  const b = last(bars);
  if (!d) return null;
  const dir = b.close > d.hi ? 1 : b.close < d.lo ? -1 : 0;
  if (dir === 0) return null;
  const rv = rvol(bars);
  const cl = closeLocation(b);
  return {
    dir,
    steps: [
      { label: `closed ${dir === 1 ? 'over the 20-bar high' : 'under the 20-bar low'}`, ok: true },
      { label: `RVOL ${RVOL_MIN} or more${rv === null ? '' : ` (${rv.toFixed(1)})`}`, ok: rv === null ? null : rv >= RVOL_MIN },
      { label: `closed near its ${dir === 1 ? 'high' : 'low'} (close location ${cl.toFixed(2)})`, ok: dir === 1 ? cl >= BREAKOUT_CLOSE_LOC : cl <= 1 - BREAKOUT_CLOSE_LOC },
    ],
    zone: atClose(b, dir, a),
    stop: dir === 1 ? b.low : b.high,
    triggerTime: b.time,
  };
};

/**
 * 2. Breakout + retest -- BreakoutConfirmed AND Low <= BrokenLevel + tolerance
 * AND Close > BrokenLevel AND rejection. A close back through the level
 * (past the tolerance) at any point since is a fake breakout.
 */
const breakoutRetest: Detector = ({ bars, a }) => {
  for (let j = bars.length - 2; j >= Math.max(21, bars.length - 13); j--) {
    const d = donchian(bars.slice(0, j + 1), 20);
    const bj = bars[j]!;
    if (!d) continue;
    const dir = bj.close > d.hi ? 1 : bj.close < d.lo ? -1 : 0;
    if (dir === 0) continue;
    const level = dir === 1 ? d.hi : d.lo;
    const after = bars.slice(j + 1);
    const b = last(bars);
    const retest = touches(b, level, dir, a) && closedBeyond(b, level, dir);
    return {
      dir,
      steps: [
        { label: `broke ${dir === 1 ? 'the 20-bar high' : 'the 20-bar low'}`, ok: true },
        { label: 'no close back through the level since (not a fake)', ok: !after.some((x) => lostLevel(x, level, dir, a)) },
        { label: `retest: touched the level and closed ${dir === 1 ? 'above' : 'below'} it`, ok: retest },
        { label: 'rejected it (a wick, or a candle its way)', ok: retest && rejects(b, dir) },
      ],
      zone: near(level, dir, a),
      stop: extremeSince(bars, j + 1, dir),
      triggerTime: bj.time,
    };
  }
  return null;
};

/**
 * 3. Liquidity sweep -- Low < SwingLow − buffer AND Close > SwingLow (the
 * sweep, on one bar) AND Close > LastLowerHigh (the MSS). The entry is a
 * limit at the MSS level: the paper log fills it only if price comes back.
 */
const liquiditySweep: Detector = ({ bars, a }) => {
  const s = lastSweep(bars, 8, SWEEP_BUFFER_ATR * a);
  if (!s) return null;
  const dir = s.dir;
  const lh = swingBefore(bars, dir === 1 ? 'high' : 'low', s.i);
  const level = lh?.price ?? null;
  const mss = level !== null && bars.slice(s.i + 1).some((x) => closedBeyond(x, level, dir));
  return {
    dir,
    steps: [
      { label: `swept ${dir === 1 ? 'a swing low' : 'a swing high'} by ${SWEEP_BUFFER_ATR} ATR or more`, ok: true },
      { label: `recovered: closed back ${dir === 1 ? 'above' : 'below'} it`, ok: true },
      { label: `MSS: closed through the last ${dir === 1 ? 'lower high' : 'higher low'}`, ok: level === null ? null : mss },
    ],
    zone: near(level ?? last(bars).close, dir, a),
    stop: extremeSince(bars, s.i, dir),
    triggerTime: s.time,
  };
};

/**
 * 4. FVG retest -- BullishDisplacement AND FVG (Low[0] > High[2]) AND price
 * back in the gap AND a reaction (a candle closing up out of it), the touch
 * and the reaction within the last few bars.
 */
const fvgRetest: Detector = ({ bars }) => {
  const z = openFvgs(bars, 30)[0];
  if (!z) return null;
  const dir = z.dir;
  const inGap = (x: Candle) => (dir === 1 ? x.low <= z.hi : x.high >= z.lo);
  const since = bars.slice(z.i + 2);
  const b = last(bars);
  const recent = bars.slice(-RECENT_BARS).filter((x) => since.includes(x));
  const cameBack = recent.some(inGap);
  return {
    dir,
    steps: [
      { label: `a ${dir === 1 ? 'bullish' : 'bearish'} gap left by displacement`, ok: true },
      { label: 'price back in the gap', ok: cameBack },
      { label: `reaction: closed ${dir === 1 ? 'up' : 'down'} out of it`, ok: cameBack && withDir(b, dir) && (dir === 1 ? b.close > z.hi - 0.5 * (z.hi - z.lo) : b.close < z.lo + 0.5 * (z.hi - z.lo)) },
    ],
    // From the edge price reaches first to the gap's middle (its consequent encroachment), not the whole gap.
    zone: dir === 1 ? [(z.lo + z.hi) / 2, z.hi] : [z.lo, (z.lo + z.hi) / 2],
    // The displacement's origin -- the far end of the candle that left the gap (owner's SL/TP table, 1 Oct
    // 2026): the move is wrong once price trades back through where it started. Not past the gap's first
    // candle, which could be far away (847 points on a 3m short, 30 Sep 2026); the stop band gate caps it.
    stop: dir === 1 ? Math.min(bars[z.i]!.low, z.lo) : Math.max(bars[z.i]!.high, z.hi),
    triggerTime: z.time,
  };
};

/**
 * 5. Order-block retest -- a valid OB (the last opposite candle before a
 * displacement that broke structure) AND price enters it AND rejection
 * (closes back out). Invalidation: a close through its far side.
 */
const obRetest: Detector = ({ bars }) => {
  const z = orderBlocks(bars, 40)[0];
  if (!z) return null;
  const dir = z.dir;
  const b = last(bars);
  const since = bars.slice(z.i + 2);
  const entered = bars.slice(-RECENT_BARS).filter((x) => since.includes(x)).some((x) => (dir === 1 ? x.low <= z.hi : x.high >= z.lo));
  return {
    dir,
    steps: [
      { label: 'an order block behind a BOS / MSS', ok: true },
      { label: 'price entered the block', ok: entered },
      { label: 'rejected there: closed back out of it', ok: entered && withDir(b, dir) && (dir === 1 ? b.close > z.hi : b.close < z.lo) },
    ],
    // From the block's edge price reaches first to its mean threshold (the 50% line), not the whole candle.
    zone: dir === 1 ? [(z.lo + z.hi) / 2, z.hi] : [z.lo, (z.lo + z.hi) / 2],
    stop: dir === 1 ? z.lo : z.hi,
    triggerTime: z.time,
  };
};

/**
 * 6. BOS -- Close > PreviousSwingHigh AND displacement AND trend aligned.
 * The entry is a limit at the broken level (the retest the reference prefers).
 */
const bos: Detector = ({ bars, a, trend }) => {
  const br = lastBreak(bars, 4);
  if (!br) return null;
  const dir = br.dir;
  const hl = swingBefore(bars, dir === 1 ? 'low' : 'high', br.i);
  const bb = bars[br.i]!;
  return {
    dir,
    steps: [
      { label: `BOS: closed through the swing ${dir === 1 ? 'high' : 'low'}`, ok: true },
      { label: 'by displacement (a 1 ATR body, its way)', ok: isDisplacement(bb, a, 1) && withDir(bb, dir) },
      { label: `trend aligned (${dir === 1 ? 'HH/HL over the EMAs' : 'LH/LL under the EMAs'})`, ok: trend === dir },
    ],
    zone: near(br.level, dir, a),
    stop: hl?.price ?? extremeSince(bars, Math.max(0, br.i - 5), dir),
    triggerTime: br.time,
  };
};

/**
 * 7. MSS / CHoCH -- bearish structure, a liquidity sweep, bullish
 * displacement, Close > LastLowerHigh; then MSS + retest = entry.
 */
const mss: Detector = ({ bars, a }) => {
  const br = lastBreak(bars, 6);
  if (!br) return null;
  const dir = br.dir;
  if (trendOf(bars.slice(0, br.i)) !== -dir) return null;
  const sw = lastSweep(bars.slice(0, br.i + 1), 12, SWEEP_BUFFER_ATR * a);
  const swept = sw !== null && sw.dir === dir;
  const b = last(bars);
  const bb = bars[br.i]!;
  return {
    dir,
    steps: [
      { label: `the structure was ${dir === 1 ? 'bearish' : 'bullish'}`, ok: true },
      { label: 'liquidity swept first', ok: swept },
      { label: `CHoCH: closed through the last ${dir === 1 ? 'lower high' : 'higher low'}`, ok: true },
      { label: 'by displacement', ok: isDisplacement(bb, a, 1) && withDir(bb, dir) },
      { label: 'retest of the break holds', ok: br.i < bars.length - 1 && touches(b, br.level, dir, a) && closedBeyond(b, br.level, dir) },
    ],
    zone: near(br.level, dir, a),
    stop: extremeSince(bars, Math.max(0, (swept ? sw!.i : br.i) - 1), dir),
    triggerTime: br.time,
  };
};

/**
 * 8. Momentum -- Body >= 1.5 ATR AND RVOL >= 1.5 AND CloseLocation >= 0.75
 * AND FollowThrough (the next bar closes further its way) AND not extended
 * (opened within 3 ATR of the 20 EMA). Extended: no chase.
 */
const momentum: Detector = ({ bars, a }) => {
  const n = bars.length;
  const isSignal = (b: Candle) => body(b) >= MOMENTUM_BODY_ATR * a;
  // The signal is the newest bar (follow-through still to come) or the one before it.
  const at = isSignal(bars[n - 1]!) ? n - 1 : isSignal(bars[n - 2]!) ? n - 2 : -1;
  if (at < 0) return null;
  const sig = bars[at]!;
  const dir: 1 | -1 = bullish(sig) ? 1 : -1;
  const rv = rvol(bars, 20, at);
  const cl = closeLocation(sig);
  const next = at < n - 1 ? bars[at + 1]! : null;
  const e20 = ema(bars.slice(0, at), 20);
  const stretch = e20 === null ? null : Math.abs(sig.open - e20) / a;
  const b = last(bars);
  return {
    dir,
    steps: [
      { label: `a body of ${MOMENTUM_BODY_ATR} ATR or more`, ok: true },
      { label: `RVOL ${RVOL_MIN} or more${rv === null ? '' : ` (${rv.toFixed(1)})`}`, ok: rv === null ? null : rv >= RVOL_MIN },
      { label: `closed near its ${dir === 1 ? 'high' : 'low'} (close location ${cl.toFixed(2)})`, ok: dir === 1 ? cl >= MOMENTUM_CLOSE_LOC : cl <= 1 - MOMENTUM_CLOSE_LOC },
      { label: 'follow-through: the next bar closed further its way', ok: next !== null && closedBeyond(next, sig.close, dir) },
    ],
    zone: atClose(b, dir, a),
    stop: dir === 1 ? Math.min(sig.low, b.low) : Math.max(sig.high, b.high),
    triggerTime: sig.time,
    ...(stretch !== null && stretch > MAX_EXTENSION_ATR ? { blocked: `extended: opened ${stretch.toFixed(1)} ATR from the 20 EMA -- no chase` } : {}),
  };
};

/**
 * 9. Pullback -- trend (HH + HL over the EMAs) AND price back to the 20 EMA
 * AND rejection from it (closed back on the trend's side) AND a micro BOS
 * (closed past the prior bar's high).
 */
const pullback: Detector = ({ bars, a, trend }) => {
  if (trend === 0) return null;
  const dir = trend;
  const e20 = ema(bars, 20);
  if (e20 === null) return null;
  const recent = bars.slice(-4);
  const touched = dir === 1 ? Math.min(...recent.map((x) => x.low)) <= e20 + 0.2 * a : Math.max(...recent.map((x) => x.high)) >= e20 - 0.2 * a;
  if (!touched) return null;
  const b = last(bars);
  const extremeIdx = bars.length - 4 + recent.findIndex((x) => (dir === 1 ? x.low : x.high) === (dir === 1 ? Math.min(...recent.map((y) => y.low)) : Math.max(...recent.map((y) => y.high))));
  return {
    dir,
    steps: [
      { label: `trend ${dir === 1 ? 'up: HH/HL over the 20/50 EMA' : 'down: LH/LL under the 20/50 EMA'}`, ok: true },
      { label: 'pulled back to the 20 EMA', ok: true },
      { label: `rejected it: closed ${dir === 1 ? 'above' : 'below'} the 20 EMA`, ok: closedBeyond(b, e20, dir) },
      { label: `micro BOS: closed past the prior bar's ${dir === 1 ? 'high' : 'low'}`, ok: turned(b, prev(bars), dir) },
    ],
    zone: atClose(b, dir, a),
    stop: extremeSince(bars, bars.length - 4, dir),
    triggerTime: bars[extremeIdx]?.time ?? b.time,
  };
};

/**
 * 10. VWAP / mean reversion -- the stretch (Price − VWAP) / σ at least 2 in
 * the last few bars AND a reversal candle AND delta improving AND price
 * returning toward VWAP. Off on a trend day.
 */
const vwapReversion: Detector = ({ bars, a, ctx }) => {
  const vb = vwapBand(bars);
  if (!vb || !(vb.sd > 0)) return null;
  const recent = bars.slice(-RECENT_BARS);
  const lowest = recent.reduce((m, x) => (x.low < m.low ? x : m));
  const highest = recent.reduce((m, x) => (x.high > m.high ? x : m));
  const zLow = (lowest.low - vb.vwap) / vb.sd;
  const zHigh = (highest.high - vb.vwap) / vb.sd;
  // Stretched now, or in the last few bars: once it turns, the close is already coming back.
  const dir: 1 | -1 | 0 = zLow <= -VWAP_SIGMA && -zLow >= zHigh ? 1 : zHigh >= VWAP_SIGMA ? -1 : 0;
  if (dir === 0) return null;
  const ext = dir === 1 ? lowest : highest;
  const zExt = dir === 1 ? zLow : zHigh;
  const b = last(bars);
  const er = efficiency(bars, 20);
  const nowD = tapeDelta(ctx, 4, 1);
  const beforeD = tapeDelta(ctx, 7, 4);
  const improving = nowD === null || beforeD === null ? null : (nowD - beforeD) * dir > 0;
  return {
    dir,
    steps: [
      { label: `stretched ${Math.abs(zExt).toFixed(1)}σ from VWAP`, ok: true },
      { label: 'a reversal candle', ok: turned(b, prev(bars), dir) },
      { label: `delta ${dir === 1 ? 'improving' : 'weakening'} (last 3 min against the 3 before)`, ok: improving },
      { label: 'returning toward VWAP', ok: vb.z !== null && Math.abs(vb.z) < Math.abs(zExt) && closedBeyond(b, prev(bars).close, dir) },
    ],
    zone: atClose(b, dir, a, 0.2),
    stop: dir === 1 ? ext.low : ext.high,
    triggerTime: ext.time,
    // TP1 the VWAP itself; TP2 the band one σ past it on the other side.
    targets: [
      { price: vb.vwap, why: `VWAP ${Math.round(vb.vwap).toLocaleString('en-US')}` },
      { price: vb.vwap + dir * vb.sd, why: `VWAP ${dir === 1 ? '+' : '−'}1σ ${Math.round(vb.vwap + dir * vb.sd).toLocaleString('en-US')}` },
    ],
    ...(er !== null && er > TREND_DAY_ER ? { blocked: `trend day: price is travelling straight (efficiency ${er.toFixed(2)}), mean reversion is off` } : {}),
  };
};

/**
 * 11. Order flow -- at a key level AND absorption (the other side's
 * aggression, and price did not continue) AND the delta flips AND CVD turns
 * AND a micro BOS on 1m.
 *
 * Read from the perpetual's recorded tape (1m buy / sell volume) and the book's
 * persistent walls. Footprint -- volume at each price -- is not recorded yet, so
 * absorption is read from delta against price, which is what footprint would
 * show more finely.
 */
const orderFlow: Detector = ({ bars, a, ctx }) => {
  const b = last(bars);
  const lows = pivots(bars, 'low').map((p) => p.price);
  const highs = pivots(bars, 'high').map((p) => p.price);
  const bidWalls = ctx.walls.filter((w) => w.side === 'bid').map((w) => w.price);
  const askWalls = ctx.walls.filter((w) => w.side === 'ask').map((w) => w.price);
  const support = [...lows, ...bidWalls].filter((p) => p <= b.close && b.close - p <= 0.6 * a).sort((x, y) => y - x)[0];
  const resistance = [...highs, ...askWalls].filter((p) => p >= b.close && p - b.close <= 0.6 * a).sort((x, y) => x - y)[0];
  if (support === undefined && resistance === undefined) return null;
  const dir: 1 | -1 = resistance === undefined || (support !== undefined && b.close - support <= resistance - b.close) ? 1 : -1;
  const level = dir === 1 ? support! : resistance!;
  const now = Math.floor(ctx.now / 1000);
  const minutes = ctx.flow.filter((m) => m.time >= now - 7 * 60 && m.time < now - 60);
  const read = minutes.length >= 5;
  const one = ctx.frames['1m'] ?? [];
  const early = minutes.slice(0, -2);
  const late = minutes.slice(-2);
  const delta = (xs: typeof minutes) => xs.reduce((s, m) => s + m.buy - m.sell, 0);
  const pressed = read ? delta(early) * dir < 0 : null;
  const heldAt = one.length >= 7 ? extremeSince(one, one.length - 7, dir) : null;
  const held = heldAt === null ? null : dir === 1 ? heldAt >= level - 0.2 * a : heldAt <= level + 0.2 * a;
  // CVD turned: its extreme against the trade is behind it (not in the last two minutes) and it has come off it.
  let cvdTurned: boolean | null = null;
  if (read) {
    let c = 0;
    const cvd = minutes.map((m) => (c += (m.buy - m.sell) * dir));
    const worst = cvd.indexOf(Math.min(...cvd));
    cvdTurned = worst < cvd.length - 2 && cvd[cvd.length - 1]! > cvd[worst]!;
  }
  const m1 = one.slice(-4);
  const microBos = m1.length < 4 ? null : dir === 1
    ? m1[3]!.close > Math.max(...m1.slice(0, 3).map((x) => x.high))
    : m1[3]!.close < Math.min(...m1.slice(0, 3).map((x) => x.low));
  return {
    dir,
    steps: [
      { label: `at ${dir === 1 ? 'support (swing low / bid wall)' : 'resistance (swing high / ask wall)'}`, ok: true },
      { label: `absorption: ${dir === 1 ? 'sellers' : 'buyers'} hit it and it held`, ok: pressed === null || held === null ? null : pressed && held },
      { label: `delta flipped ${dir === 1 ? 'positive' : 'negative'}`, ok: read ? delta(late) * dir > 0 : null },
      { label: `CVD turned ${dir === 1 ? 'up' : 'down'}`, ok: cvdTurned },
      { label: `micro BOS: 1m closed past the last three 1m ${dir === 1 ? 'highs' : 'lows'}`, ok: microBos },
    ],
    zone: near(level, dir, a),
    stop: heldAt === null ? level : (dir === 1 ? Math.min(level, heldAt) : Math.max(level, heldAt)),
    triggerTime: b.time,
  };
};

/**
 * 12. Options / derivatives -- near an OI wall AND the wall holds AND price
 * rejects it AND spot structure not against AND big-move risk compatible AND
 * the tape its way. The OI wall alone never makes an entry.
 */
const optionsFlow: Detector = ({ bars, a, trend, ctx }) => {
  const o = ctx.options;
  if (!o) return null;
  const b = last(bars);
  const tol = Math.max(0.4 * a, b.close * 0.001);
  const atPut = o.putWall !== null && Math.abs(b.low - o.putWall) <= tol;
  const atCall = o.callWall !== null && Math.abs(b.high - o.callWall) <= tol;
  if (!atPut && !atCall) return null;
  const dir: 1 | -1 = atPut && (!atCall || Math.abs(b.low - o.putWall!) <= Math.abs(b.high - o.callWall!)) ? 1 : -1;
  const wall = dir === 1 ? o.putWall! : o.callWall!;
  const bm = ctx.bigMove;
  // No big-move reading: not read. A reading with no direction is not against anything.
  const compatible = bm === null ? null : bm.direction === null ? true : !((bm.band === 'high' || bm.band === 'sudden') && bm.direction * dir <= -0.3);
  const tp3 = o.maxPain !== null && (dir === 1 ? o.maxPain > b.close : o.maxPain < b.close)
    ? { price: o.maxPain, why: `max pain ${o.maxPain.toLocaleString('en-US')}` } : undefined;
  return {
    dir,
    steps: [
      { label: `at the ${dir === 1 ? 'put' : 'call'} OI wall ${wall.toLocaleString('en-US')}`, ok: true },
      { label: `the wall held: closed ${dir === 1 ? 'above' : 'below'} it`, ok: closedBeyond(b, wall, dir) },
      { label: 'price rejected it (closed past the prior bar)', ok: turned(b, prev(bars), dir) },
      { label: 'spot structure not against', ok: trend !== -dir },
      { label: 'big-move risk compatible', ok: compatible },
      { label: 'the tape its way (last 5 min delta)', ok: sign(tapeDelta(ctx, 6, 1, 3), dir) },
    ],
    zone: atClose(b, dir, a, 0.2),
    stop: dir === 1 ? Math.min(wall, b.low) : Math.max(wall, b.high),
    triggerTime: b.time,
    ...(tp3 ? { tp3 } : {}),
  };
};

/**
 * Where each method takes profit (owner's SL/TP tables, 1 Oct 2026). TP1, the
 * kind looked at first (engine.ts pickTargets takes the nearest that pays the
 * minimum R:R): `nearest` any liquidity; `swing` a swing on the entry
 * timeframe (the continuation / reaction / previous swing); `book` a book wall,
 * then a swing; `oi` an OI wall; `own` the method's own first target (VWAP). TP2, the next target at least half an ATR past TP1:
 * `htf` the next 1H/4H swing; `next` the next level of any kind; `own` the
 * method's own second target; `book` the next book wall or swing; `oi` the next
 * OI wall. Each falls back to the next real level of any kind -- never an
 * invented one. TP3: the expected-move edge, or the method's own (max pain).
 */
export type TargetSpec = { tp1: 'nearest' | 'swing' | 'own' | 'book' | 'oi'; tp2: 'htf' | 'next' | 'own' | 'book' | 'oi' };
const tgt = (tp1: TargetSpec['tp1'], tp2: TargetSpec['tp2']): TargetSpec => ({ tp1, tp2 });

/** `gate`: the method's own hard gate, in words, for the methods that have one. */
/** `sl`: where the method's stop goes, before the 0.25 ATR buffer (owner's SL/TP table, 1 Oct 2026). */
/** How a method is read: every method in this file, the twelve and the rest, in the same shape. */
export type MethodDef = {
  id: MethodId; n: number; name: string; group: Group; summary: string; gate?: string; sl: string;
  targets: TargetSpec; detect: Detector;
};
/** The first twelve, TEST.md's (the rest follow further down, and METHODS is all of them). */
const TWELVE: readonly MethodDef[] = [
  { id: 'breakout', n: 1, name: 'Breakout', group: 'breakout', summary: 'A close through the 20-bar range, RVOL 1.5, closing near its extreme', sl: "the breakout candle's far end", targets: tgt('swing', 'htf'), detect: breakout },
  { id: 'breakout-retest', n: 2, name: 'Breakout + retest', group: 'pullback', summary: 'A breakout, then a pullback to the level that holds', sl: "the retest extreme", targets: tgt('swing', 'htf'), detect: breakoutRetest },
  { id: 'liquidity-sweep', n: 3, name: 'Liquidity sweep', group: 'reversal', summary: 'Stops taken past a swing, a close back, then the MSS', sl: "the sweep extreme", targets: tgt('nearest', 'htf'), detect: liquiditySweep },
  { id: 'fvg-retest', n: 4, name: 'FVG retest', group: 'pullback', summary: 'Back into a gap left by displacement, and a reaction', sl: "the displacement origin", targets: tgt('swing', 'next'), detect: fvgRetest },
  { id: 'ob-retest', n: 5, name: 'Order-block retest', group: 'pullback', summary: 'Back into the last opposite candle before a break', sl: "the order block's far edge", targets: tgt('swing', 'htf'), detect: obRetest },
  { id: 'bos', n: 6, name: 'BOS', group: 'breakout', summary: 'A displacement close through a swing, with the trend', sl: "the last higher low / lower high", targets: tgt('swing', 'htf'), detect: bos },
  { id: 'mss', n: 7, name: 'MSS / CHoCH', group: 'reversal', summary: 'The trend turns: a sweep, then a close through the last swing', sl: "the post-sweep extreme", targets: tgt('nearest', 'htf'), detect: mss },
  { id: 'momentum', n: 8, name: 'Momentum', group: 'breakout', summary: 'A 1.5 ATR candle, RVOL 1.5, follow-through -- no chase when extended', gate: `not opened > ${MAX_EXTENSION_ATR} ATR from the 20 EMA (no chase)`, sl: "the momentum candle's far end", targets: tgt('nearest', 'next'), detect: momentum },
  { id: 'pullback', n: 9, name: 'Pullback', group: 'pullback', summary: 'A trend back to its 20 EMA, then resuming', sl: "the pullback extreme", targets: tgt('swing', 'htf'), detect: pullback },
  { id: 'vwap-reversion', n: 10, name: 'VWAP / mean reversion', group: 'reversal', summary: 'Two σ from VWAP, turning, delta improving -- off on trend days', gate: `not a trend day (efficiency ≤ ${TREND_DAY_ER})`, sl: "the 2σ reversal extreme", targets: tgt('own', 'own'), detect: vwapReversion },
  { id: 'order-flow', n: 11, name: 'Order flow', group: 'flow', summary: 'At a level: absorption, delta flip, CVD turn, micro BOS', sl: "the absorption / held-level extreme", targets: tgt('book', 'book'), detect: orderFlow },
  { id: 'options-flow', n: 12, name: 'Options / derivatives', group: 'flow', summary: 'An OI wall that holds, with structure, flow and big-move risk', sl: "the OI wall / rejection extreme", targets: tgt('oi', 'oi'), detect: optionsFlow },
];


/*
 * ===================================================================== the research candidates
 *
 * Candidate entry methods, #13-#37 of the owner's list of 1 Oct 2026, written
 * the way the twelve are (methods.ts) so one that earns its place can join
 * them unchanged. Since 1 Oct 2026 they are on the desk as methods like the twelve; scripts/methods-study.ts
 * replays each over the cached 5m history through the same plan, gates and
 * grading as the twelve, against a bar declared before it ran. None is on the
 * desk until it passes.
 *
 * Only the ones candles can answer are here; the ones that need the desk's
 * live data (tape, mark, index, funding, the option board) are in
 * the live-data section below. Liquidations, L2
 * order-book ticks, per-price footprint and ETH are not collected. #19 (range
 * consumed) is a regime, read beside every setup rather than as an entry;
 * #38 was declined by the owner.
 */

const DAY = 86_400;
const hiOf = (xs: readonly Candle[]) => Math.max(...xs.map((b) => b.high));
const loOf = (xs: readonly Candle[]) => Math.min(...xs.map((b) => b.low));
const fmt = (p: number) => Math.round(p).toLocaleString('en-US');

/** The UTC day before `t`'s, from hourly bars: its high, low and all 24 hours, or null. */
export function prevDay(h1: readonly Candle[] | undefined, t: number): { hi: number; lo: number } | null {
  const d0 = t - (t % DAY);
  const xs = (h1 ?? []).filter((b) => b.time >= d0 - DAY && b.time < d0);
  return xs.length === 24 ? { hi: hiOf(xs), lo: loOf(xs) } : null;
}

/** A day's volume profile from its 5m bars, each bar's volume spread over its range: POC and the 70% value area. */
export function valueArea(xs: readonly Candle[], step = 25): { poc: number; vah: number; val: number } | null {
  if (xs.length < 100) return null;
  const vol = new Map<number, number>();
  for (const b of xs) {
    const lo = Math.floor(b.low / step), hi = Math.floor(b.high / step), n = hi - lo + 1;
    for (let k = lo; k <= hi; k++) vol.set(k, (vol.get(k) ?? 0) + b.volume / n);
  }
  const keys = [...vol.keys()].sort((x, y) => x - y);
  const total = keys.reduce((s, k) => s + vol.get(k)!, 0);
  let poc = keys[0]!;
  for (const k of keys) if (vol.get(k)! > vol.get(poc)!) poc = k;
  let lo = keys.indexOf(poc), hi = lo, got = vol.get(poc)!;
  while (got < 0.7 * total && (lo > 0 || hi < keys.length - 1)) {
    const down = lo > 0 ? vol.get(keys[lo - 1]!)! : -1, up = hi < keys.length - 1 ? vol.get(keys[hi + 1]!)! : -1;
    if (up >= down) got += vol.get(keys[++hi]!)!; else got += vol.get(keys[--lo]!)!;
  }
  return { poc: (poc + 0.5) * step, vah: (keys[hi]! + 1) * step, val: keys[lo]! * step };
}

/** Sessions, UTC: Asia from 00:00, London from 07:00, New York from 13:30. */
export const SESSIONS = { asia: 0, london: 7 * 3600, ny: 13.5 * 3600 } as const;
type Session = keyof typeof SESSIONS;
const sessionStart = (t: number, s: Session) => t - (t % DAY) + SESSIONS[s];

// ------------------------------------------------------------------ 13
/** 13. Compression break: a tight hour (12 bars under 2.5 ATR wide), a close out of it on volume, then follow-through. */
const compressionBreak = ({ bars, a }: DetectInput): Setup | null => {
  const box = bars.slice(-14, -2), br = prev(bars), b = last(bars);
  const hi = hiOf(box), lo = loOf(box), width = hi - lo;
  if (!(width <= 2.5 * a)) return null;
  const dir: 1 | -1 | 0 = br.close > hi ? 1 : br.close < lo ? -1 : 0;
  if (dir === 0) return null;
  return {
    dir,
    steps: [
      { label: `a compression: 12 bars ${(width / a).toFixed(1)} ATR wide`, ok: true },
      { label: 'closed out of it on volume (RVOL 1.5)', ok: (rvol(bars, 20, bars.length - 2) ?? 0) >= 1.5 },
      { label: 'follow-through: the next close further', ok: dir === 1 ? b.close > br.close : b.close < br.close },
    ],
    zone: atClose(b, dir, a),
    stop: dir === 1 ? lo : hi,
    triggerTime: br.time,
    targets: [{ price: dir === 1 ? hi + width : lo - width, why: `box projection ${fmt(dir === 1 ? hi + width : lo - width)}` }],
  };
};

// ------------------------------------------------------------------ 14 / 15
/** 14-15. Trap: a break of the 20-bar high (low) with no follow-through, closed back inside -- reversed. */
const trap = ({ bars, a }: DetectInput): Setup | null => {
  const ref = bars.slice(-24, -4), hi = hiOf(ref), lo = loOf(ref), recent = bars.slice(-4), b = last(bars);
  const brokeUp = recent.some((x) => x.high > hi), brokeDown = recent.some((x) => x.low < lo);
  const dir: 1 | -1 | 0 = brokeUp && !brokeDown && b.close < hi - 0.1 * a ? -1 : brokeDown && !brokeUp && b.close > lo + 0.1 * a ? 1 : 0;
  if (dir === 0) return null;
  const level = dir === -1 ? hi : lo;
  const mid = (hi + lo) / 2;
  return {
    dir,
    steps: [
      { label: `broke the 20-bar ${dir === -1 ? 'high' : 'low'} ${fmt(level)}`, ok: true },
      { label: 'no follow-through: closed back inside', ok: true },
      { label: 'a turn: closed past the bar before', ok: turned(b, prev(bars), dir) },
    ],
    zone: atClose(b, dir, a),
    stop: dir === -1 ? hiOf(recent) : loOf(recent),
    triggerTime: b.time,
    targets: [{ price: mid, why: `range middle ${fmt(mid)}` }, { price: dir === -1 ? lo : hi, why: `range ${dir === -1 ? 'low' : 'high'} ${fmt(dir === -1 ? lo : hi)}` }],
  };
};

// ------------------------------------------------------------------ 16
/** 16. Opening-range breakout: the session's first 30 minutes, then the first close out of it on volume, within two hours. */
const orb = (s: Session) => ({ bars, a }: DetectInput): Setup | null => {
  const b = last(bars), t0 = sessionStart(b.time, s);
  const or = bars.filter((x) => x.time >= t0 && x.time < t0 + 1800), after = bars.filter((x) => x.time >= t0 + 1800 && x.time <= b.time);
  if (or.length !== 6 || !after.length || after.length > 24) return null;
  const hi = hiOf(or), lo = loOf(or);
  const dir: 1 | -1 | 0 = b.close > hi ? 1 : b.close < lo ? -1 : 0;
  if (dir === 0) return null;
  // The first close out on this side since the range formed.
  if (after.slice(0, -1).some((x) => (dir === 1 ? x.close > hi : x.close < lo))) return null;
  return {
    dir,
    steps: [
      { label: `${s} opening range ${fmt(lo)}-${fmt(hi)}`, ok: true },
      { label: 'first close out of it', ok: true },
      { label: 'on volume (RVOL 1.5)', ok: (rvol(bars) ?? 0) >= 1.5 },
    ],
    zone: atClose(b, dir, a),
    stop: (hi + lo) / 2,
    triggerTime: b.time,
    targets: [{ price: dir === 1 ? hi + (hi - lo) : lo - (hi - lo), why: 'opening-range projection' }],
  };
};

// ------------------------------------------------------------------ 17 / 18
/** 17. Previous day's high (low) swept and rejected: a turn back inside after trading past it. */
const pdRejection = ({ bars, a, ctx }: DetectInput): Setup | null => {
  const b = last(bars), pd = prevDay(ctx.frames['1h'], b.time);
  if (!pd) return null;
  const recent = bars.slice(-4);
  const dir: 1 | -1 | 0 = recent.some((x) => x.high > pd.hi) && b.close < pd.hi ? -1 : recent.some((x) => x.low < pd.lo) && b.close > pd.lo ? 1 : 0;
  if (dir === 0) return null;
  return {
    dir,
    steps: [
      { label: `swept the previous day's ${dir === -1 ? 'high' : 'low'} ${fmt(dir === -1 ? pd.hi : pd.lo)}`, ok: true },
      { label: 'closed back inside', ok: true },
      { label: 'a turn: closed past the bar before', ok: turned(b, prev(bars), dir) },
    ],
    zone: atClose(b, dir, a),
    stop: dir === -1 ? hiOf(recent) : loOf(recent),
    triggerTime: b.time,
    targets: [{ price: (pd.hi + pd.lo) / 2, why: `previous day's middle ${fmt((pd.hi + pd.lo) / 2)}` }],
  };
};

/** 18. Previous day's high (low) broken, held, retested and rejected the trade's way. */
const pdBreakHold = ({ bars, a, ctx }: DetectInput): Setup | null => {
  const b = last(bars), pd = prevDay(ctx.frames['1h'], b.time);
  if (!pd) return null;
  const since = bars.slice(-24, -3), retest = bars.slice(-3);
  for (const dir of [1, -1] as const) {
    const level = dir === 1 ? pd.hi : pd.lo;
    const brk = since.findIndex((x) => (dir === 1 ? x.close > level : x.close < level));
    if (brk < 0) continue;
    const held = since.slice(brk).every((x) => (dir === 1 ? x.close > level : x.close < level));
    const back = retest.some((x) => (dir === 1 ? x.low <= level + 0.15 * a : x.high >= level - 0.15 * a));
    if (!held || !back || !(dir === 1 ? b.close > level : b.close < level)) continue;
    return {
      dir,
      steps: [
        { label: `closed through the previous day's ${dir === 1 ? 'high' : 'low'} ${fmt(level)}`, ok: true },
        { label: 'held outside it since', ok: true },
        { label: 'retested and rejected the trade\'s way', ok: dir === 1 ? bullish(b) : bearish(b) },
      ],
      zone: atClose(b, dir, a),
      stop: dir === 1 ? loOf(retest) : hiOf(retest),
      triggerTime: b.time,
    };
  }
  return null;
};

// ------------------------------------------------------------------ 20 / 21
/** 20. VWAP reclaim (loss): from the other side, a close back over the day's VWAP, a retest, a hold. */
const vwapReclaim = ({ bars, a }: DetectInput): Setup | null => {
  const vb = vwapBand(bars);
  if (!vb) return null;
  const v = vb.vwap, b = last(bars), before = bars.slice(-14, -4), retest = bars.slice(-3);
  for (const dir of [1, -1] as const) {
    const wasOther = before.filter((x) => (dir === 1 ? x.close < v : x.close > v)).length >= 7;
    const crossed = bars.slice(-4, -1).some((x) => (dir === 1 ? x.close > v : x.close < v));
    const back = retest.some((x) => (dir === 1 ? x.low <= v + 0.15 * a : x.high >= v - 0.15 * a));
    if (!wasOther || !crossed || !back || !(dir === 1 ? b.close > v && bullish(b) : b.close < v && bearish(b))) continue;
    return {
      dir,
      steps: [
        { label: `was ${dir === 1 ? 'under' : 'over'} the day's VWAP ${fmt(v)}`, ok: true },
        { label: `${dir === 1 ? 'reclaimed' : 'lost'} it, retested, held`, ok: true },
      ],
      zone: atClose(b, dir, a),
      stop: dir === 1 ? loOf(retest) : hiOf(retest),
      triggerTime: b.time,
    };
  }
  return null;
};

/** The week's anchored VWAP (from Monday 00:00 UTC), from hourly bars. */
export function weekVwap(h1: readonly Candle[] | undefined, t: number): number | null {
  const d = new Date(t * 1000), monday = t - (t % DAY) - ((d.getUTCDay() + 6) % 7) * DAY;
  const xs = (h1 ?? []).filter((b) => b.time >= monday && b.time + 3600 <= t);
  const vol = xs.reduce((s, b) => s + b.volume, 0);
  return xs.length >= 6 && vol > 0 ? xs.reduce((s, b) => s + ((b.high + b.low + b.close) / 3) * b.volume, 0) / vol : null;
}

/** 21. Anchored VWAP (the week's): price comes back to it from the trend's side and turns away. */
const anchoredVwap = ({ bars, a, ctx }: DetectInput): Setup | null => {
  const b = last(bars), v = weekVwap(ctx.frames['1h'], b.time + 300);
  if (v === null) return null;
  const before = bars.slice(-24, -3), recent = bars.slice(-3);
  for (const dir of [1, -1] as const) {
    const fromSide = before.filter((x) => (dir === 1 ? x.close > v : x.close < v)).length >= 18;
    const touch = recent.some((x) => (dir === 1 ? x.low <= v + 0.1 * a : x.high >= v - 0.1 * a));
    if (!fromSide || !touch || !turned(b, prev(bars), dir) || !(dir === 1 ? b.close > v : b.close < v)) continue;
    return {
      dir,
      steps: [
        { label: `the week's anchored VWAP ${fmt(v)}, held ${dir === 1 ? 'above' : 'below'}`, ok: true },
        { label: 'touched and turned away', ok: true },
      ],
      zone: atClose(b, dir, a),
      stop: dir === 1 ? loOf(recent) : hiOf(recent),
      triggerTime: b.time,
    };
  }
  return null;
};

// ------------------------------------------------------------------ 22 / 23
const prevDayProfile = (bars: readonly Candle[], t: number) => {
  const d0 = t - (t % DAY);
  return valueArea(bars.filter((x) => x.time >= d0 - DAY && x.time < d0));
};

/** 22. Value-area break: a close out of the previous day's value area on volume, from inside it. */
const vaBreak = ({ bars, a }: DetectInput): Setup | null => {
  const b = last(bars), p = prev(bars), va = prevDayProfile(bars, b.time);
  if (!va) return null;
  const dir: 1 | -1 | 0 = b.close > va.vah && p.close <= va.vah ? 1 : b.close < va.val && p.close >= va.val ? -1 : 0;
  if (dir === 0) return null;
  return {
    dir,
    steps: [
      { label: `closed out of the value area ${fmt(va.val)}-${fmt(va.vah)}`, ok: true },
      { label: 'on volume (RVOL 1.5)', ok: (rvol(bars) ?? 0) >= 1.5 },
    ],
    zone: atClose(b, dir, a),
    stop: dir === 1 ? Math.min(b.low, va.vah) : Math.max(b.high, va.val),
    triggerTime: b.time,
  };
};

/** 23. POC reclaim (loss): from the other side of the previous day's POC, a close over it that holds. */
const pocReclaim = ({ bars, a }: DetectInput): Setup | null => {
  const b = last(bars), va = prevDayProfile(bars, b.time);
  if (!va) return null;
  const before = bars.slice(-10, -2), p = prev(bars);
  for (const dir of [1, -1] as const) {
    const other = before.every((x) => (dir === 1 ? x.close < va.poc : x.close > va.poc));
    const over = (x: Candle) => (dir === 1 ? x.close > va.poc : x.close < va.poc);
    if (!other || !over(p) || !over(b) || !(dir === 1 ? b.low >= va.poc - 0.2 * a : b.high <= va.poc + 0.2 * a)) continue;
    return {
      dir,
      steps: [
        { label: `${dir === 1 ? 'reclaimed' : 'lost'} the previous day's POC ${fmt(va.poc)}`, ok: true },
        { label: 'held for a second close', ok: true },
      ],
      zone: atClose(b, dir, a),
      stop: dir === 1 ? Math.min(p.low, b.low) : Math.max(p.high, b.high),
      triggerTime: b.time,
      targets: [{ price: dir === 1 ? va.vah : va.val, why: `value-area ${dir === 1 ? 'high' : 'low'} ${fmt(dir === 1 ? va.vah : va.val)}` }],
    };
  }
  return null;
};

// ------------------------------------------------------------------ 29 / 30
/** 29. Equal lows (highs) swept and reclaimed: two swings within 0.15 ATR, traded through, closed back. */
const equalSweep = ({ bars, a }: DetectInput): Setup | null => {
  const look = bars.slice(-60, -4), b = last(bars), recent = bars.slice(-4);
  for (const dir of [1, -1] as const) {
    const ps = pivots(look, dir === 1 ? 'low' : 'high').slice(-6);
    let level: number | null = null;
    for (let i = 0; i < ps.length && level === null; i++) for (let j = i + 1; j < ps.length; j++) {
      if (Math.abs(ps[i]!.price - ps[j]!.price) <= 0.15 * a) { level = dir === 1 ? Math.min(ps[i]!.price, ps[j]!.price) : Math.max(ps[i]!.price, ps[j]!.price); break; }
    }
    if (level === null) continue;
    const swept = recent.some((x) => (dir === 1 ? x.low < level! : x.high > level!));
    if (!swept || !(dir === 1 ? b.close > level : b.close < level) || !turned(b, prev(bars), dir)) continue;
    return {
      dir,
      steps: [
        { label: `equal ${dir === 1 ? 'lows' : 'highs'} at ${fmt(level)}`, ok: true },
        { label: 'swept and closed back', ok: true },
      ],
      zone: atClose(b, dir, a),
      stop: dir === 1 ? loOf(recent) : hiOf(recent),
      triggerTime: b.time,
    };
  }
  return null;
};

/** 30. The previous session's high (low) swept, then rejected, in the session that follows. */
const sessionSweep = (s: Session) => ({ bars, a }: DetectInput): Setup | null => {
  const b = last(bars), order: Session[] = ['asia', 'london', 'ny'];
  const i = order.indexOf(s), t0 = sessionStart(b.time, s);
  if (b.time < t0 || b.time >= t0 + 4 * 3600) return null;
  const pStart = i === 0 ? sessionStart(b.time, 'ny') - DAY : sessionStart(b.time, order[i - 1]!);
  const ps = bars.filter((x) => x.time >= pStart && x.time < t0);
  if (ps.length < 60) return null;
  const hi = hiOf(ps), lo = loOf(ps), recent = bars.slice(-4);
  const dir: 1 | -1 | 0 = recent.some((x) => x.high > hi) && b.close < hi ? -1 : recent.some((x) => x.low < lo) && b.close > lo ? 1 : 0;
  if (dir === 0 || !turned(b, prev(bars), dir)) return null;
  return {
    dir,
    steps: [
      { label: `swept the previous session's ${dir === -1 ? 'high' : 'low'} ${fmt(dir === -1 ? hi : lo)}`, ok: true },
      { label: 'rejected: closed back and turned', ok: true },
    ],
    zone: atClose(b, dir, a),
    stop: dir === -1 ? hiOf(recent) : loOf(recent),
    triggerTime: b.time,
  };
};

// ------------------------------------------------------------------ 36 / 37
/** 36. Volatility transition: a quiet stretch (bars under 0.6 of the usual range), then range expanding into a 20-bar break. */
const volTransition = ({ bars, a }: DetectInput): Setup | null => {
  if (bars.length < 200) return null;
  const mean = (xs: readonly Candle[]) => xs.reduce((s, x) => s + range(x), 0) / xs.length;
  const quiet = mean(bars.slice(-40, -4)), usual = mean(bars.slice(-200, -40)), now = mean(bars.slice(-3));
  if (!(quiet <= 0.6 * usual && now >= 1.5 * quiet)) return null;
  const ref = bars.slice(-24, -1), b = last(bars);
  const dir: 1 | -1 | 0 = b.close > hiOf(ref) ? 1 : b.close < loOf(ref) ? -1 : 0;
  if (dir === 0) return null;
  return {
    dir,
    steps: [
      { label: `quiet: bars ${(quiet / usual).toFixed(2)} of their usual range`, ok: true },
      { label: 'range expanding through the 20-bar extreme', ok: true },
    ],
    zone: atClose(b, dir, a),
    stop: dir === 1 ? b.low : b.high,
    triggerTime: b.time,
  };
};

/** 37. Z-score reversion: two and a half deviations from the 50-bar mean, then a turn back. */
const zReversion = ({ bars, a }: DetectInput): Setup | null => {
  const xs = bars.slice(-53, -3).map((x) => x.close);
  if (xs.length < 50) return null;
  const m = xs.reduce((s, v) => s + v, 0) / xs.length, sd = Math.sqrt(xs.reduce((s, v) => s + (v - m) ** 2, 0) / xs.length);
  if (!(sd > 0)) return null;
  const recent = bars.slice(-4), b = last(bars);
  const zLo = (loOf(recent) - m) / sd, zHi = (hiOf(recent) - m) / sd;
  const dir: 1 | -1 | 0 = zLo <= -2.5 ? 1 : zHi >= 2.5 ? -1 : 0;
  if (dir === 0 || !turned(b, prev(bars), dir)) return null;
  return {
    dir,
    steps: [
      { label: `${Math.abs(dir === 1 ? zLo : zHi).toFixed(1)} deviations from the 50-bar mean ${fmt(m)}`, ok: true },
      { label: 'turned back', ok: true },
    ],
    zone: atClose(b, dir, a),
    stop: dir === 1 ? loOf(recent) : hiOf(recent),
    triggerTime: b.time,
    targets: [{ price: m, why: `50-bar mean ${fmt(m)}` }],
  };
};

// ------------------------------------------------------------------ round 2 (the owner's #38-#130, deduplicated)

/** The high and low of a calendar period before `t`'s (`len` s long, starting at `startOf(t)`), from hourly or 4h bars. */
function prevPeriod(xs: readonly Candle[] | undefined, t: number, startOf: (t: number) => number): { hi: number; lo: number } | null {
  const s = startOf(t), p = startOf(s - 1);
  const ys = (xs ?? []).filter((b) => b.time >= p && b.time < s);
  // The whole period, or nothing: a month half in the window has a wrong high and low.
  const per = ys.length > 1 ? ys[1]!.time - ys[0]!.time : 0;
  return ys.length >= 3 && ys[0]!.time - p <= per && s - ys[ys.length - 1]!.time <= 2 * per ? { hi: hiOf(ys), lo: loOf(ys) } : null;
}
const weekStart = (t: number) => { const d0 = t - (t % DAY); return d0 - ((new Date(d0 * 1000).getUTCDay() + 6) % 7) * DAY; };
const monthStart = (t: number) => { const d = new Date(t * 1000); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) / 1000; };

/** A sweep of a level then a turn back inside: the shape of #17 at any level. */
function sweepReject(bars: readonly Candle[], a: number, hi: number, lo: number, what: string): Setup | null {
  const b = last(bars), recent = bars.slice(-4);
  const dir: 1 | -1 | 0 = recent.some((x) => x.high > hi) && b.close < hi ? -1 : recent.some((x) => x.low < lo) && b.close > lo ? 1 : 0;
  if (dir === 0 || !turned(b, prev(bars), dir)) return null;
  return {
    dir,
    steps: [{ label: `swept the ${what} ${dir === -1 ? 'high' : 'low'} ${fmt(dir === -1 ? hi : lo)}`, ok: true }, { label: 'closed back and turned', ok: true }],
    zone: atClose(b, dir, a), stop: dir === -1 ? hiOf(recent) : loOf(recent), triggerTime: b.time,
    targets: [{ price: (hi + lo) / 2, why: `${what} middle ${fmt((hi + lo) / 2)}` }],
  };
}

/** 87 / 88. The previous week's (month's) high or low swept and rejected. */
const weekSweep = ({ bars, a, ctx }: DetectInput): Setup | null => {
  const p = prevPeriod(ctx.frames['1h'], last(bars).time, weekStart);
  return p ? sweepReject(bars, a, p.hi, p.lo, "previous week's") : null;
};
const monthSweep = ({ bars, a, ctx }: DetectInput): Setup | null => {
  const p = prevPeriod(ctx.frames['4h'], last(bars).time, monthStart);
  return p ? sweepReject(bars, a, p.hi, p.lo, "previous month's") : null;
};

/** 91 / 92. The previous week's (month's) high or low broken by a close, then reclaimed: a failed break at a big level. */
function breakReclaim(bars: readonly Candle[], a: number, hi: number, lo: number, what: string): Setup | null {
  const b = last(bars), recent = bars.slice(-6, -1);
  const dir: 1 | -1 | 0 = recent.some((x) => x.close > hi) && b.close < hi - 0.1 * a ? -1 : recent.some((x) => x.close < lo) && b.close > lo + 0.1 * a ? 1 : 0;
  if (dir === 0) return null;
  return {
    dir,
    steps: [{ label: `closed through the ${what} ${dir === -1 ? 'high' : 'low'}`, ok: true }, { label: 'and closed back inside', ok: true }],
    zone: atClose(b, dir, a), stop: dir === -1 ? hiOf(bars.slice(-6)) : loOf(bars.slice(-6)), triggerTime: b.time,
  };
}
const weekReclaim = ({ bars, a, ctx }: DetectInput): Setup | null => {
  const p = prevPeriod(ctx.frames['1h'], last(bars).time, weekStart);
  return p ? breakReclaim(bars, a, p.hi, p.lo, "previous week's") : null;
};
const monthReclaim = ({ bars, a, ctx }: DetectInput): Setup | null => {
  const p = prevPeriod(ctx.frames['4h'], last(bars).time, monthStart);
  return p ? breakReclaim(bars, a, p.hi, p.lo, "previous month's") : null;
};

/** 82. Initial balance (the UTC day's first hour) broken by a close on volume, the first time today. */
const ibBreak = ({ bars, a }: DetectInput): Setup | null => {
  const b = last(bars), d0 = b.time - (b.time % DAY);
  const ib = bars.filter((x) => x.time >= d0 && x.time < d0 + 3600), after = bars.filter((x) => x.time >= d0 + 3600 && x.time <= b.time);
  if (ib.length !== 12 || !after.length || after.length > 48) return null;
  const hi = hiOf(ib), lo = loOf(ib);
  const dir: 1 | -1 | 0 = b.close > hi ? 1 : b.close < lo ? -1 : 0;
  if (dir === 0 || after.slice(0, -1).some((x) => (dir === 1 ? x.close > hi : x.close < lo))) return null;
  return {
    dir,
    steps: [{ label: `initial balance ${fmt(lo)}-${fmt(hi)}`, ok: true }, { label: 'first close out of it, on volume', ok: (rvol(bars) ?? 0) >= 1.5 }],
    zone: atClose(b, dir, a), stop: (hi + lo) / 2, triggerTime: b.time,
    targets: [{ price: dir === 1 ? hi + (hi - lo) : lo - (hi - lo), why: 'initial-balance projection' }],
  };
};

/** 83. Initial balance broken, then closed back inside: the failed break, faded. */
const ibFail = ({ bars, a }: DetectInput): Setup | null => {
  const b = last(bars), d0 = b.time - (b.time % DAY);
  const ib = bars.filter((x) => x.time >= d0 && x.time < d0 + 3600);
  if (ib.length !== 12 || b.time < d0 + 3600 + 900) return null;
  const s = breakReclaim(bars, a, hiOf(ib), loOf(ib), 'initial balance');
  return s && { ...s, targets: [{ price: (hiOf(ib) + loOf(ib)) / 2, why: 'initial-balance middle' }] };
};

/** 39. Mid-range rejection: in a 4-hour range, price comes to the middle from one side and turns back to it. */
const midRange = ({ bars, a }: DetectInput): Setup | null => {
  const box = bars.slice(-52, -4), hi = hiOf(box), lo = loOf(box), mid = (hi + lo) / 2, b = last(bars);
  if (!(hi - lo >= 3 * a && hi - lo <= 8 * a)) return null;
  const recent = bars.slice(-4), before = bars.slice(-16, -4);
  const fromBelow = before.every((x) => x.close < mid) && recent.some((x) => x.high >= mid - 0.1 * a);
  const fromAbove = before.every((x) => x.close > mid) && recent.some((x) => x.low <= mid + 0.1 * a);
  const dir: 1 | -1 | 0 = fromBelow ? -1 : fromAbove ? 1 : 0;
  if (dir === 0 || !turned(b, prev(bars), dir)) return null;
  return {
    dir,
    steps: [{ label: `a range ${fmt(lo)}-${fmt(hi)}, back to its middle ${fmt(mid)}`, ok: true }, { label: 'rejected there', ok: true }],
    zone: atClose(b, dir, a), stop: dir === -1 ? hiOf(recent) : loOf(recent), triggerTime: b.time,
    targets: [{ price: dir === -1 ? lo : hi, why: `range ${dir === -1 ? 'low' : 'high'} ${fmt(dir === -1 ? lo : hi)}` }],
  };
};

/** 40. Trendline break and retest: the line through the last two falling swing highs (rising lows), closed through, retested, held. */
const trendlineRetest = ({ bars, a }: DetectInput): Setup | null => {
  const look = bars.slice(-80), b = last(bars), n = look.length;
  for (const dir of [1, -1] as const) {
    const ps = pivots(look.slice(0, -6), dir === 1 ? 'high' : 'low').slice(-2);
    if (ps.length < 2) continue;
    const [p1, p2] = ps as [typeof ps[0], typeof ps[0]];
    const slope = (p2.price - p1.price) / (p2.i - p1.i);
    if (dir === 1 ? slope >= 0 : slope <= 0) continue; // a falling line of highs to break up, a rising line of lows to break down
    const lineAt = (i: number) => p2.price + slope * (i - p2.i);
    const brk = look.slice(-6, -2).findIndex((x, k) => (dir === 1 ? x.close > lineAt(n - 6 + k) : x.close < lineAt(n - 6 + k)));
    if (brk < 0) continue;
    const L = lineAt(n - 1);
    const retest = dir === 1 ? b.low <= L + 0.15 * a && b.close > L && bullish(b) : b.high >= L - 0.15 * a && b.close < L && bearish(b);
    if (!retest) continue;
    return {
      dir,
      steps: [{ label: `closed through the ${dir === 1 ? 'falling' : 'rising'} trendline`, ok: true }, { label: 'retested it and held', ok: true }],
      zone: atClose(b, dir, a), stop: dir === 1 ? Math.min(b.low, prev(bars).low) : Math.max(b.high, prev(bars).high), triggerTime: b.time,
    };
  }
  return null;
};

/** 41. Channel breakout: a close beyond the 48-bar regression channel (2 deviations) on volume. */
const channelBreak = ({ bars, a }: DetectInput): Setup | null => {
  const xs = bars.slice(-49, -1).map((x) => x.close), n = xs.length;
  const mx = (n - 1) / 2, my = xs.reduce((s, v) => s + v, 0) / n;
  let sxy = 0, sxx = 0;
  xs.forEach((v, k) => { sxy += (k - mx) * (v - my); sxx += (k - mx) ** 2; });
  const slope = sxy / sxx, at = (k: number) => my + slope * (k - mx);
  const sd = Math.sqrt(xs.reduce((s, v, k) => s + (v - at(k)) ** 2, 0) / n);
  const b = last(bars), edgeUp = at(n) + 2 * sd, edgeDn = at(n) - 2 * sd;
  const dir: 1 | -1 | 0 = b.close > edgeUp ? 1 : b.close < edgeDn ? -1 : 0;
  if (dir === 0 || !((rvol(bars) ?? 0) >= 1.5)) return null;
  return {
    dir,
    steps: [{ label: 'closed beyond the 48-bar channel (2σ)', ok: true }, { label: 'on volume (RVOL 1.5)', ok: true }],
    zone: atClose(b, dir, a), stop: dir === 1 ? b.low : b.high, triggerTime: b.time,
  };
};

/** 43. Engulfing with structure: an engulfing candle that also closes through the last swing the other way (an MSS). */
const engulfingMss = ({ bars, a }: DetectInput): Setup | null => {
  const b = last(bars), p = prev(bars);
  for (const dir of [1, -1] as const) {
    const engulf = dir === 1 ? bullish(b) && bearish(p) && b.close > p.open && b.open <= p.close : bearish(b) && bullish(p) && b.close < p.open && b.open >= p.close;
    if (!engulf) continue;
    const sw = pivots(bars.slice(-40, -2), dir === 1 ? 'high' : 'low').slice(-1)[0];
    if (!sw || !(dir === 1 ? b.close > sw.price : b.close < sw.price)) continue;
    return {
      dir,
      steps: [{ label: `${dir === 1 ? 'bullish' : 'bearish'} engulfing`, ok: true }, { label: `closed through the last swing ${fmt(sw.price)} (MSS)`, ok: true }],
      zone: atClose(b, dir, a), stop: dir === 1 ? Math.min(b.low, p.low) : Math.max(b.high, p.high), triggerTime: b.time,
    };
  }
  return null;
};

/** 44 / 45. NR7: the narrowest bar of seven, then the next bar breaks out of it. */
const nr7 = ({ bars, a }: DetectInput): Setup | null => {
  const seven = bars.slice(-8, -1), nr = prev(bars), b = last(bars);
  if (!(range(nr) <= Math.min(...seven.map(range)))) return null;
  const dir: 1 | -1 | 0 = b.close > nr.high ? 1 : b.close < nr.low ? -1 : 0;
  if (dir === 0) return null;
  return {
    dir,
    steps: [{ label: 'the narrowest bar of seven', ok: true }, { label: 'the next closed out of it', ok: true }],
    zone: atClose(b, dir, a), stop: dir === 1 ? nr.low : nr.high, triggerTime: b.time,
  };
};

/** 46. Dislocation reversion: a bar of 3 ATR or more, then within six bars a turn back against it, toward its middle. */
const dislocation = ({ bars, a }: DetectInput): Setup | null => {
  const look = bars.slice(-7, -1), b = last(bars);
  const big = [...look].reverse().find((x) => range(x) >= 3 * a);
  if (!big) return null;
  const up = big.close > big.open, dir: 1 | -1 = up ? -1 : 1;
  if (!turned(b, prev(bars), dir)) return null;
  const mid = (big.high + big.low) / 2;
  return {
    dir,
    steps: [{ label: `a ${(range(big) / a).toFixed(1)} ATR bar`, ok: true }, { label: 'turned back against it', ok: true }],
    zone: atClose(b, dir, a), stop: dir === -1 ? hiOf(bars.slice(-4)) : loOf(bars.slice(-4)), triggerTime: b.time,
    targets: [{ price: mid, why: `the bar's middle ${fmt(mid)}` }],
  };
};

/**
 * Each UTC day's POC once the day is over, and whether price has traded
 * through it since -- kept as the bars go by, so a POC from days back needs no
 * days of bars in the window. Read bar by bar, in order (the study, the live
 * minute).
 */
const pocs = new Map<number, { poc: number; touched: boolean; seenTo: number }>();
/** 78. Naked POC: a POC of the last five days that price has not traded through since -- touched now, and rejected. */
const nakedPoc = ({ bars, a }: DetectInput): Setup | null => {
  const b = last(bars), today = b.time - (b.time % DAY);
  const y0 = today - DAY;
  if (!pocs.has(y0)) {
    const day = bars.filter((x) => x.time >= y0 && x.time < today);
    const va = day.length >= 280 ? valueArea(day) : null;
    if (va) pocs.set(y0, { poc: va.poc, touched: false, seenTo: today - 300 });
  }
  const recent = bars.slice(-3);
  for (const [d0, p] of pocs) {
    if (d0 < today - 5 * DAY) { pocs.delete(d0); continue; }
    // Bars since it was last looked at, up to three bars ago: did any trade through it?
    for (const x of bars) if (x.time > p.seenTo && x.time < b.time - 600 && x.low <= p.poc && x.high >= p.poc) p.touched = true;
    p.seenTo = Math.max(p.seenTo, b.time - 900);
    if (p.touched) continue;
    const touched = recent.some((x) => x.low <= p.poc + 0.1 * a && x.high >= p.poc - 0.1 * a);
    const dir: 1 | -1 = b.close > p.poc ? 1 : -1;
    if (!touched || !turned(b, prev(bars), dir)) continue;
    const k = Math.round((today - d0) / DAY);
    return {
      dir,
      steps: [{ label: `a naked POC ${fmt(p.poc)} from ${k} day${k === 1 ? '' : 's'} ago`, ok: true }, { label: 'touched and rejected', ok: true }],
      zone: atClose(b, dir, a), stop: dir === 1 ? loOf(recent) : hiOf(recent), triggerTime: b.time,
    };
  }
  return null;
};

export type Candidate = { id: string; n: number; name: string; family: string; sl: string; targets: TargetSpec; detect: (m: DetectInput) => Setup | null };

/** The candidates, by the owner's numbers. */
export const CANDIDATES: readonly Candidate[] = [
  { id: 'compression-break', n: 13, name: 'Compression break', family: 'volatility', sl: 'the compression box\'s far side', targets: tgt('nearest', 'next'), detect: compressionBreak },
  { id: 'trap', n: 14, name: 'Failed breakout / breakdown (trap)', family: 'reversal', sl: 'the trap extreme', targets: tgt('own', 'own'), detect: trap },
  { id: 'orb-asia', n: 16, name: 'Opening-range breakout · Asia', family: 'session', sl: 'the opening range middle', targets: tgt('nearest', 'next'), detect: orb('asia') },
  { id: 'orb-london', n: 16, name: 'Opening-range breakout · London', family: 'session', sl: 'the opening range middle', targets: tgt('nearest', 'next'), detect: orb('london') },
  { id: 'orb-ny', n: 16, name: 'Opening-range breakout · New York', family: 'session', sl: 'the opening range middle', targets: tgt('nearest', 'next'), detect: orb('ny') },
  { id: 'pd-rejection', n: 17, name: 'Previous day H/L rejection', family: 'liquidity', sl: 'the sweep extreme', targets: tgt('nearest', 'htf'), detect: pdRejection },
  { id: 'pd-break-hold', n: 18, name: 'Previous day H/L break & hold', family: 'breakout', sl: 'the retest extreme', targets: tgt('nearest', 'htf'), detect: pdBreakHold },
  { id: 'vwap-reclaim', n: 20, name: 'VWAP reclaim / loss', family: 'vwap', sl: 'the VWAP retest extreme', targets: tgt('nearest', 'next'), detect: vwapReclaim },
  { id: 'anchored-vwap', n: 21, name: 'Anchored VWAP (week)', family: 'vwap', sl: 'the touch extreme', targets: tgt('nearest', 'next'), detect: anchoredVwap },
  { id: 'va-break', n: 22, name: 'Value-area break', family: 'volume profile', sl: 'back inside the value area', targets: tgt('nearest', 'next'), detect: vaBreak },
  { id: 'poc-reclaim', n: 23, name: 'POC reclaim / loss', family: 'volume profile', sl: 'the hold extreme', targets: tgt('nearest', 'next'), detect: pocReclaim },
  { id: 'equal-sweep', n: 29, name: 'Equal H/L sweep & reclaim', family: 'liquidity', sl: 'the sweep extreme', targets: tgt('nearest', 'htf'), detect: equalSweep },
  { id: 'session-sweep-asia', n: 30, name: 'Session H/L sweep · Asia', family: 'liquidity', sl: 'the sweep extreme', targets: tgt('nearest', 'next'), detect: sessionSweep('asia') },
  { id: 'session-sweep-london', n: 30, name: 'Session H/L sweep · London', family: 'liquidity', sl: 'the sweep extreme', targets: tgt('nearest', 'next'), detect: sessionSweep('london') },
  { id: 'session-sweep-ny', n: 30, name: 'Session H/L sweep · New York', family: 'liquidity', sl: 'the sweep extreme', targets: tgt('nearest', 'next'), detect: sessionSweep('ny') },
  { id: 'vol-transition', n: 36, name: 'Volatility regime transition', family: 'volatility', sl: 'the break bar\'s far end', targets: tgt('nearest', 'next'), detect: volTransition },
  { id: 'z-reversion', n: 37, name: 'Z-score reversion', family: 'statistical', sl: 'the stretch extreme', targets: tgt('own', 'next'), detect: zReversion },
  // Round 2: the genuinely new candle concepts from the owner's #38-#130, after duplicates were merged (docs/research/entry-concepts.md).
  { id: 'mid-range', n: 39, name: 'Mid-range rejection', family: 'range', sl: 'the rejection extreme', targets: tgt('own', 'next'), detect: midRange },
  { id: 'trendline-retest', n: 40, name: 'Trendline break & retest', family: 'structure', sl: 'the retest extreme', targets: tgt('nearest', 'htf'), detect: trendlineRetest },
  { id: 'channel-break', n: 41, name: 'Channel breakout', family: 'structure', sl: 'the break bar\'s far end', targets: tgt('nearest', 'next'), detect: channelBreak },
  { id: 'engulfing-mss', n: 43, name: 'Engulfing + structure', family: 'structure', sl: 'the engulfing extreme', targets: tgt('nearest', 'htf'), detect: engulfingMss },
  { id: 'nr7', n: 45, name: 'NR7 / inside-bar break', family: 'volatility', sl: 'the narrow bar\'s far side', targets: tgt('nearest', 'next'), detect: nr7 },
  { id: 'dislocation', n: 46, name: 'Dislocation reversion', family: 'imbalance', sl: 'the turn extreme', targets: tgt('own', 'next'), detect: dislocation },
  { id: 'naked-poc', n: 78, name: 'Naked POC reaction', family: 'volume profile', sl: 'the touch extreme', targets: tgt('nearest', 'next'), detect: nakedPoc },
  { id: 'ib-break', n: 82, name: 'Initial balance break', family: 'session', sl: 'the initial balance middle', targets: tgt('nearest', 'next'), detect: ibBreak },
  { id: 'ib-fail', n: 83, name: 'Initial balance failed break', family: 'session', sl: 'the failed-break extreme', targets: tgt('own', 'next'), detect: ibFail },
  { id: 'week-sweep', n: 87, name: 'Previous week H/L sweep', family: 'liquidity', sl: 'the sweep extreme', targets: tgt('nearest', 'htf'), detect: weekSweep },
  { id: 'month-sweep', n: 88, name: 'Previous month H/L sweep', family: 'liquidity', sl: 'the sweep extreme', targets: tgt('nearest', 'htf'), detect: monthSweep },
  { id: 'week-reclaim', n: 91, name: 'Previous week H/L break-reclaim', family: 'reversal', sl: 'the failed-break extreme', targets: tgt('nearest', 'htf'), detect: weekReclaim },
  { id: 'month-reclaim', n: 92, name: 'Previous month H/L break-reclaim', family: 'reversal', sl: 'the failed-break extreme', targets: tgt('nearest', 'htf'), detect: monthReclaim },
];


/*
 * ===================================================================== research candidates on live data
 *
 * Research candidates that need the desk's live data -- the perpetual's tape
 * per minute, its mark and index, the funding rate, the option board -- which
 * was not recorded for 2024-26, so they cannot be replayed (scripts/
 * methods-study.ts). They run live like the twelve: read every
 * minute beside the twelve, paper-logged, never alerted, for a week or more
 * of forward evidence (owner, 1 Oct 2026). With the data missing -- the tape
 * down, no option board -- each says nothing rather than guessing.
 *
 * Numbers are the owner's research list (docs/research/entry-concepts.md).
 */

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

const GROUP: Record<string, MethodDef['group']> = {
  volatility: 'breakout', breakout: 'breakout', session: 'breakout', structure: 'breakout',
  reversal: 'reversal', liquidity: 'reversal', range: 'reversal', statistical: 'reversal', imbalance: 'reversal', vwap: 'reversal', 'volume profile': 'reversal',
  flow: 'flow',
};
/**
 * Every entry method: the twelve first, then the rest by the owner's numbers --
 * read, shown, paper-logged and alerted alike (owner, 1 Oct 2026: "no separate
 * research; append them like the first twelve"). The replay found no edge in
 * the candle ones (research/METHODS-STUDY.txt); the live log is their record.
 */
export const METHODS: readonly MethodDef[] = [
  ...TWELVE,
  ...[...CANDIDATES, ...LIVE_CANDIDATES].map((c) => ({
    id: c.id, n: c.n, name: c.name, group: GROUP[c.family] ?? 'reversal', summary: c.family, sl: c.sl, targets: c.targets, detect: c.detect,
  })),
];
