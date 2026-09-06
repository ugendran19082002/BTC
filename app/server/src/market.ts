import { candles, type Candle } from './delta.js';

/**
 * A multi-timeframe read of BTC itself, from the same public candles.
 *
 * Only one thing here has been tested against the strategy's own results: the
 * 24-hour return, which drives the lot split. The rest is context — it tells
 * you what kind of day you are entering, and it is labelled as untested so it
 * cannot quietly become a trading rule.
 */

export type Timeframe = '5m' | '15m' | '1h' | '4h' | '1d';
const MINUTES: Record<Timeframe, number> = { '5m': 5, '15m': 15, '1h': 60, '4h': 240, '1d': 1440 };

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
  /** average true range as a percentage of price */
  atrPct: number | null;
  /** -1 falling, 0 flat, +1 rising, from the EMA stack */
  trend: -1 | 0 | 1;
  label: string;
};

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
  return {
    tf,
    bars: bars.length,
    close,
    ema9: e9,
    ema21: e21,
    ema50: e50,
    rsi14: rsi(closes),
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
};

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

export async function readMarket(): Promise<MarketRead> {
  const now = Math.floor(Date.now() / 1000);
  const wanted: Timeframe[] = ['5m', '15m', '1h', '4h', '1d'];

  const series = await Promise.all(
    wanted.map(async (tf) => {
      // 200 bars of each, which is enough for a 50-period EMA with room to settle
      const span = MINUTES[tf] * 60 * 220;
      const bars = await candles('BTCUSD', now - span, now, tf).catch(() => []);
      return [tf, bars] as const;
    }),
  );

  const timeframes = series
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

  const m5 = series.find(([tf]) => tf === '5m')?.[1] ?? [];
  const h1 = series.find(([tf]) => tf === '1h')?.[1] ?? [];
  const moves: Move[] = [
    moveOver(m5, 1, 5 / 60, 'last 5m'),
    moveOver(m5, 12, 1, 'last 1h'),
    moveOver(h1, 12, 12, 'last 12h'),
    moveOver(h1, 24, 24, 'last 24h'),
  ];

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

  return {
    spot, return24h, dailyRsiPrior, timeframes, agreement, regime, realisedVol,
    moves, max24hRangeUsd, max24hRangePct,
  };
}
