import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import * as Collapsible from '@radix-ui/react-collapsible';
import {
  CandlestickSeries, ColorType, CrosshairMode, HistogramSeries, createChart, createSeriesMarkers,
  type IChartApi, type ISeriesApi, type ISeriesMarkersPluginApi, type Time, type UTCTimestamp,
} from 'lightweight-charts';
import {
  ChevronDown, Expand, Lock, Maximize2, Minimize, Move,
  Trash2, Plus, Target, TrendingUp, TrendingDown, Square, Zap,
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
  getAnnotations, createAnnotation, deleteAnnotationById,
  type Annotation, type AnnotationKind,
} from '@/api/annotations';

/**
 * BTC price chart — upgraded with:
 *  • Full-width single-row layout (no sidebar cramping)
 *  • SMC overlay: BOS / CHoCH / OB / FVG / Supply / Demand drawn on the canvas
 *  • Red SL box + Green TGT boxes persisted to PostgreSQL
 *  • AUTO kind-picker: no manual selection needed — system reads TF + trend + price position
 */

export type ChartTf = '1m' | '5m' | '15m' | '30m' | '1h' | '4h' | '1d';
export const CHART_TFS: readonly ChartTf[] = ['1m', '5m', '15m', '30m', '1h', '4h'];

const RIGHT_BARS = 14;
const OPENING_BARS = 60;

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
  sl:       { label: 'SL',      fill: 'rgba(226,80,79,0.18)',   border: C_SL,     group: 'trade' },
  tgt:      { label: 'TP 1',    fill: 'rgba(38,161,123,0.18)',  border: C_TGT,    group: 'trade' },
  tgt2:     { label: 'TP 2',    fill: 'rgba(52,211,153,0.14)',  border: C_TGT2,   group: 'trade' },
  tgt3:     { label: 'TP 3',    fill: 'rgba(110,231,183,0.10)', border: C_TGT3,   group: 'trade' },
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

// ── AUTO-PICK ENGINE ──────────────────────────────────────────────────────────
/**
 * Automatically determines the correct SMC kind from context.
 *
 * Best-practice hierarchy:
 *  1. Price position relative to spot (above / below / at = SL)
 *  2. Timeframe:
 *     4h / 1h   → institutional zones → Supply / Demand
 *     15m / 5m  → execution zones    → OB / FVG
 *     1m        → entry execution    → SL / TGT
 *  3. Trend / bias direction (UP → bullish kinds; DOWN → bearish kinds)
 *  4. Zone width: tight (<0.3% of spot) → SL/TGT; wide → zone
 *
 * Returns { kind, reason } so the UI can explain its pick.
 */
function autoPickKind(
  tf: ChartTf,
  trend: 'UP' | 'DOWN' | 'RANGE' | 'QUIET' | null,
  spot: number,
  lo: number,
  hi: number,
): { kind: AnnotationKind; reason: string } {
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || spot <= 0) {
    return { kind: 'sl', reason: 'Enter price range first' };
  }

  const mid = (lo + hi) / 2;
  const widthPct = spot > 0 ? ((hi - lo) / spot) * 100 : 0;
  const above = mid > spot * 1.0005;  // zone centre is above spot
  const below = mid < spot * 0.9995;  // zone centre is below spot
  const atSpot = !above && !below;

  const dir = trend === 'UP' ? 'up' : trend === 'DOWN' ? 'down' : 'neutral';

  // ── At-spot → always SL (tight stop around current price)
  if (atSpot || widthPct < 0.15) {
    return { kind: 'sl', reason: `Zone ≈ spot → SL (tight, ${widthPct.toFixed(2)}% wide)` };
  }

  // ── 1-minute: execution only — SL or TP
  if (tf === '1m') {
    if (above && dir === 'down') return { kind: 'sl',  reason: '1m + trend DOWN + above spot → SL' };
    if (above && dir === 'up')   return { kind: 'tgt', reason: '1m + trend UP + above spot → TP 1' };
    if (below && dir === 'up')   return { kind: 'sl',  reason: '1m + trend UP + below spot → SL' };
    if (below && dir === 'down') return { kind: 'tgt', reason: '1m + trend DOWN + below spot → TP 1' };
    return { kind: above ? 'tgt' : 'sl', reason: '1m execution — SL/TP by position' };
  }

  // ── 4h / 1h: institutional zones — Supply / Demand
  if (tf === '4h' || tf === '1h') {
    if (above) {
      const kind: AnnotationKind = dir === 'up' ? 'tgt' : 'supply';
      return { kind, reason: `${tf} + above spot + ${dir} → ${KIND_META[kind].label}` };
    } else {
      const kind: AnnotationKind = dir === 'down' ? 'tgt' : 'demand';
      return { kind, reason: `${tf} + below spot + ${dir} → ${KIND_META[kind].label}` };
    }
  }

  // ── 15m / 5m: execution zones — OB or FVG
  // Wide zones (>0.5%) → OB; narrow (0.15–0.5%) → FVG
  if (tf === '15m' || tf === '5m') {
    const useOb = widthPct >= 0.5;
    if (above) {
      if (dir === 'up')   return { kind: 'tgt',     reason: `${tf} + UP + above → TP 1 (price heading there)` };
      if (useOb)          return { kind: 'ob_bear',  reason: `${tf} + DOWN + above + wide (${widthPct.toFixed(2)}%) → OB↓` };
      return               { kind: 'fvg_bear',        reason: `${tf} + DOWN + above + narrow → FVG↓` };
    } else {
      if (dir === 'down') return { kind: 'tgt',     reason: `${tf} + DOWN + below → TP 1` };
      if (useOb)          return { kind: 'ob_bull',  reason: `${tf} + UP + below + wide → OB↑` };
      return               { kind: 'fvg_bull',        reason: `${tf} + UP + below + narrow → FVG↑` };
    }
  }

  // ── 30m: mixed — OB for wide, SL/TGT for tight
  if (tf === '30m') {
    if (widthPct < 0.4) {
      // Tight → trade management
      const kind: AnnotationKind = (above && dir === 'down') || (below && dir === 'up') ? 'sl' : 'tgt';
      return { kind, reason: `30m tight zone → ${KIND_META[kind].label}` };
    }
    if (above) return { kind: dir === 'up' ? 'supply' : 'ob_bear', reason: `30m + above + ${dir} → zone` };
    return       { kind: dir === 'down' ? 'demand' : 'ob_bull',     reason: `30m + below + ${dir} → zone` };
  }

  // ── default fallback (shouldn't reach here)
  return { kind: above ? 'supply' : 'demand', reason: 'Default: zone by position' };
}

// ── Quick-add kinds for optional manual override ──────────────────────────────
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

// ── TF best-practice display label ───────────────────────────────────────────
const TF_ROLE: Record<ChartTf, string> = {
  '1d': 'Macro direction',
  '4h': 'Institutional zones — Supply / Demand',
  '1h': 'Key levels — Supply / Demand',
  '30m': 'Setup frame — OB / Zones',
  '15m': 'Pattern confirm — OB / FVG',
  '5m':  'Trigger confirm — OB / FVG',
  '1m':  'Execution only — SL / TP',
};

// ── component ─────────────────────────────────────────────────────────────────
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

  // ── annotation state ──────────────────────────────────────────────────────
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [annBusy, setAnnBusy] = useState(false);
  const [showAnnPanel, setShowAnnPanel] = usePersisted('chart:ann-panel', true);

  // Price inputs — kind is AUTO-derived, no manual kind state needed as default
  const [addLow, setAddLow] = useState('');
  const [addHigh, setAddHigh] = useState('');
  const [addLabel, setAddLabel] = useState('');
  /** null = AUTO mode (recommended); non-null = trader manual override */
  const [manualKind, setManualKind] = useState<AnnotationKind | null>(null);
  const [showOverride, setShowOverride] = useState(false);

  // ── AUTO pick — recalculates whenever inputs or context change ─────────────
  const autoPick = useMemo(() => {
    const lo = parseFloat(addLow);
    const hi = parseFloat(addHigh);
    return autoPickKind(tf, trend, spot, lo, hi);
  }, [tf, trend, spot, addLow, addHigh]);

  // The effective kind: manual override wins, else auto
  const effectiveKind = manualKind ?? autoPick.kind;
  const effectiveMeta = KIND_META[effectiveKind];

  // Reset manual override when TF, trend, or price changes significantly
  useEffect(() => {
    setManualKind(null);
    setShowOverride(false);
  }, [tf, trend]);

  const loadAnnotations = useCallback(async () => {
    try {
      const list = await getAnnotations(symbol, tf);
      setAnnotations(list);
    } catch { /* non-fatal */ }
  }, [symbol, tf]);

  useEffect(() => { void loadAnnotations(); }, [loadAnnotations]);

  const handleAddAnnotation = useCallback(async () => {
    const lo = parseFloat(addLow);
    const hi = parseFloat(addHigh);
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) return;
    const lastBar = bars[bars.length - 1];
    const now = Math.floor(Date.now() / 1000);
    setAnnBusy(true);
    try {
      const ann = await createAnnotation({
        symbol, tf, kind: effectiveKind,
        fromTime: lastBar ? lastBar.time : now - 3600,
        toTime: now + 86400 * 3,
        priceLow: Math.min(lo, hi),
        priceHigh: Math.max(lo, hi),
        label: addLabel || null,
        meta: { autoPickReason: manualKind ? 'manual' : autoPick.reason },
      });
      setAnnotations((prev) => [ann, ...prev]);
      setAddLow(''); setAddHigh(''); setAddLabel('');
      setManualKind(null);
    } catch { /* ignore */ } finally {
      setAnnBusy(false);
    }
  }, [symbol, tf, effectiveKind, addLow, addHigh, addLabel, bars, autoPick.reason, manualKind]);

  const handleDeleteAnnotation = useCallback(async (id: number) => {
    try {
      await deleteAnnotationById(id);
      setAnnotations((prev) => prev.filter((a) => a.id !== id));
    } catch { /* ignore */ }
  }, []);

  // ── candle data ────────────────────────────────────────────────────────────
  const shown = hover ?? bars[bars.length - 1] ?? null;
  const previous = useMemo(() => {
    if (!shown) return null;
    const i = bars.findIndex((b) => b.time === shown.time);
    return i > 0 ? bars[i - 1]! : null;
  }, [bars, shown]);
  const change = shown && previous ? shown.close - previous.close : null;
  const changePct = change !== null && previous ? (change / previous.close) * 100 : null;

  // ── chart init ────────────────────────────────────────────────────────────
  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host || !open || error) return;

    const chart = createChart(host, {
      width: host.clientWidth || 720,
      height: host.clientHeight || 380,
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
      rightPriceScale: { borderColor: 'rgba(255,255,255,0.12)', scaleMargins: { top: 0.06, bottom: 0.22 } },
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

    if (bars.length) {
      candles.setData(bars.map((b) => ({
        time: b.time as UTCTimestamp, open: b.open, high: b.high, low: b.low, close: b.close,
      })));
      volume.setData(bars.map((b) => ({
        time: b.time as UTCTimestamp,
        value: b.volume,
        color: b.close >= b.open ? 'rgba(38,161,123,0.45)' : 'rgba(226,80,79,0.45)',
      })));
      const last = bars.length - 1;
      chart.timeScale().setVisibleLogicalRange({ from: Math.max(0, last - OPENING_BARS), to: last + RIGHT_BARS });
    }
    setSize({ width: host.clientWidth, height: host.clientHeight });

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

    return () => {
      ro.disconnect();
      chart.remove();
      chartRef.current = null;
      candleRef.current = null;
      volumeRef.current = null;
      markersRef.current = null;
    };
  }, [open, error, bars.length === 0]);

  useEffect(() => {
    chartRef.current?.applyOptions({ handleScroll: zoomOn, handleScale: zoomOn });
  }, [zoomOn]);

  useEffect(() => {
    const candles = candleRef.current;
    const volume = volumeRef.current;
    if (!candles || !volume) return;
    candles.setData(bars.map((b) => ({
      time: b.time as UTCTimestamp, open: b.open, high: b.high, low: b.low, close: b.close,
    })));
    volume.setData(bars.map((b) => ({
      time: b.time as UTCTimestamp,
      value: b.volume,
      color: b.close >= b.open ? 'rgba(38,161,123,0.45)' : 'rgba(226,80,79,0.45)',
    })));
    setMoved((n) => n + 1);
  }, [bars]);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || !bars.length) return;
    const last = bars.length - 1;
    chart.timeScale().setVisibleLogicalRange({ from: Math.max(0, last - OPENING_BARS), to: last + RIGHT_BARS });
  }, [tf, bars.length === 0]);

  useEffect(() => {
    markersRef.current?.setMarkers(markers.map((m) => ({
      time: m.time as UTCTimestamp,
      position: m.above ? 'aboveBar' : 'belowBar',
      shape: m.above ? 'arrowDown' : 'arrowUp',
      color: m.tone === 'up' ? C_UP : C_DOWN,
      text: m.label,
    })));
  }, [markers, bars.length === 0, open, error]);

  // ── SVG overlay ───────────────────────────────────────────────────────────
  const overlay = useMemo(() => {
    const chart = chartRef.current;
    const candles = candleRef.current;
    if (!chart || !candles || !bars.length || !size.width || !size.height) return null;
    void moved;
    const priceH = size.height * 0.74;
    const c: Converters = {
      width: size.width,
      height: priceH,
      gutter: chartRef.current?.priceScale('right').width?.() ?? 64,
      y: (price) => {
        const at = candles.priceToCoordinate(price);
        return at === null ? null : Number(at);
      },
      x: (barsAgo) => {
        const bar = bars[bars.length - 1 - barsAgo];
        if (!bar) return null;
        const at = chart.timeScale().timeToCoordinate(bar.time as UTCTimestamp);
        return at === null ? null : Number(at);
      },
    };

    const annShapes = annotations.map((ann) => {
      const meta = KIND_META[ann.kind];
      const yTop = c.y(ann.priceHigh);
      const yBot = c.y(ann.priceLow);
      if (yTop === null || yBot === null) return null;
      const top = Math.min(yTop, yBot);
      const bot = Math.max(yTop, yBot);
      const height = Math.max(bot - top, 3);
      let xLeft = 0;
      const tCoord = chart.timeScale().timeToCoordinate(ann.fromTime as UTCTimestamp);
      if (tCoord !== null) xLeft = Math.max(0, Number(tCoord));
      const xRight = Math.max(xLeft + 20, size.width - (c.gutter ?? 64));
      return { ann, meta, top, height, xLeft, xRight };
    }).filter(Boolean) as {
      ann: Annotation; meta: KindMeta;
      top: number; height: number; xLeft: number; xRight: number;
    }[];

    return {
      zones: zoneShapes(zones, c),
      lines: lineShapes(lines, c),
      callouts: calloutShapes(projection, spot, c),
      annShapes,
      width: size.width,
      height: size.height,
    };
  }, [zones, lines, projection, spot, bars, size, moved, annotations]);

  // ── helpers ────────────────────────────────────────────────────────────────
  const fillSpot = useCallback(() => {
    const p = String(Math.round(spot));
    setAddLow(p); setAddHigh(p);
  }, [spot]);

  const tradeAnns = annotations.filter((a) => KIND_META[a.kind]?.group === 'trade');
  const smcAnns   = annotations.filter((a) => KIND_META[a.kind]?.group === 'smc');
  const liqAnns   = annotations.filter((a) => KIND_META[a.kind]?.group === 'liq');

  const readyToAdd = Boolean(addLow && addHigh && !annBusy);

  // ── render ─────────────────────────────────────────────────────────────────
  return (
    <Collapsible.Root ref={cardRef} open={open} onOpenChange={setOpen}
      className={`price-chart smc-chart${full ? ' is-full' : ''}`}>

      {/* ── header ─────────────────────────────────────────────────────────── */}
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
                  ? `${bias.reasons.map((r) => r.text).join(' · ')} — weighted vote`
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
                <span className="dim">{bars.length} bars</span>
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

          <div className="price-chart-tools" role="group" aria-label="zoom">
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
              title="Zone / SL / TGT annotation panel"
              onClick={() => setShowAnnPanel(!showAnnPanel)}>
              <Square size={12} aria-hidden /> Zones
            </button>
          </div>
        </div>
      </div>

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

                {/* Level bands */}
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

                {/* Swing lines */}
                {overlay.lines.map((l, i) => (
                  <line key={`trend-${i}`} data-trend={l.kind} x1={l.x1} y1={l.y1} x2={l.x2} y2={l.y2}
                    stroke="rgba(236,243,250,0.7)" strokeWidth="1.6" strokeLinecap="round" />
                ))}

                {/* Saved annotation boxes */}
                {overlay.annShapes.map(({ ann, meta, top, height, xLeft, xRight }) => {
                  const lbl = ann.label || meta.label;
                  const isThin = height < 20;
                  return (
                    <g key={`ann-${ann.id}`} data-ann-kind={ann.kind}>
                      <rect x={xLeft} y={top} width={Math.max(xRight - xLeft, 2)} height={height}
                        fill={meta.fill} rx={2} />
                      <line x1={xLeft} x2={xRight} y1={top} y2={top}
                        stroke={meta.border} strokeWidth="1.8" />
                      <line x1={xLeft} x2={xRight} y1={top + height} y2={top + height}
                        stroke={meta.border} strokeWidth="1.2" strokeDasharray="4 3" opacity="0.6" />
                      <text x={xLeft + 8} y={isThin ? top - 4 : top + Math.min(height * 0.55, 16)}
                        fontSize="11" fontWeight="700" fill={meta.border}>{lbl}</text>
                      <text x={xLeft + 8} y={isThin ? top - 4 : top + Math.min(height * 0.55, 16) + 13}
                        fontSize="10" fill="rgba(206,216,230,0.8)">
                        {fmtStrike(Math.round(ann.priceHigh))} – {fmtStrike(Math.round(ann.priceLow))}
                      </text>
                    </g>
                  );
                })}

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
                      {c.key === 'range' ? (
                        <text x={c.x + 10} y={c.y + 10} fontSize="11.5" fill="rgba(226,235,245,0.95)">
                          {fmtStrike(Math.round(c.low ?? 0))} – {fmtStrike(Math.round(c.high ?? 0))}
                        </text>
                      ) : (
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
            OI walls · support <b>{support === null ? '—' : fmtStrike(support)}</b> (heaviest put) · resistance{' '}
            <b>{resistance === null ? '—' : fmtStrike(resistance)}</b> (heaviest call)
          </span>
          <span>{zoomOn ? 'scroll/pinch to zoom, drag to pan' : 'zoom off — page scrolls over chart'} · times IST</span>
        </p>

        {/* ── ZONE ANNOTATION PANEL ─────────────────────────────────────── */}
        {showAnnPanel && (
          <div className="ann-panel">

            {/* TF context banner */}
            <div className="ann-tf-banner">
              <Zap size={12} style={{ color: '#60a5fa', flexShrink: 0 }} aria-hidden />
              <span className="ann-tf-name">{tf}</span>
              <span className="ann-tf-role">{TF_ROLE[tf]}</span>
            </div>

            {/* ── Auto-pick form ────────────────────────────────────────── */}
            <div className="ann-add-form">

              {/* Auto-picked kind display — the big pill */}
              <div className="ann-autopick-row">
                <div className="ann-autopick-badge"
                  style={{ '--ann-color': effectiveMeta.border } as React.CSSProperties}>
                  <Zap size={11} aria-hidden />
                  {manualKind ? 'Override' : 'Auto'}
                  <span className="ann-autopick-kind" style={{ color: effectiveMeta.border }}>
                    {effectiveMeta.label}
                  </span>
                </div>

                {/* Reason tooltip */}
                <span className="ann-autopick-reason" title={autoPick.reason}>
                  {manualKind ? `Override: ${effectiveMeta.label}` : autoPick.reason}
                </span>

                {/* Toggle override picker */}
                <button type="button"
                  className={`ann-override-toggle${showOverride ? ' on' : ''}`}
                  onClick={() => setShowOverride((v) => !v)}
                  title="Manually override the auto-picked kind">
                  {showOverride ? 'Hide override' : 'Override'}
                </button>

                {manualKind && (
                  <button type="button" className="ann-override-toggle"
                    onClick={() => { setManualKind(null); }}
                    title="Back to auto-pick">
                    ↺ Auto
                  </button>
                )}
              </div>

              {/* Override picker — only shown on demand */}
              {showOverride && (
                <div className="ann-kind-row">
                  {OVERRIDE_KINDS.map(({ kind, label, color }) => (
                    <button key={kind} type="button"
                      className={`ann-kind-btn${manualKind === kind ? ' on' : ''}`}
                      style={{ '--ann-color': color } as React.CSSProperties}
                      onClick={() => { setManualKind(kind); }}>
                      {label}
                    </button>
                  ))}
                </div>
              )}

              {/* Price inputs */}
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
                <button type="button" className="chain-chip dim" title="Fill with current spot price"
                  onClick={fillSpot}>
                  Spot
                </button>
                <button type="button"
                  className="ann-add-btn"
                  style={{ '--ann-color': effectiveMeta.border } as React.CSSProperties}
                  disabled={!readyToAdd}
                  onClick={() => void handleAddAnnotation()}>
                  <Plus size={13} aria-hidden />
                  Save {effectiveMeta.label}
                </button>
              </div>
            </div>

            {/* ── Saved boxes list ───────────────────────────────────────── */}
            {annotations.length > 0 && (
              <div className="ann-list">
                {tradeAnns.length > 0 && (
                  <div className="ann-group">
                    <div className="ann-group-title"><Target size={12} aria-hidden /> Trade</div>
                    <div className="ann-rows">
                      {tradeAnns.map((ann) => {
                        const meta = KIND_META[ann.kind];
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
                )}

                {smcAnns.length > 0 && (
                  <div className="ann-group">
                    <div className="ann-group-title"><TrendingUp size={12} aria-hidden /> SMC Zones</div>
                    <div className="ann-rows">
                      {smcAnns.map((ann) => {
                        const meta = KIND_META[ann.kind];
                        return (
                          <div key={ann.id} className="ann-row" data-kind={ann.kind}>
                            <span className="ann-row-badge"
                              style={{ background: meta.fill, borderColor: meta.border, color: meta.border }}>
                              {ann.label || meta.label}
                            </span>
                            <span className="ann-row-prices">
                              {fmtStrike(Math.round(ann.priceHigh))} – {fmtStrike(Math.round(ann.priceLow))}
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
                )}

                {liqAnns.length > 0 && (
                  <div className="ann-group">
                    <div className="ann-group-title"><TrendingDown size={12} aria-hidden /> Liquidity</div>
                    <div className="ann-rows">
                      {liqAnns.map((ann) => {
                        const meta = KIND_META[ann.kind];
                        return (
                          <div key={ann.id} className="ann-row" data-kind={ann.kind}>
                            <span className="ann-row-badge"
                              style={{ background: meta.fill, borderColor: meta.border, color: meta.border }}>
                              {ann.label || meta.label}
                            </span>
                            <span className="ann-row-prices">
                              {fmtStrike(Math.round(ann.priceHigh))} – {fmtStrike(Math.round(ann.priceLow))}
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
                )}
              </div>
            )}

            {annotations.length === 0 && (
              <p className="ann-empty">
                Enter Low + High price → kind auto-selected by TF + trend. Click "Save" to draw on chart.
              </p>
            )}
          </div>
        )}
      </Collapsible.Content>
    </Collapsible.Root>
  );
}
