import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import * as Collapsible from '@radix-ui/react-collapsible';
import {
  CandlestickSeries, ColorType, CrosshairMode, HistogramSeries, createChart, createSeriesMarkers,
  type IChartApi, type ISeriesApi, type ISeriesMarkersPluginApi, type Time, type UTCTimestamp,
} from 'lightweight-charts';
import { ChevronDown, Expand, Lock, Maximize2, Minimize, Move } from 'lucide-react';
import { usePersisted } from '@/hooks/usePersisted';
import type { Candle } from '@/types/desk';
import { strike as fmtStrike } from '@/lib/format';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import {
  CALLOUT_H, CALLOUT_W, calloutShapes, lineShapes, zoneShapes,
  type Converters, type Projection, type StateMarker, type TrendLine, type Zone,
} from '@/components/desk/chart-overlay';

/**
 * BTC, drawn by `lightweight-charts`, read by the desk.
 *
 * The candles, the volume, the axes, the crosshair, the wheel, the pinch and
 * the pan are the library's -- they are solved problems and were a thousand
 * lines of our own SVG before (23 Sep 2026). What the library has no opinion
 * about is everything the desk knows: the level bands it judges a break
 * against, the lines through the last swings, the target callouts. Those are
 * laid out in `chart-overlay.ts` and drawn as one SVG over the canvas, in the
 * gutter the chart is told to keep clear to the right of the newest bar.
 *
 * The split is the point. The library owns pixels of price; the desk owns
 * meaning, on the server, and hands this component finished numbers.
 */

export type ChartTf = '1m' | '5m' | '15m' | '30m' | '1h' | '4h' | '1d';

/**
 * The one timeframe row on the screen.
 *
 * The chart had seven and the analysis beside it had five of its own, which is
 * two controls for one question -- and two answers the moment they disagree.
 * One row, the chart owns it, everything read off the chart follows it.
 */
export const CHART_TFS: readonly ChartTf[] = ['5m', '15m', '30m', '1h', '4h'];

/** Bars of empty plot kept to the right, where the callouts live. */
const RIGHT_BARS = 12;
/**
 * Bars on screen when the chart is first drawn.
 *
 * Ninety of them squeezed a five-minute chart's whole day onto the scale, and
 * the candles that matter -- the last couple of hours -- were a band an inch
 * tall in the middle of it. Sixty is about four hours on 5m, which fills the
 * height with bars somebody is actually deciding on; *Fit* still shows the lot.
 */
const OPENING_BARS = 60;

const IST_FULL = new Intl.DateTimeFormat('en-IN', {
  timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
});

const UP = '#26a17b';
const DOWN = '#e2504f';

export function PriceChart({
  bars, support, resistance, spot, zones = [], lines = [], projection = null,
  markers = [], trend = null, tf, onTf, loading = false, error,
}: {
  bars: Candle[];
  /** Heaviest put strike, or null when the board has no open interest to read. */
  support: number | null;
  /** Heaviest call strike. */
  resistance: number | null;
  spot: number;
  /** The bands the state engine judges a break against. */
  zones?: readonly Zone[];
  /** The lines through the last two swings each side, in bars back from the newest. */
  lines?: readonly TrendLine[];
  /** Where price goes if it goes, drawn in the right-hand gutter. */
  projection?: Projection | null;
  /** What happened, flagged on the bar it happened on. */
  markers?: readonly StateMarker[];
  /** Up, down or neither, in the header: the one word the chart is read for. */
  trend?: 'UP' | 'DOWN' | 'RANGE' | 'QUIET' | null;
  tf: ChartTf;
  onTf: (tf: ChartTf) => void;
  loading?: boolean;
  error?: string;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const volumeRef = useRef<ISeriesApi<'Histogram'> | null>(null);
  const markersRef = useRef<ISeriesMarkersPluginApi<Time> | null>(null);

  const [open, setOpen] = usePersisted('open:price-chart', true);
  const [full, setFull] = useState(false);
  /*
   * Zoom and pan are off until they are asked for. The chart sits in the
   * middle of a long scrolling page, so a wheel that always zooms is a wheel
   * that stops the page dead, and on a phone a drag over the plot would scroll
   * nothing at all. The choice is remembered, because somebody who wants it
   * wants it every time.
   */
  const [zoomOn, setZoomOn] = usePersisted('zoom:price-chart', false);
  /** The bar under the crosshair, for the header. */
  const [hover, setHover] = useState<Candle | null>(null);
  /** Bumped whenever the chart moves, so the overlay is recomputed. */
  const [moved, setMoved] = useState(0);
  const [size, setSize] = useState({ width: 0, height: 0 });

  const shown = hover ?? bars[bars.length - 1] ?? null;
  const previous = useMemo(() => {
    if (!shown) return null;
    const i = bars.findIndex((b) => b.time === shown.time);
    return i > 0 ? bars[i - 1]! : null;
  }, [bars, shown]);
  const change = shown && previous ? shown.close - previous.close : null;
  const changePct = change !== null && previous ? (change / previous.close) * 100 : null;

  // ---------------------------------------------------------------- the chart
  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host || !open || error) return;

    const chart = createChart(host, {
      width: host.clientWidth || 720,
      height: host.clientHeight || 360,
      layout: {
        // Its own dark ground rather than the card's: a transparent canvas
        // took whatever was behind it, so the grid, the wicks and the axis all
        // sat at a different contrast from every other dark panel on the desk.
        background: { type: ColorType.Solid, color: '#0c1219' },
        textColor: 'rgba(206, 216, 230, 0.85)',
        fontSize: 11,
        attributionLogo: false,
      },
      grid: {
        vertLines: { color: 'rgba(255,255,255,0.06)' },
        horzLines: { color: 'rgba(255,255,255,0.06)' },
      },
      // The candles get the height: a wide margin above and below is empty
      // chart, and empty chart is what makes a candle a smudge.
      rightPriceScale: { borderColor: 'rgba(255,255,255,0.14)', scaleMargins: { top: 0.06, bottom: 0.22 } },
      timeScale: {
        borderColor: 'rgba(255,255,255,0.14)',
        timeVisible: true,
        secondsVisible: false,
        // The gutter the callouts live in: without it the newest candle is
        // drawn hard against the axis, under its own price tag.
        rightOffset: RIGHT_BARS,
        barSpacing: 8,
      },
      crosshair: { mode: CrosshairMode.Normal },
      handleScroll: zoomOn,
      handleScale: zoomOn,
      localization: {
        locale: 'en-IN',
        timeFormatter: (t: Time) => IST_FULL.format(Number(t) * 1000),
        // 84800.00 on the axis is two digits of noise on a number nobody
        // trades to the cent: BTC is quoted whole here, as it is everywhere
        // else on the desk.
        priceFormatter: (p: number) => Math.round(p).toLocaleString('en-US'),
      },
    });

    const candles = chart.addSeries(CandlestickSeries, {
      upColor: UP, downColor: DOWN, borderUpColor: UP, borderDownColor: DOWN,
      wickUpColor: UP, wickDownColor: DOWN,
      priceFormat: { type: 'price', precision: 0, minMove: 1 },
    });
    const volume = chart.addSeries(HistogramSeries, {
      priceFormat: { type: 'volume' },
      priceScaleId: 'volume',
      // The volume's own last value on the price axis is a number in the wrong
      // units sitting among prices, in the corner where the newest bar is.
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
  }, [open, error]);

  // Zoom and pan follow the lock, without tearing the chart down.
  useEffect(() => {
    chartRef.current?.applyOptions({ handleScroll: zoomOn, handleScale: zoomOn });
  }, [zoomOn]);

  // ----------------------------------------------------------------- the data
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

  // A new timeframe is a new series: show the same readable window again.
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || !bars.length) return;
    const last = bars.length - 1;
    chart.timeScale().setVisibleLogicalRange({ from: Math.max(0, last - OPENING_BARS), to: last + RIGHT_BARS });
  }, [tf, bars.length === 0]);

  /*
   * Nothing is drawn as a price line any more.
   *
   * Spot was, and it produced two labels on the axis a few dollars apart --
   * the yellow spot tag sitting on top of the series' own last-price tag, both
   * saying essentially the same number, both over the callouts. The candle
   * series already marks where price is. The open-interest walls are named
   * under the chart, and the levels that matter are the shaded bands.
   */

  /*
   * The flags on the candles: what the desk called, and what it saw.
   *
   * The library draws these, not the overlay, because a marker has to move
   * with its bar through every pan and zoom -- an SVG flag would need
   * repositioning on every frame and would drift on the one frame it missed.
   */
  useEffect(() => {
    markersRef.current?.setMarkers(markers.map((m) => ({
      time: m.time as UTCTimestamp,
      position: m.above ? 'aboveBar' : 'belowBar',
      shape: m.above ? 'arrowDown' : 'arrowUp',
      color: m.tone === 'up' ? UP : DOWN,
      text: m.label,
    })));
  }, [markers, bars.length === 0, open, error]);

  // --------------------------------------------------------------- the overlay
  const overlay = useMemo(() => {
    const chart = chartRef.current;
    const candles = candleRef.current;
    if (!chart || !candles || !bars.length || !size.width || !size.height) return null;
    // `moved` is the dependency that matters: every pan, zoom and resize.
    void moved;
    const priceH = size.height * 0.74;
    const c: Converters = {
      width: size.width,
      height: priceH,
      // The axis is where a number is checked; a box across it hides the very
      // prices it quotes. `width()` is what the library actually reserved.
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
    return {
      zones: zoneShapes(zones, c),
      lines: lineShapes(lines, c),
      callouts: calloutShapes(projection, spot, c),
      width: size.width,
      height: size.height,
    };
  }, [zones, lines, projection, spot, bars, size, moved]);

  return (
    <Collapsible.Root ref={cardRef} open={open} onOpenChange={setOpen}
      className={`price-chart${full ? ' is-full' : ''}`}>
      <div className="price-chart-head">
        <div className="price-chart-headline">
          <Collapsible.Trigger className="price-chart-title" aria-label="price chart">
            <ChevronDown className={`smr-chev${open ? '' : ' shut'}`} size={13} aria-hidden />
            BTC <span className="price-chart-dot" aria-hidden>•</span> {tf === '1d' ? '1D' : tf}
          </Collapsible.Trigger>

          {/* One word for what the chart is doing, which is what it is opened
              to find out. It is the regime the state engine measured, not a
              second guess made here. */}
          {trend ? (
            <span className={`price-chart-trend is-${trend.toLowerCase()}`}>
              {trend === 'UP' ? '↗ Uptrend' : trend === 'DOWN' ? '↘ Downtrend'
                : trend === 'QUIET' ? '→ Quiet' : '↔ Range'}
            </span>
          ) : null}

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

        <div className="price-chart-controls">
          <ToggleGroup type="single" value={tf} onValueChange={(v) => v && onTf(v as ChartTf)}
            aria-label="chart timeframe">
            {CHART_TFS.map((t) => (
              <ToggleGroupItem key={t} value={t}>{t === '1d' ? '1D' : t}</ToggleGroupItem>
            ))}
          </ToggleGroup>

          <div className="price-chart-tools" role="group" aria-label="zoom">
            <button type="button" className={`chain-chip${zoomOn ? ' on' : ''}`} aria-pressed={zoomOn}
              aria-label={zoomOn ? 'Zoom on' : 'Zoom off'}
              title={zoomOn
                ? 'Zoom and pan are on: scroll or pinch to zoom, drag to pan. Turn off to scroll the page over the chart.'
                : 'Zoom and pan are off, so the page scrolls over the chart.'}
              onClick={() => setZoomOn(!zoomOn)}>
              {zoomOn ? <Move size={13} aria-hidden /> : <Lock size={13} aria-hidden />}
            </button>
            <button type="button" className="chain-chip" aria-label="fit" title="Back to the whole series"
              onClick={() => chartRef.current?.timeScale().fitContent()}>
              <Maximize2 size={12} aria-hidden /> Fit
            </button>
            <button type="button" className="chain-chip" aria-label={full ? 'exit full screen' : 'full screen'}
              title={full ? 'Exit full screen' : 'Full screen'} onClick={() => setFull((v) => !v)}>
              {full ? <Minimize size={13} aria-hidden /> : <Expand size={13} aria-hidden />}
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
                    <path d="M 0 0 L 8 4 L 0 8 z" fill={UP} />
                  </marker>
                  <marker id="pc-arrow-down" viewBox="0 0 8 8" refX="6" refY="4" markerWidth="5" markerHeight="5" orient="auto">
                    <path d="M 0 0 L 8 4 L 0 8 z" fill={DOWN} />
                  </marker>
                </defs>

                {overlay.zones.map((z) => {
                  const colour = z.tone === 'up' ? DOWN : UP;
                  return (
                    <g key={z.label} data-zone={z.label}>
                      <rect x={0} y={z.top} width={overlay.width} height={z.height} fill={colour} opacity="0.16" />
                      <line x1={0} x2={overlay.width} y1={z.edge} y2={z.edge} stroke={colour}
                        strokeWidth="1.3" strokeDasharray="6 4" opacity="0.95" />
                      {/* Inside the band where it is deep enough to hold the
                          words, just outside where it is not. */}
                      {!z.labelInside && (
                        <rect x={6} y={z.tagY} width={124} height={28} rx={4} fill="rgba(10,16,24,0.92)"
                          stroke={colour} strokeWidth="0.8" />
                      )}
                      <text x={z.labelInside ? 14 : 12} y={z.tagY + 13} fontSize="11" fontWeight="600" fill={colour}>
                        {z.label}
                      </text>
                      <text x={z.labelInside ? 14 : 12} y={z.tagY + 25} fontSize="11" fill="rgba(226,235,245,0.92)">
                        {fmtStrike(Math.round(z.low))} – {fmtStrike(Math.round(z.high))}
                      </text>
                    </g>
                  );
                })}

                {/* Drawn in a neutral white rather than in the up and down
                    colours: they are where the swings were, not a call on
                    which way it goes, and two more green and red lines over
                    green and red candles is noise. */}
                {overlay.lines.map((l, i) => (
                  <line key={`trend-${i}`} data-trend={l.kind} x1={l.x1} y1={l.y1} x2={l.x2} y2={l.y2}
                    stroke="rgba(236,243,250,0.8)" strokeWidth="1.8" strokeLinecap="round" />
                ))}

                {overlay.callouts.map((c) => {
                  const colour = c.key === 'up' ? UP : c.key === 'down' ? DOWN : 'rgba(190,200,215,0.8)';
                  const h = c.key === 'range' ? 34 : CALLOUT_H;
                  return (
                    <g key={c.key} data-leg={c.key}>
                      {c.key !== 'range' && (
                        <path d={`M ${c.x - 40} ${c.fromY} Q ${c.x - 18} ${c.fromY} ${c.x - 6} ${c.y}`}
                          fill="none" stroke={colour} strokeWidth="1.6" opacity="0.85"
                          markerEnd={`url(#pc-arrow-${c.key})`} />
                      )}
                      <rect x={c.x} y={c.y - h / 2} width={CALLOUT_W} height={h} rx={6}
                        fill="rgba(10,16,24,0.96)" stroke={colour} strokeWidth="1.2" />
                      <text x={c.x + 10} y={c.y - h / 2 + 16} fontSize="11.5" fontWeight="600"
                        fill={c.key === 'range' ? 'rgba(206,216,230,0.95)' : colour}>{c.title}</text>
                      {c.key === 'range' ? (
                        <text x={c.x + 10} y={c.y + 10} fontSize="11.5" fill="rgba(226,235,245,0.95)">
                          {fmtStrike(Math.round(c.low ?? 0))} – {fmtStrike(Math.round(c.high ?? 0))}
                        </text>
                      ) : (
                        <>
                          <text x={c.x + 10} y={c.y + 5} fontSize="11" fill="rgba(190,200,215,0.85)">Target</text>
                          <text x={c.x + CALLOUT_W - 10} y={c.y + 5} fontSize="12" textAnchor="end"
                            fill="rgba(232,240,248,1)">
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

        {/* The open-interest walls, said rather than drawn: they are where the
            board's open interest sits, not where BTC will settle, and a line
            through the candles claims more than that. */}
        <p className="price-chart-note">
          <span>
            OI walls · support{' '}
            <b>{support === null ? '—' : fmtStrike(support)}</b> (heaviest put strike) · resistance{' '}
            <b>{resistance === null ? '—' : fmtStrike(resistance)}</b> (heaviest call strike) — where open
            interest sits, not where BTC will settle
          </span>
          <span>
            times IST · {zoomOn ? 'scroll or pinch to zoom, drag to pan' : 'zoom is off, so the page scrolls over the chart'}
          </span>
        </p>
      </Collapsible.Content>
    </Collapsible.Root>
  );
}
