import { candles, type Candle } from './delta.js';

/**
 * A multi-timeframe read of BTC itself, from the same public candles.
 *
 * Only one thing here has been tested against the strategy's own results: the
 * 24-hour return, which drives the lot split. The rest is context — it tells
 * you what kind of day you are entering, and it is labelled as untested so it
 * cannot quietly become a trading rule.
 */

export type Timeframe = '1m' | '5m' | '15m' | '1h' | '4h' | '1d';
const MINUTES: Record<Timeframe, number> = { '1m': 1, '5m': 5, '15m': 15, '1h': 60, '4h': 240, '1d': 1440 };

/**
 * The timeframes the trend read is built from -- five, and deliberately not
 * every series fetched.
 *
 * `agreement` counts how many of these agree and `regime` is read off that
 * count, both of which are on the screen. Letting a newly fetched series join
 * the list would quietly change a number nobody asked to change. The 1-minute
 * bars are fetched for the moves table alone.
 */
const TREND_TIMEFRAMES: readonly Timeframe[] = ['5m', '15m', '1h', '4h', '1d'];

function ema(values: number[], period: number): number | null {
  if (values.length < period) return null;
  const k = 2 / (period + 1);
  let e = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < values.length; i++) e = values[i]! * k + e * (1 - k);
  return e;
}

function rsi(values: number[], period = 14): number | null {
  if (values.length < period + 1) return null;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = values[i]! - values[i - 1]!;
    if (d >= 0) gain += d;
    else loss -= d;
  }
  gain /= period;
  loss /= period;
  for (let i = period + 1; i < values.length; i++) {
    const d = values[i]! - values[i - 1]!;
    gain = (gain * (period - 1) + Math.max(d, 0)) / period;
    loss = (loss * (period - 1) + Math.max(-d, 0)) / period;
  }
  if (loss === 0) return 100;
  return 100 - 100 / (1 + gain / loss);
}

function atr(bars: Candle[], period = 14): number | null {
  if (bars.length < period + 1) return null;
  const tr: number[] = [];
  for (let i = 1; i < bars.length; i++) {
    const b = bars[i]!;
    const p = bars[i - 1]!;
    tr.push(Math.max(b.high - b.low, Math.abs(b.high - p.close), Math.abs(b.low - p.close)));
  }
  return tr.slice(-period).reduce((a, b) => a + b, 0) / period;
}

export type TimeframeRead = {
  tf: Timeframe;
  bars: number;
  close: number;
  ema9: number | null;
  ema21: number | null;
  ema50: number | null;
  rsi14: number | null;
  /** RSI now less RSI one bar ago: which way momentum is moving, not where it is. */
  rsiSlope: number | null;
  /** Wilder's ADX(14): how strong the trend is, whichever way it points. */
  adx14: number | null;
  /** Volume-weighted average price over the bars read. */
  vwap: number | null;
  /** Price against VWAP, as a percentage of VWAP. */
  vwapDistPct: number | null;
  /** Swing structure: +1 higher highs and higher lows, -1 the mirror, 0 neither. */
  structure: -1 | 0 | 1;
  /**
   * This timeframe's own support and resistance: the two nearest fractal
   * swing highs above the close and swing lows below it, from the bars read.
   * Nearest first. Empty where the bars hold no swing on that side.
   */
  resistance: number[];
  support: number[];
  /** average true range as a percentage of price */
  atrPct: number | null;
  /** -1 falling, 0 flat, +1 rising, from the EMA stack */
  trend: -1 | 0 | 1;
  label: string;
};

/**
 * Wilder's ADX: how *strong* a trend is, saying nothing about its direction.
 *
 * Here to keep the direction score honest. Two timeframes pointing the same way
 * in a market going nowhere is agreement about noise, and the score should read
 * it as less than the same agreement in a market that is actually moving.
 */
function adx(bars: Candle[], period = 14): number | null {
  if (bars.length < period * 2 + 1) return null;
  const tr: number[] = [];
  const plus: number[] = [];
  const minus: number[] = [];
  for (let i = 1; i < bars.length; i++) {
    const b = bars[i]!;
    const p = bars[i - 1]!;
    const up = b.high - p.high;
    const down = p.low - b.low;
    plus.push(up > down && up > 0 ? up : 0);
    minus.push(down > up && down > 0 ? down : 0);
    tr.push(Math.max(b.high - b.low, Math.abs(b.high - p.close), Math.abs(b.low - p.close)));
  }
  // Wilder smoothing, then DX, then the average of the DXs.
  const smooth = (xs: number[]): number[] => {
    const out: number[] = [];
    let run = xs.slice(0, period).reduce((a, b) => a + b, 0);
    out.push(run);
    for (let i = period; i < xs.length; i++) {
      run = run - run / period + xs[i]!;
      out.push(run);
    }
    return out;
  };
  const trS = smooth(tr);
  const pS = smooth(plus);
  const mS = smooth(minus);
  const dx: number[] = [];
  for (let i = 0; i < trS.length; i++) {
    const t = trS[i]!;
    if (!(t > 0)) continue;
    const pdi = (pS[i]! / t) * 100;
    const mdi = (mS[i]! / t) * 100;
    const sum = pdi + mdi;
    if (!(sum > 0)) continue;
    dx.push((Math.abs(pdi - mdi) / sum) * 100);
  }
  if (dx.length < period) return null;
  return dx.slice(-period).reduce((a, b) => a + b, 0) / period;
}

/**
 * Volume-weighted average price over the bars given, and where price sits
 * against it.
 *
 * The number intraday desks actually argue about: above VWAP the buyers have
 * been paying up, below it the sellers have. Typical price per bar (H+L+C)/3,
 * weighted by that bar's volume, which is the standard definition and the one
 * every other screen will agree with.
 */
function vwapOf(bars: Candle[]): number | null {
  let pv = 0;
  let v = 0;
  for (const b of bars) {
    const typical = (b.high + b.low + b.close) / 3;
    if (!(b.volume > 0) || !(typical > 0)) continue;
    pv += typical * b.volume;
    v += b.volume;
  }
  return v > 0 ? pv / v : null;
}

/**
 * Market structure over the recent swings: higher highs and higher lows, or
 * lower highs and lower lows.
 *
 * A fractal swing is a bar whose high is the highest of the two either side of
 * it (and the mirror for a low) -- the smallest definition that is not a line
 * drawn by eye. +1 when the last two swing highs and the last two swing lows
 * are both rising, -1 when both are falling, 0 otherwise, which includes every
 * range and every break that has not been confirmed by the other side.
 */
function structureOf(bars: Candle[]): -1 | 0 | 1 {
  const highs: number[] = [];
  const lows: number[] = [];
  for (let i = 2; i < bars.length - 2; i++) {
    const b = bars[i]!;
    if (b.high > bars[i - 1]!.high && b.high > bars[i - 2]!.high
      && b.high > bars[i + 1]!.high && b.high > bars[i + 2]!.high) highs.push(b.high);
    if (b.low < bars[i - 1]!.low && b.low < bars[i - 2]!.low
      && b.low < bars[i + 1]!.low && b.low < bars[i + 2]!.low) lows.push(b.low);
  }
  if (highs.length < 2 || lows.length < 2) return 0;
  const hh = highs.at(-1)! > highs.at(-2)!;
  const hl = lows.at(-1)! > lows.at(-2)!;
  const lh = highs.at(-1)! < highs.at(-2)!;
  const ll = lows.at(-1)! < lows.at(-2)!;
  if (hh && hl) return 1;
  if (lh && ll) return -1;
  return 0;
}

/** Every fractal swing high and low in the bars: a bar whose high (low) beats the two either side. Pure. */
export function swingsOf(bars: readonly Candle[]): { highs: number[]; lows: number[] } {
  const highs: number[] = [];
  const lows: number[] = [];
  for (let i = 2; i < bars.length - 2; i++) {
    const b = bars[i]!;
    if (b.high > bars[i - 1]!.high && b.high > bars[i - 2]!.high && b.high > bars[i + 1]!.high && b.high > bars[i + 2]!.high) highs.push(b.high);
    if (b.low < bars[i - 1]!.low && b.low < bars[i - 2]!.low && b.low < bars[i + 1]!.low && b.low < bars[i + 2]!.low) lows.push(b.low);
  }
  return { highs, lows };
}

/** The two nearest swing highs above `price` and swing lows below it, nearest first; a swing within a tenth of a percent of price is the price, not a level. */
export function swingLevels(bars: readonly Candle[], price: number, n = 2): { resistance: number[]; support: number[] } {
  const { highs, lows } = swingsOf(bars);
  const gap = price * 0.001;
  const above = [...new Set(highs.filter((h) => h > price + gap))].sort((a, b) => a - b).slice(0, n);
  const below = [...new Set(lows.filter((l) => l < price - gap))].sort((a, b) => b - a).slice(0, n);
  return { resistance: above, support: below };
}

function readOne(tf: Timeframe, bars: Candle[]): TimeframeRead | null {
  if (bars.length < 25) return null;
  const closes = bars.map((b) => b.close);
  const close = closes[closes.length - 1]!;
  const e9 = ema(closes, 9);
  const e21 = ema(closes, 21);
  const e50 = ema(closes, 50);
  let trend: -1 | 0 | 1 = 0;
  if (e9 !== null && e21 !== null) {
    const up = e9 > e21 && (e50 === null || e21 > e50);
    const down = e9 < e21 && (e50 === null || e21 < e50);
    trend = up ? 1 : down ? -1 : 0;
  }
  const a = atr(bars);
  const r = rsi(closes);
  // The same RSI one bar ago: the level says where momentum is, the change
  // says which way it is going, and a direction score wants the second one.
  const rPrior = closes.length > 1 ? rsi(closes.slice(0, -1)) : null;
  const vwap = vwapOf(bars);
  return {
    tf,
    bars: bars.length,
    close,
    ema9: e9,
    ema21: e21,
    ema50: e50,
    rsi14: r,
    rsiSlope: r === null || rPrior === null ? null : r - rPrior,
    adx14: adx(bars),
    vwap,
    vwapDistPct: vwap === null || !(vwap > 0) ? null : ((close - vwap) / vwap) * 100,
    structure: structureOf(bars),
    ...swingLevels(bars, close),
    atrPct: a === null ? null : (a / close) * 100,
    trend,
    label: trend === 1 ? 'rising' : trend === -1 ? 'falling' : 'flat',
  };
}

export type Move = {
  /** how long a window, in hours */
  hours: number;
  label: string;
  /** close-to-close change over the window, in dollars */
  changeUsd: number | null;
  changePct: number | null;
  /** high-to-low range over the window */
  rangeUsd: number | null;
  rangePct: number | null;
};

/**
 * How busy the tape is now against how busy it usually is.
 *
 * The median rather than the mean of the last twenty bars: one violent minute
 * drags a mean up enough that the next violent minute no longer looks unusual,
 * which is the opposite of what a spike detector is for.
 */
export type VolumePulse = {
  tf: Timeframe;
  current: number;
  median: number;
  /** current ÷ median. 1 is an ordinary bar. */
  spike: number | null;
};

export type MarketRead = {
  spot: number;
  /** the 24-hour return that decides the lot split; this one is tested */
  return24h: number | null;
  /**
   * Daily RSI(14) on the last COMPLETED bar. The backtest used the prior day's
   * close, so today's half-formed bar must be excluded or the live signal is
   * not the one that was measured.
   */
  dailyRsiPrior: number | null;
  timeframes: TimeframeRead[];
  /** how many of the five timeframes agree, signed */
  agreement: number;
  regime: 'trending up' | 'trending down' | 'mixed' | 'quiet';
  /** realised volatility on the daily bars, annualised, as a percentage */
  realisedVol: number | null;
  /** what BTC has actually done over several windows, points and percent */
  moves: Move[];
  /** the largest 24-hour range in the last 30 days */
  max24hRangeUsd: number | null;
  max24hRangePct: number | null;
  /** how busy the last 5m and 15m bars are against their own recent median */
  volume: VolumePulse[];
  /** the high and low of the last 24 hours, from the hourly bars */
  high24h: number | null;
  low24h: number | null;
  /** the previous completed UTC day's extremes, the two levels every desk marks */
  prevDayHigh: number | null;
  prevDayLow: number | null;
  /**
   * Realised volatility over the last hour, six and twelve hours, from the
   * 5-minute closes, annualised percent -- what BTC is delivering right now,
   * against the 21-day figure that says what it usually delivers.
   */
  realisedVol1h: number | null;
  realisedVol6h: number | null;
  realisedVol12h: number | null;
  /** MACD(12, 26, 9) on the 15-minute closes: the line, its signal and the histogram. */
  macd15m: { line: number; signal: number; hist: number } | null;
};

/** Annualised volatility of log returns over consecutive bars of `minutes` each, percent. */
export function realisedVolOf(closes: readonly number[], minutes: number): number | null {
  if (closes.length < 3) return null;
  const rets: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    const a = closes[i - 1]!, b = closes[i]!;
    if (a > 0 && b > 0) rets.push(Math.log(b / a));
  }
  if (rets.length < 2) return null;
  const mean = rets.reduce((x, y) => x + y, 0) / rets.length;
  const varr = rets.reduce((x, y) => x + (y - mean) ** 2, 0) / (rets.length - 1);
  const perYear = (365 * 24 * 60) / minutes;
  return Math.sqrt(varr * perYear) * 100;
}

/** MACD: EMA(fast) − EMA(slow), its EMA(signal), and the difference. Null without enough bars. */
export function macdOf(closes: readonly number[], fast = 12, slow = 26, signal = 9): { line: number; signal: number; hist: number } | null {
  if (closes.length < slow + signal) return null;
  const series = (period: number): number[] => {
    const k = 2 / (period + 1);
    const out: number[] = [];
    let e = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
    for (let i = period; i < closes.length; i++) { e = closes[i]! * k + e * (1 - k); out.push(e); }
    return out;
  };
  const f = series(fast), sl = series(slow);
  // Align on the slow EMA's first value.
  const line = sl.map((v, i) => f[i + (f.length - sl.length)]! - v);
  if (line.length < signal) return null;
  const sig = ema(line, signal);
  const last = line[line.length - 1]!;
  return sig === null ? null : { line: last, signal: sig, hist: last - sig };
}

/**
 * The newest bar's volume against the median of the twenty before it.
 *
 * The newest bar is excluded from the median: comparing a bar against a window
 * that contains it pulls the answer toward 1 exactly when the bar is unusual.
 * The last bar is also still forming, so `current` is a partial count and the
 * ratio understates a spike in progress rather than overstating it — the safer
 * way round for something that says "something is happening".
 */
function volumePulse(tf: Timeframe, bars: Candle[]): VolumePulse | null {
  if (bars.length < 6) return null;
  const current = bars[bars.length - 1]!.volume;
  const window = bars.slice(-21, -1).map((b) => b.volume).filter((v) => Number.isFinite(v));
  if (!window.length) return null;
  const sorted = [...window].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2
    ? sorted[mid]!
    : (sorted[mid - 1]! + sorted[mid]!) / 2;
  return { tf, current, median, spike: median > 0 ? current / median : null };
}

/** Close-to-close change and high-low range over the last `bars` bars. */
function moveOver(bars: Candle[], count: number, hours: number, label: string): Move {
  const slice = bars.slice(-count);
  // One bar is a perfectly good window -- open to close of that bar is exactly
  // the move over its own duration. Requiring two dropped the 5-minute row.
  if (slice.length < 1) {
    return { hours, label, changeUsd: null, changePct: null, rangeUsd: null, rangePct: null };
  }
  const first = slice[0]!;
  const last = slice[slice.length - 1]!;
  const hi = Math.max(...slice.map((b) => b.high));
  const lo = Math.min(...slice.map((b) => b.low));
  const change = last.close - first.open;
  return {
    hours,
    label,
    changeUsd: change,
    changePct: (change / first.open) * 100,
    rangeUsd: hi - lo,
    rangePct: ((hi - lo) / first.open) * 100,
  };
}

/** The label of the day's row, shared with the web so the header can find it. */
export const TODAY_MOVE = 'today, since 05:30';

const SERIES_TTL_MS = 20_000;
let seriesCache: { at: number; data: [Timeframe, Candle[]][] } | null = null;
let seriesInflight: Promise<[Timeframe, Candle[]][]> | null = null;

async function fetchSeriesFresh(): Promise<[Timeframe, Candle[]][]> {
  if (seriesInflight) return seriesInflight;
  seriesInflight = (async () => {
    try {
      const now = Math.floor(Date.now() / 1000);
      const wanted: Timeframe[] = ['1m', '5m', '15m', '1h', '4h', '1d'];
      const data = await Promise.all(
        wanted.map(async (tf) => {
          const span = MINUTES[tf] * 60 * 220;
          const bars = await candles('BTCUSD', now - span, now, tf).catch(() => []);
          return [tf, bars] as [Timeframe, Candle[]];
        }),
      );
      seriesCache = { at: Date.now(), data };
      return data;
    } finally {
      seriesInflight = null;
    }
  })();
  return seriesInflight;
}

/**
 * @param sinceHours  hours since the desk's day began at 05:30 IST, if known.
 *   The fixed windows answer "how has BTC been behaving"; this one answers
 *   "how far has it come today", against the same baseline as the day's P&L
 *   and the morning entry -- the number that says whether a strike is still as
 *   far away as it looked at entry.
 */
/**
 * The bars the analytics service labels "now" from, as compact parallel arrays.
 *
 * Straight out of the cache `readMarket` already fills, so asking costs no
 * request to Delta. Every bar goes, the one still forming included: the service
 * drops it itself, the same way the history it was measured on never saw one.
 * Null until the first read has filled the cache.
 */
export function seriesForAnalytics(): Partial<Record<'5m' | '15m' | '1h' | '4h' | '1d', { t: number[]; c: number[] }>> | null {
  if (!seriesCache) return null;
  const out: Partial<Record<'5m' | '15m' | '1h' | '4h' | '1d', { t: number[]; c: number[] }>> = {};
  for (const [tf, bars] of seriesCache.data) {
    if (tf === '1m') continue;
    out[tf] = { t: bars.map((b) => b.time), c: bars.map((b) => b.close) };
  }
  return out;
}

/**
 * BTC's close nearest `minutesAgo`, off the cached series: the 1-minute bars
 * for the last eight hours, the 5-minute ones beyond. Null before the first
 * read, or past what the cache holds.
 */
export function spotMinutesAgo(minutesAgo: number, nowMs = Date.now()): number | null {
  if (!seriesCache) return null;
  const target = Math.floor(nowMs / 1000) - minutesAgo * 60;
  const pick = (tf: Timeframe) => {
    const bars = seriesCache!.data.find(([t]) => t === tf)?.[1] ?? [];
    let best: Candle | null = null;
    for (const b of bars) if (b.time <= target && (!best || b.time > best.time)) best = b;
    return best && target - best.time <= MINUTES[tf] * 60 * 2 ? best.close : null;
  };
  return pick(minutesAgo <= 8 * 60 ? '1m' : '5m') ?? pick('5m') ?? pick('1h');
}

export async function readMarket(sinceHours?: number): Promise<MarketRead> {
  let series: [Timeframe, Candle[]][];
  if (seriesCache) {
    if (Date.now() - seriesCache.at >= SERIES_TTL_MS) {
      void fetchSeriesFresh().catch(() => {});
    }
    series = seriesCache.data;
  } else {
    try {
      series = await fetchSeriesFresh();
    } catch (e) {
      const cached = seriesCache as { at: number; data: [Timeframe, Candle[]][] } | null;
      if (cached) series = cached.data;
      else throw e;
    }
  }

  const timeframes = series
    // The 1-minute series is for the moves table; it is not one of the five the
    // agreement and the regime are counted over. See TREND_TIMEFRAMES.
    .filter(([tf]) => TREND_TIMEFRAMES.includes(tf))
    .map(([tf, bars]) => readOne(tf, bars))
    .filter((r): r is TimeframeRead => r !== null);

  const daily = series.find(([tf]) => tf === '1d')?.[1] ?? [];
  const spot = timeframes.find((t) => t.tf === '5m')?.close ?? daily[daily.length - 1]?.close ?? 0;

  let return24h: number | null = null;
  if (daily.length >= 2) {
    const prev = daily[daily.length - 2]!.close;
    return24h = ((spot - prev) / prev) * 100;
  }

  // exclude the bar still forming, to match what the backtest could have known
  const dailyRsiPrior = daily.length >= 16 ? rsi(daily.slice(0, -1).map((b) => b.close)) : null;

  let realisedVol: number | null = null;
  if (daily.length >= 21) {
    const rets = daily.slice(-21).map((b, i, a) => (i === 0 ? 0 : Math.log(b.close / a[i - 1]!.close)));
    const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
    const varr = rets.reduce((a, b) => a + (b - mean) ** 2, 0) / (rets.length - 1);
    realisedVol = Math.sqrt(varr * 365) * 100;
  }

  const m1 = series.find(([tf]) => tf === '1m')?.[1] ?? [];
  const m5 = series.find(([tf]) => tf === '5m')?.[1] ?? [];
  const h1 = series.find(([tf]) => tf === '1h')?.[1] ?? [];
  /*
   * Shortest window first, so the table reads as one zoom outward.
   *
   * Each is taken from the coarsest series that still covers it in whole bars
   * -- a quarter of an hour is three 5-minute bars, six hours is six hourly
   * ones -- because a window cut out of finer bars than it needs is the same
   * number at more cost.
   */
  const moves: Move[] = [
    moveOver(m1, 1, 1 / 60, 'last 1m'),
    moveOver(m5, 1, 5 / 60, 'last 5m'),
    moveOver(m5, 3, 0.25, 'last 15m'),
    moveOver(m5, 12, 1, 'last 1h'),
    moveOver(h1, 6, 6, 'last 6h'),
    moveOver(h1, 12, 12, 'last 12h'),
    moveOver(h1, 24, 24, 'last 24h'),
  ];

  // 5-minute bars while the day is young enough for them to reach back to
  // 05:30 (12h is 144 of them), hourly after that.
  if (sinceHours !== undefined && sinceHours > 0.08) {
    const use5m = sinceHours <= 12 && m5.length >= Math.round(sinceHours * 12);
    moves.push(
      moveOver(
        use5m ? m5 : h1,
        Math.max(1, Math.round(sinceHours * (use5m ? 12 : 1))),
        sinceHours,
        TODAY_MOVE,
      ),
    );
  }

  // the biggest single day of the last month, as a reference for how wrong the
  // expected move can be
  let max24hRangeUsd: number | null = null;
  let max24hRangePct: number | null = null;
  if (daily.length >= 2) {
    const recent = daily.slice(-30);
    let best = recent[0]!;
    for (const b of recent) if (b.high - b.low > best.high - best.low) best = b;
    max24hRangeUsd = best.high - best.low;
    max24hRangePct = ((best.high - best.low) / best.open) * 100;
  }

  const agreement = timeframes.reduce((a, t) => a + t.trend, 0);
  const regime =
    agreement >= 3 ? 'trending up'
    : agreement <= -3 ? 'trending down'
    : timeframes.every((t) => t.trend === 0) ? 'quiet'
    : 'mixed';

  // The same series the moves above were read from: no second fetch.
  const volume = (['5m', '15m', '1h', '4h'] as const)
    .map((tf) => volumePulse(tf, series.find(([t]) => t === tf)?.[1] ?? []))
    .filter((v): v is VolumePulse => v !== null);

  // The last day's extremes, off the hourly series the moves already use.
  const day = (series.find(([t]) => t === '1h')?.[1] ?? []).slice(-24);
  const high24h = day.length ? Math.max(...day.map((b) => b.high)) : null;
  const low24h = day.length ? Math.min(...day.map((b) => b.low)) : null;

  // The previous completed daily bar; the last one is today's, still forming.
  const prevDay = daily.length >= 2 ? daily[daily.length - 2]! : null;
  const m5Closes = m5.map((b) => b.close);
  const m15 = series.find(([tf]) => tf === '15m')?.[1] ?? [];

  return {
    spot, return24h, dailyRsiPrior, timeframes, agreement, regime, realisedVol,
    moves, max24hRangeUsd, max24hRangePct, volume, high24h, low24h,
    prevDayHigh: prevDay?.high ?? null,
    prevDayLow: prevDay?.low ?? null,
    realisedVol1h: m5Closes.length >= 13 ? realisedVolOf(m5Closes.slice(-13), 5) : null,
    realisedVol6h: m5Closes.length >= 73 ? realisedVolOf(m5Closes.slice(-73), 5) : null,
    realisedVol12h: m5Closes.length >= 145 ? realisedVolOf(m5Closes.slice(-145), 5) : null,
    macd15m: macdOf(m15.map((b) => b.close)),
  };
}
