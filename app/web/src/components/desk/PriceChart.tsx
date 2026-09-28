import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  CandlestickSeries, ColorType, CrosshairMode, HistogramSeries, createChart,
  type IChartApi, type ISeriesApi, type Time, type UTCTimestamp,
} from 'lightweight-charts';
import { Expand, Layers, Lock, Minimize2, Unlock } from 'lucide-react';
import type { Candle } from '@/types/desk';
import { usePersisted } from '@/hooks/usePersisted';
import { TF_SECONDS } from '@/lib/live-bar';
import { DESK_SMC_OPTIONS, runSmc } from '@/lib/smc/engine';
import { closedBars, trendTimeline, type TfRead } from '@/lib/smc/context';
import { readout } from '@/lib/smc/readout';
import { clearAnnotationsApi, getAnnotations, type Annotation } from '@/api/annotations';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { SmcPrimitive } from './chart/smc-primitive';
import { buildScene, C, DEFAULT_LAYERS, htfScene, LAYERS, type Layer, type SceneItem } from './chart/scene';
import { ChartHud } from './chart/ChartHud';
import './chart/price-chart.css';

export type ChartTf = '1m' | '5m' | '15m' | '30m' | '1h' | '4h' | '1d';

/** Bars shown when a timeframe opens -- about nine pixels each, at least thirty -- and the space kept right of the last one for levels and labels. */
const openingBars = (width: number) => Math.max(30, Math.min(90, Math.floor(width / 9)));
const RIGHT_BARS = 24;

const IST_FULL = new Intl.DateTimeFormat('en-IN', {
  timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
});

/**
 * The price chart: candles, and every price-action concept the engine found,
 * drawn on the candles themselves -- structure, liquidity, OB / FVG, levels,
 * premium / discount, sessions, VWAP, candle tags and the live setup's entry,
 * stop and targets. Nothing is explained beside the chart; the HUD in its
 * corner says what the engine knows now and what it is waiting for.
 *
 * The engine (lib/smc) is given closed candles only. The forming candle is
 * drawn, but no concept is read off it until it closes, so a label never
 * appears and then vanishes within a candle.
 */
export function PriceChart({
  bars, tf, loading = false, error, context = [], regime, higher = [], symbol = 'BTCUSD',
}: {
  bars: readonly Candle[];
  tf: ChartTf;
  loading?: boolean;
  error?: string;
  /** The higher / lower timeframe reads for the HUD's context row. */
  context?: readonly TfRead[];
  /** The regime timeframe's candles (1H): each setup records whether it agreed with that trend as it was known then. */
  regime?: { bars: readonly Candle[]; tfSec: number } | null;
  /** Higher timeframes drawn on this chart: 1H order blocks, 15m structure. Ignored when not higher than this chart. */
  higher?: readonly { tf: string; tfSec: number; bars: readonly Candle[]; show: 'zones' | 'structure' }[];
  symbol?: string;
}) {
  const cardRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const hudRef = useRef<HTMLDivElement>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const volumeRef = useRef<ISeriesApi<'Histogram'> | null>(null);
  const primitiveRef = useRef<SmcPrimitive | null>(null);

  const [zoomOn, setZoomOn] = usePersisted('zoom:price-chart', false);
  const [layerList, setLayerList] = usePersisted<Layer[]>('chart:layers', [...DEFAULT_LAYERS]);
  // Folded by default on a phone, where it would cover half the candles; one tap opens it.
  const [hudOpen, setHudOpen] = usePersisted('chart:hud-open', typeof window === 'undefined' || window.innerWidth > 640);
  const [full, setFull] = useState(false);
  const [hover, setHover] = useState<Candle | null>(null);
  const [saved, setSaved] = useState<Annotation[]>([]);
  const layers = useMemo(() => new Set(layerList), [layerList]);
  const tfSec = TF_SECONDS[tf] ?? 300;

  // ── The engine, on closed candles only ────────────────────────────────────
  const closed = closedBars(bars, tfSec, Math.floor(Date.now() / 1000));
  const lastClosed = closed[closed.length - 1];
  const closedKey = `${tf}:${closed.length}:${lastClosed?.time ?? 0}:${lastClosed?.close ?? 0}`;
  const regimeClosed = regime ? closedBars(regime.bars, regime.tfSec, Math.floor(Date.now() / 1000)) : [];
  const regimeKey = `${regimeClosed.length}:${regimeClosed[regimeClosed.length - 1]?.time ?? 0}`;
  const htfTrendAt = useMemo(
    () => (regime && regimeClosed.length ? trendTimeline(runSmc(regimeClosed, { tfSec: regime.tfSec }), regimeClosed, regime.tfSec) : undefined),
    [regimeKey],
  );
  // Keyed on the closed candles, not the array: the forming candle changes every tick and must not re-run the engine.
  const smc = useMemo(() => runSmc(closed, { tfSec, htfTrendAt, ...DESK_SMC_OPTIONS }), [closedKey, htfTrendAt]);
  const read = useMemo(() => readout(smc, closed, context), [smc, context]);
  const nowMin = Math.floor(Date.now() / 60_000);
  const overlays = useMemo(() => higher
    .filter((h) => h.tfSec > tfSec)
    .map((h) => {
      const hb = closedBars(h.bars, h.tfSec, nowMin * 60);
      return { tf: h.tf, tfSec: h.tfSec, bars: hb, state: runSmc(hb, { tfSec: h.tfSec }), show: h.show };
    }), [higher, tfSec, nowMin]);

  // ── What is drawn ─────────────────────────────────────────────────────────
  const scene = useMemo<SceneItem[]>(() => {
    const items = buildScene(smc, closed, layers, read.blocked);
    if (layers.has('htf')) items.push(...htfScene(overlays, closed));
    if (layers.has('saved')) items.push(...savedBoxes(saved, bars));
    return items;
  }, [smc, layers, saved, bars.length, read.blocked, overlays]);

  const loadSaved = useCallback(async () => {
    try { setSaved(await getAnnotations(symbol, tf)); } catch { /* the chart works without them */ }
  }, [symbol, tf]);
  useEffect(() => { void loadSaved(); }, [loadSaved]);
  const clearSaved = useCallback(async () => {
    try { await clearAnnotationsApi(symbol, tf); setSaved([]); } catch { /* left as they were */ }
  }, [symbol, tf]);

  // ── The chart itself ──────────────────────────────────────────────────────
  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host || error) return;
    const chart = createChart(host, {
      width: host.clientWidth || 720,
      height: host.clientHeight || 480,
      layout: {
        background: { type: ColorType.Solid, color: '#0a0e17' },
        textColor: 'rgba(206, 216, 230, 0.85)',
        fontSize: 11,
        attributionLogo: false,
      },
      grid: { vertLines: { color: 'rgba(255,255,255,0.04)' }, horzLines: { color: 'rgba(255,255,255,0.04)' } },
      rightPriceScale: { borderColor: 'rgba(255,255,255,0.12)', scaleMargins: { top: 0.1, bottom: 0.2 } },
      timeScale: { borderColor: 'rgba(255,255,255,0.12)', timeVisible: true, secondsVisible: false, rightOffset: RIGHT_BARS, barSpacing: 8 },
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
      upColor: C.bull, downColor: C.bear, borderUpColor: C.bull, borderDownColor: C.bear, wickUpColor: C.bull, wickDownColor: C.bear,
      priceFormat: { type: 'price', precision: 0, minMove: 1 },
    });
    const volume = chart.addSeries(HistogramSeries, { priceFormat: { type: 'volume' }, priceScaleId: 'volume', lastValueVisible: false, priceLineVisible: false });
    volume.priceScale().applyOptions({ scaleMargins: { top: 0.86, bottom: 0 } });
    const primitive = new SmcPrimitive();
    candles.attachPrimitive(primitive);

    chart.subscribeCrosshairMove((param) => {
      const at = param.time === undefined ? null : param.seriesData.get(candles);
      setHover(at ? ({ ...(at as unknown as Candle), time: Number(param.time) }) : null);
    });

    chartRef.current = chart;
    candleRef.current = candles;
    volumeRef.current = volume;
    primitiveRef.current = primitive;

    const ro = new ResizeObserver(([entry]) => {
      const w = Math.round(entry?.contentRect.width ?? 0);
      const h = Math.round(entry?.contentRect.height ?? 0);
      if (w > 0 && h > 0) chart.applyOptions({ width: w, height: h });
    });
    ro.observe(host);
    return () => {
      ro.disconnect();
      chart.remove();
      chartRef.current = null;
      candleRef.current = null;
      volumeRef.current = null;
      primitiveRef.current = null;
    };
  }, [error, bars.length === 0]);

  useEffect(() => {
    chartRef.current?.applyOptions({ handleScroll: zoomOn, handleScale: zoomOn });
  }, [zoomOn]);

  useEffect(() => {
    const candles = candleRef.current;
    const volume = volumeRef.current;
    if (!candles || !volume) return;
    candles.setData(bars.map((b) => ({ time: b.time as UTCTimestamp, open: b.open, high: b.high, low: b.low, close: b.close })));
    volume.setData(bars.map((b) => ({
      time: b.time as UTCTimestamp, value: b.volume,
      color: b.close >= b.open ? 'rgba(38,161,123,0.45)' : 'rgba(226,80,79,0.45)',
    })));
  }, [bars, error]);

  // Open each timeframe on its recent bars, with room on the right for the levels.
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || !bars.length) return;
    const last = bars.length - 1;
    const width = hostRef.current?.clientWidth || 720;
    chart.timeScale().setVisibleLogicalRange({ from: Math.max(0, last - openingBars(width)), to: last + Math.round(openingBars(width) / 4) });
  }, [tf, bars.length === 0, error]);

  useEffect(() => { primitiveRef.current?.setScene(scene); }, [scene, error, bars.length === 0]);

  // Keep labels out from under the HUD and the toolbar.
  useEffect(() => {
    const host = hostRef.current;
    const primitive = primitiveRef.current;
    if (!primitive || !host) return;
    const covers = [hudRef.current, toolbarRef.current].filter((x): x is HTMLDivElement => !!x);
    const measure = () => {
      const c = host.getBoundingClientRect();
      primitive.setReserved(covers.map((el) => {
        const r = el.getBoundingClientRect();
        return { x: r.left - c.left - 4, y: r.top - c.top - 4, w: r.width + 8, h: r.height + 8 };
      }));
    };
    measure();
    const ro = new ResizeObserver(measure);
    covers.forEach((el) => ro.observe(el));
    ro.observe(host);
    return () => ro.disconnect();
  }, [hudOpen, read, error, bars.length === 0]);

  const toggleLayer = (l: Layer) => setLayerList((cur) => (cur.includes(l) ? cur.filter((x) => x !== l) : [...cur, l]));
  const shown = hover ?? bars[bars.length - 1] ?? null;

  return (
    <div ref={cardRef} className={`pc${full ? ' pc-full' : ''}`} aria-label="Price chart">
      {error ? (
        <div className="pc-empty" role="alert">Chart unavailable: {error}</div>
      ) : !bars.length ? (
        <div className="pc-empty">{loading ? 'Loading candles…' : 'No candles yet.'}</div>
      ) : (
        <div className="pc-stage">
          <div ref={hostRef} className="pc-host" />

          <div ref={toolbarRef} className="pc-toolbar" role="toolbar" aria-label="Chart controls">
            <Popover>
              <PopoverTrigger asChild>
                <button type="button" className="pc-tool" aria-label="Layers" title="What the chart draws"><Layers size={14} /><span>Layers</span></button>
              </PopoverTrigger>
              <PopoverContent align="end" className="pc-layers">
                {LAYERS.map(({ key, label }) => (
                  <label key={key} className="pc-layer">
                    <input type="checkbox" checked={layers.has(key)} onChange={() => toggleLayer(key)} />
                    <span>{label}</span>
                  </label>
                ))}
                {saved.length > 0 && (
                  <button type="button" className="pc-clear" onClick={() => void clearSaved()}>Clear {saved.length} saved level{saved.length === 1 ? '' : 's'}</button>
                )}
              </PopoverContent>
            </Popover>
            <button type="button" className={`pc-tool${zoomOn ? ' on' : ''}`} aria-pressed={zoomOn} onClick={() => setZoomOn(!zoomOn)}
              title={zoomOn ? 'Pan and zoom on — the page will not scroll over the chart' : 'Pan and zoom off — the page scrolls over the chart'}>
              {zoomOn ? <Unlock size={14} /> : <Lock size={14} />}<span>{zoomOn ? 'Zoom on' : 'Zoom'}</span>
            </button>
            <button type="button" className="pc-tool" onClick={() => setFull(!full)} aria-label={full ? 'Exit full screen' : 'Full screen'}>
              {full ? <Minimize2 size={14} /> : <Expand size={14} />}
            </button>
          </div>

          <ChartHud
            ref={hudRef}
            open={hudOpen}
            onToggle={() => setHudOpen(!hudOpen)}
            tf={tf}
            read={read}
            context={context}
            candle={shown ? { ...shown, when: IST_FULL.format(shown.time * 1000), hovering: hover !== null } : null}
          />
        </div>
      )}
    </div>
  );
}

/** Saved levels from the database, as boxes on the bars their times fall on. */
function savedBoxes(saved: readonly Annotation[], bars: readonly Candle[]): SceneItem[] {
  if (!bars.length) return [];
  const indexAt = (t: number) => {
    let lo = 0;
    let hi = bars.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (bars[mid]!.time <= t) lo = mid; else hi = mid - 1; }
    return lo;
  };
  const lastTime = bars[bars.length - 1]!.time;
  return saved.map((a) => ({
    t: 'box' as const, layer: 'saved' as const,
    x1: indexAt(a.fromTime), x2: a.toTime >= lastTime ? 'right' as const : indexAt(a.toTime),
    y1: a.priceLow, y2: Math.max(a.priceHigh, a.priceLow + 1),
    fill: 'rgba(148,163,184,0.08)', stroke: C.muted, dash: true, label: a.label ?? a.kind.toUpperCase(), labelColor: C.muted, priority: 58,
  }));
}
