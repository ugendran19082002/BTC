import type { Candle } from '../market/delta.js';
import { atr, ema, mean } from '../domain/indicators.js';
import { marketState, type Side } from '../domain/market-state.js';
import { evaluateSignalOutcome } from '../market/state-history.js';

/**
 * The momentum call, replayed over history (26 Sep 2026).
 *
 * The live card says "breakout confirmed" with a target and a stop; the
 * journal has four days of how that went. This replays the *same*
 * `marketState` over two and a half years of closed bars, grades each call
 * with the *same* `evaluateSignalOutcome`, and then asks the question a hit
 * rate cannot answer on its own: what did it pay, in units of what it risked,
 * after Delta's fees. A 90% hit rate with a target a tenth the size of its
 * stop loses money; R does not let that hide.
 *
 * Everything here is pure: bars in, rows out. The script that fetches and
 * prints is `momentum-study.ts`.
 */

export type Tf = '5m' | '15m' | '30m' | '1h';
export const TF_BARS_OF_5M: Record<Tf, number> = { '5m': 1, '15m': 3, '30m': 6, '1h': 12 };

/** Five-minute bars into `n`-bar bars, aligned to the clock, incomplete buckets dropped. */
export function resample(bars: readonly Candle[], n: number): Candle[] {
  if (n === 1) return [...bars];
  const span = n * 300;
  const out: Candle[] = [];
  let bucket: Candle[] = [];
  let start = -1;
  const flush = () => {
    if (bucket.length === n) {
      out.push({
        time: start,
        open: bucket[0]!.open,
        high: Math.max(...bucket.map((b) => b.high)),
        low: Math.min(...bucket.map((b) => b.low)),
        close: bucket[bucket.length - 1]!.close,
        volume: bucket.reduce((a, b) => a + b.volume, 0),
      });
    }
    bucket = [];
  };
  for (const b of bars) {
    const s = b.time - (b.time % span);
    if (s !== start) { flush(); start = s; }
    bucket.push(b);
  }
  flush();
  return out;
}

export type Trend = 1 | -1 | 0;

/**
 * A higher timeframe's trend at each moment, from its *closed* bars only.
 *
 * Close over its EMA and the EMA rising is up; the mirror is down; anything
 * else is no trend. `at(t)` answers for a bar that closed at `t` seconds, and
 * never looks at a higher bar that had not closed by then.
 */
export function trendSeries(htf: readonly Candle[], spanSec: number, period: number): (t: number) => Trend {
  const closes: number[] = [];
  const times: number[] = [];
  const trend: Trend[] = [];
  let prevEma: number | null = null;
  for (const b of htf) {
    closes.push(b.close);
    const e = closes.length >= period ? ema(closes.slice(-period * 3), period) : null;
    times.push(b.time + spanSec);
    trend.push(e === null || prevEma === null ? 0 : b.close > e && e > prevEma ? 1 : b.close < e && e < prevEma ? -1 : 0);
    prevEma = e;
  }
  return (t: number) => {
    // The last higher bar that had closed by `t`.
    let lo = 0;
    let hi = times.length - 1;
    let idx = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (times[mid]! <= t) { idx = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return idx < 0 ? 0 : trend[idx]!;
  };
}

export type Signal = {
  tf: Tf;
  /** The signal bar's open time, seconds; it is acted on at its close. */
  time: number;
  side: Side;
  level: number;
  entry: number;
  atr: number;
  /** The signal bar's far extreme against the trade: its low for a long. */
  barExtreme: number;
  plan: { trigger: number; target1: number; invalidation: number };
  features: {
    year: number;
    /** 1h and 4h trend against the signal: +1 with it, −1 against, 0 none. */
    h1: Trend;
    h4: Trend;
    /** ATR now against its average over the prior 100 bars: under 1 is compressed. */
    compression: number | null;
    volumeRatio: number | null;
    /** How far the close already is past the level, in ATR: a late entry is a worse entry. */
    overshootAtr: number;
    /** Hour of the day, IST. */
    hourIst: number;
  };
};

const WINDOW = 60;

/**
 * Every confirmed breakout and breakdown on `tf`, as the live card would have
 * called it at the bar's close.
 *
 * A second call the same way within `cooldownBars` is the same move and is
 * dropped: counting it again would count one good hour several times.
 */
export function extractSignals(bars5m: readonly Candle[], tf: Tf, cooldownBars = 3): { signals: Signal[]; bars: Candle[] } {
  const bars = resample(bars5m, TF_BARS_OF_5M[tf]);
  const h1 = trendSeries(resample(bars5m, 12), 3600, 20);
  const h4 = trendSeries(resample(bars5m, 48), 4 * 3600, 20);
  const span = TF_BARS_OF_5M[tf] * 300;
  const signals: Signal[] = [];
  const lastAt: Record<Side, number> = { UP: -Infinity, DOWN: -Infinity };
  // A rolling true range, for the compression ratio.
  const trs: number[] = [0];
  for (let i = 1; i < bars.length; i++) {
    const b = bars[i]!; const a = bars[i - 1]!;
    trs.push(Math.max(b.high - b.low, Math.abs(b.high - a.close), Math.abs(b.low - a.close)));
  }
  for (let i = Math.max(WINDOW, 115); i < bars.length; i++) {
    const window = bars.slice(i - WINDOW + 1, i + 1);
    const a = atr(window, 14);
    if (!a || a <= 0) continue;
    const s = marketState({ bars: window, level: { resistance: null, support: null }, atr: a, tfLabel: tf });
    if (s.stage !== 'CONFIRMED' || !s.side || s.against === null) continue;
    if (s.event !== 'BREAKOUT_CONFIRMED' && s.event !== 'BREAKDOWN_CONFIRMED') continue;
    if (i - lastAt[s.side] <= cooldownBars) { lastAt[s.side] = i; continue; }
    lastAt[s.side] = i;
    const plan = s.plans[s.side === 'UP' ? 'up' : 'down'];
    if (!plan) continue;
    const bar = bars[i]!;
    const closeT = bar.time + span;
    const dir = s.side === 'UP' ? 1 : -1;
    const prior = mean(trs.slice(i - 114, i - 14));
    const nowAtr = mean(trs.slice(i - 14, i));
    signals.push({
      tf, time: bar.time, side: s.side, level: s.against, entry: bar.close, atr: a,
      barExtreme: s.side === 'UP' ? bar.low : bar.high,
      plan: { trigger: plan.trigger, target1: plan.target1, invalidation: plan.invalidation },
      features: {
        year: new Date(closeT * 1000).getUTCFullYear(),
        h1: (h1(closeT) * dir) as Trend,
        h4: (h4(closeT) * dir) as Trend,
        compression: prior && nowAtr ? nowAtr / prior : null,
        volumeRatio: s.volumeRatio,
        overshootAtr: Math.abs(bar.close - s.against) / a,
        hourIst: Math.floor(((closeT + 19_800) % 86_400) / 3600),
      },
    });
  }
  return { signals, bars };
}

/** How the stop and target are placed. Every policy enters at the signal bar's close. */
export type Policy = {
  name: string;
  levels: (s: Signal) => { stop: number; target: number };
};

export const POLICIES: Policy[] = [
  // What the live card draws today: both measured from the level, not the entry.
  { name: 'live (level ± 1 ATR)', levels: (s) => ({ stop: s.plan.invalidation, target: s.plan.target1 }) },
  { name: 'entry 1 ATR : 1 ATR', levels: (s) => byAtr(s, 1, 1) },
  { name: 'entry 1 ATR : 1.5 ATR', levels: (s) => byAtr(s, 1, 1.5) },
  { name: 'entry 1 ATR : 2 ATR', levels: (s) => byAtr(s, 1, 2) },
  { name: 'entry 1.5 ATR : 3 ATR', levels: (s) => byAtr(s, 1.5, 3) },
  { name: 'bar extreme : 2R', levels: (s) => {
    const risk = Math.max(Math.abs(s.entry - s.barExtreme), s.atr * 0.25);
    const dir = s.side === 'UP' ? 1 : -1;
    return { stop: s.entry - dir * risk, target: s.entry + dir * risk * 2 };
  } },
];

function byAtr(s: Signal, stopAtr: number, targetAtr: number) {
  const dir = s.side === 'UP' ? 1 : -1;
  return { stop: s.entry - dir * s.atr * stopAtr, target: s.entry + dir * s.atr * targetAtr };
}

export type Result = {
  outcome: 'TARGET' | 'STOP' | 'TIME' | 'NO_ROOM';
  /** Profit in units of the risk taken, before and after fees. */
  r: number;
  rNet: number;
};

/**
 * One trade, bar by bar after the signal, until the target, the stop or
 * `horizon` bars have passed; at the horizon it is closed at that bar's close.
 *
 * A bar that reaches both is a stop -- the order inside a bar is not in the
 * bar, and the grader takes the same side of that doubt. `feePct` is charged
 * on both sides, as a share of price.
 */
export function simulate(s: Signal, after: readonly Candle[], policy: Policy, horizon: number, feePct = 0.0005): Result {
  const { stop, target } = policy.levels(s);
  const dir = s.side === 'UP' ? 1 : -1;
  const risk = Math.abs(s.entry - stop);
  const fee = (s.entry * 2 * feePct) / risk;
  if (!(risk > 0)) return { outcome: 'TIME', r: 0, rNet: -fee };
  // No room: the target is already at or behind the entry. There is no trade to take, so it is not scored.
  if (dir * (target - s.entry) <= 0) return { outcome: 'NO_ROOM', r: 0, rNet: 0 };
  const bars = after.slice(0, horizon);
  for (const b of bars) {
    const hitStop = dir === 1 ? b.low <= stop : b.high >= stop;
    const hitTarget = dir === 1 ? b.high >= target : b.low <= target;
    if (hitStop) return { outcome: 'STOP', r: -1, rNet: -1 - fee };
    if (hitTarget) {
      // Signed: a target already behind the entry is a loss when it fills, not a win.
      const r = (dir * (target - s.entry)) / risk;
      return { outcome: 'TARGET', r, rNet: r - fee };
    }
  }
  const last = bars[bars.length - 1];
  const r = last ? (dir * (last.close - s.entry)) / risk : 0;
  return { outcome: 'TIME', r, rNet: r - fee };
}

/** The live grader's verdict on the live plan, over the live window: the journal's own number. */
export function liveGrade(s: Signal, after: readonly Candle[], windowBars: number, spanSec: number) {
  return evaluateSignalOutcome({
    plan: { side: s.side, trigger: s.plan.trigger, target1: s.plan.target1, target2: s.plan.target1, invalidation: s.plan.invalidation },
    side: s.side,
    stage: 'CONFIRMED',
    callAt: (s.time + spanSec) * 1000,
    closeAtCall: s.entry,
    windowMs: windowBars * spanSec * 1000,
    after: after.slice(0, windowBars),
  }).outcome;
}

export type Tally = { n: number; hits: number; r: number; rNet: number; noRoom: number };
export const emptyTally = (): Tally => ({ n: 0, hits: 0, r: 0, rNet: 0, noRoom: 0 });
export function add(t: Tally, x: Result): void {
  if (x.outcome === 'NO_ROOM') { t.noRoom++; return; }
  t.n++;
  if (x.outcome === 'TARGET') t.hits++;
  t.r += x.r;
  t.rNet += x.rNet;
}
