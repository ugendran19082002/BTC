import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  CandlestickSeries, ColorType, CrosshairMode, HistogramSeries, LineSeries, createChart,
  type AutoscaleInfo, type IChartApi, type ISeriesApi, type LogicalRange, type Time, type UTCTimestamp,
} from 'lightweight-charts';
import { Expand, Layers, Lock, Minimize2, Unlock } from 'lucide-react';
import type { Candle } from '@/types/desk';
import { usePersisted } from '@/hooks/usePersisted';
import { TF_SECONDS } from '@/lib/live-bar';
import { runSmc } from '@/lib/smc/engine';
import { closedBars, type TfRead } from '@/lib/smc/context';
import { clearAnnotationsApi, getAnnotations, type Annotation } from '@/api/annotations';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { SmcPrimitive } from './chart/smc-primitive';
import { buildScene, C, DEFAULT_LAYERS, htfScene, LAYER_PRESETS, LAYERS, type Layer, type SceneItem } from './chart/scene';
import { ChartHud } from './chart/ChartHud';
import { bigTradeScene, bigTradeSummary, deltaSeries, flowRead, heatScene, profileScene, strikeScene, volRegime, volumeProfile, type BigTrade } from './chart/flow-layers';
import type { FlowBar, HeatColumn, PerpOiChange, Wall } from '@/api/desk';
import type { Leg } from '@/types/desk';
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
 * The price chart: candles, and the market context the engine found, drawn
 * on the candles themselves -- structure, liquidity, OB / FVG, levels,
 * premium / discount, sessions, VWAP, candle tags, the book, big trades,
 * option strikes, the profile and delta. The HUD in its corner reads the
 * candle and the market, never a setup.
 *
 * It decides no entry of its own. The one setup it draws is `entry`, the
 * entry section's choice (components/desk/entry, decided on the server), so
 * there is one entry logic on the desk and it is that one.
 *
 * The engine (lib/smc) is given closed candles only. The forming candle is
 * drawn, but no concept is read off it until it closes, so a label never
 * appears and then vanishes within a candle.
 */
export function PriceChart({
  bars, tf, views = [], onView, loading = false, error, context = [], higher = [], bigTrades, flowBars, heat, strikes, derivs, ltp, symbol = 'BTCUSD', entry = null, size = 'full', label = 'Price chart',
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
  /** Higher timeframes drawn on this chart: 1H order blocks, 15m structure. Ignored when not higher than this chart. */
  higher?: readonly { tf: string; tfSec: number; bars: readonly Candle[]; show: 'zones' | 'structure' }[];
  /** Large taker orders for the bubbles, the smallest drawn (contracts, set from the market), and how that was set. */
  bigTrades?: { prints: readonly BigTrade[]; min: number; basis?: string };
  /** The recorded order book: one column of resting size per candle, and the persistent walls now. */
  heat?: { step: number; columns: readonly HeatColumn[]; walls: readonly Wall[] } | null;
  /** Aggressive flow per candle, for the delta / CVD pane and the readout. */
  flowBars?: readonly FlowBar[];
  /** The option board: every strike's OI and its last hour's change, and max pain, for the strike levels. */
  strikes?: { legs: readonly Leg[]; maxPain: number | null } | null;
  /** The perpetual's positioning: OI against an hour ago, and funding (percent a funding period). */
  derivs?: { oi: PerpOiChange | null; funding: number | null } | null;
  /** The perp's last trade, from the stream, for the LTP chip. */
  ltp?: { price: number; at: number } | null;
  symbol?: string;
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
  const primitiveRef = useRef<SmcPrimitive | null>(null);

  const [zoomOn, setZoomOn] = usePersisted('zoom:price-chart', false);
  // v5: the chart's own trade and trend-plan layers went (30 Sep 2026); a list saved before would still name them.
  const [layerList, setLayerList] = usePersisted<Layer[]>('chart:layers:v5', [...DEFAULT_LAYERS]);
  // Folded by default in a panel and on a phone, where it would cover half the candles; one tap opens it.
  const [hudOpen, setHudOpen] = usePersisted(`chart:hud-open:${size}`, size === 'full' && (typeof window === 'undefined' || window.innerWidth > 640));
  const [full, setFull] = useState(false);
  const [hover, setHover] = useState<Candle | null>(null);
  const [saved, setSaved] = useState<Annotation[]>([]);
  /** The bars in view, whole indices: what the volume profile is taken over. */
  const [inView, setInView] = useState<{ from: number; to: number } | null>(null);
  /** The big-trade bubble under the pointer, and where. */
  const [tip, setTip] = useState<{ x: number; y: number; text: string } | null>(null);
  const layers = useMemo(() => new Set(layerList), [layerList]);
  const tfSec = TF_SECONDS[tf] ?? 300;
  const compact = size === 'compact';

  // ── The engine, on closed candles only ────────────────────────────────────
  const closed = closedBars(bars, tfSec, Math.floor(Date.now() / 1000));
  const lastClosed = closed[closed.length - 1];
  const closedKey = `${tf}:${closed.length}:${lastClosed?.time ?? 0}:${lastClosed?.close ?? 0}`;
  // Keyed on the closed candles, not the array: the forming candle changes every tick and must not re-run the engine.
  const smc = useMemo(() => runSmc(closed, { tfSec }), [closedKey]);
  const nowMin = Math.floor(Date.now() / 60_000);
  const overlays = useMemo(() => higher
    .filter((h) => h.tfSec > tfSec)
    .map((h) => {
      const hb = closedBars(h.bars, h.tfSec, nowMin * 60);
      return { tf: h.tf, tfSec: h.tfSec, bars: hb, state: runSmc(hb, { tfSec: h.tfSec }), show: h.show };
    }), [higher, tfSec, nowMin]);

  // ── What is drawn ─────────────────────────────────────────────────────────
  const base = useMemo<SceneItem[]>(() => {
    const items = buildScene(smc, closed, layers);
    if (layers.has('htf')) items.push(...htfScene(overlays, closed));
    if (layers.has('saved')) items.push(...savedBoxes(saved, bars));
    // The entry section's setup has its own on/off switch, so it is drawn whatever the layers say.
    if (entry) items.push(...entryScene(entry, bars));
    return items;
  }, [smc, layers, saved, bars.length, overlays, entry]);
  // The order-flow layers are kept apart from the engine's scene. The heatmap and the bubbles place
  // themselves by candle *time* only, so they are rebuilt when a candle is added or their data
  // arrives -- not on every tick of the forming candle, which only the volume profile follows.
  const timesKey = `${bars.length}:${bars[0]?.time ?? 0}:${bars[bars.length - 1]?.time ?? 0}`;
  const barsRef = useRef(bars);
  barsRef.current = bars;
  const heatItems = useMemo<SceneItem[]>(
    () => (layers.has('heatmap') && heat ? heatScene(heat.columns, heat.step, heat.walls, barsRef.current, tfSec) : []),
    [layers, heat, timesKey, tfSec],
  );
  const bigItems = useMemo<SceneItem[]>(
    () => (layers.has('bigtrades') && bigTrades ? bigTradeScene(bigTrades.prints, barsRef.current, tfSec, bigTrades.min) : []),
    [layers, bigTrades, timesKey, tfSec],
  );
  const profileItems = useMemo<SceneItem[]>(() => {
    if (!layers.has('profile') || !bars.length) return [];
    const to = Math.min(bars.length - 1, inView?.to ?? bars.length - 1);
    const from = Math.max(0, inView?.from ?? to - 90);
    // Each candle's taker-buy share from the recorded flow, where there is one: the profile splits by it.
    const split = new Map((flowBars ?? []).map((f) => [f.time, f.buy + f.sell > 0 ? f.buy / (f.buy + f.sell) : null]));
    const p = volumeProfile(bars, from, to, 48, (i) => split.get(bars[i]!.time) ?? null);
    return p ? profileScene(p, from, bars[bars.length - 1]!.close) : [];
  }, [layers, bars, inView, flowBars]);
  // Strike levels move with the board (every few seconds), not the tick; the price only picks which strikes are near.
  const nearPrice = Math.round((bars[bars.length - 1]?.close ?? 0) / 100) * 100;
  const strikeItems = useMemo<SceneItem[]>(
    () => (layers.has('options') && strikes && nearPrice ? strikeScene(strikes.legs, strikes.maxPain, nearPrice) : []),
    [layers, strikes, nearPrice],
  );
  const scene = useMemo(() => [...base, ...heatItems, ...strikeItems, ...profileItems, ...bigItems], [base, heatItems, strikeItems, profileItems, bigItems]);
  const vol = useMemo(() => volRegime(closed), [closedKey]);

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
    const primitive = new SmcPrimitive();
    candles.attachPrimitive(primitive);

    const onRange = (r: LogicalRange | null) => {
      if (!r) return;
      const from = Math.floor(r.from);
      const to = Math.ceil(r.to);
      setInView((v) => (v && v.from === from && v.to === to ? v : { from, to }));
    };
    chart.timeScale().subscribeVisibleLogicalRangeChange(onRange);

    chart.subscribeCrosshairMove((param) => {
      const text = param.point ? primitive.bubbleAt(param.point.x, param.point.y) : null;
      setTip((cur) => (text && param.point ? { x: param.point.x, y: param.point.y, text } : cur ? null : cur));
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
      chart.timeScale().unsubscribeVisibleLogicalRangeChange(onRange);
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

  // ── The delta / CVD pane, under the price, while its layer is on and there is flow ──
  const flowPaneRef = useRef<{ delta: ISeriesApi<'Histogram'>; cvd: ISeriesApi<'Line'> } | null>(null);
  const showFlow = layers.has('delta') && !!flowBars?.length;
  useLayoutEffect(() => {
    const chart = chartRef.current;
    if (!chart || !showFlow) return;
    const delta = chart.addSeries(HistogramSeries, {
      priceFormat: { type: 'volume' }, priceLineVisible: false, lastValueVisible: true, title: 'Δ',
    }, 1);
    // CVD on its own overlay scale: its level runs to tens of thousands, the delta's to hundreds.
    const cvd = chart.addSeries(LineSeries, {
      color: '#a78bfa', lineWidth: 2, priceScaleId: 'cvd', priceLineVisible: false, lastValueVisible: false, title: 'CVD',
    }, 1);
    chart.panes()[1]?.setStretchFactor(0.28);
    flowPaneRef.current = { delta, cvd };
    return () => {
      flowPaneRef.current = null;
      // The chart may already be gone (unmount removes it first); a removed chart must not be touched.
      if (chartRef.current !== chart) return;
      chart.removeSeries(delta);
      chart.removeSeries(cvd);
      if (chart.panes().length > 1) chart.removePane(1);
    };
  }, [showFlow, error, bars.length === 0]);

  useEffect(() => {
    const pane = flowPaneRef.current;
    if (!pane || !flowBars) return;
    const { delta, cvd } = deltaSeries(flowBars, tfSec, Math.floor(Date.now() / 1000));
    pane.delta.setData(delta.map((d) => ({ ...d, time: d.time as UTCTimestamp })));
    pane.cvd.setData(cvd.map((d) => ({ ...d, time: d.time as UTCTimestamp })));
  }, [flowBars, showFlow, tfSec, error, bars.length === 0]);

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

  const toggleLayer = (l: Layer) => setLayerList((cur) => (cur.includes(l) ? cur.filter((x) => x !== l) : [...cur, l]));
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
            <Popover>
              <PopoverTrigger asChild>
                <button type="button" className="pc-tool" aria-label="Layers" title="What the chart draws"><Layers size={14} /><span>Layers</span></button>
              </PopoverTrigger>
              <PopoverContent align="end" className="pc-layers">
                <div className="pc-presets" role="group" aria-label="Layer presets">
                  {LAYER_PRESETS.map((p) => {
                    const on = p.layers.length === layerList.length && p.layers.every((l) => layers.has(l));
                    return (
                      <button key={p.key} type="button" className={`pc-preset${on ? ' on' : ''}`} aria-pressed={on} title={p.title} onClick={() => setLayerList([...p.layers])}>
                        {p.label}
                      </button>
                    );
                  })}
                </div>
                {LAYERS.map(({ key, label, note }) => (
                  <label key={key} className="pc-layer">
                    <input type="checkbox" checked={layers.has(key)} onChange={() => toggleLayer(key)} />
                    <span>{label}{note && <small className="pc-layer-note">{note}</small>}</span>
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
          </div>}

          {tip && (
            <div className="pc-tip" role="tooltip" style={{ left: tip.x + 14, top: tip.y + 14 }}>
              {tip.text.split('\n').map((l, i) => <div key={i} className={i === 0 ? 'pc-tip-head' : ''}>{l}</div>)}
            </div>
          )}

          {!compact && <ChartHud
            ref={hudRef}
            open={hudOpen}
            onToggle={() => setHudOpen(!hudOpen)}
            tf={tf}
            context={context}
            derivs={derivs || vol ? { oi: derivs?.oi ?? null, funding: derivs?.funding ?? null, vol } : null}
            big={layers.has('bigtrades') && bigTrades && bars.length ? {
              ...bigTradeSummary(bigTrades.prints, bars, tfSec, bigTrades.min, inView?.from ?? bars.length - 90, inView?.to ?? bars.length - 1),
              min: bigTrades.min, basis: bigTrades.basis,
            } : null}
            candle={shown ? {
              ...shown, when: IST_FULL.format(shown.time * 1000), hovering: hover !== null,
              flow: flowBars?.length ? flowRead(flowBars, shown.time, tfSec, Math.floor(Date.now() / 1000)) : null,
            } : null}
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

