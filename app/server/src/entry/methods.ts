import type { Candle } from '../market/delta.js';
import type { EntryContext, Group, MethodId } from './types.js';
import {
  body, bullish, bearish, donchian, efficiency, ema, isDisplacement, lastBreak, lastSweep,
  openFvgs, orderBlocks, pivots, range, rvol, trendOf, vwapBand,
} from './prims.js';

/**
 * The twelve entry methods of TEST.md, each as its own trigger chain on one
 * timeframe.
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

const last = (bars: readonly Candle[]) => bars[bars.length - 1]!;
const prev = (bars: readonly Candle[]) => bars[bars.length - 2]!;
/** A zone of `w` ATRs on the side of `px` the trade enters from. */
const near = (px: number, dir: 1 | -1, a: number, w = 0.25): [number, number] =>
  dir === 1 ? [px, px + w * a] : [px - w * a, px];
const turned = (b: Candle, p: Candle, dir: 1 | -1) =>
  dir === 1 ? bullish(b) && b.close > p.high : bearish(b) && b.close < p.low;
const wickShare = (b: Candle, dir: 1 | -1) =>
  range(b) > 0 ? (dir === 1 ? Math.min(b.open, b.close) - b.low : b.high - Math.max(b.open, b.close)) / range(b) : 0;
const extremeSince = (bars: readonly Candle[], i: number, dir: 1 | -1) =>
  dir === 1 ? Math.min(...bars.slice(i).map((b) => b.low)) : Math.max(...bars.slice(i).map((b) => b.high));

/** 1. A close through the 20-bar range, on volume, with a strong body. */
const breakout: Detector = ({ bars, a }) => {
  const d = donchian(bars, 20);
  const b = last(bars);
  if (!d) return null;
  const dir = b.close > d.hi ? 1 : b.close < d.lo ? -1 : 0;
  if (dir === 0) return null;
  const rv = rvol(bars);
  return {
    dir,
    steps: [
      { label: `closed ${dir === 1 ? 'over the 20-bar high' : 'under the 20-bar low'}`, ok: true },
      { label: 'volume at least 1.3x its median', ok: rv === null ? null : rv >= 1.3 },
      { label: 'a strong close (body half the bar or more)', ok: range(b) > 0 && body(b) / range(b) >= 0.5 },
    ],
    zone: dir === 1 ? [b.close - 0.25 * a, b.close] : [b.close, b.close + 0.25 * a],
    stop: dir === 1 ? b.low : b.high,
    triggerTime: b.time,
  };
};

/** 2. A breakout in the last dozen bars, then a pullback to the level that holds. */
const breakoutRetest: Detector = ({ bars, a }) => {
  for (let j = bars.length - 2; j >= Math.max(21, bars.length - 13); j--) {
    const d = donchian(bars.slice(0, j + 1), 20);
    const bj = bars[j]!;
    if (!d) continue;
    const dir = bj.close > d.hi ? 1 : bj.close < d.lo ? -1 : 0;
    if (dir === 0) continue;
    const level = dir === 1 ? d.hi : d.lo;
    const after = bars.slice(j + 1);
    const came = after.some((x) => (dir === 1 ? x.low <= level + 0.3 * a : x.high >= level - 0.3 * a));
    const lost = after.some((x) => (dir === 1 ? x.close < level - 0.3 * a : x.close > level + 0.3 * a));
    const b = last(bars);
    const held = (dir === 1 ? b.close > level : b.close < level) && wickShare(b, dir) >= 0.3;
    return {
      dir,
      steps: [
        { label: `broke ${dir === 1 ? 'the 20-bar high' : 'the 20-bar low'}`, ok: true },
        { label: 'came back to the level', ok: came },
        { label: 'held it: no close back through', ok: !lost },
        { label: 'rejected it (a wick, a close away)', ok: held },
      ],
      zone: near(level, dir, a),
      stop: extremeSince(bars, j + 1, dir),
      triggerTime: bj.time,
    };
  }
  return null;
};

/** 3. Liquidity taken, then the structure breaks the other way, then a retest. */
const liquiditySweep: Detector = ({ bars, a }) => {
  const s = lastSweep(bars, 8);
  if (!s) return null;
  const dir = s.dir;
  const swings = pivots(bars, dir === 1 ? 'high' : 'low');
  const before = [...swings].reverse().find((p) => p.i < s.i);
  const after = bars.slice(s.i + 1);
  const level = before?.price ?? null;
  const mss = level !== null && after.some((x) => (dir === 1 ? x.close > level : x.close < level));
  const disp = after.some((x) => isDisplacement(x, a, 1) && (dir === 1 ? bullish(x) : bearish(x)));
  const b = last(bars);
  const retest = level !== null && mss
    && (dir === 1 ? b.low <= level + 0.3 * a && b.close > level : b.high >= level - 0.3 * a && b.close < level);
  return {
    dir,
    steps: [
      { label: `swept ${dir === 1 ? 'a swing low' : 'a swing high'} and closed back`, ok: true },
      { label: `MSS: closed through the swing ${dir === 1 ? 'high' : 'low'} before it`, ok: level === null ? null : mss },
      { label: 'displacement away from the sweep', ok: disp },
      { label: 'retest of the break holds', ok: retest },
    ],
    zone: near(level ?? b.close, dir, a),
    stop: extremeSince(bars, s.i, dir),
    triggerTime: s.time,
  };
};

/** 4. A gap left by displacement, price back into it, a reaction out. */
const fvgRetest: Detector = ({ bars, trend }) => {
  const z = openFvgs(bars, 30)[0];
  if (!z) return null;
  const dir = z.dir;
  const after = bars.slice(z.i + 2);
  const came = after.some((x) => (dir === 1 ? x.low <= z.hi : x.high >= z.lo));
  const b = last(bars);
  const reacted = came && (dir === 1 ? bullish(b) && b.close > z.lo : bearish(b) && b.close < z.hi);
  return {
    dir,
    steps: [
      { label: `a ${dir === 1 ? 'bullish' : 'bearish'} gap left by displacement`, ok: true },
      { label: 'structure not against it', ok: trend !== -dir },
      { label: 'price came back into the gap', ok: came },
      { label: 'a reaction out of it', ok: reacted },
    ],
    zone: [z.lo, z.hi],
    stop: dir === 1 ? bars[Math.max(0, z.i - 1)]!.low : bars[Math.max(0, z.i - 1)]!.high,
    triggerTime: z.time,
  };
};

/** 5. The last opposite candle before a structure-breaking displacement, revisited. */
const obRetest: Detector = ({ bars }) => {
  const z = orderBlocks(bars, 40)[0];
  if (!z) return null;
  const dir = z.dir;
  const after = bars.slice(z.i + 2);
  const came = after.some((x) => (dir === 1 ? x.low <= z.hi : x.high >= z.lo));
  const b = last(bars);
  // Rejected: a candle its way that closes back out of the block.
  const rejected = came && (dir === 1 ? bullish(b) && b.close > z.hi : bearish(b) && b.close < z.lo);
  return {
    dir,
    steps: [
      { label: 'an order block behind a structure break', ok: true },
      { label: 'price came back into the block', ok: came },
      { label: 'rejected there: closed back out of it', ok: rejected },
    ],
    zone: [z.lo, z.hi],
    stop: dir === 1 ? z.lo : z.hi,
    triggerTime: z.time,
  };
};

/** 6. A close through a swing with the trend, by displacement, then the retest. */
const bos: Detector = ({ bars, a, trend }) => {
  const br = lastBreak(bars, 4);
  if (!br || trend !== br.dir) return null;
  const dir = br.dir;
  const b = last(bars);
  const swings = pivots(bars, dir === 1 ? 'low' : 'high');
  const hl = [...swings].reverse().find((p) => p.i < br.i);
  return {
    dir,
    steps: [
      { label: `trend ${dir === 1 ? 'up (HH/HL)' : 'down (LH/LL)'}`, ok: true },
      { label: `BOS: closed through the swing ${dir === 1 ? 'high' : 'low'}`, ok: true },
      { label: 'the break was a displacement', ok: isDisplacement(bars[br.i]!, a, 1) },
      { label: 'retest of the broken level', ok: dir === 1 ? b.low <= br.level + 0.3 * a && b.close > br.level : b.high >= br.level - 0.3 * a && b.close < br.level },
    ],
    zone: near(br.level, dir, a),
    stop: hl?.price ?? extremeSince(bars, Math.max(0, br.i - 5), dir),
    triggerTime: br.time,
  };
};

/** 7. The trend the other way, a sweep, then a change of character, then the retest. */
const mss: Detector = ({ bars, a }) => {
  const br = lastBreak(bars, 6);
  if (!br) return null;
  const dir = br.dir;
  const priorTrend = trendOf(bars.slice(0, br.i));
  if (priorTrend !== -dir) return null;
  const sw = lastSweep(bars.slice(0, br.i + 1), 12);
  const swept = sw !== null && sw.dir === dir;
  const b = last(bars);
  return {
    dir,
    steps: [
      { label: `the trend was ${dir === 1 ? 'down' : 'up'}`, ok: true },
      { label: 'liquidity swept first', ok: swept },
      { label: 'CHoCH: closed through the last swing', ok: true },
      { label: 'the break was a displacement', ok: isDisplacement(bars[br.i]!, a, 1) },
      { label: 'retest of the break holds', ok: dir === 1 ? b.low <= br.level + 0.3 * a && b.close > br.level : b.high >= br.level - 0.3 * a && b.close < br.level },
    ],
    zone: near(br.level, dir, a),
    stop: extremeSince(bars, Math.max(0, (sw?.i ?? br.i) - 1), dir),
    triggerTime: br.time,
  };
};

/** 8. A strong directional bar on heavy volume that closes near its extreme -- not chased once extended. */
const momentum: Detector = ({ bars, a }) => {
  const b = last(bars);
  if (!isDisplacement(b, a, 1.5)) return null;
  const dir = bullish(b) ? 1 : -1;
  const rv = rvol(bars);
  // Extended *before* this bar: where it opened against the 20 EMA. The
  // displacement itself is the signal, and always a long way from the average.
  const e20 = ema(bars.slice(0, -1), 20);
  const stretch = e20 === null ? null : Math.abs(b.open - e20) / a;
  const nearExtreme = range(b) > 0 && (dir === 1 ? (b.high - b.close) / range(b) <= 0.25 : (b.close - b.low) / range(b) <= 0.25);
  return {
    dir,
    steps: [
      { label: 'displacement: a body of 1.5 ATR or more', ok: true },
      { label: 'volume at least 1.8x its median', ok: rv === null ? null : rv >= 1.8 },
      { label: 'follow-through: closed near its extreme', ok: nearExtreme },
    ],
    zone: dir === 1 ? [b.close - 0.25 * a, b.close] : [b.close, b.close + 0.25 * a],
    stop: dir === 1 ? b.low : b.high,
    triggerTime: b.time,
    ...(stretch !== null && stretch > 3 ? { blocked: `extended: opened ${stretch.toFixed(1)} ATR from the 20 EMA -- not chased` } : {}),
  };
};

/** 9. A trend, a pullback to the 20 EMA, and the resumption. */
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
      { label: 'resumed: closed past the prior bar', ok: turned(b, prev(bars), dir) },
    ],
    zone: dir === 1 ? [b.close - 0.25 * a, b.close] : [b.close, b.close + 0.25 * a],
    stop: extremeSince(bars, bars.length - 4, dir),
    triggerTime: bars[extremeIdx]?.time ?? b.time,
  };
};

/** 10. Stretched two deviations from VWAP, exhausted, and turning -- off on a trend day. */
const vwapReversion: Detector = ({ bars, a }) => {
  const vb = vwapBand(bars);
  if (!vb || vb.z === null || Math.abs(vb.z) < 2) return null;
  const dir = vb.z < 0 ? 1 : -1;
  const b = last(bars);
  const rv = rvol(bars);
  const er = efficiency(bars, 20);
  const recent = bars.slice(-3);
  const extremeBar = dir === 1 ? recent.reduce((m, x) => (x.low < m.low ? x : m)) : recent.reduce((m, x) => (x.high > m.high ? x : m));
  return {
    dir,
    steps: [
      { label: `stretched ${Math.abs(vb.z).toFixed(1)} deviations from VWAP`, ok: true },
      { label: 'exhaustion: a volume spike or a long wick', ok: (rv !== null && rv >= 1.5) || recent.some((x) => wickShare(x, dir) >= 0.4) },
      { label: 'a reversal candle', ok: turned(b, prev(bars), dir) },
    ],
    zone: dir === 1 ? [b.close - 0.2 * a, b.close] : [b.close, b.close + 0.2 * a],
    stop: dir === 1 ? extremeBar.low : extremeBar.high,
    triggerTime: extremeBar.time,
    targets: [{ price: vb.vwap, why: `VWAP ${Math.round(vb.vwap).toLocaleString('en-US')}` }],
    ...(er !== null && er > 0.6 ? { blocked: `trend day: price is travelling straight (efficiency ${er.toFixed(2)}), mean reversion is off` } : {}),
  };
};

/**
 * 11. At a level, the other side's aggression absorbed, then the delta turns.
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
  const one = ctx.frames['1m'] ?? [];
  const read = minutes.length >= 5;
  const early = minutes.slice(0, -2);
  const late = minutes.slice(-2);
  const delta = (xs: typeof minutes) => xs.reduce((s, m) => s + m.buy - m.sell, 0);
  const pressed = read ? (dir === 1 ? delta(early) < 0 : delta(early) > 0) : null;
  const heldLow = one.slice(-7).length ? extremeSince(one, Math.max(0, one.length - 7), dir) : null;
  const held = heldLow === null ? null : dir === 1 ? heldLow >= level - 0.2 * a : heldLow <= level + 0.2 * a;
  const flipped = read ? (dir === 1 ? delta(late) > 0 : delta(late) < 0) : null;
  const big = read ? minutes.reduce((s, m) => s + (dir === 1 ? m.largeBuy - m.largeSell : m.largeSell - m.largeBuy), 0) > 0 : null;
  return {
    dir,
    steps: [
      { label: `at ${dir === 1 ? 'support (swing low / bid wall)' : 'resistance (swing high / ask wall)'}`, ok: true },
      { label: `${dir === 1 ? 'sellers' : 'buyers'} hit it (delta against)`, ok: pressed },
      { label: 'and it held (absorption)', ok: pressed === null ? null : Boolean(pressed) && held === true },
      { label: `delta turned ${dir === 1 ? 'positive' : 'negative'}`, ok: flipped },
      { label: `big ${dir === 1 ? 'buy' : 'sell'} prints on the side`, ok: big },
    ],
    zone: near(level, dir, a),
    stop: heldLow === null ? level : (dir === 1 ? Math.min(level, heldLow) : Math.max(level, heldLow)),
    triggerTime: b.time,
  };
};

/** 12. At an option OI wall, price reacts, and the big-move reading is not against it. */
const optionsFlow: Detector = ({ bars, a, ctx }) => {
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
  const notAgainst = bm === null || bm.direction === null ? null : !((bm.band === 'high' || bm.band === 'sudden') && bm.direction * dir <= -0.3);
  const targets = o.maxPain !== null && (dir === 1 ? o.maxPain > b.close : o.maxPain < b.close)
    ? [{ price: o.maxPain, why: `max pain ${o.maxPain.toLocaleString('en-US')}` }] : [];
  return {
    dir,
    steps: [
      { label: `at the ${dir === 1 ? 'put' : 'call'} OI wall ${wall.toLocaleString('en-US')}`, ok: true },
      { label: 'held and reacted (closed past the prior bar)', ok: turned(b, prev(bars), dir) },
      { label: 'big-move reading not against it', ok: notAgainst },
    ],
    zone: dir === 1 ? [b.close - 0.2 * a, b.close] : [b.close, b.close + 0.2 * a],
    stop: dir === 1 ? Math.min(wall, b.low) : Math.max(wall, b.high),
    triggerTime: b.time,
    targets,
  };
};

export const METHODS: readonly { id: MethodId; n: number; name: string; group: Group; detect: Detector }[] = [
  { id: 'breakout', n: 1, name: 'Breakout', group: 'breakout', detect: breakout },
  { id: 'breakout-retest', n: 2, name: 'Breakout + retest', group: 'pullback', detect: breakoutRetest },
  { id: 'liquidity-sweep', n: 3, name: 'Liquidity sweep', group: 'reversal', detect: liquiditySweep },
  { id: 'fvg-retest', n: 4, name: 'FVG retest', group: 'pullback', detect: fvgRetest },
  { id: 'ob-retest', n: 5, name: 'Order-block retest', group: 'pullback', detect: obRetest },
  { id: 'bos', n: 6, name: 'BOS', group: 'breakout', detect: bos },
  { id: 'mss', n: 7, name: 'MSS / CHoCH', group: 'reversal', detect: mss },
  { id: 'momentum', n: 8, name: 'Momentum', group: 'breakout', detect: momentum },
  { id: 'pullback', n: 9, name: 'Pullback', group: 'pullback', detect: pullback },
  { id: 'vwap-reversion', n: 10, name: 'VWAP / mean reversion', group: 'reversal', detect: vwapReversion },
  { id: 'order-flow', n: 11, name: 'Order flow', group: 'flow', detect: orderFlow },
  { id: 'options-flow', n: 12, name: 'Options / derivatives', group: 'flow', detect: optionsFlow },
];

