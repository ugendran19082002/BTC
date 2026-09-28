import type { Candle } from '@/types/desk';
import type { ChartTf } from '@/components/desk/PriceChart';
import type { AnnotationKind } from '@/api/annotations';

/**
 * Smart Money Concepts (SMC) & Price Action Auto-Detection Engine
 *
 * Automatically detects:
 *  1. Market Structure: Swing Highs (HH, LH, EQH), Swing Lows (HL, LL, EQL)
 *  2. Break of Structure (BOS) & Change of Character (CHoCH)
 *  3. Order Blocks (OB↑ Bullish Demand & OB↓ Bearish Supply)
 *  4. Fair Value Gaps (FVG↑ Bullish & FVG↓ Bearish Imbalances)
 *  5. Institutional Supply & Demand Zones
 *  6. Liquidity Pools (BSL Buy-Side Liquidity, SSL Sell-Side Liquidity, EQH, EQL)
 *  7. Complete Trade Setup (Entry, Red Stop Loss Box, Green TP1/TP2/TP3 Boxes, Risk:Reward)
 */

export type SwingPoint = {
  barIndex: number;
  time: number;
  price: number;
  type: 'HH' | 'HL' | 'LH' | 'LL' | 'EQH' | 'EQL';
  kind: 'high' | 'low';
};

export type StructureBreak = {
  type: 'BOS' | 'CHoCH';
  direction: 'bullish' | 'bearish';
  price: number;
  fromBarIndex: number;
  toBarIndex: number;
  fromTime: number;
  toTime: number;
  label: string;
};

export type SmcOrderBlock = {
  id: string;
  type: 'bull' | 'bear';
  kind: AnnotationKind;
  priceLow: number;
  priceHigh: number;
  barIndex: number;
  time: number;
  label: string;
  isTesting: boolean;
  mitigated: boolean;
};

export type SmcFvg = {
  id: string;
  type: 'bull' | 'bear';
  kind: AnnotationKind;
  priceLow: number;
  priceHigh: number;
  barIndex: number;
  time: number;
  label: string;
  mitigated: boolean;
};

export type SmcLiquidityLevel = {
  type: 'BSL' | 'SSL' | 'EQH' | 'EQL' | 'PDH' | 'PDL';
  price: number;
  label: string;
  barIndex: number;
  time: number;
};

export type AutoTradePlan = {
  direction: 'LONG' | 'SHORT';
  entry: number;
  sl: {
    price: number;
    priceLow: number;
    priceHigh: number;
    riskPct: number;
    riskAmount: number;
    label: string;
  };
  tp1: {
    price: number;
    priceLow: number;
    priceHigh: number;
    gainPct: number;
    rr: number;
    label: string;
  };
  tp2: {
    price: number;
    priceLow: number;
    priceHigh: number;
    gainPct: number;
    rr: number;
    label: string;
  };
  tp3?: {
    price: number;
    priceLow: number;
    priceHigh: number;
    gainPct: number;
    rr: number;
    label: string;
  };
  riskReward: string;
  reason: string;
};

export type LiquiditySweep = {
  id: string;
  time: number;
  barIndex: number;
  price: number;
  type: 'sell_stops' | 'buy_stops';
  label: string;
  sublabel: string;
  extremeLabel: 'SSL' | 'BSL';
};

export type Displacement = {
  id: string;
  time: number;
  barIndex: number;
  price: number;
  direction: 'bull' | 'bear';
  label: string;
  sublabel: string;
};

export type MitigationBlock = {
  id: string;
  time: number;
  barIndex: number;
  priceLow: number;
  priceHigh: number;
  type: 'bull' | 'bear';
  label: string;
  sublabel: string;
};

export type SupplyDemandZone = {
  type: 'supply' | 'demand';
  priceLow: number;
  priceHigh: number;
  label: string;
  sublabel: string;
};

export type SmcAnalysisResult = {
  swings: SwingPoint[];
  breaks: StructureBreak[];
  orderBlocks: SmcOrderBlock[];
  fvgs: SmcFvg[];
  liquidity: SmcLiquidityLevel[];
  tradePlan: AutoTradePlan | null;
  trend: 'UP' | 'DOWN' | 'RANGE';
  atr: number;
  sweeps: LiquiditySweep[];
  displacements: Displacement[];
  mitigations: MitigationBlock[];
  supplyDemandZones: SupplyDemandZone[];
};

/** Calculate Average True Range (ATR) */
function computeAtr(bars: readonly Candle[], period = 14): number {
  if (bars.length < 2) return (bars[0]?.high ?? 100) - (bars[0]?.low ?? 0);
  const trs: number[] = [];
  for (let i = 1; i < bars.length; i++) {
    const cur = bars[i]!;
    const prev = bars[i - 1]!;
    const tr = Math.max(
      cur.high - cur.low,
      Math.abs(cur.high - prev.close),
      Math.abs(cur.low - prev.close)
    );
    trs.push(tr);
  }
  const slice = trs.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / Math.max(slice.length, 1);
}

/** Detect fractal swing pivots */
function detectPivots(
  bars: readonly Candle[],
  left = 2,
  right = 2
): { highs: { i: number; bar: Candle }[]; lows: { i: number; bar: Candle }[] } {
  const highs: { i: number; bar: Candle }[] = [];
  const lows: { i: number; bar: Candle }[] = [];

  for (let i = left; i < bars.length - right; i++) {
    const b = bars[i]!;
    let isHigh = true;
    let isLow = true;

    for (let j = 1; j <= left; j++) {
      if (bars[i - j]!.high >= b.high) isHigh = false;
      if (bars[i - j]!.low <= b.low) isLow = false;
    }
    for (let j = 1; j <= right; j++) {
      if (bars[i + j]!.high > b.high) isHigh = false;
      if (bars[i + j]!.low < b.low) isLow = false;
    }

    if (isHigh) highs.push({ i, bar: b });
    if (isLow) lows.push({ i, bar: b });
  }

  return { highs, lows };
}

/**
 * Run complete automated SMC and Price Action analysis
 */
export function analyzeSmc(
  bars: readonly Candle[],
  spot: number,
  tf: ChartTf,
  marketRegime?: 'UP' | 'DOWN' | 'RANGE' | 'QUIET' | null
): SmcAnalysisResult {
  const empty: SmcAnalysisResult = {
    swings: [],
    breaks: [],
    orderBlocks: [],
    fvgs: [],
    liquidity: [],
    tradePlan: null,
    trend: 'RANGE',
    atr: 0,
    sweeps: [],
    displacements: [],
    mitigations: [],
    supplyDemandZones: [],
  };

  if (!bars || bars.length < 8 || spot <= 0) return empty;

  const atr = Math.max(computeAtr(bars, 14), spot * 0.002);
  const tol = Math.max(atr * 0.25, spot * 0.0008);
  const lastBar = bars[bars.length - 1]!;

  // ── 1. Detect Pivots & Classify Swings ─────────────────────────────────────
  // For lower TF (1m, 5m), use tighter pivot window (2,2); for higher (1h, 4h), use (3,2)
  const pivotLeft = tf === '1m' || tf === '5m' ? 2 : 3;
  const pivotRight = 2;
  const { highs, lows } = detectPivots(bars, pivotLeft, pivotRight);

  const swings: SwingPoint[] = [];

  // Classify Highs
  for (let idx = 0; idx < highs.length; idx++) {
    const cur = highs[idx]!;
    const prev = idx > 0 ? highs[idx - 1] : null;
    let type: 'HH' | 'LH' | 'EQH' = 'HH';

    if (prev) {
      if (Math.abs(cur.bar.high - prev.bar.high) <= tol) {
        type = 'EQH';
      } else if (cur.bar.high > prev.bar.high) {
        type = 'HH';
      } else {
        type = 'LH';
      }
    }
    swings.push({
      barIndex: cur.i,
      time: cur.bar.time,
      price: cur.bar.high,
      type,
      kind: 'high',
    });
  }

  // Classify Lows
  for (let idx = 0; idx < lows.length; idx++) {
    const cur = lows[idx]!;
    const prev = idx > 0 ? lows[idx - 1] : null;
    let type: 'HL' | 'LL' | 'EQL' = 'HL';

    if (prev) {
      if (Math.abs(cur.bar.low - prev.bar.low) <= tol) {
        type = 'EQL';
      } else if (cur.bar.low < prev.bar.low) {
        type = 'LL';
      } else {
        type = 'HL';
      }
    }
    swings.push({
      barIndex: cur.i,
      time: cur.bar.time,
      price: cur.bar.low,
      type,
      kind: 'low',
    });
  }

  // Sort swings chronologically
  swings.sort((a, b) => a.time - b.time);

  // ── 2. Break of Structure (BOS) & Change of Character (CHoCH) ─────────────
  const breaks: StructureBreak[] = [];
  const recentHighs = highs.slice(-5);
  const recentLows = lows.slice(-5);

  let currentTrend: 'UP' | 'DOWN' | 'RANGE' = 'RANGE';
  if (recentHighs.length >= 2 && recentLows.length >= 2) {
    const h1 = recentHighs[recentHighs.length - 1]!;
    const h0 = recentHighs[recentHighs.length - 2]!;
    const l1 = recentLows[recentLows.length - 1]!;
    const l0 = recentLows[recentLows.length - 2]!;

    if (h1.bar.high > h0.bar.high && l1.bar.low > l0.bar.low) {
      currentTrend = 'UP';
    } else if (h1.bar.high < h0.bar.high && l1.bar.low < l0.bar.low) {
      currentTrend = 'DOWN';
    }
  }
  if (marketRegime === 'UP' || marketRegime === 'DOWN') {
    currentTrend = marketRegime;
  }

  // Check BOS / CHoCH against recent swing highs and lows
  for (let idx = 0; idx < recentHighs.length; idx++) {
    const pivotH = recentHighs[idx]!;
    // Look for first subsequent bar that broke this high with close
    for (let b = pivotH.i + 1; b < bars.length; b++) {
      const candidate = bars[b]!;
      if (candidate.close > pivotH.bar.high + tol * 0.5) {
        const isChoch = currentTrend === 'DOWN';
        breaks.push({
          type: isChoch ? 'CHoCH' : 'BOS',
          direction: 'bullish',
          price: pivotH.bar.high,
          fromBarIndex: pivotH.i,
          toBarIndex: b,
          fromTime: pivotH.bar.time,
          toTime: candidate.time,
          label: isChoch ? 'CHoCH ↑' : 'BOS ↑',
        });
        break;
      }
    }
  }

  for (let idx = 0; idx < recentLows.length; idx++) {
    const pivotL = recentLows[idx]!;
    // Look for first subsequent bar that broke this low with close
    for (let b = pivotL.i + 1; b < bars.length; b++) {
      const candidate = bars[b]!;
      if (candidate.close < pivotL.bar.low - tol * 0.5) {
        const isChoch = currentTrend === 'UP';
        breaks.push({
          type: isChoch ? 'CHoCH' : 'BOS',
          direction: 'bearish',
          price: pivotL.bar.low,
          fromBarIndex: pivotL.i,
          toBarIndex: b,
          fromTime: pivotL.bar.time,
          toTime: candidate.time,
          label: isChoch ? 'CHoCH ↓' : 'BOS ↓',
        });
        break;
      }
    }
  }

  // Keep most recent breaks
  breaks.sort((a, b) => b.toTime - a.toTime);
  const activeBreaks = breaks.slice(0, 4);

  // ── 3. Order Blocks (OB↑ & OB↓) ──────────────────────────────────────────
  const orderBlocks: SmcOrderBlock[] = [];
  const searchLimit = Math.max(1, bars.length - 45);

  // Scan backwards for high-displacement origin candles
  for (let i = bars.length - 2; i >= searchLimit; i--) {
    const impulseBar = bars[i]!;
    const obBar = bars[i - 1];
    if (!obBar) continue;

    // Bullish OB: Red candle followed by strong green expansion
    const isBullImpulse =
      obBar.close <= obBar.open &&
      impulseBar.close - impulseBar.open >= atr * 0.9 &&
      impulseBar.close > obBar.high;

    if (isBullImpulse && orderBlocks.filter((o) => o.type === 'bull').length < 3) {
      const later = bars.slice(i + 1);
      const broken = later.some((b) => b.close < obBar.low);
      if (!broken) {
        const isTesting = lastBar.low <= obBar.high && lastBar.close >= obBar.low;
        const mitigated = later.some((b) => b.low <= obBar.high);
        orderBlocks.push({
          id: `ob-bull-${obBar.time}`,
          type: 'bull',
          kind: 'ob_bull',
          priceLow: obBar.low,
          priceHigh: obBar.high,
          barIndex: i - 1,
          time: obBar.time,
          label: isTesting ? 'OB↑ (Testing)' : 'OB↑ Bullish Demand',
          isTesting,
          mitigated,
        });
      }
    }

    // Bearish OB: Green candle followed by strong red displacement
    const isBearImpulse =
      obBar.close >= obBar.open &&
      impulseBar.open - impulseBar.close >= atr * 0.9 &&
      impulseBar.close < obBar.low;

    if (isBearImpulse && orderBlocks.filter((o) => o.type === 'bear').length < 3) {
      const later = bars.slice(i + 1);
      const broken = later.some((b) => b.close > obBar.high);
      if (!broken) {
        const isTesting = lastBar.high >= obBar.low && lastBar.close <= obBar.high;
        const mitigated = later.some((b) => b.high >= obBar.low);
        orderBlocks.push({
          id: `ob-bear-${obBar.time}`,
          type: 'bear',
          kind: 'ob_bear',
          priceLow: obBar.low,
          priceHigh: obBar.high,
          barIndex: i - 1,
          time: obBar.time,
          label: isTesting ? 'OB↓ (Testing)' : 'OB↓ Bearish Supply',
          isTesting,
          mitigated,
        });
      }
    }
  }

  // ── 4. Fair Value Gaps (FVG) ─────────────────────────────────────────────
  const fvgs: SmcFvg[] = [];
  const fvgTol = Math.max(atr * 0.12, spot * 0.0004);
  const fvgSearchLimit = Math.max(0, bars.length - 35);

  for (let i = bars.length - 3; i >= fvgSearchLimit; i--) {
    const b0 = bars[i]!;
    const b1 = bars[i + 1]!;
    const b2 = bars[i + 2]!;

    // Bullish FVG: Bar 0 High < Bar 2 Low
    if (b1.close > b1.open && b2.low > b0.high + fvgTol) {
      const later = bars.slice(i + 3);
      const fullyMitigated = later.some((b) => b.low <= b0.high);
      if (!fullyMitigated && fvgs.filter((f) => f.type === 'bull').length < 2) {
        fvgs.push({
          id: `fvg-bull-${b1.time}`,
          type: 'bull',
          kind: 'fvg_bull',
          priceLow: b0.high,
          priceHigh: b2.low,
          barIndex: i + 1,
          time: b1.time,
          label: 'FVG↑ Bullish Gap',
          mitigated: later.some((b) => b.low <= b2.low),
        });
      }
    }

    // Bearish FVG: Bar 0 Low > Bar 2 High
    if (b1.close < b1.open && b0.low > b2.high + fvgTol) {
      const later = bars.slice(i + 3);
      const fullyMitigated = later.some((b) => b.high >= b0.low);
      if (!fullyMitigated && fvgs.filter((f) => f.type === 'bear').length < 2) {
        fvgs.push({
          id: `fvg-bear-${b1.time}`,
          type: 'bear',
          kind: 'fvg_bear',
          priceLow: b2.high,
          priceHigh: b0.low,
          barIndex: i + 1,
          time: b1.time,
          label: 'FVG↓ Bearish Gap',
          mitigated: later.some((b) => b.high >= b2.high),
        });
      }
    }
  }

  // ── 5. Liquidity Pools ───────────────────────────────────────────────────
  const liquidity: SmcLiquidityLevel[] = [];
  const visibleBars = bars.slice(-60);

  // Highest High = Buy-Side Liquidity (BSL)
  let maxBar = visibleBars[0]!;
  let minBar = visibleBars[0]!;
  for (const b of visibleBars) {
    if (b.high > maxBar.high) maxBar = b;
    if (b.low < minBar.low) minBar = b;
  }

  if (maxBar && maxBar.high > spot * 1.001) {
    liquidity.push({
      type: 'BSL',
      price: maxBar.high,
      label: 'BSL · Buy-Side Stops',
      barIndex: bars.indexOf(maxBar),
      time: maxBar.time,
    });
  }

  if (minBar && minBar.low < spot * 0.999) {
    liquidity.push({
      type: 'SSL',
      price: minBar.low,
      label: 'SSL · Sell-Side Stops',
      barIndex: bars.indexOf(minBar),
      time: minBar.time,
    });
  }

  // Equal Highs / Lows as liquidity
  for (const s of swings) {
    if (s.type === 'EQH' && s.price > spot * 1.0005) {
      liquidity.push({
        type: 'EQH',
        price: s.price,
        label: 'EQH · Equal Highs Liquidity',
        barIndex: s.barIndex,
        time: s.time,
      });
      break;
    }
    if (s.type === 'EQL' && s.price < spot * 0.9995) {
      liquidity.push({
        type: 'EQL',
        price: s.price,
        label: 'EQL · Equal Lows Liquidity',
        barIndex: s.barIndex,
        time: s.time,
      });
      break;
    }
  }

  // ── 6. Automated Trade Setup (Stop Loss & Target Boxes) ───────────────────
  // Best-practice execution: determine direction by Trend, CHoCH, or position relative to key OB
  let tradeDir: 'LONG' | 'SHORT' = 'LONG';
  if (currentTrend === 'DOWN') tradeDir = 'SHORT';
  else if (currentTrend === 'UP') tradeDir = 'LONG';
  else {
    // If range, trade towards center or based on closest rejection
    const nearestBullOb = orderBlocks.find((o) => o.type === 'bull');
    const nearestBearOb = orderBlocks.find((o) => o.type === 'bear');
    if (nearestBullOb && Math.abs(spot - nearestBullOb.priceHigh) < Math.abs(spot - (nearestBearOb?.priceLow ?? Infinity))) {
      tradeDir = 'LONG';
    } else if (nearestBearOb) {
      tradeDir = 'SHORT';
    }
  }

  let tradePlan: AutoTradePlan | null = null;
  const entry = Math.round(spot);

  if (tradeDir === 'LONG') {
    // Stop loss: below nearest Bullish OB low or nearest Swing Low
    const bullOb = orderBlocks.find((o) => o.type === 'bull');
    const swingLow = swings.filter((s) => s.kind === 'low' && s.price < spot).slice(-1)[0];

    const slPriceRaw = bullOb
      ? Math.min(bullOb.priceLow - atr * 0.25, spot * 0.994)
      : swingLow
      ? Math.min(swingLow.price - atr * 0.3, spot * 0.994)
      : spot - atr * 1.5;

    const slPrice = Math.round(Math.min(slPriceRaw, spot - atr * 0.5));
    const riskAmount = Math.max(entry - slPrice, 50);
    const riskPct = (riskAmount / entry) * 100;

    // Targets: 1:1.5, 1:2.5, 1:3.5 or nearest resistance/BSL
    const bsl = liquidity.find((l) => l.type === 'BSL');
    const tp1Price = Math.round(entry + riskAmount * 1.6);
    const tp2Price = Math.round(bsl ? Math.max(bsl.price, entry + riskAmount * 2.5) : entry + riskAmount * 2.6);
    const tp3Price = Math.round(entry + riskAmount * 3.8);

    tradePlan = {
      direction: 'LONG',
      entry,
      sl: {
        price: slPrice,
        priceLow: Math.round(slPrice - atr * 0.4),
        priceHigh: slPrice,
        riskPct,
        riskAmount,
        label: `SL: $${slPrice.toLocaleString()} (-${riskPct.toFixed(2)}%)`,
      },
      tp1: {
        price: tp1Price,
        priceLow: tp1Price,
        priceHigh: Math.round(tp1Price + atr * 0.3),
        gainPct: ((tp1Price - entry) / entry) * 100,
        rr: 1.6,
        label: `TP 1: $${tp1Price.toLocaleString()} (1:1.6)`,
      },
      tp2: {
        price: tp2Price,
        priceLow: tp2Price,
        priceHigh: Math.round(tp2Price + atr * 0.4),
        gainPct: ((tp2Price - entry) / entry) * 100,
        rr: 2.6,
        label: `TP 2: $${tp2Price.toLocaleString()} (1:2.6)`,
      },
      tp3: {
        price: tp3Price,
        priceLow: tp3Price,
        priceHigh: Math.round(tp3Price + atr * 0.5),
        gainPct: ((tp3Price - entry) / entry) * 100,
        rr: 3.8,
        label: `TP 3: $${tp3Price.toLocaleString()} (1:3.8)`,
      },
      riskReward: '1 : 2.6',
      reason: `${tf} ${currentTrend} trend · Entry at spot, SL under ${bullOb ? 'OB' : 'swing low'}, TP targeting BSL liquidity`,
    };
  } else {
    // SHORT SETUP
    const bearOb = orderBlocks.find((o) => o.type === 'bear');
    const swingHigh = swings.filter((s) => s.kind === 'high' && s.price > spot).slice(-1)[0];

    const slPriceRaw = bearOb
      ? Math.max(bearOb.priceHigh + atr * 0.25, spot * 1.006)
      : swingHigh
      ? Math.max(swingHigh.price + atr * 0.3, spot * 1.006)
      : spot + atr * 1.5;

    const slPrice = Math.round(Math.max(slPriceRaw, spot + atr * 0.5));
    const riskAmount = Math.max(slPrice - entry, 50);
    const riskPct = (riskAmount / entry) * 100;

    const ssl = liquidity.find((l) => l.type === 'SSL');
    const tp1Price = Math.round(entry - riskAmount * 1.6);
    const tp2Price = Math.round(ssl ? Math.min(ssl.price, entry - riskAmount * 2.5) : entry - riskAmount * 2.6);
    const tp3Price = Math.round(entry - riskAmount * 3.8);

    tradePlan = {
      direction: 'SHORT',
      entry,
      sl: {
        price: slPrice,
        priceLow: slPrice,
        priceHigh: Math.round(slPrice + atr * 0.4),
        riskPct,
        riskAmount,
        label: `SL: $${slPrice.toLocaleString()} (+${riskPct.toFixed(2)}%)`,
      },
      tp1: {
        price: tp1Price,
        priceLow: Math.round(tp1Price - atr * 0.3),
        priceHigh: tp1Price,
        gainPct: ((entry - tp1Price) / entry) * 100,
        rr: 1.6,
        label: `TP 1: $${tp1Price.toLocaleString()} (1:1.6)`,
      },
      tp2: {
        price: tp2Price,
        priceLow: Math.round(tp2Price - atr * 0.4),
        priceHigh: tp2Price,
        gainPct: ((entry - tp2Price) / entry) * 100,
        rr: 2.6,
        label: `TP 2: $${tp2Price.toLocaleString()} (1:2.6)`,
      },
      tp3: {
        price: tp3Price,
        priceLow: Math.round(tp3Price - atr * 0.5),
        priceHigh: tp3Price,
        gainPct: ((entry - tp3Price) / entry) * 100,
        rr: 3.8,
        label: `TP 3: $${tp3Price.toLocaleString()} (1:3.8)`,
      },
      riskReward: '1 : 2.6',
      reason: `${tf} ${currentTrend} trend · Short from spot, SL above ${bearOb ? 'OB' : 'swing high'}, TP targeting SSL liquidity`,
    };
  }

  // ── 7. Liquidity Sweeps (Takes Sell Stops / Takes Buy Stops) ─────────────
  const sweeps: LiquiditySweep[] = [];
  for (let i = 4; i < bars.length; i++) {
    const cur = bars[i]!;
    // Sweep prior low and close back above
    const sweptLow = lows.find((l) => l.i < i && l.i >= i - 30 && cur.low < l.bar.low - tol * 0.2 && cur.close > l.bar.low);
    if (sweptLow && sweeps.filter((s) => s.type === 'sell_stops').length < 2) {
      sweeps.push({
        id: `sweep-ssl-${cur.time}`,
        time: cur.time,
        barIndex: i,
        price: cur.low,
        type: 'sell_stops',
        label: 'Liquidity Sweep',
        sublabel: '(Takes Sell Stops)',
        extremeLabel: 'SSL',
      });
    }

    // Sweep prior high and close back below
    const sweptHigh = highs.find((h) => h.i < i && h.i >= i - 30 && cur.high > h.bar.high + tol * 0.2 && cur.close < h.bar.high);
    if (sweptHigh && sweeps.filter((s) => s.type === 'buy_stops').length < 2) {
      sweeps.push({
        id: `sweep-bsl-${cur.time}`,
        time: cur.time,
        barIndex: i,
        price: cur.high,
        type: 'buy_stops',
        label: 'Liquidity Sweep',
        sublabel: '(Takes Buy Stops)',
        extremeLabel: 'BSL',
      });
    }
  }

  // ── 8. Displacements (Institutional Strong Moves) ─────────────────────────
  const displacements: Displacement[] = [];
  for (let i = Math.max(1, bars.length - 35); i < bars.length; i++) {
    const b = bars[i]!;
    const body = Math.abs(b.close - b.open);
    if (body >= atr * 1.3) {
      const isBull = b.close > b.open;
      displacements.push({
        id: `disp-${b.time}`,
        time: b.time,
        barIndex: i,
        price: isBull ? b.low : b.high,
        direction: isBull ? 'bull' : 'bear',
        label: 'Displacement',
        sublabel: '(Strong Move)',
      });
      if (displacements.length >= 2) break;
    }
  }

  // ── 9. Mitigation Blocks (Retested Breached Order Blocks) ───────────────────
  const mitigations: MitigationBlock[] = [];
  for (const ob of orderBlocks) {
    if (ob.mitigated && mitigations.length < 2) {
      mitigations.push({
        id: `mit-${ob.id}`,
        time: ob.time,
        barIndex: ob.barIndex,
        priceLow: ob.priceLow,
        priceHigh: ob.priceHigh,
        type: ob.type,
        label: 'Mitigation Block',
        sublabel: '(Retest)',
      });
    }
  }

  // ── 10. Institutional Supply & Demand Zones ────────────────────────────────
  const supplyDemandZones: SupplyDemandZone[] = [];
  if (visibleBars.length >= 8) {
    const highestP = Math.max(...visibleBars.map((b) => b.high));
    const lowestP = Math.min(...visibleBars.map((b) => b.low));
    const zHeight = Math.max(atr * 0.5, (highestP - lowestP) * 0.08);

    supplyDemandZones.push({
      type: 'supply',
      priceHigh: Math.round(highestP),
      priceLow: Math.round(highestP - zHeight),
      label: 'Supply Zone',
      sublabel: '(Resistance)',
    });

    supplyDemandZones.push({
      type: 'demand',
      priceHigh: Math.round(lowestP + zHeight),
      priceLow: Math.round(lowestP),
      label: 'Demand Zone',
      sublabel: '(Support)',
    });
  }

  return {
    swings,
    breaks: activeBreaks,
    orderBlocks,
    fvgs,
    liquidity,
    tradePlan,
    trend: currentTrend,
    atr,
    sweeps,
    displacements,
    mitigations,
    supplyDemandZones,
  };
}
