import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  CandlestickSeries, ColorType, CrosshairMode, HistogramSeries, createChart,
  type AutoscaleInfo, type IChartApi, type ISeriesApi, type Time, type UTCTimestamp,
} from 'lightweight-charts';
import { Expand, Lock, Minimize2, Unlock } from 'lucide-react';
import type { Candle } from '@/types/desk';
import { usePersisted } from '@/hooks/usePersisted';
import { TF_SECONDS } from '@/lib/live-bar';
import { closedBars, type TfRead } from '@/lib/smc/context';
import { volRegime } from '@/lib/vol-regime';
import { ScenePrimitive } from './chart/scene-primitive';
import { C } from './chart/scene';
import { ChartHud } from './chart/ChartHud';
import type { PerpOiChange } from '@/api/desk';
import { LtpChip } from './chart/LtpChip';
import { entryScene } from './chart/entry-layer';
import type { EntryOverlay } from '@/types/entry';
import './chart/price-chart.css';

export type ChartTf = '1m' | '3m' | '5m' | '15m' | '30m' | '1h' | '4h' | '1d';

/** Bars shown when a timeframe opens -- about nine pixels each, at least thirty -- and the space kept right of the last one for levels and labels. */
const openingBars = (width: number) => Math.max(30, Math.min(90, Math.floor(width / 9)));
const RIGHT_BARS = 24;

const IST_TICK = new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false });
const IST_FULL = new Intl.DateTimeFormat('en-IN', {
  timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
});

/**
 * The price chart: candles and volume, and the one setup it is handed --
 * `entry`, the entry section's choice (components/desk/entry, decided on the
 * server), drawn as its entry box, stop and targets. It decides no entry of
 * its own, so there is one entry logic on the desk and it is that one. The
 * HUD in its corner reads the candle and the market, never a setup.
 *
 * Until 4 Oct 2026 it also drew fifteen layers of context -- structure,
 * liquidity, OB / FVG, levels, sessions, VWAP, the book heatmap, big trades,
 * option strikes, the volume profile, delta and saved levels -- under a Layers
 * menu. None had shown an edge (docs/features/price-chart.md), and they were
 * removed with their data feeds.
 */
export function PriceChart({
  bars, tf, views = [], onView, loading = false, error, context = [], derivs, ltp, entry = null, size = 'full', label = 'Price chart',
}: {
  /** The entry section's chosen setup, drawn as its entry box, stop and targets. Null: nothing drawn. */
  entry?: EntryOverlay | null;
  /** 'full': the desk's height; 'panel': an entry panel's; 'compact': a small chart with no readout or toolbar (the twelve-chart grid). */
  size?: 'full' | 'panel' | 'compact';
  /** The chart's accessible name. */
  label?: string;
  bars: readonly Candle[];
  tf: ChartTf;
  /** The timeframes the viewer may switch the chart to, shown as a switch in the toolbar; none, no switch. */
  views?: readonly ChartTf[];
  onView?: (tf: ChartTf) => void;
  loading?: boolean;
  error?: string;
  /** The higher / lower timeframe reads for the HUD's context row. */
  context?: readonly TfRead[];
  /** The perpetual's positioning: OI against an hour ago, and funding (percent a funding period). */
  derivs?: { oi: PerpOiChange | null; funding: number | null } | null;
  /** The perp's last trade, from the stream, for the LTP chip. */
  ltp?: { price: number; at: number } | null;
}) {
  const cardRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const hudRef = useRef<HTMLDivElement>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const entryRef = useRef<EntryOverlay | null>(entry);
  entryRef.current = entry;
  // A new setup re-scales at once, not on the next tick: the provider is set again, which makes the chart ask it.
  useEffect(() => {
    candleRef.current?.applyOptions({ autoscaleInfoProvider: (base: () => AutoscaleInfo | null) => withEntryLevels(base(), entryRef.current) });
  }, [entry]);
  const volumeRef = useRef<ISeriesApi<'Histogram'> | null>(null);
  const primitiveRef = useRef<ScenePrimitive | null>(null);

  const [zoomOn, setZoomOn] = usePersisted('zoom:price-chart', false);
  // Folded by default in a panel and on a phone, where it would cover half the candles; one tap opens it.
  const [hudOpen, setHudOpen] = usePersisted(`chart:hud-open:${size}`, size === 'full' && (typeof window === 'undefined' || window.innerWidth > 640));
  const [full, setFull] = useState(false);
  const [hover, setHover] = useState<Candle | null>(null);
  const tfSec = TF_SECONDS[tf] ?? 300;
  const compact = size === 'compact';

  // ── What is drawn: the entry section's setup, and nothing else ────────────
  const scene = useMemo(() => (entry ? entryScene(entry, bars) : []), [bars.length, entry]);
  // The volatility read is taken off closed candles: the forming one changes every tick.
  const closed = closedBars(bars, tfSec, Math.floor(Date.now() / 1000));
  const lastClosed = closed[closed.length - 1];
  const closedKey = `${tf}:${closed.length}:${lastClosed?.time ?? 0}:${lastClosed?.close ?? 0}`;
  const vol = useMemo(() => volRegime(closed), [closedKey]);

  // ── The chart itself ──────────────────────────────────────────────────────
  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host || error) return;
    const chart = createChart(host, {
      width: host.clientWidth || 720,
      height: host.clientHeight || 480,
      layout: {
        background: { type: ColorType.Solid, color: '#0a0d10' },
        textColor: 'rgba(206, 216, 230, 0.85)',
        fontSize: 11,
        attributionLogo: false,
      },
      grid: { vertLines: { color: 'rgba(255,255,255,0.04)' }, horzLines: { color: 'rgba(255,255,255,0.04)' } },
      rightPriceScale: { borderColor: 'rgba(255,255,255,0.12)', scaleMargins: { top: 0.1, bottom: 0.2 } },
      timeScale: {
        borderColor: 'rgba(255,255,255,0.12)', timeVisible: true, secondsVisible: false, rightOffset: RIGHT_BARS, barSpacing: 8,
        // The axis in IST like the crosshair: without this the library labels it in UTC, and one candle read 11:10 on the axis and 16:40 on hover.
        tickMarkFormatter: (t: Time) => IST_TICK.format(Number(t) * 1000),
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
      upColor: C.bull, downColor: C.bear, borderUpColor: C.bull, borderDownColor: C.bear, wickUpColor: C.bull, wickDownColor: C.bear,
      priceFormat: { type: 'price', precision: 0, minMove: 1 },
    });
    const volume = chart.addSeries(HistogramSeries, { priceFormat: { type: 'volume' }, priceScaleId: 'volume', lastValueVisible: false, priceLineVisible: false });
    volume.priceScale().applyOptions({ scaleMargins: { top: 0.86, bottom: 0 } });
    const primitive = new ScenePrimitive();
    candles.attachPrimitive(primitive);

    chart.subscribeCrosshairMove((param) => {
      const at = param.time === undefined ? null : param.seriesData.get(candles);
      setHover(at ? ({ ...(at as unknown as Candle), time: Number(param.time) }) : null);
    });

    chartRef.current = chart;
    candleRef.current = candles;
    // The price axis spans the drawn setup as well as the candles: a TGT 1R or more away is
    // otherwise off the chart, and looks missing (1 Oct 2026, a 186-point short's TGT1).
    candles.applyOptions({ autoscaleInfoProvider: (base: () => AutoscaleInfo | null) => withEntryLevels(base(), entryRef.current) });
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
      // Detach first: `chart.remove()` does not detach series primitives, and the
      // label-measuring observer below can still fire once before its own cleanup.
      // A repaint asked of a removed chart throws "Object is disposed".
      candles.detachPrimitive(primitive);
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

  // What the series were last given, so a tick sends only what changed. A tick moves the forming
  // candle, and a new candle is one more: both are `update()` on the tail -- the library redraws one
  // bar instead of re-reading the whole history four times a second. Anything else (the poll's
  // fresh history, a switch of timeframe, a new chart) is `setData`.
  const sentRef = useRef<{ series: ISeriesApi<'Candlestick'> | null; bars: readonly Candle[] }>({ series: null, bars: [] });
  useEffect(() => {
    const candles = candleRef.current;
    const volume = volumeRef.current;
    if (!candles || !volume) return;
    const toCandle = (b: Candle) => ({ time: b.time as UTCTimestamp, open: b.open, high: b.high, low: b.low, close: b.close });
    const toVolume = (b: Candle) => ({
      time: b.time as UTCTimestamp, value: b.volume,
      color: b.close >= b.open ? 'rgba(38,161,123,0.45)' : 'rgba(226,80,79,0.45)',
    });
    const tail = tailFrom(sentRef.current.series === candles ? sentRef.current.bars : [], bars);
    if (tail >= 0) {
      for (let i = tail; i < bars.length; i++) { candles.update(toCandle(bars[i]!)); volume.update(toVolume(bars[i]!)); }
    } else {
      candles.setData(bars.map(toCandle));
      volume.setData(bars.map(toVolume));
    }
    sentRef.current = { series: candles, bars };
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
  }, [hudOpen, compact, error, bars.length === 0]);

  const shown = hover ?? bars[bars.length - 1] ?? null;

  return (
    <div ref={cardRef} className={`pc${size === 'full' ? '' : ` pc-${size}`}${full ? ' pc-full' : ''}`} aria-label={label}>
      {error ? (
        <div className="pc-empty" role="alert">Chart unavailable: {error}</div>
      ) : !bars.length ? (
        <div className="pc-empty">{loading ? 'Loading candles…' : 'No candles yet.'}</div>
      ) : (
        <div className="pc-stage">
          <div ref={hostRef} className="pc-host" />

          {!compact && <div ref={toolbarRef} className="pc-toolbar" role="toolbar" aria-label="Chart controls">
            {ltp && <LtpChip price={ltp.price} at={ltp.at} tfSec={tfSec} />}
            {views.length > 1 && onView && (
              <div className="pc-views" role="radiogroup" aria-label="Chart timeframe">
                {views.map((v) => (
                  <button key={v} type="button" role="radio" aria-checked={v === tf} className={`pc-tool${v === tf ? ' on' : ''}`} onClick={() => onView(v)}>
                    {v}
                  </button>
                ))}
              </div>
            )}
            <button type="button" className={`pc-tool${zoomOn ? ' on' : ''}`} aria-pressed={zoomOn} onClick={() => setZoomOn(!zoomOn)}
              title={zoomOn ? 'Pan and zoom on — the page will not scroll over the chart' : 'Pan and zoom off — the page scrolls over the chart'}>
              {zoomOn ? <Unlock size={14} /> : <Lock size={14} />}<span>{zoomOn ? 'Zoom on' : 'Zoom'}</span>
            </button>
            <button type="button" className="pc-tool" onClick={() => setFull(!full)} aria-label={full ? 'Exit full screen' : 'Full screen'}>
              {full ? <Minimize2 size={14} /> : <Expand size={14} />}
            </button>
          </div>}

          {!compact && <ChartHud
            ref={hudRef}
            open={hudOpen}
            onToggle={() => setHudOpen(!hudOpen)}
            tf={tf}
            context={context}
            derivs={derivs || vol ? { oi: derivs?.oi ?? null, funding: derivs?.funding ?? null, vol } : null}
            candle={shown ? { ...shown, when: IST_FULL.format(shown.time * 1000), hovering: hover !== null } : null}
          />}
        </div>
      )}
    </div>
  );
}

/**
 * Where `next` differs from what the series were last given (`prev`), when
 * only the tail changed: the index to `update()` from, or -1 for `setData`.
 * The tail changed alone when `next` is as long or one longer, every bar
 * before `prev`'s last is the same object (the live candle only replaces the
 * last one), and nothing goes back in time.
 */
export function tailFrom(prev: readonly Candle[], next: readonly Candle[]): number {
  const m = prev.length;
  const n = next.length;
  if (!m || (n !== m && n !== m + 1)) return -1;
  for (let i = 0; i < m - 1; i++) if (prev[i] !== next[i]) return -1;
  if (next[m - 1]!.time !== prev[m - 1]!.time) return -1;
  if (n === m + 1 && !(next[m]!.time > next[m - 1]!.time)) return -1;
  return m - 1;
}

/**
 * A price range widened to take in a setup's entry zone, stop, TGT1 and TGT2,
 * so they are on the chart. Not TGT3: the expected-move edge can be far
 * enough to squash the candles into a line. Pure.
 */
export function withEntryLevels(info: AutoscaleInfo | null, e: EntryOverlay | null): AutoscaleInfo | null {
  if (!info || !info.priceRange || !e) return info;
  const levels = [e.entryLo, e.entryHi, e.stop, e.tp1, ...(e.tp2 !== null ? [e.tp2] : [])];
  return {
    ...info,
    priceRange: {
      minValue: Math.min(info.priceRange.minValue, ...levels),
      maxValue: Math.max(info.priceRange.maxValue, ...levels),
    },
  };
}

