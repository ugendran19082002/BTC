import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import * as Collapsible from '@radix-ui/react-collapsible';
import {
  CandlestickSeries, ColorType, CrosshairMode, HistogramSeries, createChart, createSeriesMarkers,
  type IChartApi, type ISeriesApi, type ISeriesMarkersPluginApi, type Time, type UTCTimestamp,
} from 'lightweight-charts';
import {
  ChevronDown, Expand, Lock, Maximize2, Minimize, Move,
  Trash2, Plus, Target, TrendingUp, TrendingDown, Square, Zap,
  CheckCircle2, Layers, BarChart2, Droplets, BookmarkCheck,
} from 'lucide-react';
import { usePersisted } from '@/hooks/usePersisted';
import type { Candle } from '@/types/desk';
import { strike as fmtStrike } from '@/lib/format';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import {
  CALLOUT_H, CALLOUT_W, calloutShapes, lineShapes, zoneShapes,
  type Converters, type Projection, type StateMarker, type TrendLine, type Zone,
} from '@/components/desk/chart-overlay';
import {
  getAnnotations, createAnnotation, deleteAnnotationById, clearAnnotationsApi,
  type Annotation, type AnnotationKind,
} from '@/api/annotations';
import {
  analyzeSmc, type SmcAnalysisResult, type AutoTradePlan,
} from '@/lib/smc-engine';

/**
 * BTC Price Chart — Full Auto SMC & Price Action Suite:
 *  • Zero manual entry needed: System automatically detects Market Structure,
 *    Order Blocks (OB↑/OB↓), Fair Value Gaps (FVG), Liquidity Pools (BSL/SSL/EQH/EQL),
 *    and generates a complete Auto Trade Setup with Red Stop Loss & Green Target Boxes!
 *  • Full-width layout with responsive canvas & SVG overlay.
 *  • 1-Click "Save Auto Setup to DB" to persist levels to PostgreSQL.
 *  • Individual toggle controls for SMC, Trade Setup, Liquidity, and Structure.
 */

export type ChartTf = '1m' | '5m' | '15m' | '30m' | '1h' | '4h' | '1d';
export const CHART_TFS: readonly ChartTf[] = ['1m', '5m', '15m', '30m', '1h', '4h'];

const RIGHT_BARS = 18;
const OPENING_BARS = 65;

const IST_FULL = new Intl.DateTimeFormat('en-IN', {
  timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
});

// ── colour palette ────────────────────────────────────────────────────────────
const C_UP    = '#26a17b';
const C_DOWN  = '#e2504f';
const C_BOS   = '#60a5fa';
const C_CHOCH = '#f59e0b';
const C_OB_B  = 'rgba(38,161,123,0.22)';
const C_OB_R  = 'rgba(226,80,79,0.22)';
const C_FVG_B = 'rgba(96,165,250,0.18)';
const C_FVG_R = 'rgba(245,158,11,0.18)';
const C_SL    = '#e2504f';
const C_TGT   = '#26a17b';
const C_TGT2  = '#34d399';
const C_TGT3  = '#6ee7b7';
const C_SUPPLY  = 'rgba(226,80,79,0.14)';
const C_DEMAND  = 'rgba(38,161,123,0.14)';

// ── annotation kind metadata ──────────────────────────────────────────────────
type KindMeta = { label: string; fill: string; border: string; group: 'trade' | 'smc' | 'liq' };

const KIND_META: Record<AnnotationKind, KindMeta> = {
  sl:       { label: 'SL',      fill: 'rgba(226,80,79,0.20)',   border: C_SL,     group: 'trade' },
  tgt:      { label: 'TP 1',    fill: 'rgba(38,161,123,0.20)',  border: C_TGT,    group: 'trade' },
  tgt2:     { label: 'TP 2',    fill: 'rgba(52,211,153,0.16)',  border: C_TGT2,   group: 'trade' },
  tgt3:     { label: 'TP 3',    fill: 'rgba(110,231,183,0.12)', border: C_TGT3,   group: 'trade' },
  ob_bull:  { label: 'OB↑',    fill: C_OB_B,                   border: C_UP,     group: 'smc'   },
  ob_bear:  { label: 'OB↓',    fill: C_OB_R,                   border: C_DOWN,   group: 'smc'   },
  fvg_bull: { label: 'FVG↑',   fill: C_FVG_B,                  border: C_BOS,    group: 'smc'   },
  fvg_bear: { label: 'FVG↓',   fill: C_FVG_R,                  border: C_CHOCH,  group: 'smc'   },
  supply:   { label: 'Supply',  fill: C_SUPPLY,                 border: C_DOWN,   group: 'smc'   },
  demand:   { label: 'Demand',  fill: C_DEMAND,                 border: C_UP,     group: 'smc'   },
  bos:      { label: 'BOS',     fill: 'transparent',            border: C_BOS,    group: 'smc'   },
  choch:    { label: 'CHoCH',   fill: 'transparent',            border: C_CHOCH,  group: 'smc'   },
  eqh:      { label: 'EQH',     fill: 'transparent',            border: '#94a3b8',group: 'liq'   },
  eql:      { label: 'EQL',     fill: 'transparent',            border: '#94a3b8',group: 'liq'   },
  ssl:      { label: 'SSL',     fill: 'rgba(226,80,79,0.08)',   border: C_DOWN,   group: 'liq'   },
  bsl:      { label: 'BSL',     fill: 'rgba(38,161,123,0.08)',  border: C_UP,     group: 'liq'   },
  breaker:  { label: 'Breaker', fill: 'rgba(245,158,11,0.12)',  border: C_CHOCH,  group: 'smc'   },
};

// ── TF best-practice display label ───────────────────────────────────────────
const TF_ROLE: Record<ChartTf, string> = {
  '1d': 'Macro Direction & Higher Swings',
  '4h': 'Institutional Zones — Supply / Demand',
  '1h': 'Key Levels — Supply / Demand / Trend',
  '30m': 'Setup Frame — Order Blocks & Imbalances',
  '15m': 'Execution Frame — OB, FVG, BOS/CHoCH',
  '5m':  'Micro Trigger — Liquidity Sweeps & Tight Setups',
  '1m':  'Scalp Execution — Rapid SL/TP Execution',
};

// ── Quick-add kinds for manual override ───────────────────────────────────────
const OVERRIDE_KINDS: { kind: AnnotationKind; label: string; color: string }[] = [
  { kind: 'sl',       label: 'SL',      color: C_SL    },
  { kind: 'tgt',      label: 'TP 1',    color: C_TGT   },
  { kind: 'tgt2',     label: 'TP 2',    color: C_TGT2  },
  { kind: 'tgt3',     label: 'TP 3',    color: C_TGT3  },
  { kind: 'ob_bull',  label: 'OB↑',    color: C_UP    },
  { kind: 'ob_bear',  label: 'OB↓',    color: C_DOWN  },
  { kind: 'fvg_bull', label: 'FVG↑',   color: C_BOS   },
  { kind: 'fvg_bear', label: 'FVG↓',   color: C_CHOCH },
  { kind: 'supply',   label: 'Supply',  color: C_DOWN  },
  { kind: 'demand',   label: 'Demand',  color: C_UP    },
  { kind: 'bos',      label: 'BOS',     color: C_BOS   },
  { kind: 'choch',    label: 'CHoCH',   color: C_CHOCH },
  { kind: 'ssl',      label: 'SSL',     color: C_DOWN  },
  { kind: 'bsl',      label: 'BSL',     color: C_UP    },
];

export function PriceChart({
  bars, support, resistance, spot, zones = [], lines = [], projection = null,
  markers = [], trend = null, bias = null, tf, onTf, loading = false, error,
  hideTfSelector = false, hideHeadline = false, symbol = 'BTCUSD',
}: {
  bars: readonly Candle[];
  support: number | null;
  resistance: number | null;
  spot: number;
  zones?: readonly Zone[];
  lines?: readonly TrendLine[];
  projection?: Projection | null;
  markers?: readonly StateMarker[];
  trend?: 'UP' | 'DOWN' | 'RANGE' | 'QUIET' | null;
  bias?: { side: 'UP' | 'DOWN' | 'NEUTRAL'; strength: number; up: number; down: number;
    reasons: { text: string; side: 'UP' | 'DOWN'; weight: number }[] } | null;
  tf: ChartTf;
  onTf: (tf: ChartTf) => void;
  loading?: boolean;
  error?: string;
  hideTfSelector?: boolean;
  hideHeadline?: boolean;
  symbol?: string;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const volumeRef = useRef<ISeriesApi<'Histogram'> | null>(null);
  const markersRef = useRef<ISeriesMarkersPluginApi<Time> | null>(null);

  const [open, setOpen] = usePersisted('open:price-chart', true);
  const [full, setFull] = useState(false);
  const [zoomOn, setZoomOn] = usePersisted('zoom:price-chart', false);
  const [hover, setHover] = useState<Candle | null>(null);
  const [moved, setMoved] = useState(0);
  const [size, setSize] = useState({ width: 0, height: 0 });

  // ── Auto Draw Feature Toggles (Persisted) ──────────────────────────────────
  const [showSmc, setShowSmc] = usePersisted('chart:show-smc', true);
  const [showTradePlan, setShowTradePlan] = usePersisted('chart:show-trade-plan', true);
  const [showStructure, setShowStructure] = usePersisted('chart:show-structure', true);
  const [showLiquidity, setShowLiquidity] = usePersisted('chart:show-liquidity', true);
  const [showAnnPanel, setShowAnnPanel] = usePersisted('chart:ann-panel', false);

  // ── DB-saved annotations state ─────────────────────────────────────────────
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [annBusy, setAnnBusy] = useState(false);
  const [savedToast, setSavedToast] = useState<string | null>(null);

  // ── Manual form inputs (optional override) ─────────────────────────────────
  const [addLow, setAddLow] = useState('');
  const [addHigh, setAddHigh] = useState('');
  const [addLabel, setAddLabel] = useState('');
  const [manualKind, setManualKind] = useState<AnnotationKind | null>(null);
  const [showOverride, setShowOverride] = useState(false);

  const effectiveBars = bars ?? [];

  // ── Automated SMC & Price Action Engine ────────────────────────────────────
  const smc = useMemo<SmcAnalysisResult>(() => {
    return analyzeSmc(effectiveBars, spot > 0 ? spot : effectiveBars[effectiveBars.length - 1]?.close ?? 76500, tf, trend);
  }, [effectiveBars, spot, tf, trend]);

  // Load annotations from PostgreSQL DB
  const loadAnnotations = useCallback(async () => {
    try {
      const list = await getAnnotations(symbol, tf);
      setAnnotations(list);
    } catch { /* non-fatal */ }
  }, [symbol, tf]);

  useEffect(() => { void loadAnnotations(); }, [loadAnnotations]);

  // Reset manual override on TF or trend change
  useEffect(() => {
    setManualKind(null);
    setShowOverride(false);
  }, [tf, trend]);

  // ── 1-Click Save Auto Plan to Database ─────────────────────────────────────
  const handleSaveAutoSetup = useCallback(async () => {
    if (!smc.tradePlan) return;
    const plan = smc.tradePlan;
    const lastBar = effectiveBars[effectiveBars.length - 1];
    const now = Math.floor(Date.now() / 1000);
    const fromTime = lastBar ? lastBar.time - 3600 : now - 3600;
    const toTime = now + 86400 * 3;

    setAnnBusy(true);
    try {
      // 1. Save Stop Loss box
      const slAnn = await createAnnotation({
        symbol, tf, kind: 'sl',
        fromTime, toTime,
        priceLow: Math.min(plan.sl.priceLow, plan.sl.priceHigh),
        priceHigh: Math.max(plan.sl.priceLow, plan.sl.priceHigh),
        label: plan.sl.label,
        meta: { autoGenerated: true, direction: plan.direction, reason: plan.reason },
      });

      // 2. Save TP 1 box
      const tp1Ann = await createAnnotation({
        symbol, tf, kind: 'tgt',
        fromTime, toTime,
        priceLow: Math.min(plan.tp1.priceLow, plan.tp1.priceHigh),
        priceHigh: Math.max(plan.tp1.priceLow, plan.tp1.priceHigh),
        label: plan.tp1.label,
        meta: { autoGenerated: true, direction: plan.direction, rr: plan.tp1.rr },
      });

      // 3. Save primary active Order Block if available
      const primaryOb = smc.orderBlocks[0];
      let obAnn: Annotation | null = null;
      if (primaryOb) {
        obAnn = await createAnnotation({
          symbol, tf, kind: primaryOb.kind,
          fromTime: primaryOb.time, toTime,
          priceLow: primaryOb.priceLow,
          priceHigh: primaryOb.priceHigh,
          label: primaryOb.label,
          meta: { autoGenerated: true },
        });
      }

      setAnnotations((prev) => [slAnn, tp1Ann, ...(obAnn ? [obAnn] : []), ...prev]);
      setSavedToast(`⚡ Saved Auto ${plan.direction} Setup (SL & TP) to Database!`);
      setTimeout(() => setSavedToast(null), 4000);
    } catch {
      setSavedToast('Failed to save to DB.');
      setTimeout(() => setSavedToast(null), 3000);
    } finally {
      setAnnBusy(false);
    }
  }, [smc.tradePlan, effectiveBars, symbol, tf, smc.orderBlocks]);

  // ── Manual Add / Delete Handlers ───────────────────────────────────────────
  const handleAddManualAnnotation = useCallback(async () => {
    const lo = parseFloat(addLow);
    const hi = parseFloat(addHigh);
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) return;
    const kind = manualKind ?? (smc.tradePlan?.direction === 'SHORT' ? 'sl' : 'tgt');
    const lastBar = effectiveBars[effectiveBars.length - 1];
    const now = Math.floor(Date.now() / 1000);
    setAnnBusy(true);
    try {
      const ann = await createAnnotation({
        symbol, tf, kind,
        fromTime: lastBar ? lastBar.time : now - 3600,
        toTime: now + 86400 * 3,
        priceLow: Math.min(lo, hi),
        priceHigh: Math.max(lo, hi),
        label: addLabel || null,
        meta: { manual: true },
      });
      setAnnotations((prev) => [ann, ...prev]);
      setAddLow(''); setAddHigh(''); setAddLabel('');
      setManualKind(null);
    } catch { /* ignore */ } finally {
      setAnnBusy(false);
    }
  }, [addLow, addHigh, manualKind, smc.tradePlan, effectiveBars, symbol, tf, addLabel]);

  const handleDeleteAnnotation = useCallback(async (id: number) => {
    try {
      await deleteAnnotationById(id);
      setAnnotations((prev) => prev.filter((a) => a.id !== id));
    } catch { /* ignore */ }
  }, []);

  const handleClearAll = useCallback(async () => {
    try {
      await clearAnnotationsApi(symbol, tf);
      setAnnotations([]);
    } catch { /* ignore */ }
  }, [symbol, tf]);

  // ── OHLC Candle data ───────────────────────────────────────────────────────
  const shown = hover ?? effectiveBars[effectiveBars.length - 1] ?? null;
  const previous = useMemo(() => {
    if (!shown) return null;
    const i = effectiveBars.findIndex((b) => b.time === shown.time);
    return i > 0 ? effectiveBars[i - 1]! : null;
  }, [effectiveBars, shown]);
  const change = shown && previous ? shown.close - previous.close : null;
  const changePct = change !== null && previous ? (change / previous.close) * 100 : null;

  // ── Chart Initialization ───────────────────────────────────────────────────
  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host || !open || error) return;

    const chart = createChart(host, {
      width: host.clientWidth || 720,
      height: host.clientHeight || 420,
      layout: {
        background: { type: ColorType.Solid, color: '#0a0e17' },
        textColor: 'rgba(206, 216, 230, 0.85)',
        fontSize: 11,
        attributionLogo: false,
      },
      grid: {
        vertLines: { color: 'rgba(255,255,255,0.05)' },
        horzLines: { color: 'rgba(255,255,255,0.05)' },
      },
      rightPriceScale: { borderColor: 'rgba(255,255,255,0.12)', scaleMargins: { top: 0.08, bottom: 0.22 } },
      timeScale: {
        borderColor: 'rgba(255,255,255,0.12)',
        timeVisible: true,
        secondsVisible: false,
        rightOffset: RIGHT_BARS,
        barSpacing: 8,
      },
      crosshair: { mode: CrosshairMode.Normal },
      handleScroll: zoomOn,
      handleScale: zoomOn,
      localization: {
        locale: 'en-IN',
        timeFormatter: (t: Time) => IST_FULL.format(Number(t) * 1000),
        priceFormatter: (p: number) => Math.round(p).toLocaleString('en-US'),
      },
    });

    const candles = chart.addSeries(CandlestickSeries, {
      upColor: C_UP, downColor: C_DOWN, borderUpColor: C_UP, borderDownColor: C_DOWN,
      wickUpColor: C_UP, wickDownColor: C_DOWN,
      priceFormat: { type: 'price', precision: 0, minMove: 1 },
    });
    const volume = chart.addSeries(HistogramSeries, {
      priceFormat: { type: 'volume' },
      priceScaleId: 'volume',
      lastValueVisible: false,
      priceLineVisible: false,
    });
    volume.priceScale().applyOptions({ scaleMargins: { top: 0.84, bottom: 0 } });

    chart.subscribeCrosshairMove((param) => {
      const at = param.time === undefined ? null : param.seriesData.get(candles);
      setHover(at ? ({ ...(at as unknown as Candle), time: Number(param.time) }) : null);
    });
    chart.timeScale().subscribeVisibleTimeRangeChange(() => setMoved((n) => n + 1));

    chartRef.current = chart;
    candleRef.current = candles;
    volumeRef.current = volume;
    markersRef.current = createSeriesMarkers(candles, []);

    if (effectiveBars.length) {
      candles.setData(effectiveBars.map((b) => ({
        time: b.time as UTCTimestamp, open: b.open, high: b.high, low: b.low, close: b.close,
      })));
      volume.setData(effectiveBars.map((b) => ({
        time: b.time as UTCTimestamp,
        value: b.volume,
        color: b.close >= b.open ? 'rgba(38,161,123,0.45)' : 'rgba(226,80,79,0.45)',
      })));
      const last = effectiveBars.length - 1;
      chart.timeScale().setVisibleLogicalRange({ from: Math.max(0, last - OPENING_BARS), to: last + RIGHT_BARS });
    }
    setSize({ width: host.clientWidth || 720, height: host.clientHeight || 420 });

    const ro = new ResizeObserver(([entry]) => {
      const w = Math.round(entry?.contentRect.width ?? 0);
      const h = Math.round(entry?.contentRect.height ?? 0);
      if (w > 0 && h > 0) {
        chart.applyOptions({ width: w, height: h });
        setSize({ width: w, height: h });
        setMoved((n) => n + 1);
      }
    });
    ro.observe(host);

    // Re-measure after canvas completes first paint
    const t1 = requestAnimationFrame(() => setMoved((n) => n + 1));
    const t2 = setTimeout(() => setMoved((n) => n + 1), 80);
    const t3 = setTimeout(() => setMoved((n) => n + 1), 250);

    return () => {
      cancelAnimationFrame(t1);
      clearTimeout(t2);
      clearTimeout(t3);
      ro.disconnect();
      chart.remove();
      chartRef.current = null;
      candleRef.current = null;
      volumeRef.current = null;
      markersRef.current = null;
    };
  }, [open, error, effectiveBars.length === 0]);

  useEffect(() => {
    chartRef.current?.applyOptions({ handleScroll: zoomOn, handleScale: zoomOn });
  }, [zoomOn]);

  useEffect(() => {
    const candles = candleRef.current;
    const volume = volumeRef.current;
    if (!candles || !volume) return;
    candles.setData(effectiveBars.map((b) => ({
      time: b.time as UTCTimestamp, open: b.open, high: b.high, low: b.low, close: b.close,
    })));
    volume.setData(effectiveBars.map((b) => ({
      time: b.time as UTCTimestamp,
      value: b.volume,
      color: b.close >= b.open ? 'rgba(38,161,123,0.45)' : 'rgba(226,80,79,0.45)',
    })));
    setMoved((n) => n + 1);
  }, [effectiveBars]);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || !effectiveBars.length) return;
    const last = effectiveBars.length - 1;
    chart.timeScale().setVisibleLogicalRange({ from: Math.max(0, last - OPENING_BARS), to: last + RIGHT_BARS });
  }, [tf, effectiveBars.length === 0]);

  useEffect(() => {
    markersRef.current?.setMarkers(markers.map((m) => ({
      time: m.time as UTCTimestamp,
      position: m.above ? 'aboveBar' : 'belowBar',
      shape: m.above ? 'arrowDown' : 'arrowUp',
      color: m.tone === 'up' ? C_UP : C_DOWN,
      text: m.label,
    })));
  }, [markers, effectiveBars.length === 0, open, error]);

  // ── Bulletproof SVG Overlay Geometry (NEVER DROPS SHAPES) ──────────────────
  const overlay = useMemo(() => {
    const chart = chartRef.current;
    const candles = candleRef.current;
    if (!chart || !candles || !effectiveBars.length) return null;
    void moved;

    const width = size.width || 720;
    const height = size.height || 420;
    const priceH = height * 0.76;
    const gutter = (chart && typeof chart.priceScale === 'function' ? (chart.priceScale('right')?.width?.() ?? 64) : 64) ?? 64;
    const xMax = Math.max(100, width - gutter);

    // Calculate bar price extremes for safe fallback scaling
    let minBarPrice = Infinity;
    let maxBarPrice = -Infinity;
    for (const b of effectiveBars) {
      if (b.low < minBarPrice) minBarPrice = b.low;
      if (b.high > maxBarPrice) maxBarPrice = b.high;
    }
    if (!Number.isFinite(minBarPrice) || minBarPrice <= 0) {
      minBarPrice = (spot > 0 ? spot : 76500) * 0.98;
      maxBarPrice = (spot > 0 ? spot : 76500) * 1.02;
    }
    const priceSpan = Math.max(maxBarPrice - minBarPrice, (spot > 0 ? spot : 76500) * 0.005);
    const plotH = Math.max(priceH, 180);

    const c: Converters = {
      width,
      height: priceH,
      gutter,
      y: (price) => {
        const at = candles.priceToCoordinate(price);
        return at === null ? null : Number(at);
      },
      x: (barsAgo) => {
        const bar = effectiveBars[effectiveBars.length - 1 - barsAgo];
        if (!bar) return null;
        const at = chart.timeScale().timeToCoordinate(bar.time as UTCTimestamp);
        return at === null ? null : Number(at);
      },
    };

    // Safe Y that NEVER returns null (falls back proportionally to visible canvas)
    const safeY = (price: number): number => {
      const at = candles.priceToCoordinate(price);
      if (at !== null && Number.isFinite(at)) {
        return Math.max(4, Math.min(plotH - 4, Number(at)));
      }
      const ratio = (maxBarPrice - price) / priceSpan;
      return Math.max(4, Math.min(plotH - 4, ratio * (plotH * 0.8) + plotH * 0.1));
    };

    // Safe X that maps accurately across time or bar index without nulls
    const safeX = (time: number, barIndex?: number): number => {
      const at = chart.timeScale().timeToCoordinate(time as UTCTimestamp);
      if (at !== null && Number.isFinite(at)) {
        return Math.max(0, Math.min(xMax, Number(at)));
      }
      if (typeof barIndex === 'number' && effectiveBars.length > 0) {
        const barsAgo = effectiveBars.length - 1 - barIndex;
        const atAgo = c.x(barsAgo);
        if (atAgo !== null && Number.isFinite(atAgo)) {
          return Math.max(0, Math.min(xMax, atAgo));
        }
        const pct = barIndex / Math.max(effectiveBars.length - 1, 1);
        return Math.max(0, Math.min(xMax, pct * (xMax - 30)));
      }
      if (effectiveBars.length > 0 && time <= effectiveBars[0]!.time) return 0;
      return 0;
    };

    // 1. Auto Trade Setup (Stop Loss Box & Target Boxes)
    let autoTradeBox: {
      plan: AutoTradePlan;
      entryY: number;
      slTop: number;
      slHeight: number;
      tp1Top: number;
      tp1Height: number;
      tp2Top: number;
      tp2Height: number;
      xStart: number;
      xEnd: number;
    } | null = null;

    if (showTradePlan && smc.tradePlan) {
      const p = smc.tradePlan;
      const entryY = safeY(p.entry);
      const slY = safeY(p.sl.price);
      const tp1Y = safeY(p.tp1.price);
      const tp2Y = safeY(p.tp2.price);

      const slTop = Math.min(entryY, slY);
      const slHeight = Math.max(Math.abs(entryY - slY), 16);

      const tp1Top = Math.min(entryY, tp1Y);
      const tp1Height = Math.max(Math.abs(entryY - tp1Y), 16);

      const tp2Top = Math.min(tp1Y, tp2Y);
      const tp2Height = Math.max(Math.abs(tp1Y - tp2Y), 16);

      const lastBarX = c.x(0) ?? (xMax - 180);
      const xStart = Math.max(0, lastBarX - 50);
      const xEnd = xMax;

      autoTradeBox = {
        plan: p,
        entryY,
        slTop,
        slHeight,
        tp1Top,
        tp1Height,
        tp2Top,
        tp2Height,
        xStart,
        xEnd,
      };
    }

    // 2. Auto Order Blocks (OB↑ & OB↓)
    const obShapes = (showSmc ? smc.orderBlocks : []).map((ob) => {
      const yHigh = safeY(ob.priceHigh);
      const yLow = safeY(ob.priceLow);
      const top = Math.min(yHigh, yLow);
      const height = Math.max(Math.abs(yLow - yHigh), 12);
      const xLeft = safeX(ob.time, ob.barIndex);
      const xRight = xMax;
      return { ob, top, height, xLeft, xRight };
    });

    // 3. Auto Fair Value Gaps (FVG)
    const fvgShapes = (showSmc ? smc.fvgs : []).map((fvg) => {
      const yHigh = safeY(fvg.priceHigh);
      const yLow = safeY(fvg.priceLow);
      const top = Math.min(yHigh, yLow);
      const height = Math.max(Math.abs(yLow - yHigh), 8);
      const xLeft = safeX(fvg.time, fvg.barIndex);
      const xRight = xMax;
      return { fvg, top, height, xLeft, xRight };
    });

    // 4. Market Structure Swings (HH, HL, LH, LL)
    const swingShapes = (showStructure ? smc.swings : []).map((s) => {
      const y = safeY(s.price);
      const x = safeX(s.time, s.barIndex);
      return { s, x, y };
    });

    // 5. Structure Breaks (BOS & CHoCH)
    const breakShapes = (showStructure ? smc.breaks : []).map((b) => {
      const y = safeY(b.price);
      const x1 = safeX(b.fromTime, b.fromBarIndex);
      const x2 = Math.min(xMax, Math.max(x1 + 40, safeX(b.toTime, b.toBarIndex)));
      return { b, y, x1, x2 };
    });

    // 6. Liquidity Lines (BSL, SSL, EQH, EQL)
    const liqShapes = (showLiquidity ? smc.liquidity : []).map((l) => {
      const y = safeY(l.price);
      return { l, y, x1: 0, x2: xMax };
    });

    // 7. DB Saved Annotations (manual or previously saved auto setups)
    const annShapes = annotations.map((ann) => {
      const meta = KIND_META[ann.kind] ?? { label: ann.label || 'Zone', fill: 'rgba(255,255,255,0.1)', border: '#60a5fa' };
      const yTop = safeY(ann.priceHigh);
      const yBot = safeY(ann.priceLow);
      const top = Math.min(yTop, yBot);
      const height = Math.max(Math.abs(yBot - yTop), 4);
      const xLeft = safeX(ann.fromTime);
      const xRight = Math.max(xLeft + 20, xMax);
      return { ann, meta, top, height, xLeft, xRight };
    });

    return {
      autoTradeBox,
      obShapes,
      fvgShapes,
      swingShapes,
      breakShapes,
      liqShapes,
      annShapes,
      zones: zoneShapes(zones, c),
      lines: lineShapes(lines, c),
      callouts: calloutShapes(projection, spot > 0 ? spot : effectiveBars[effectiveBars.length - 1]!.close, c),
      width,
      height,
      xMax,
    };
  }, [
    effectiveBars, size, moved, showTradePlan, showSmc, showStructure, showLiquidity,
    smc, annotations, zones, lines, projection, spot,
  ]);

  const fillSpot = useCallback(() => {
    const p = String(Math.round(spot));
    setAddLow(p); setAddHigh(p);
  }, [spot]);

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <Collapsible.Root ref={cardRef} open={open} onOpenChange={setOpen}
      className={`price-chart smc-chart${full ? ' is-full' : ''}`}>

      {/* ── Toast notification ────────────────────────────────────────────── */}
      {savedToast && (
        <div className="smc-toast" role="status">
          <BookmarkCheck size={14} className="smc-toast-icon" />
          <span>{savedToast}</span>
        </div>
      )}

      {/* ── Header ────────────────────────────────────────────────────────── */}
      <div className={`price-chart-head${hideHeadline ? ' is-compact' : ''}`}>
        {!hideHeadline && (
          <div className="price-chart-headline">
            <Collapsible.Trigger className="price-chart-title" aria-label="price chart">
              <ChevronDown className={`smr-chev${open ? '' : ' shut'}`} size={13} aria-hidden />
              BTC <span className="price-chart-dot" aria-hidden>•</span> {tf === '1d' ? '1D' : tf}
            </Collapsible.Trigger>

            {trend && (
              <span className={`price-chart-trend is-${trend.toLowerCase()}`}>
                {trend === 'UP' ? '↗ Uptrend' : trend === 'DOWN' ? '↘ Downtrend'
                  : trend === 'QUIET' ? '→ Quiet' : '↔ Range'}
              </span>
            )}

            {bias && (
              <span className={`price-chart-bias is-${bias.side.toLowerCase()}`}
                title={bias.reasons.length
                  ? `${bias.reasons.map((r) => r.text).join(' · ')} — weighted vote, not a probability`
                  : 'Nothing measured is pointing either way'}>
                <b>{bias.side === 'UP' ? '▲ Up' : bias.side === 'DOWN' ? '▼ Down' : '● No lean'}</b>
                {bias.up + bias.down > 0 && (
                  <span>{Math.round(Math.max(bias.up, bias.down))} vs {Math.round(Math.min(bias.up, bias.down))}</span>
                )}
              </span>
            )}

            {open && shown && !error && (
              <div className="price-chart-ohlc">
                <span className="dim">{hover === null ? 'last' : IST_FULL.format(shown.time * 1000)}</span>
                <span>O <b>{fmtStrike(Math.round(shown.open))}</b></span>
                <span>H <b>{fmtStrike(Math.round(shown.high))}</b></span>
                <span>L <b>{fmtStrike(Math.round(shown.low))}</b></span>
                <span>C <b className={shown.close >= shown.open ? 'up' : 'down'}>{fmtStrike(Math.round(shown.close))}</b></span>
                {change !== null && (
                  <b className={`price-chart-change ${change >= 0 ? 'up' : 'down'}`}>
                    {change >= 0 ? '+' : '−'}{fmtStrike(Math.round(Math.abs(change)))} ({change >= 0 ? '+' : '−'}{Math.abs(changePct!).toFixed(2)}%)
                  </b>
                )}
                <span className="dim">{effectiveBars.length} bars</span>
              </div>
            )}
          </div>
        )}

        <div className="price-chart-controls">
          {!hideTfSelector && (
            <ToggleGroup type="single" value={tf} onValueChange={(v) => v && onTf(v as ChartTf)}
              aria-label="chart timeframe">
              {CHART_TFS.map((t) => (
                <ToggleGroupItem key={t} value={t}>{t === '1d' ? '1D' : t}</ToggleGroupItem>
              ))}
            </ToggleGroup>
          )}

          {/* ── Auto-Draw Feature Pill Toolbar ──────────────────────────────── */}
          <div className="smc-tool-strip" role="toolbar" aria-label="SMC auto overlay toggles">
            <button
              type="button"
              className={`smc-pill-btn${showTradePlan ? ' on trade' : ''}`}
              title="Toggle Auto Trade Setup (Red Stop Loss Box & Green Take Profit Boxes with R:R)"
              onClick={() => setShowTradePlan((v) => !v)}>
              <Target size={12} aria-hidden />
              <span>SL/TP Plan</span>
            </button>

            <button
              type="button"
              className={`smc-pill-btn${showSmc ? ' on smc' : ''}`}
              title="Toggle Order Blocks (OB↑/OB↓) & Fair Value Gaps (FVG)"
              onClick={() => setShowSmc((v) => !v)}>
              <Layers size={12} aria-hidden />
              <span>OB & FVG</span>
            </button>

            <button
              type="button"
              className={`smc-pill-btn${showStructure ? ' on struct' : ''}`}
              title="Toggle Market Structure Swings (HH/HL/LH/LL) & BOS/CHoCH"
              onClick={() => setShowStructure((v) => !v)}>
              <BarChart2 size={12} aria-hidden />
              <span>Structure</span>
            </button>

            <button
              type="button"
              className={`smc-pill-btn${showLiquidity ? ' on liq' : ''}`}
              title="Toggle Liquidity Pools (BSL Buy Stops & SSL Sell Stops)"
              onClick={() => setShowLiquidity((v) => !v)}>
              <Droplets size={12} aria-hidden />
              <span>Liquidity</span>
            </button>

            {/* 1-Click Save Auto Setup to DB */}
            {smc.tradePlan && (
              <button
                type="button"
                className="smc-pill-btn save-btn"
                disabled={annBusy}
                title="1-Click Save Auto-Detected Stop Loss & Target Boxes to Database"
                onClick={() => void handleSaveAutoSetup()}>
                <Zap size={12} style={{ color: '#fbbf24' }} aria-hidden />
                <span>{annBusy ? 'Saving…' : 'Save Setup'}</span>
              </button>
            )}

            <button type="button" className={`chain-chip${zoomOn ? ' on' : ''}`} aria-pressed={zoomOn}
              title={zoomOn ? 'Zoom on' : 'Zoom off'} onClick={() => setZoomOn(!zoomOn)}>
              {zoomOn ? <Move size={13} aria-hidden /> : <Lock size={13} aria-hidden />}
            </button>
            <button type="button" className="chain-chip" aria-label="fit" title="Fit all bars"
              onClick={() => chartRef.current?.timeScale().fitContent()}>
              <Maximize2 size={12} aria-hidden /> Fit
            </button>
            <button type="button" className="chain-chip" aria-label={full ? 'exit full' : 'full screen'}
              title={full ? 'Exit full screen' : 'Full screen'} onClick={() => setFull((v) => !v)}>
              {full ? <Minimize size={13} aria-hidden /> : <Expand size={13} aria-hidden />}
            </button>
            <button type="button"
              className={`chain-chip${showAnnPanel ? ' on' : ''}`}
              title="Toggle Details & Manual Drawing Panel"
              onClick={() => setShowAnnPanel(!showAnnPanel)}>
              <Square size={12} aria-hidden /> Panel
            </button>
          </div>
        </div>
      </div>

      {/* ── Active Auto Setup Info Bar ───────────────────────────────────────── */}
      {smc.tradePlan && showTradePlan && (
        <div className="smc-autoplan-strip">
          <div className="smc-autoplan-badge" data-direction={smc.tradePlan.direction}>
            {smc.tradePlan.direction === 'LONG' ? <TrendingUp size={13} /> : <TrendingDown size={13} />}
            <span>AUTO {smc.tradePlan.direction} SETUP</span>
          </div>

          <div className="smc-autoplan-metrics">
            <span>Entry: <b>${smc.tradePlan.entry.toLocaleString()}</b></span>
            <span className="smc-sep">•</span>
            <span className="smc-metric-sl">SL: <b>${smc.tradePlan.sl.price.toLocaleString()}</b> (-{smc.tradePlan.sl.riskPct.toFixed(2)}%)</span>
            <span className="smc-sep">•</span>
            <span className="smc-metric-tp">TP 1: <b>${smc.tradePlan.tp1.price.toLocaleString()}</b> (+{smc.tradePlan.tp1.gainPct.toFixed(2)}%)</span>
            <span className="smc-sep">•</span>
            <span className="smc-metric-tp">TP 2: <b>${smc.tradePlan.tp2.price.toLocaleString()}</b></span>
            <span className="smc-sep">•</span>
            <span className="smc-metric-rr">R:R <b>{smc.tradePlan.riskReward}</b></span>
          </div>

          <div className="smc-autoplan-reason dim" title={smc.tradePlan.reason}>
            {TF_ROLE[tf]}
          </div>
        </div>
      )}

      <Collapsible.Content>
        {error ? (
          <p className="price-chart-error">{error}</p>
        ) : bars.length === 0 ? (
          <p className="price-chart-empty">{loading ? 'Loading candles…' : 'No candles.'}</p>
        ) : (
          <div className="price-chart-plot">
            <div ref={hostRef} className="price-chart-canvas" />

            {overlay && (
              <svg className="price-chart-overlay" viewBox={`0 0 ${overlay.width} ${overlay.height}`}
                width={overlay.width} height={overlay.height} aria-hidden>
                <defs>
                  <marker id="pc-arrow-up" viewBox="0 0 8 8" refX="6" refY="4" markerWidth="5" markerHeight="5" orient="auto">
                    <path d="M 0 0 L 8 4 L 0 8 z" fill={C_UP} />
                  </marker>
                  <marker id="pc-arrow-down" viewBox="0 0 8 8" refX="6" refY="4" markerWidth="5" markerHeight="5" orient="auto">
                    <path d="M 0 0 L 8 4 L 0 8 z" fill={C_DOWN} />
                  </marker>
                </defs>

                {/* ── 1. Order Blocks (OB↑ & OB↓) ─────────────────────────── */}
                {overlay.obShapes.map(({ ob, top, height, xLeft, xRight }) => {
                  const isBull = ob.type === 'bull';
                  const strokeColor = isBull ? C_UP : C_DOWN;
                  const fillColor = isBull ? 'rgba(38,161,123,0.22)' : 'rgba(226,80,79,0.22)';
                  return (
                    <g key={ob.id} className="smc-ob-group" data-type={ob.type}>
                      <rect x={xLeft} y={top} width={Math.max(xRight - xLeft, 20)} height={height}
                        fill={fillColor} stroke={strokeColor} strokeWidth="1.5" rx={3} />
                      {/* Left Badge */}
                      <rect x={xLeft + 6} y={top + 2} width={isBull ? 116 : 112} height={18} rx={3}
                        fill="rgba(10,14,23,0.92)" stroke={strokeColor} strokeWidth="1" />
                      <text x={xLeft + 10} y={top + 15} fontSize="10.5" fontWeight="700" fill={strokeColor}>
                        {ob.label}
                      </text>
                      {/* Price Range */}
                      <text x={xRight - 8} y={top + 14} fontSize="10" fontWeight="600" fill="rgba(226,235,245,0.9)" textAnchor="end">
                        {fmtStrike(Math.round(ob.priceHigh))} – {fmtStrike(Math.round(ob.priceLow))}
                      </text>
                    </g>
                  );
                })}

                {/* ── 2. Fair Value Gaps (FVG) ────────────────────────────── */}
                {overlay.fvgShapes.map(({ fvg, top, height, xLeft, xRight }) => {
                  const isBull = fvg.type === 'bull';
                  const strokeColor = isBull ? C_BOS : C_CHOCH;
                  const fillColor = isBull ? 'rgba(96,165,250,0.16)' : 'rgba(245,158,11,0.16)';
                  return (
                    <g key={fvg.id} className="smc-fvg-group" data-type={fvg.type}>
                      <rect x={xLeft} y={top} width={Math.max(xRight - xLeft, 20)} height={height}
                        fill={fillColor} stroke={strokeColor} strokeWidth="1.2" strokeDasharray="5 3" rx={2} />
                      <rect x={xLeft + 6} y={top + 2} width={74} height={16} rx={2}
                        fill="rgba(10,14,23,0.92)" stroke={strokeColor} strokeWidth="0.8" />
                      <text x={xLeft + 10} y={top + 14} fontSize="10" fontWeight="700" fill={strokeColor}>
                        {fvg.label}
                      </text>
                    </g>
                  );
                })}

                {/* ── 3. Liquidity Lines (BSL & SSL) ──────────────────────── */}
                {overlay.liqShapes.map(({ l, y, x1, x2 }) => {
                  const isBsl = l.type === 'BSL';
                  const color = isBsl ? C_UP : C_DOWN;
                  return (
                    <g key={`liq-${l.type}-${l.time}`} className="smc-liq-group">
                      <line x1={x1} x2={x2} y1={y} y2={y} stroke={color}
                        strokeWidth="1.5" strokeDasharray="4 3" opacity="0.9" />
                      <rect x={x2 - 155} y={y - 10} width={150} height={20} rx={3}
                        fill="rgba(10,14,23,0.94)" stroke={color} strokeWidth="1" />
                      <text x={x2 - 148} y={y + 4} fontSize="10.5" fontWeight="700" fill={color}>
                        {l.label}
                      </text>
                    </g>
                  );
                })}

                {/* ── 4. Structure Breaks (BOS & CHoCH) ───────────────────── */}
                {overlay.breakShapes.map(({ b, y, x1, x2 }, idx) => {
                  const isBos = b.type === 'BOS';
                  const color = isBos ? C_BOS : C_CHOCH;
                  return (
                    <g key={`break-${idx}`} className="smc-break-group">
                      <line x1={x1} x2={x2} y1={y} y2={y} stroke={color}
                        strokeWidth="1.6" strokeDasharray="6 3" />
                      <rect x={x2 - 64} y={y - 10} width={60} height={18} rx={3}
                        fill="rgba(10,14,23,0.92)" stroke={color} strokeWidth="1" />
                      <text x={x2 - 58} y={y + 3} fontSize="10.5" fontWeight="800" fill={color}>
                        {b.label}
                      </text>
                    </g>
                  );
                })}

                {/* ── 5. Market Structure Swings (HH, HL, LH, LL) ─────────── */}
                {overlay.swingShapes.map(({ s, x, y }, idx) => {
                  const isHigh = s.kind === 'high';
                  const isBull = s.type === 'HH' || s.type === 'HL';
                  const color = isBull ? C_UP : C_DOWN;
                  const tagY = isHigh ? y - 16 : y + 6;
                  return (
                    <g key={`swing-${idx}`} className="smc-swing-tag">
                      <circle cx={x} cy={y} r="3" fill={color} />
                      <rect x={x - 15} y={tagY} width={30} height={15} rx={3}
                        fill="rgba(10,14,23,0.92)" stroke={color} strokeWidth="1" />
                      <text x={x} y={tagY + 11} fontSize="9" fontWeight="800"
                        fill={color} textAnchor="middle">
                        {s.type}
                      </text>
                    </g>
                  );
                })}

                {/* ── 6. Automated Trade Setup (Red SL & Green TP Boxes) ──── */}
                {overlay.autoTradeBox && (
                  <g className="smc-trade-plan-group">
                    {/* Entry Line */}
                    <line
                      x1={overlay.autoTradeBox.xStart}
                      x2={overlay.autoTradeBox.xEnd}
                      y1={overlay.autoTradeBox.entryY}
                      y2={overlay.autoTradeBox.entryY}
                      stroke="#ffffff"
                      strokeWidth="1.8"
                      strokeDasharray="5 3"
                      opacity="0.95"
                    />
                    <rect
                      x={overlay.autoTradeBox.xStart + 6}
                      y={overlay.autoTradeBox.entryY - 10}
                      width={112}
                      height={20}
                      rx={3}
                      fill="rgba(10,14,23,0.96)"
                      stroke="#ffffff"
                      strokeWidth="1"
                    />
                    <text
                      x={overlay.autoTradeBox.xStart + 12}
                      y={overlay.autoTradeBox.entryY + 4}
                      fontSize="10.5"
                      fontWeight="800"
                      fill="#ffffff">
                      ENTRY ${overlay.autoTradeBox.plan.entry.toLocaleString()}
                    </text>

                    {/* RED STOP LOSS BOX */}
                    <rect
                      x={overlay.autoTradeBox.xStart}
                      y={overlay.autoTradeBox.slTop}
                      width={overlay.autoTradeBox.xEnd - overlay.autoTradeBox.xStart}
                      height={overlay.autoTradeBox.slHeight}
                      fill="rgba(226, 80, 79, 0.25)"
                      stroke="#e2504f"
                      strokeWidth="1.8"
                      rx={3}
                    />
                    <rect
                      x={overlay.autoTradeBox.xStart + 6}
                      y={overlay.autoTradeBox.slTop + 3}
                      width={140}
                      height={20}
                      rx={3}
                      fill="rgba(10,14,23,0.96)"
                      stroke="#e2504f"
                      strokeWidth="1"
                    />
                    <text
                      x={overlay.autoTradeBox.xStart + 12}
                      y={overlay.autoTradeBox.slTop + 17}
                      fontSize="10.5"
                      fontWeight="800"
                      fill="#e2504f">
                      🛑 {overlay.autoTradeBox.plan.sl.label}
                    </text>

                    {/* GREEN TP 1 BOX */}
                    <rect
                      x={overlay.autoTradeBox.xStart}
                      y={overlay.autoTradeBox.tp1Top}
                      width={overlay.autoTradeBox.xEnd - overlay.autoTradeBox.xStart}
                      height={overlay.autoTradeBox.tp1Height}
                      fill="rgba(38, 161, 123, 0.25)"
                      stroke="#26a17b"
                      strokeWidth="1.8"
                      rx={3}
                    />
                    <rect
                      x={overlay.autoTradeBox.xStart + 6}
                      y={overlay.autoTradeBox.tp1Top + 3}
                      width={140}
                      height={20}
                      rx={3}
                      fill="rgba(10,14,23,0.96)"
                      stroke="#26a17b"
                      strokeWidth="1"
                    />
                    <text
                      x={overlay.autoTradeBox.xStart + 12}
                      y={overlay.autoTradeBox.tp1Top + 17}
                      fontSize="10.5"
                      fontWeight="800"
                      fill="#26a17b">
                      🎯 {overlay.autoTradeBox.plan.tp1.label}
                    </text>

                    {/* GREEN TP 2 BOX */}
                    <rect
                      x={overlay.autoTradeBox.xStart}
                      y={overlay.autoTradeBox.tp2Top}
                      width={overlay.autoTradeBox.xEnd - overlay.autoTradeBox.xStart}
                      height={overlay.autoTradeBox.tp2Height}
                      fill="rgba(52, 211, 153, 0.16)"
                      stroke="#34d399"
                      strokeWidth="1.4"
                      strokeDasharray="5 3"
                      rx={3}
                    />
                    <rect
                      x={overlay.autoTradeBox.xStart + 6}
                      y={overlay.autoTradeBox.tp2Top + 3}
                      width={132}
                      height={19}
                      rx={3}
                      fill="rgba(10,14,23,0.96)"
                      stroke="#34d399"
                      strokeWidth="1"
                    />
                    <text
                      x={overlay.autoTradeBox.xStart + 12}
                      y={overlay.autoTradeBox.tp2Top + 16}
                      fontSize="10"
                      fontWeight="800"
                      fill="#34d399">
                      🚀 {overlay.autoTradeBox.plan.tp2.label}
                    </text>

                    {/* Summary Callout Banner in Gutter */}
                    <rect
                      x={overlay.autoTradeBox.xEnd - 136}
                      y={overlay.autoTradeBox.entryY - 28}
                      width={130}
                      height={54}
                      rx={6}
                      fill="rgba(10,14,23,0.97)"
                      stroke="#60a5fa"
                      strokeWidth="1.4"
                    />
                    <text
                      x={overlay.autoTradeBox.xEnd - 71}
                      y={overlay.autoTradeBox.entryY - 12}
                      fontSize="11"
                      fontWeight="800"
                      fill="#60a5fa"
                      textAnchor="middle">
                      {overlay.autoTradeBox.plan.direction} SETUP
                    </text>
                    <text
                      x={overlay.autoTradeBox.xEnd - 71}
                      y={overlay.autoTradeBox.entryY + 4}
                      fontSize="10.5"
                      fontWeight="800"
                      fill="#34d399"
                      textAnchor="middle">
                      R:R {overlay.autoTradeBox.plan.riskReward}
                    </text>
                    <text
                      x={overlay.autoTradeBox.xEnd - 71}
                      y={overlay.autoTradeBox.entryY + 18}
                      fontSize="9.5"
                      fill="rgba(206,216,230,0.85)"
                      textAnchor="middle">
                      Risk {overlay.autoTradeBox.plan.sl.riskPct.toFixed(2)}% | TP +{overlay.autoTradeBox.plan.tp1.gainPct.toFixed(2)}%
                    </text>
                  </g>
                )}

                {/* ── 7. DB Saved Annotations ─────────────────────────────── */}
                {overlay.annShapes.map(({ ann, meta, top, height, xLeft, xRight }) => {
                  const lbl = ann.label || meta.label;
                  return (
                    <g key={`ann-${ann.id}`} data-ann-kind={ann.kind}>
                      <rect x={xLeft} y={top} width={Math.max(xRight - xLeft, 2)} height={height}
                        fill={meta.fill} rx={2} />
                      <line x1={xLeft} x2={xRight} y1={top} y2={top}
                        stroke={meta.border} strokeWidth="1.8" />
                      <line x1={xLeft} x2={xRight} y1={top + height} y2={top + height}
                        stroke={meta.border} strokeWidth="1.2" strokeDasharray="4 3" opacity="0.6" />
                      <text x={xLeft + 8} y={top + Math.min(height * 0.55, 16)}
                        fontSize="11" fontWeight="700" fill={meta.border}>{lbl}</text>
                      <text x={xLeft + 8} y={top + Math.min(height * 0.55, 16) + 13}
                        fontSize="10" fill="rgba(206,216,230,0.8)">
                        {fmtStrike(Math.round(ann.priceHigh))} – {fmtStrike(Math.round(ann.priceLow))}
                      </text>
                    </g>
                  );
                })}

                {/* Level bands from desk */}
                {overlay.zones.map((z) => {
                  const colour = z.tone === 'up' ? C_DOWN : C_UP;
                  return (
                    <g key={z.label} data-zone={z.label}>
                      <rect x={0} y={z.top} width={overlay.width} height={z.height} fill={colour} opacity="0.14" />
                      <line x1={0} x2={overlay.width} y1={z.edge} y2={z.edge} stroke={colour}
                        strokeWidth="1.3" strokeDasharray="6 4" opacity="0.9" />
                      {!z.labelInside && (
                        <rect x={6} y={z.tagY} width={124} height={28} rx={4} fill="rgba(10,14,23,0.92)"
                          stroke={colour} strokeWidth="0.8" />
                      )}
                      <text x={z.labelInside ? 14 : 12} y={z.tagY + 13} fontSize="11" fontWeight="600" fill={colour}>{z.label}</text>
                      <text x={z.labelInside ? 14 : 12} y={z.tagY + 25} fontSize="11" fill="rgba(226,235,245,0.9)">
                        {fmtStrike(Math.round(z.low))} – {fmtStrike(Math.round(z.high))}
                      </text>
                    </g>
                  );
                })}

                {/* Swing lines from desk */}
                {overlay.lines.map((l, i) => (
                  <line key={`trend-${i}`} data-trend={l.kind} x1={l.x1} y1={l.y1} x2={l.x2} y2={l.y2}
                    stroke="rgba(236,243,250,0.7)" strokeWidth="1.6" strokeLinecap="round" />
                ))}

                {/* Projection callouts */}
                {overlay.callouts.map((c) => {
                  const colour = c.key === 'up' ? C_UP : c.key === 'down' ? C_DOWN : 'rgba(190,200,215,0.8)';
                  const h = c.key === 'range' ? 34 : CALLOUT_H;
                  return (
                    <g key={c.key} data-leg={c.key}>
                      {c.key !== 'range' && (
                        <path d={`M ${c.x - 40} ${c.fromY} Q ${c.x - 18} ${c.fromY} ${c.x - 6} ${c.y}`}
                          fill="none" stroke={colour} strokeWidth="1.6" opacity="0.85"
                          markerEnd={`url(#pc-arrow-${c.key})`} />
                      )}
                      <rect x={c.x} y={c.y - h / 2} width={CALLOUT_W} height={h} rx={6}
                        fill="rgba(10,14,23,0.96)" stroke={colour} strokeWidth="1.2" />
                      <text x={c.x + 10} y={c.y - h / 2 + 16} fontSize="11.5" fontWeight="600"
                        fill={c.key === 'range' ? 'rgba(206,216,230,0.95)' : colour}>{c.title}</text>
                      {c.key !== 'range' && (
                        <>
                          <text x={c.x + 10} y={c.y + 5} fontSize="11" fill="rgba(190,200,215,0.85)">Target</text>
                          <text x={c.x + CALLOUT_W - 10} y={c.y + 5} fontSize="12" textAnchor="end" fill="rgba(232,240,248,1)">
                            {Math.round(c.price ?? 0).toLocaleString('en-US')}
                          </text>
                          <text x={c.x + CALLOUT_W - 10} y={c.y + 18} fontSize="10.5" textAnchor="end" fill={colour}>
                            ({(c.awayPct ?? 0) >= 0 ? '+' : '−'}{Math.abs(c.awayPct ?? 0).toFixed(2)}%)
                          </text>
                        </>
                      )}
                    </g>
                  );
                })}
              </svg>
            )}
          </div>
        )}

        <p className="price-chart-note">
          <span>
            {support === null && resistance === null
              ? 'No open-interest wall within reach — where open interest sits is off the scale —'
              : <>OI walls · support <b>{support === null ? '—' : fmtStrike(support)}</b> (put wall) · resistance{' '}<b>{resistance === null ? '—' : fmtStrike(resistance)}</b> (call wall) — where open interest sits</>}
          </span>
          <span>{zoomOn ? 'scroll/pinch to zoom, drag to pan' : 'zoom is off, so the page scrolls over the chart'} · times IST</span>
        </p>

        {/* ── ZONE & ANNOTATION DRAWER (OPTIONAL/DETAIL) ───────────────────── */}
        {showAnnPanel && (
          <div className="ann-panel">
            <div className="ann-tf-banner">
              <Zap size={12} style={{ color: '#60a5fa', flexShrink: 0 }} aria-hidden />
              <span className="ann-tf-name">{tf}</span>
              <span className="ann-tf-role">{TF_ROLE[tf]}</span>
              {annotations.length > 0 && (
                <button
                  type="button"
                  className="ann-del-btn"
                  title="Clear all saved annotations for this TF"
                  onClick={() => void handleClearAll()}
                  style={{ marginLeft: 'auto', fontSize: '11px', width: 'auto', padding: '2px 8px' }}>
                  Clear All
                </button>
              )}
            </div>

            {/* Manual price input form (for traders who want custom zones) */}
            <div className="ann-add-form">
              <div className="ann-autopick-row">
                <span className="ann-autopick-badge" style={{ '--ann-color': '#60a5fa' } as React.CSSProperties}>
                  <Zap size={11} aria-hidden />
                  {manualKind ? `Override: ${KIND_META[manualKind].label}` : 'Auto Engine Active'}
                </span>
                <span className="ann-autopick-reason">
                  {smc.tradePlan ? smc.tradePlan.reason : 'All SMC zones and trade setups are auto-calculated and drawn on chart.'}
                </span>
                <button
                  type="button"
                  className={`ann-override-toggle${showOverride ? ' on' : ''}`}
                  onClick={() => setShowOverride((v) => !v)}>
                  {showOverride ? 'Hide Custom Kinds' : 'Custom Kind'}
                </button>
              </div>

              {showOverride && (
                <div className="ann-kind-row">
                  {OVERRIDE_KINDS.map(({ kind, label, color }) => (
                    <button key={kind} type="button"
                      className={`ann-kind-btn${manualKind === kind ? ' on' : ''}`}
                      style={{ '--ann-color': color } as React.CSSProperties}
                      onClick={() => setManualKind(kind)}>
                      {label}
                    </button>
                  ))}
                </div>
              )}

              <div className="ann-price-row">
                <input
                  className="ann-price-input"
                  type="number"
                  placeholder="Low price"
                  value={addLow}
                  onChange={(e) => setAddLow(e.target.value)}
                  step="100"
                />
                <input
                  className="ann-price-input"
                  type="number"
                  placeholder="High price"
                  value={addHigh}
                  onChange={(e) => setAddHigh(e.target.value)}
                  step="100"
                />
                <input
                  className="ann-price-input"
                  type="text"
                  placeholder="Label (optional)"
                  value={addLabel}
                  onChange={(e) => setAddLabel(e.target.value)}
                  maxLength={40}
                />
                <button type="button" className="chain-chip dim" title="Fill with spot" onClick={fillSpot}>
                  Spot
                </button>
                <button
                  type="button"
                  className="ann-add-btn"
                  style={{ '--ann-color': '#60a5fa' } as React.CSSProperties}
                  disabled={!addLow || !addHigh || annBusy}
                  onClick={() => void handleAddManualAnnotation()}>
                  <Plus size={13} aria-hidden />
                  Add Custom Zone
                </button>
              </div>
            </div>

            {/* Saved list */}
            {annotations.length > 0 && (
              <div className="ann-list">
                <div className="ann-group">
                  <div className="ann-group-title"><CheckCircle2 size={12} aria-hidden /> Saved DB Annotations ({annotations.length})</div>
                  <div className="ann-rows">
                    {annotations.map((ann) => {
                      const meta = KIND_META[ann.kind] ?? { label: ann.label || 'Zone', fill: 'rgba(255,255,255,0.1)', border: '#60a5fa' };
                      return (
                        <div key={ann.id} className="ann-row" data-kind={ann.kind}>
                          <span className="ann-row-badge"
                            style={{ background: meta.fill, borderColor: meta.border, color: meta.border }}>
                            {ann.label || meta.label}
                          </span>
                          <span className="ann-row-prices">
                            <span style={{ color: meta.border }}>{fmtStrike(Math.round(ann.priceHigh))}</span>
                            <span className="dim"> – </span>
                            <span style={{ color: meta.border }}>{fmtStrike(Math.round(ann.priceLow))}</span>
                          </span>
                          <span className="ann-row-tf dim">{ann.tf}</span>
                          <button type="button" className="ann-del-btn" title="Delete" aria-label="delete"
                            onClick={() => void handleDeleteAnnotation(ann.id)}>
                            <Trash2 size={12} aria-hidden />
                          </button>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            )}
          </div>
        )}
      </Collapsible.Content>
    </Collapsible.Root>
  );
}
