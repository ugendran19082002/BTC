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
  entryType: 'POI_RETEST' | 'POI_IN_ZONE' | 'BREAKOUT_RETEST' | 'DISCOUNT_OTE' | 'PREMIUM_OTE' | 'LIQUIDITY_RUN';
  poiSource: string;
  status: 'PENDING_RETRACEMENT' | 'TRIGGER_ACTIVE' | 'BREAKOUT_CONFIRMED';
  statusLabel: string;
  spotDistance: number;
  invalidation: number;
  breakEven: number;
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
  checklist: { element: string; status: 'CONFIRMED' | 'ALIGNING' | 'TARGET'; detail: string }[];
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

export type DealingRange = {
  high: number;
  low: number;
  equilibrium: number;
  premiumZone: { low: number; high: number };
  discountZone: { low: number; high: number };
  ote: { low: number; high: number; sweetSpot: number };
  currentZone: 'PREMIUM' | 'DISCOUNT' | 'EQUILIBRIUM' | 'OTE';
  currentPct: number;
};

export type SessionState = {
  asiaActive: boolean;
  londonActive: boolean;
  nyActive: boolean;
  currentSession: string;
  pdh: number;
  pdl: number;
};

export type CandlePattern = {
  name: string;
  type: 'bull' | 'bear' | 'neutral';
  barIndex: number;
  time: number;
  description: string;
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
  dealingRange: DealingRange;
  sessions: SessionState;
  candlePatterns: CandlePattern[];
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
    dealingRange: {
      high: 0,
      low: 0,
      equilibrium: 0,
      premiumZone: { low: 0, high: 0 },
      discountZone: { low: 0, high: 0 },
      ote: { low: 0, high: 0, sweetSpot: 0 },
      currentZone: 'EQUILIBRIUM',
      currentPct: 50,
    },
    sessions: {
      asiaActive: false,
      londonActive: false,
      nyActive: false,
      currentSession: 'Off-Hours',
      pdh: 0,
      pdl: 0,
    },
    candlePatterns: [],
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

  // ── 11. Premium / Discount & Optimal Trade Entry (OTE) ─────────────────────
  const rangeHigh = visibleBars.length >= 5 ? Math.max(...visibleBars.map((b) => b.high)) : spot * 1.02;
  const rangeLow = visibleBars.length >= 5 ? Math.min(...visibleBars.map((b) => b.low)) : spot * 0.98;
  const rangeDiff = Math.max(rangeHigh - rangeLow, 50);
  const equilibrium = Math.round(rangeLow + rangeDiff * 0.5);
  const currentPct = Math.round(((spot - rangeLow) / rangeDiff) * 1000) / 10;

  // Fibonacci OTE (61.8% to 79%)
  const ote62 = Math.round(rangeLow + rangeDiff * 0.618);
  const ote705 = Math.round(rangeLow + rangeDiff * 0.705);
  const ote79 = Math.round(rangeLow + rangeDiff * 0.79);

  let currentZone: 'PREMIUM' | 'DISCOUNT' | 'EQUILIBRIUM' | 'OTE' = 'EQUILIBRIUM';
  if (currentPct >= 61.8 && currentPct <= 79) {
    currentZone = 'OTE';
  } else if (currentPct > 52) {
    currentZone = 'PREMIUM';
  } else if (currentPct < 48) {
    currentZone = 'DISCOUNT';
  }

  const dealingRange: DealingRange = {
    high: Math.round(rangeHigh),
    low: Math.round(rangeLow),
    equilibrium,
    premiumZone: { low: equilibrium, high: Math.round(rangeHigh) },
    discountZone: { low: Math.round(rangeLow), high: equilibrium },
    ote: { low: Math.min(ote62, ote79), high: Math.max(ote62, ote79), sweetSpot: ote705 },
    currentZone,
    currentPct,
  };

  // ── 12. Session Concepts & Kill Zones (Asia, London, New York) ─────────────
  const now = new Date();
  const utcHour = now.getUTCHours();
  const asiaActive = utcHour >= 0 && utcHour < 9;
  const londonActive = utcHour >= 7 && utcHour < 16;
  const nyActive = utcHour >= 13 && utcHour < 22;
  const activeSessions = [
    asiaActive ? 'Asia' : null,
    londonActive ? 'London' : null,
    nyActive ? 'New York' : null,
  ].filter(Boolean);
  const currentSession = activeSessions.join(' + ') || 'Off-Hours';

  const oneDayAgo = Math.floor(Date.now() / 1000) - 86400;
  const dayBars = bars.filter((b) => b.time >= oneDayAgo);
  const pdh = dayBars.length ? Math.max(...dayBars.map((b) => b.high)) : rangeHigh;
  const pdl = dayBars.length ? Math.min(...dayBars.map((b) => b.low)) : rangeLow;

  const sessions: SessionState = {
    asiaActive,
    londonActive,
    nyActive,
    currentSession,
    pdh: Math.round(pdh),
    pdl: Math.round(pdl),
  };

  // ── 13. Institutional Candle Patterns ─────────────────────────────────────
  const candlePatterns: CandlePattern[] = [];
  for (let i = Math.max(1, bars.length - 8); i < bars.length; i++) {
    const cur = bars[i]!;
    const prev = bars[i - 1]!;
    const range = cur.high - cur.low;
    if (range <= 0) continue;
    const body = Math.abs(cur.close - cur.open);
    const upperWick = cur.high - Math.max(cur.open, cur.close);
    const lowerWick = Math.min(cur.open, cur.close) - cur.low;

    if (body <= range * 0.12) {
      candlePatterns.push({
        name: 'Doji',
        type: 'neutral',
        barIndex: i,
        time: cur.time,
        description: 'Indecision & equilibrium candle at key level',
      });
    } else if (lowerWick >= body * 2.0 && upperWick <= body * 0.8) {
      candlePatterns.push({
        name: 'Pin Bar (Rejection)',
        type: 'bull',
        barIndex: i,
        time: cur.time,
        description: 'Bullish liquidity grab & bottom rejection wick',
      });
    } else if (upperWick >= body * 2.0 && lowerWick <= body * 0.8) {
      candlePatterns.push({
        name: 'Pin Bar (Rejection)',
        type: 'bear',
        barIndex: i,
        time: cur.time,
        description: 'Bearish liquidity sweep & top rejection wick',
      });
    } else if (prev.close < prev.open && cur.close > cur.open && cur.close >= prev.open && cur.open <= prev.close) {
      candlePatterns.push({
        name: 'Engulfing',
        type: 'bull',
        barIndex: i,
        time: cur.time,
        description: 'Bullish momentum reversal engulfing previous candle',
      });
    } else if (prev.close > prev.open && cur.close < cur.open && cur.close <= prev.open && cur.open >= prev.close) {
      candlePatterns.push({
        name: 'Engulfing',
        type: 'bear',
        barIndex: i,
        time: cur.time,
        description: 'Bearish distribution engulfing previous candle',
      });
    } else if (cur.high <= prev.high && cur.low >= prev.low) {
      candlePatterns.push({
        name: 'Inside Bar',
        type: 'neutral',
        barIndex: i,
        time: cur.time,
        description: 'Consolidation & contraction before breakout expansion',
      });
    }
  }

  // ── 14. Institutional Automated Trade Plan (Real Trader Decision Engine) ───
  // Evaluates previous SMC concepts (BOS/CHoCH, Liquidity Sweeps, Order Blocks, FVGs,
  // Dealing Range & OTE) to identify high-probability POI limit entries, invalidation SL,
  // and external liquidity TP targets.
  let bullScore = 0;
  let bearScore = 0;

  // 1. Structure Breaks
  for (const b of activeBreaks) {
    if (b.direction === 'bullish') bullScore += b.type === 'CHoCH' ? 3 : 2;
    else bearScore += b.type === 'CHoCH' ? 3 : 2;
  }

  // 2. Liquidity Sweeps (Reversal Precursors)
  for (const sw of sweeps) {
    if (sw.type === 'sell_stops') bullScore += 3; // Swept retail sell stops -> smart money buys!
    else bearScore += 3; // Swept retail buy stops -> smart money sells!
  }

  // 3. Regime / Trend
  if (currentTrend === 'UP') bullScore += 2;
  else if (currentTrend === 'DOWN') bearScore += 2;

  // 4. Dealing Range Discount vs Premium
  if (dealingRange.currentZone === 'DISCOUNT' || dealingRange.currentZone === 'OTE') bullScore += 1;
  else if (dealingRange.currentZone === 'PREMIUM') bearScore += 1;

  const tradeDir: 'LONG' | 'SHORT' = bullScore >= bearScore ? 'LONG' : 'SHORT';
  let tradePlan: AutoTradePlan | null = null;

  if (tradeDir === 'LONG') {
    // Look for high probability Bullish POIs
    const bullOb = orderBlocks.find((o) => o.type === 'bull' && !o.mitigated && o.priceHigh <= spot * 1.008)
      ?? orderBlocks.find((o) => o.type === 'bull' && o.priceHigh <= spot * 1.01);
    const bullFvg = fvgs.find((f) => f.type === 'bull' && !f.mitigated && f.priceHigh <= spot * 1.008);
    const demandZone = supplyDemandZones.find((z) => z.type === 'demand');

    let poiEntry: number;
    let poiSource: string;
    let entryType: AutoTradePlan['entryType'] = 'POI_RETEST';
    let poiLow: number;

    if (bullOb) {
      // 50% Consequent Encroachment (CE) of Bullish Order Block
      poiEntry = Math.round((bullOb.priceHigh + bullOb.priceLow) / 2);
      poiSource = 'Bullish OB↑ (50% CE)';
      entryType = 'POI_RETEST';
      poiLow = bullOb.priceLow;
    } else if (bullFvg) {
      // 50% Consequent Encroachment (CE) of Fair Value Gap
      poiEntry = Math.round((bullFvg.priceHigh + bullFvg.priceLow) / 2);
      poiSource = 'FVG↑ Imbalance (50% CE)';
      entryType = 'POI_RETEST';
      poiLow = bullFvg.priceLow;
    } else if (dealingRange.ote.sweetSpot > 0 && dealingRange.ote.sweetSpot <= spot * 1.005) {
      // 61.8% to 70.5% Fibonacci OTE
      poiEntry = Math.round(dealingRange.ote.sweetSpot);
      poiSource = 'Discount OTE (62%–79% Fib)';
      entryType = 'DISCOUNT_OTE';
      poiLow = Math.round(dealingRange.low);
    } else if (demandZone && demandZone.priceHigh <= spot * 1.008) {
      poiEntry = Math.round((demandZone.priceHigh + demandZone.priceLow) / 2);
      poiSource = 'Demand Zone Support Retest';
      entryType = 'BREAKOUT_RETEST';
      poiLow = demandZone.priceLow;
    } else {
      const swingLow = swings.filter((s) => s.kind === 'low' && s.price < spot).slice(-1)[0];
      poiEntry = swingLow ? Math.round(swingLow.price + atr * 0.3) : Math.round(spot);
      poiSource = 'Structural Support Reclaim';
      entryType = 'LIQUIDITY_RUN';
      poiLow = swingLow ? swingLow.price : Math.round(spot - atr * 0.8);
    }

    // Stop Loss under POI invalidation
    const slRaw = Math.min(poiLow - atr * 0.25, poiEntry - atr * 0.5);
    const slPrice = Math.round(slRaw);
    const riskAmount = Math.max(poiEntry - slPrice, Math.round(atr * 0.5), 60);
    const riskPct = ((riskAmount) / poiEntry) * 100;

    // Targets: Institutional Liquidity Targets (BSL, EQH, Structure High)
    const bsl = liquidity.find((l) => l.type === 'BSL' && l.price > poiEntry);
    const eqh = liquidity.find((l) => l.type === 'EQH' && l.price > poiEntry);
    const targetLiquidity = bsl ?? eqh;

    const tp1Price = Math.round(poiEntry + riskAmount * 2.0); // Minimum 1:2.0 R:R
    const tp2Price = Math.round(targetLiquidity ? Math.max(targetLiquidity.price, poiEntry + riskAmount * 3.0) : poiEntry + riskAmount * 3.0);
    const tp3Price = Math.round(poiEntry + riskAmount * 4.5);

    // Status: Pending pullback vs in-zone trigger
    let status: AutoTradePlan['status'] = 'PENDING_RETRACEMENT';
    let statusLabel: string;
    const spotDist = spot - poiEntry;

    if (spotDist > atr * 0.25) {
      status = 'PENDING_RETRACEMENT';
      statusLabel = `⏳ Waiting for Retest to ${poiSource} ($${poiEntry.toLocaleString()})`;
    } else if (Math.abs(spotDist) <= atr * 0.25) {
      status = 'TRIGGER_ACTIVE';
      statusLabel = `🔥 IN-ZONE TRIGGER: Price at ${poiSource} ($${poiEntry.toLocaleString()})`;
    } else {
      status = 'TRIGGER_ACTIVE';
      statusLabel = `⚡ Discount Entry: Reclaiming ${poiSource} ($${poiEntry.toLocaleString()})`;
    }

    tradePlan = {
      direction: 'LONG',
      entry: poiEntry,
      entryType,
      poiSource,
      status,
      statusLabel,
      spotDistance: spotDist,
      invalidation: slPrice,
      breakEven: poiEntry,
      sl: {
        price: slPrice,
        priceLow: Math.round(slPrice - atr * 0.3),
        priceHigh: slPrice,
        riskPct,
        riskAmount,
        label: `SL: $${slPrice.toLocaleString()} (-${riskPct.toFixed(2)}%)`,
      },
      tp1: {
        price: tp1Price,
        priceLow: tp1Price,
        priceHigh: Math.round(tp1Price + atr * 0.2),
        gainPct: ((tp1Price - poiEntry) / poiEntry) * 100,
        rr: 2.0,
        label: `TP 1: $${tp1Price.toLocaleString()} (1:2.0 R:R)`,
      },
      tp2: {
        price: tp2Price,
        priceLow: tp2Price,
        priceHigh: Math.round(tp2Price + atr * 0.3),
        gainPct: ((tp2Price - poiEntry) / poiEntry) * 100,
        rr: Math.round(((tp2Price - poiEntry) / riskAmount) * 10) / 10,
        label: `TP 2: $${tp2Price.toLocaleString()} (${targetLiquidity ? targetLiquidity.type : '1:3.0 R:R'})`,
      },
      tp3: {
        price: tp3Price,
        priceLow: tp3Price,
        priceHigh: Math.round(tp3Price + atr * 0.4),
        gainPct: ((tp3Price - poiEntry) / poiEntry) * 100,
        rr: 4.5,
        label: `TP 3: $${tp3Price.toLocaleString()} (1:4.5 R:R)`,
      },
      riskReward: `1 : ${((tp2Price - poiEntry) / riskAmount).toFixed(1)}`,
      reason: `${tf} Institutional Long Setup · POI: ${poiSource} at $${poiEntry.toLocaleString()} · SL under $${Math.round(poiLow).toLocaleString()} · Targeting BSL stops at $${tp2Price.toLocaleString()}`,
      checklist: [
        { element: 'Market Bias', status: bullScore >= 3 ? 'CONFIRMED' : 'ALIGNING', detail: `${currentTrend} trend (${bullScore} bull pts)` },
        { element: 'Entry POI', status: bullOb || bullFvg ? 'CONFIRMED' : 'ALIGNING', detail: poiSource },
        { element: 'Invalidation', status: 'CONFIRMED', detail: `SL below POI at $${slPrice.toLocaleString()}` },
        { element: 'Liquidity Target', status: 'TARGET', detail: `BSL at $${tp2Price.toLocaleString()}` },
      ],
    };
  } else {
    // SHORT SETUP
    const bearOb = orderBlocks.find((o) => o.type === 'bear' && !o.mitigated && o.priceLow >= spot * 0.992)
      ?? orderBlocks.find((o) => o.type === 'bear' && o.priceLow >= spot * 0.99);
    const bearFvg = fvgs.find((f) => f.type === 'bear' && !f.mitigated && f.priceLow >= spot * 0.992);
    const supplyZone = supplyDemandZones.find((z) => z.type === 'supply');

    let poiEntry: number;
    let poiSource: string;
    let entryType: AutoTradePlan['entryType'] = 'POI_RETEST';
    let poiHigh: number;

    if (bearOb) {
      // 50% Consequent Encroachment (CE) of Bearish Order Block
      poiEntry = Math.round((bearOb.priceHigh + bearOb.priceLow) / 2);
      poiSource = 'Bearish OB↓ (50% CE)';
      entryType = 'POI_RETEST';
      poiHigh = bearOb.priceHigh;
    } else if (bearFvg) {
      // 50% Consequent Encroachment (CE) of Fair Value Gap
      poiEntry = Math.round((bearFvg.priceHigh + bearFvg.priceLow) / 2);
      poiSource = 'FVG↓ Imbalance (50% CE)';
      entryType = 'POI_RETEST';
      poiHigh = bearFvg.priceHigh;
    } else if (dealingRange.ote.sweetSpot > 0 && dealingRange.ote.sweetSpot >= spot * 0.995) {
      poiEntry = Math.round(dealingRange.ote.sweetSpot);
      poiSource = 'Premium OTE (62%–79% Fib)';
      entryType = 'PREMIUM_OTE';
      poiHigh = Math.round(dealingRange.high);
    } else if (supplyZone && supplyZone.priceLow >= spot * 0.992) {
      poiEntry = Math.round((supplyZone.priceHigh + supplyZone.priceLow) / 2);
      poiSource = 'Supply Zone Resistance Retest';
      entryType = 'BREAKOUT_RETEST';
      poiHigh = supplyZone.priceHigh;
    } else {
      const swingHigh = swings.filter((s) => s.kind === 'high' && s.price > spot).slice(-1)[0];
      poiEntry = swingHigh ? Math.round(swingHigh.price - atr * 0.3) : Math.round(spot);
      poiSource = 'Structural Resistance Rejection';
      entryType = 'LIQUIDITY_RUN';
      poiHigh = swingHigh ? swingHigh.price : Math.round(spot + atr * 0.8);
    }

    const slRaw = Math.max(poiHigh + atr * 0.25, poiEntry + atr * 0.5);
    const slPrice = Math.round(slRaw);
    const riskAmount = Math.max(slPrice - poiEntry, Math.round(atr * 0.5), 60);
    const riskPct = ((riskAmount) / poiEntry) * 100;

    const ssl = liquidity.find((l) => l.type === 'SSL' && l.price < poiEntry);
    const eql = liquidity.find((l) => l.type === 'EQL' && l.price < poiEntry);
    const targetLiquidity = ssl ?? eql;

    const tp1Price = Math.round(poiEntry - riskAmount * 2.0); // Minimum 1:2.0 R:R
    const tp2Price = Math.round(targetLiquidity ? Math.min(targetLiquidity.price, poiEntry - riskAmount * 3.0) : poiEntry - riskAmount * 3.0);
    const tp3Price = Math.round(poiEntry - riskAmount * 4.5);

    let status: AutoTradePlan['status'] = 'PENDING_RETRACEMENT';
    let statusLabel: string;
    const spotDist = poiEntry - spot;

    if (spotDist > atr * 0.25) {
      status = 'PENDING_RETRACEMENT';
      statusLabel = `⏳ Waiting for Retest to ${poiSource} ($${poiEntry.toLocaleString()})`;
    } else if (Math.abs(spotDist) <= atr * 0.25) {
      status = 'TRIGGER_ACTIVE';
      statusLabel = `🔥 IN-ZONE TRIGGER: Price at ${poiSource} ($${poiEntry.toLocaleString()})`;
    } else {
      status = 'TRIGGER_ACTIVE';
      statusLabel = `⚡ Premium Entry: Rejecting from ${poiSource} ($${poiEntry.toLocaleString()})`;
    }

    tradePlan = {
      direction: 'SHORT',
      entry: poiEntry,
      entryType,
      poiSource,
      status,
      statusLabel,
      spotDistance: spotDist,
      invalidation: slPrice,
      breakEven: poiEntry,
      sl: {
        price: slPrice,
        priceLow: slPrice,
        priceHigh: Math.round(slPrice + atr * 0.3),
        riskPct,
        riskAmount,
        label: `SL: $${slPrice.toLocaleString()} (+${riskPct.toFixed(2)}%)`,
      },
      tp1: {
        price: tp1Price,
        priceLow: Math.round(tp1Price - atr * 0.2),
        priceHigh: tp1Price,
        gainPct: ((poiEntry - tp1Price) / poiEntry) * 100,
        rr: 2.0,
        label: `TP 1: $${tp1Price.toLocaleString()} (1:2.0 R:R)`,
      },
      tp2: {
        price: tp2Price,
        priceLow: Math.round(tp2Price - atr * 0.3),
        priceHigh: tp2Price,
        gainPct: ((poiEntry - tp2Price) / poiEntry) * 100,
        rr: Math.round(((poiEntry - tp2Price) / riskAmount) * 10) / 10,
        label: `TP 2: $${tp2Price.toLocaleString()} (${targetLiquidity ? targetLiquidity.type : '1:3.0 R:R'})`,
      },
      tp3: {
        price: tp3Price,
        priceLow: Math.round(tp3Price - atr * 0.4),
        priceHigh: tp3Price,
        gainPct: ((poiEntry - tp3Price) / poiEntry) * 100,
        rr: 4.5,
        label: `TP 3: $${tp3Price.toLocaleString()} (1:4.5 R:R)`,
      },
      riskReward: `1 : ${((poiEntry - tp2Price) / riskAmount).toFixed(1)}`,
      reason: `${tf} Institutional Short Setup · POI: ${poiSource} at $${poiEntry.toLocaleString()} · SL above $${Math.round(poiHigh).toLocaleString()} · Targeting SSL stops at $${tp2Price.toLocaleString()}`,
      checklist: [
        { element: 'Market Bias', status: bearScore >= 3 ? 'CONFIRMED' : 'ALIGNING', detail: `${currentTrend} trend (${bearScore} bear pts)` },
        { element: 'Entry POI', status: bearOb || bearFvg ? 'CONFIRMED' : 'ALIGNING', detail: poiSource },
        { element: 'Invalidation', status: 'CONFIRMED', detail: `SL above POI at $${slPrice.toLocaleString()}` },
        { element: 'Liquidity Target', status: 'TARGET', detail: `SSL at $${tp2Price.toLocaleString()}` },
      ],
    };
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
    dealingRange,
    sessions,
    candlePatterns,
  };
}
