import type { Candle } from '../market/delta.js';
import type { DetectInput, MethodDef, Setup, TargetSpec } from './methods.js';
import { bearish, bullish, pivots, range, rvol, vwapBand } from './prims.js';
import { LIVE_CANDIDATES } from './candidates-live.js';

/**
 * Candidate entry methods, #13-#37 of the owner's list of 1 Oct 2026, written
 * the way the twelve are (methods.ts) so one that earns its place can join
 * them unchanged. They are research until then: scripts/methods-study.ts
 * replays each over the cached 5m history through the same plan, gates and
 * grading as the twelve, against a bar declared before it ran. None is on the
 * desk until it passes.
 *
 * Only the ones candles can answer are here; the ones that need the desk's
 * live data (tape, mark, index, funding, the option board) are in
 * candidates-live.ts and run on the research track only. Liquidations, L2
 * order-book ticks, per-price footprint and ETH are not collected. #19 (range
 * consumed) is a regime, read beside every setup rather than as an entry;
 * #38 was declined by the owner.
 */

const DAY = 86_400;
const last = (bars: readonly Candle[]) => bars[bars.length - 1]!;
const prev = (bars: readonly Candle[]) => bars[bars.length - 2]!;
const atClose = (b: Candle, dir: 1 | -1, a: number, w = 0.25): [number, number] =>
  dir === 1 ? [b.close - w * a, b.close] : [b.close, b.close + w * a];
const turned = (b: Candle, p: Candle, dir: 1 | -1) =>
  dir === 1 ? bullish(b) && b.close > p.high : bearish(b) && b.close < p.low;
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

const tgt = (tp1: TargetSpec['tp1'], tp2: TargetSpec['tp2']): TargetSpec => ({ tp1, tp2 });
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

const GROUP: Record<string, MethodDef['group']> = {
  volatility: 'breakout', breakout: 'breakout', session: 'breakout', structure: 'breakout',
  reversal: 'reversal', liquidity: 'reversal', range: 'reversal', statistical: 'reversal', imbalance: 'reversal', vwap: 'reversal', 'volume profile': 'reversal',
  flow: 'flow',
};
/** The candidates as methods: read live beside the twelve, on the research track (paper log only, no alerts). */
export const RESEARCH: readonly MethodDef[] = [...CANDIDATES, ...LIVE_CANDIDATES].map((c) => ({
  id: c.id, n: c.n, name: c.name, group: GROUP[c.family] ?? 'reversal', summary: `research · ${c.family}`, sl: c.sl,
  targets: c.targets, detect: c.detect, research: true,
}));

