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

/**
 * The rest of the owner's indicator list, computed from bars alone.
 *
 * Everything here needs nothing but the candles the chart is already drawing,
 * which is the whole reason these are the ones that got built: the desk can
 * take them on any timeframe without another feed, another key or another
 * thing to be down at four in the morning.
 *
 * None of them is shown by default. They are votes in the chart's up-or-down
 * badge, and `relevantIndicators()` still picks six for the card -- the owner's
 * own rule, and the right one: a screen with forty readings on it is a screen
 * nobody reads.
 */

/** Where price sits in its own recent range, 0 at the low and 1 at the high. */
export function donchian(bars: readonly Candle[], n = 20): number | null {
  const window = bars.slice(-n);
  if (window.length < Math.min(5, n)) return null;
  const high = Math.max(...window.map((b) => b.high));
  const low = Math.min(...window.map((b) => b.low));
  const close = window[window.length - 1]!.close;
  return high === low ? 0.5 : (close - low) / (high - low);
}

/** Bollinger %B: where price sits across the band, and how wide the band is. */
export function bollinger(closes: readonly number[], n = 20, k = 2): { percentB: number; width: number } | null {
  const window = closes.slice(-n);
  if (window.length < n) return null;
  const mid = mean(window);
  const sd = stdev(window);
  if (mid === null || sd === null || sd === 0 || mid === 0) return null;
  const upper = mid + k * sd;
  const lower = mid - k * sd;
  return {
    percentB: (window[window.length - 1]! - lower) / (upper - lower),
    width: ((upper - lower) / mid) * 100,
  };
}

/** Stochastic %K: the same idea as Donchian, said the way a trader says it. */
export const stochastic = (bars: readonly Candle[], n = 14): number | null => {
  const d = donchian(bars, n);
  return d === null ? null : d * 100;
};

/** Williams %R: the stochastic upside down, which is how it is quoted. */
export const williamsR = (bars: readonly Candle[], n = 14): number | null => {
  const d = donchian(bars, n);
  return d === null ? null : (d - 1) * 100;
};

/** CCI: how far price is from its own mean, in mean deviations. */
export function cci(bars: readonly Candle[], n = 20): number | null {
  const window = bars.slice(-n);
  if (window.length < n) return null;
  const typical = window.map((b) => (b.high + b.low + b.close) / 3);
  const avgT = mean(typical);
  if (avgT === null) return null;
  const dev = mean(typical.map((t) => Math.abs(t - avgT)));
  if (dev === null || dev === 0) return null;
  return (typical[typical.length - 1]! - avgT) / (0.015 * dev);
}

/**
 * On-balance volume, as a slope rather than a level.
 *
 * The level depends on where the series happens to start, so it says nothing
 * on its own; whether it is rising while price is not is the whole reading.
 */
export function obvSlope(bars: readonly Candle[], n = 20): number | null {
  const window = bars.slice(-(n + 1));
  if (window.length < 5) return null;
  let obv = 0;
  const series: number[] = [];
  for (let i = 1; i < window.length; i++) {
    const now = window[i]!;
    const before = window[i - 1]!;
    obv += now.close > before.close ? now.volume : now.close < before.close ? -now.volume : 0;
    series.push(obv);
  }
  const total = series.reduce((a, b) => a + Math.abs(b), 0) / series.length;
  if (total === 0) return null;
  return ((series[series.length - 1]! - series[0]!) / total) * 100;
}

/**
 * The choppiness index: 0 trending, 100 going nowhere.
 *
 * The sum of the bars' own ranges against the range they covered together --
 * a lot of movement inside a small range is the definition of chop.
 */
export function choppiness(bars: readonly Candle[], n = 14): number | null {
  const window = bars.slice(-n);
  if (window.length < n) return null;
  const sumRange = window.reduce((a, b) => a + (b.high - b.low), 0);
  const high = Math.max(...window.map((b) => b.high));
  const low = Math.min(...window.map((b) => b.low));
  if (high === low || sumRange === 0) return null;
  return (100 * Math.log10(sumRange / (high - low))) / Math.log10(n);
}

/** Aroon: how recently the highest high and the lowest low happened, -100 to 100. */
export function aroon(bars: readonly Candle[], n = 25): number | null {
  const window = bars.slice(-n);
  if (window.length < Math.min(10, n)) return null;
  let hi = 0;
  let lo = 0;
  for (let i = 1; i < window.length; i++) {
    if (window[i]!.high >= window[hi]!.high) hi = i;
    if (window[i]!.low <= window[lo]!.low) lo = i;
  }
  const len = window.length - 1;
  if (len === 0) return null;
  return ((hi - lo) / len) * 100;
}

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

  /*
   * The wider list, computed from the bars the chart already has. They are not
   * on the card unless the state calls for them -- they are here so the badge
   * on the chart is a vote of everything measured rather than of the six that
   * happened to fit.
   */
  const bb = bollinger(closes);
  out.push(num('bollinger', 'Bollinger %B', bb === null ? null : bb.percentB * 100, (v) => v.toFixed(0),
    (v) => (v >= 100 ? ['Over the band', 'BULLISH'] : v <= 0 ? ['Under the band', 'BEARISH']
      : v >= 70 ? ['Upper half', 'BULLISH'] : v <= 30 ? ['Lower half', 'BEARISH'] : ['Middle', 'NEUTRAL']),
    (v) => v / 100));
  out.push(num('bbwidth', 'Band width', bb === null ? null : bb.width, (v) => `${v.toFixed(2)}%`,
    (v) => (v <= 0.6 ? ['Squeezed', 'NEUTRAL'] : v >= 3 ? ['Wide', 'NEUTRAL'] : ['Normal', 'NEUTRAL']), () => null));

  out.push(num('donchian', 'Range position', donchian(input.bars) === null ? null : donchian(input.bars)! * 100,
    (v) => `${v.toFixed(0)}%`,
    (v) => (v >= 80 ? ['At the highs', 'BULLISH'] : v <= 20 ? ['At the lows', 'BEARISH'] : ['Mid range', 'NEUTRAL']),
    (v) => v / 100));

  out.push(num('stoch', 'Stochastic', stochastic(input.bars), (v) => v.toFixed(0),
    (v) => (v >= 80 ? ['Overbought', 'BEARISH'] : v <= 20 ? ['Oversold', 'BULLISH']
      : v >= 55 ? ['Bullish', 'BULLISH'] : v <= 45 ? ['Bearish', 'BEARISH'] : ['Neutral', 'NEUTRAL']),
    (v) => v / 100));

  out.push(num('williams', 'Williams %R', williamsR(input.bars), (v) => v.toFixed(0),
    (v) => (v >= -20 ? ['Overbought', 'BEARISH'] : v <= -80 ? ['Oversold', 'BULLISH'] : ['Neutral', 'NEUTRAL']),
    (v) => (v + 100) / 100));

  out.push(num('cci', 'CCI (20)', cci(input.bars), (v) => (v > 0 ? '+' : '') + v.toFixed(0),
    (v) => (v >= 100 ? ['Strong up', 'BULLISH'] : v <= -100 ? ['Strong down', 'BEARISH']
      : v > 0 ? ['Above mean', 'BULLISH'] : ['Below mean', 'BEARISH']), () => null));

  out.push(num('obv', 'OBV slope', obvSlope(input.bars), (v) => (v > 0 ? '+' : '') + v.toFixed(0),
    (v) => (v > 10 ? ['Accumulating', 'BULLISH'] : v < -10 ? ['Distributing', 'BEARISH'] : ['Flat', 'NEUTRAL']),
    () => null));

  out.push(num('chop', 'Choppiness', choppiness(input.bars), (v) => v.toFixed(0),
    (v) => (v >= 61 ? ['Going nowhere', 'NEUTRAL'] : v <= 38 ? ['Trending', 'NEUTRAL'] : ['Mixed', 'NEUTRAL']),
    (v) => v / 100));

  out.push(num('aroon', 'Aroon', aroon(input.bars), (v) => (v > 0 ? '+' : '') + v.toFixed(0),
    (v) => (v >= 50 ? ['Highs are newer', 'BULLISH'] : v <= -50 ? ['Lows are newer', 'BEARISH'] : ['Mixed', 'NEUTRAL']),
    (v) => (v + 100) / 200));

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
