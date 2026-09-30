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
  /** Targets this method has of its own (VWAP, max pain), nearest first. */
  targets?: { price: number; why: string }[];
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
const fvgRetest: Detector = ({ bars, a }) => {
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
    zone: [z.lo, z.hi],
    // Past the gap's first candle, the displacement's origin.
    stop: dir === 1 ? Math.min(bars[Math.max(0, z.i - 1)]!.low, z.lo - 0.1 * a) : Math.max(bars[Math.max(0, z.i - 1)]!.high, z.hi + 0.1 * a),
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
    zone: [z.lo, z.hi],
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
    targets: [{ price: vb.vwap, why: `VWAP ${Math.round(vb.vwap).toLocaleString('en-US')}` }],
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
  const targets = o.maxPain !== null && (dir === 1 ? o.maxPain > b.close : o.maxPain < b.close)
    ? [{ price: o.maxPain, why: `max pain ${o.maxPain.toLocaleString('en-US')}` }] : [];
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
    targets,
  };
};

export const METHODS: readonly { id: MethodId; n: number; name: string; group: Group; summary: string; detect: Detector }[] = [
  { id: 'breakout', n: 1, name: 'Breakout', group: 'breakout', summary: 'A close through the 20-bar range, RVOL 1.5, closing near its extreme', detect: breakout },
  { id: 'breakout-retest', n: 2, name: 'Breakout + retest', group: 'pullback', summary: 'A breakout, then a pullback to the level that holds', detect: breakoutRetest },
  { id: 'liquidity-sweep', n: 3, name: 'Liquidity sweep', group: 'reversal', summary: 'Stops taken past a swing, a close back, then the MSS', detect: liquiditySweep },
  { id: 'fvg-retest', n: 4, name: 'FVG retest', group: 'pullback', summary: 'Back into a gap left by displacement, and a reaction', detect: fvgRetest },
  { id: 'ob-retest', n: 5, name: 'Order-block retest', group: 'pullback', summary: 'Back into the last opposite candle before a break', detect: obRetest },
  { id: 'bos', n: 6, name: 'BOS', group: 'breakout', summary: 'A displacement close through a swing, with the trend', detect: bos },
  { id: 'mss', n: 7, name: 'MSS / CHoCH', group: 'reversal', summary: 'The trend turns: a sweep, then a close through the last swing', detect: mss },
  { id: 'momentum', n: 8, name: 'Momentum', group: 'breakout', summary: 'A 1.5 ATR candle, RVOL 1.5, follow-through -- no chase when extended', detect: momentum },
  { id: 'pullback', n: 9, name: 'Pullback', group: 'pullback', summary: 'A trend back to its 20 EMA, then resuming', detect: pullback },
  { id: 'vwap-reversion', n: 10, name: 'VWAP / mean reversion', group: 'reversal', summary: 'Two σ from VWAP, turning, delta improving -- off on trend days', detect: vwapReversion },
  { id: 'order-flow', n: 11, name: 'Order flow', group: 'flow', summary: 'At a level: absorption, delta flip, CVD turn, micro BOS', detect: orderFlow },
  { id: 'options-flow', n: 12, name: 'Options / derivatives', group: 'flow', summary: 'An OI wall that holds, with structure, flow and big-move risk', detect: optionsFlow },
];

