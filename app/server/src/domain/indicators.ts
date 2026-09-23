import type { Candle } from '../market/delta.js';
import type { MarketEvent, Side } from './market-state.js';

/**
 * The readings under the chart, and the arithmetic behind each one.
 *
 * Two jobs. The first half is formulas -- close location, rate of change, the
 * efficiency ratio, z-scores, percentiles, MACD -- each one small, pure and
 * tested on its own, so anything else in the desk can use them without
 * importing a card. The second half assembles the handful that belong on the
 * screen right now.
 *
 * The rule the summary follows, and the reason it exists: a hundred indicators
 * on one screen is nothing on one screen. What is worth reading depends
 * entirely on what price is doing -- at a level being tested, volume, the
 * aggressor split and the wick are the story and the daily RSI is not -- so
 * `relevantIndicators` picks by state, and everything else stays in the API
 * for whatever wants to measure it.
 */

// ------------------------------------------------------------------ formulas

/** Simple return over one step. */
export const simpleReturn = (now: number, then: number): number | null =>
  then > 0 ? (now - then) / then : null;

/** Log return: what volatility arithmetic wants, because they add up over time. */
export const logReturn = (now: number, then: number): number | null =>
  now > 0 && then > 0 ? Math.log(now / then) : null;

/** Rate of change over n bars, as a percentage. */
export function roc(closes: readonly number[], n: number): number | null {
  if (closes.length <= n) return null;
  const then = closes[closes.length - 1 - n]!;
  const now = closes[closes.length - 1]!;
  return then > 0 ? (now / then - 1) * 100 : null;
}

/**
 * Close location value: +1 closed on the high, -1 on the low, 0 in the middle.
 *
 * The same idea as `closeLocation` in the state engine, on the scale the
 * textbooks use. Both exist because a score wants 0 to 1 and a reader wants a
 * sign.
 */
export function clv(bar: Candle): number | null {
  const range = bar.high - bar.low;
  return range > 0 ? ((bar.close - bar.low) - (bar.high - bar.close)) / range : null;
}

export function mean(xs: readonly number[]): number | null {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}

export function stdev(xs: readonly number[]): number | null {
  const m = mean(xs);
  if (m === null || xs.length < 2) return null;
  return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1));
}

/**
 * How unusual a reading is against its own history, in standard deviations.
 *
 * The honest way to say "funding is stretched" or "that is a lot of volume":
 * a fixed threshold ages badly as the market changes, and a z-score does not.
 */
export function zScore(xs: readonly number[], x: number): number | null {
  const m = mean(xs);
  const s = stdev(xs);
  return m === null || s === null || s === 0 ? null : (x - m) / s;
}

/** Where a reading sits in its own history, 0 to 1. */
export function percentileOf(xs: readonly number[], x: number): number | null {
  if (!xs.length) return null;
  return xs.filter((v) => v <= x).length / xs.length;
}

/**
 * Efficiency ratio: how much of the distance travelled was actually progress.
 *
 * The net move over n bars divided by the sum of every step taken to get
 * there. Near 1 the market went somewhere in a straight line; near 0 it
 * covered the same ground over and over. It separates a trend from a range
 * without a single threshold on ADX.
 */
export function efficiencyRatio(closes: readonly number[], n = 10): number | null {
  if (closes.length <= n) return null;
  const window = closes.slice(-(n + 1));
  const net = Math.abs(window[window.length - 1]! - window[0]!);
  let path = 0;
  for (let i = 1; i < window.length; i++) path += Math.abs(window[i]! - window[i - 1]!);
  return path > 0 ? net / path : null;
}

export function ema(xs: readonly number[], period: number): number | null {
  if (xs.length < period) return null;
  const k = 2 / (period + 1);
  let out = xs.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < xs.length; i++) out = xs[i]! * k + out * (1 - k);
  return out;
}

export type Macd = { macd: number; signal: number; histogram: number };

/** MACD(12, 26, 9), and the histogram, which is the part worth reading. */
export function macd(closes: readonly number[], fast = 12, slow = 26, signal = 9): Macd | null {
  if (closes.length < slow + signal) return null;
  const line: number[] = [];
  for (let i = slow; i <= closes.length; i++) {
    const upTo = closes.slice(0, i);
    const f = ema(upTo, fast);
    const s = ema(upTo, slow);
    if (f === null || s === null) continue;
    line.push(f - s);
  }
  const sig = ema(line, signal);
  const last = line[line.length - 1];
  if (sig === null || last === undefined) return null;
  return { macd: last, signal: sig, histogram: last - sig };
}

// ------------------------------------------------------------------ the card

export type IndicatorBias = 'BULLISH' | 'BEARISH' | 'NEUTRAL';

export type Indicator = {
  key: string;
  /** What goes above the number: "RSI (14)", "EMA 21/50". */
  label: string;
  /** The number itself, already rounded for the screen. Null when unmeasured. */
  value: number | null;
  /** How it is written: "62", "1.8x", "+2.4%". */
  text: string;
  /** The word under it: "Neutral", "Bullish", "Increasing". */
  read: string;
  bias: IndicatorBias;
  /** 0-1 for the little gauge, where the reading has natural bounds. */
  gauge: number | null;
};

export type IndicatorInput = {
  bars: readonly Candle[];
  rsi14: number | null;
  adx14: number | null;
  atrPct: number | null;
  vwapDistPct: number | null;
  emaFast: number | null;
  emaSlow: number | null;
  volumeRatio: number | null;
  cvdSlope: number | null;
  aggressorBuyPct: number | null;
  oiChangePct: number | null;
  /** Implied less realised volatility, in points. Negative is options cheap. */
  ivRvPts?: number | null;
};

/** Everything measurable, in the order a reader would want it. */
export function indicators(input: IndicatorInput): Indicator[] {
  const closes = input.bars.map((b) => b.close);
  const m = macd(closes);
  const er = efficiencyRatio(closes);
  const out: Indicator[] = [];

  out.push(num('rsi', 'RSI (14)', input.rsi14, (v) => v.toFixed(0),
    (v) => (v >= 70 ? ['Overbought', 'BEARISH'] : v <= 30 ? ['Oversold', 'BULLISH'] : v >= 55 ? ['Bullish', 'BULLISH'] : v <= 45 ? ['Bearish', 'BEARISH'] : ['Neutral', 'NEUTRAL']),
    (v) => v / 100));

  out.push(num('macd', 'MACD', m?.histogram ?? null, (v) => (v > 0 ? '+' : '') + v.toFixed(0),
    (v) => (v > 0 ? ['Bullish', 'BULLISH'] : v < 0 ? ['Bearish', 'BEARISH'] : ['Flat', 'NEUTRAL']), () => null));

  const stack = input.emaFast !== null && input.emaSlow !== null ? input.emaFast - input.emaSlow : null;
  out.push(num('ema', 'EMA 21/50', stack, (v) => (v > 0 ? '+' : '') + v.toFixed(0),
    (v) => (v > 0 ? ['Bullish', 'BULLISH'] : v < 0 ? ['Bearish', 'BEARISH'] : ['Flat', 'NEUTRAL']), () => null));

  out.push(num('vwap', 'VWAP', input.vwapDistPct, (v) => `${v > 0 ? '+' : ''}${v.toFixed(2)}%`,
    (v) => (v > 0.05 ? ['Above', 'BULLISH'] : v < -0.05 ? ['Below', 'BEARISH'] : ['At VWAP', 'NEUTRAL']), () => null));

  out.push(num('adx', 'ADX', input.adx14, (v) => v.toFixed(0),
    (v) => (v >= 25 ? ['Trending', 'NEUTRAL'] : v <= 15 ? ['No trend', 'NEUTRAL'] : ['Weak trend', 'NEUTRAL']),
    (v) => Math.min(1, v / 50)));

  out.push(num('atr', 'ATR', input.atrPct, (v) => `${v.toFixed(2)}%`,
    () => ['Volatility', 'NEUTRAL'], () => null));

  out.push(num('volume', 'Volume', input.volumeRatio, (v) => `${v.toFixed(1)}x`,
    (v) => (v >= 2 ? ['Burst', 'NEUTRAL'] : v >= 1.5 ? ['Increasing', 'NEUTRAL'] : v >= 1 ? ['Normal', 'NEUTRAL'] : ['Quiet', 'NEUTRAL']),
    (v) => Math.min(1, v / 3)));

  out.push(num('cvd', 'CVD', input.cvdSlope, (v) => (v > 0 ? '↑ rising' : v < 0 ? '↓ falling' : 'flat'),
    (v) => (v > 0 ? ['Buyers', 'BULLISH'] : v < 0 ? ['Sellers', 'BEARISH'] : ['Even', 'NEUTRAL']), () => null));

  out.push(num('aggressor', 'Aggressor', input.aggressorBuyPct, (v) => `${v.toFixed(0)}% buy`,
    (v) => (v >= 55 ? ['Buyers lifting', 'BULLISH'] : v <= 45 ? ['Sellers hitting', 'BEARISH'] : ['Even', 'NEUTRAL']),
    (v) => v / 100));

  out.push(num('oi', 'Open interest', input.oiChangePct, (v) => `${v > 0 ? '+' : ''}${v.toFixed(1)}%`,
    (v) => (v > 0.5 ? ['Building', 'NEUTRAL'] : v < -0.5 ? ['Unwinding', 'NEUTRAL'] : ['Flat', 'NEUTRAL']), () => null));

  out.push(num('er', 'Efficiency', er, (v) => v.toFixed(2),
    (v) => (v >= 0.5 ? ['Directional', 'NEUTRAL'] : v <= 0.2 ? ['Choppy', 'NEUTRAL'] : ['Mixed', 'NEUTRAL']), (v) => v));

  if (input.ivRvPts !== undefined) {
    out.push(num('ivrv', 'IV − RV', input.ivRvPts ?? null, (v) => `${v > 0 ? '+' : ''}${v.toFixed(1)} pts`,
      (v) => (v > 2 ? ['Options dear', 'NEUTRAL'] : v < -2 ? ['Options cheap', 'NEUTRAL'] : ['Fair', 'NEUTRAL']), () => null));
  }

  return out;
}

function num(
  key: string, label: string, value: number | null,
  text: (v: number) => string,
  read: (v: number) => [string, IndicatorBias],
  gauge: (v: number) => number | null,
): Indicator {
  if (value === null) return { key, label, value: null, text: '—', read: 'No reading', bias: 'NEUTRAL', gauge: null };
  const [word, bias] = read(value);
  const g = gauge(value);
  return {
    key, label, value: Math.round(value * 100) / 100, text: text(value), read: word, bias,
    gauge: g === null ? null : Math.max(0, Math.min(1, g)),
  };
}

/**
 * The six to ten worth showing, for the state price is in.
 *
 * Each state has the readings that decide it. At a level being tested that is
 * volume, who is crossing the spread and where the bar closed; in a range it
 * is the ones that say whether the range is about to end. The rest are still
 * in the payload -- this only decides what is on the card.
 */
export const RELEVANT_BY_STATE: Record<string, readonly string[]> = {
  WATCH: ['volume', 'cvd', 'aggressor', 'oi', 'rsi', 'adx', 'er'],
  CANDIDATE: ['volume', 'cvd', 'aggressor', 'oi', 'macd', 'rsi'],
  CONFIRMED: ['volume', 'cvd', 'oi', 'macd', 'ema', 'adx'],
  RETEST: ['volume', 'cvd', 'vwap', 'ema', 'adx', 'oi'],
  FAILED: ['volume', 'aggressor', 'cvd', 'rsi', 'vwap', 'oi'],
  RANGE: ['atr', 'adx', 'er', 'volume', 'rsi', 'vwap'],
};

export function relevantIndicators(
  all: readonly Indicator[],
  stage: keyof typeof RELEVANT_BY_STATE | string,
  _event?: MarketEvent, _side?: Side | null,
  limit = 6,
): Indicator[] {
  const wanted = RELEVANT_BY_STATE[stage] ?? RELEVANT_BY_STATE.RANGE!;
  const by = new Map(all.map((i) => [i.key, i]));
  const picked = wanted.map((k) => by.get(k)).filter((i): i is Indicator => i !== undefined);
  // A reading that could not be measured takes a slot from one that could.
  const measured = picked.filter((i) => i.value !== null);
  const rest = all.filter((i) => i.value !== null && !wanted.includes(i.key));
  return [...measured, ...rest].slice(0, limit);
}
