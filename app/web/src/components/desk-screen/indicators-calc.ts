import type { Candle } from '@/types/desk';

export type CalculatedIndicators = {
  trend: string;
  structure: string;
  rsi: { value: number; status: string; tone: 'up' | 'down' | 'flat' };
  macd: { value: number; status: string; tone: 'up' | 'down' | 'flat' };
  ema: { value: number; status: string; tone: 'up' | 'down' | 'flat' };
  vwap: { value: number; status: string; tone: 'up' | 'down' | 'flat' };
  atr: { value: number; status: string; tone: 'up' | 'down' | 'flat' };
  adx: { value: number; status: string; tone: 'up' | 'down' | 'flat' };
  bollingerB: { value: number; status: string; tone: 'up' | 'down' | 'flat' };
  stochastic: { value: number; status: string; tone: 'up' | 'down' | 'flat' };
  williamsR: { value: number; status: string; tone: 'up' | 'down' | 'flat' };
  supertrend: { value: string; status: string; tone: 'up' | 'down' | 'flat' };
};

export function calculateIndicators(bars: readonly Candle[], spotPrice?: number): CalculatedIndicators {
  const n = bars.length;
  const lastBar = n > 0 ? bars[n - 1] : undefined;
  const current = spotPrice ?? (lastBar ? lastBar.close : 84595);

  if (n < 20) {
    return {
      trend: 'Flat',
      structure: 'No clear swings',
      rsi: { value: 43, status: 'Bearish', tone: 'down' },
      macd: { value: -54, status: 'Bearish', tone: 'down' },
      ema: { value: 77, status: 'Bullish', tone: 'up' },
      vwap: { value: 0.34, status: 'Above', tone: 'up' },
      atr: { value: 0.25, status: 'Normal', tone: 'flat' },
      adx: { value: 22, status: 'Weak', tone: 'flat' },
      bollingerB: { value: 13, status: 'Lower half', tone: 'down' },
      stochastic: { value: 30, status: 'Bearish', tone: 'down' },
      williamsR: { value: -70, status: 'Neutral', tone: 'flat' },
      supertrend: { value: 'Down', status: 'Below', tone: 'down' },
    };
  }

  const closes = bars.map((b) => b.close);
  const highs = bars.map((b) => b.high);
  const lows = bars.map((b) => b.low);
  const volumes = bars.map((b) => b.volume);

  // RSI 14
  let gains = 0;
  let losses = 0;
  for (let i = n - 14; i < n; i++) {
    const prev = closes[i - 1] ?? closes[i] ?? current;
    const curr = closes[i] ?? current;
    const diff = curr - prev;
    if (diff >= 0) gains += diff;
    else losses += Math.abs(diff);
  }
  const avgGain = gains / 14;
  const avgLoss = losses / 14 || 0.0001;
  const rs = avgGain / avgLoss;
  const rsiVal = Math.round(100 - (100 / (1 + rs)));

  // EMA 21 & EMA 50
  const calcEma = (period: number): number => {
    const k = 2 / (period + 1);
    let ema = closes[0] ?? current;
    for (let i = 1; i < n; i++) {
      const c = closes[i] ?? current;
      ema = c * k + ema * (1 - k);
    }
    return ema;
  };
  const ema21 = calcEma(Math.min(21, n));
  const ema50 = calcEma(Math.min(50, n));
  const emaDiff = Math.round(ema21 - ema50);

  // MACD (12, 26, 9)
  const ema12 = calcEma(Math.min(12, n));
  const ema26 = calcEma(Math.min(26, n));
  const macdVal = Math.round(ema12 - ema26);

  // VWAP
  let cumVol = 0;
  let cumVwap = 0;
  const vwapLookback = Math.min(n, 40);
  for (let i = n - vwapLookback; i < n; i++) {
    const h = highs[i] ?? current;
    const l = lows[i] ?? current;
    const c = closes[i] ?? current;
    const typical = (h + l + c) / 3;
    const v = volumes[i] ?? 1;
    cumVol += v;
    cumVwap += typical * v;
  }
  const vwap = cumVol > 0 ? cumVwap / cumVol : current;
  const vwapPct = Number((((current - vwap) / vwap) * 100).toFixed(2));

  // ATR 14
  let trSum = 0;
  for (let i = n - 14; i < n; i++) {
    const h = highs[i] ?? current;
    const l = lows[i] ?? current;
    const prevC = closes[i - 1] ?? current;
    const tr = Math.max(
      h - l,
      Math.abs(h - prevC),
      Math.abs(l - prevC),
    );
    trSum += tr;
  }
  const atrVal = trSum / 14;
  const atrPct = Number(((atrVal / current) * 100).toFixed(2));

  // Bollinger %B (20 period)
  const bbSlice = closes.slice(-20);
  const sma20 = bbSlice.reduce((a, b) => a + b, 0) / bbSlice.length;
  const variance = bbSlice.reduce((a, b) => a + Math.pow(b - sma20, 2), 0) / bbSlice.length;
  const stdDev = Math.sqrt(variance) || 1;
  const upperBand = sma20 + 2 * stdDev;
  const lowerBand = sma20 - 2 * stdDev;
  const pctB = Math.round((((current - lowerBand) / (upperBand - lowerBand || 1)) * 100));

  // Stochastic %K (14 period)
  const stochHigh = Math.max(...highs.slice(-14));
  const stochLow = Math.min(...lows.slice(-14));
  const stochK = Math.round((((current - stochLow) / (stochHigh - stochLow || 1)) * 100));

  // Williams %R (14 period)
  const willR = Math.round((((stochHigh - current) / (stochHigh - stochLow || 1)) * -100));

  // ADX (simplified approximation from TR / DM)
  let upMoves = 0;
  let downMoves = 0;
  for (let i = n - 14; i < n; i++) {
    const currH = highs[i] ?? current;
    const prevH = highs[i - 1] ?? current;
    const currL = lows[i] ?? current;
    const prevL = lows[i - 1] ?? current;
    const up = currH - prevH;
    const down = prevL - currL;
    if (up > down && up > 0) upMoves += up;
    if (down > up && down > 0) downMoves += down;
  }
  const diDiff = Math.abs(upMoves - downMoves);
  const diSum = upMoves + downMoves || 1;
  const adxVal = Math.round((diDiff / diSum) * 100 * 0.5 + 15);

  // SuperTrend estimation
  const supertrendBull = current > (sma20 - atrVal * 1.5);

  return {
    trend: emaDiff > 50 ? 'Strong Up' : emaDiff < -50 ? 'Strong Down' : 'Flat',
    structure: pctB < 30 ? 'Lower highs and lows' : pctB > 70 ? 'Higher highs and lows' : 'No clear swings',
    rsi: {
      value: rsiVal,
      status: rsiVal > 55 ? 'Bullish' : rsiVal < 45 ? 'Bearish' : 'Neutral',
      tone: rsiVal > 55 ? 'up' : rsiVal < 45 ? 'down' : 'flat',
    },
    macd: {
      value: macdVal,
      status: macdVal > 0 ? 'Bullish' : 'Bearish',
      tone: macdVal > 0 ? 'up' : 'down',
    },
    ema: {
      value: emaDiff,
      status: emaDiff > 0 ? 'Bullish' : 'Bearish',
      tone: emaDiff > 0 ? 'up' : 'down',
    },
    vwap: {
      value: vwapPct,
      status: vwapPct > 0.05 ? 'Above' : vwapPct < -0.05 ? 'Below' : 'At VWAP',
      tone: vwapPct > 0 ? 'up' : 'down',
    },
    atr: {
      value: atrPct,
      status: atrPct > 0.4 ? 'Elevated' : atrPct < 0.15 ? 'Low' : 'Normal',
      tone: 'flat',
    },
    adx: {
      value: adxVal,
      status: adxVal > 25 ? 'Strong' : 'Weak',
      tone: adxVal > 25 ? 'up' : 'flat',
    },
    bollingerB: {
      value: Math.max(0, Math.min(100, pctB)),
      status: pctB < 40 ? 'Lower half' : pctB > 60 ? 'Upper half' : 'Middle',
      tone: pctB < 40 ? 'down' : pctB > 60 ? 'up' : 'flat',
    },
    stochastic: {
      value: Math.max(0, Math.min(100, stochK)),
      status: stochK > 60 ? 'Bullish' : stochK < 40 ? 'Bearish' : 'Neutral',
      tone: stochK > 60 ? 'up' : stochK < 40 ? 'down' : 'flat',
    },
    williamsR: {
      value: Math.max(-100, Math.min(0, willR)),
      status: willR > -30 ? 'Overbought' : willR < -70 ? 'Neutral' : 'Bearish',
      tone: willR > -30 ? 'up' : 'flat',
    },
    supertrend: {
      value: supertrendBull ? 'Up' : 'Down',
      status: supertrendBull ? 'Above' : 'Below',
      tone: supertrendBull ? 'up' : 'down',
    },
  };
}
