import { useEffect, useMemo, useRef, useState } from 'react';
import * as Collapsible from '@radix-ui/react-collapsible';
import { ChevronDown, Maximize2 } from 'lucide-react';
import { usePersisted } from '@/hooks/usePersisted';
import type { Candle } from '@/types/desk';
import { strike as fmtStrike } from '@/lib/format';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';

export type ChartTf = '1m' | '5m' | '15m' | '1h' | '4h' | '1d';

export const CHART_TFS: readonly ChartTf[] = ['1m', '5m', '15m', '1h', '4h', '1d'];

const W = 780;
const H = 360;
const PAD = { top: 10, right: 74, bottom: 26, left: 8 };
/** The bottom fifth is volume. Price gets the rest. */
const VOL_SHARE = 0.2;
const GAP = 8;

/** Fewer than this and the bars are wider than they are tall. */
const MIN_BARS = 12;

const IST = (opts: Intl.DateTimeFormatOptions) =>
  new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', ...opts });
const IST_TIME = IST({ hour: '2-digit', minute: '2-digit', hour12: false });
const IST_DAY = IST({ day: 'numeric', month: 'short' });
const IST_FULL = IST({ day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false });

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** What part of the series is on screen, and how hard the price axis is stretched. */
export type View = { from: number; count: number; yZoom: number };

/**
 * The window after one notch of the wheel, anchored where the pointer is.
 *
 * Pulled out of the handler and exported so it can be tested: jsdom gives every
 * element a zero-width bounding box, so a wheel event dispatched at a test
 * never resolves to a position on the plot and the whole interaction is
 * untestable through the DOM. The arithmetic is the part that can be wrong.
 */
export function zoomHorizontally(
  win: { from: number; count: number; yZoom: number },
  total: number,
  o: { anchor: number; out: boolean },
): View {
  const floor = Math.min(MIN_BARS, total);
  const count = clamp(Math.round(win.count * (o.out ? 1.15 : 0.87)), floor, total);
  const keep = win.from + o.anchor * win.count;
  return {
    count,
    yZoom: win.yZoom,
    from: clamp(Math.round(keep - o.anchor * count), 0, Math.max(0, total - count)),
  };
}

/** The price scale after one notch. Clamped so it can always be read back. */
export const zoomVertically = (win: View, out: boolean): View =>
  ({ ...win, yZoom: clamp(win.yZoom * (out ? 0.9 : 1.1), 0.4, 8) });

/**
 * Recent BTC, with the two open-interest walls drawn against it.
 *
 * The walls are the reason this chart is here. `structure.ts` has always known
 * where the heaviest put and call strikes sit, and the number alone
 * ("resistance 80,000") says nothing about whether BTC is anywhere near it.
 *
 * ## Why the scale is price's, not the walls'
 *
 * The first version stretched the scale to reach both walls, so nothing was
 * ever clipped. On a real board that meant a 74,400–80,000 axis for a day that
 * traded 76,000–78,000, and every candle collapsed into a band a few pixels
 * tall — legible about the walls and useless about price, which is backwards.
 * The scale belongs to the bars *on screen*, and a wall outside it is pinned to
 * the edge with an arrow and how far away it is. Nothing is hidden.
 *
 * ## Zoom
 *
 * Horizontally: the wheel over the plot zooms about the cursor, a drag pans,
 * and on a phone one finger pans. Vertically: the wheel over the price axis, or
 * shift and the wheel anywhere, stretches the price scale about the middle of
 * what is showing. Double-click, or Fit, puts both back.
 *
 * The vertical default is to fit whatever is on screen, which is what every
 * charting tool does and the only default that keeps a quiet hour readable
 * inside a violent day.
 *
 * What it is not: a signal. Open interest is positioning, and every attempt to
 * trade it failed the cross-period screen — see TODO.md.
 */
export function PriceChart({
  bars,
  support,
  resistance,
  spot,
  expectedMove = null,
  tf,
  onTf,
  loading = false,
  error,
}: {
  bars: Candle[];
  /** Heaviest put strike, or null when the board has no open interest to read. */
  support: number | null;
  /** Heaviest call strike. */
  resistance: number | null;
  spot: number;
  /** ± this much by settlement, shaded behind the candles. */
  expectedMove?: number | null;
  tf: ChartTf;
  onTf: (tf: ChartTf) => void;
  loading?: boolean;
  error?: string;
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  const [open, setOpen] = usePersisted('open:price-chart', true);

  /** Null means "all of it, fitted" — where a fresh load and a reset sit. */
  const [view, setView] = useState<View | null>(null);
  const drag = useRef<{ x: number; from: number } | null>(null);

  // A new timeframe is a new series; a window into the old one would land you
  // somewhere arbitrary in it.
  useEffect(() => { setView(null); }, [tf]);

  const win = useMemo(() => {
    if (!bars.length) return null;
    const count = clamp(view?.count ?? bars.length, Math.min(MIN_BARS, bars.length), bars.length);
    const from = clamp(view?.from ?? bars.length - count, 0, Math.max(0, bars.length - count));
    return { from, count, slice: bars.slice(from, from + count), yZoom: view?.yZoom ?? 1 };
  }, [bars, view]);

  const geom = useMemo(() => {
    if (!win || !win.slice.length) return null;
    const shown = win.slice;

    // The scale is what is on screen, plus the spot line which is always near it.
    const lo0 = Math.min(...shown.map((b) => b.low), spot);
    const hi0 = Math.max(...shown.map((b) => b.high), spot);
    const mid = (lo0 + hi0) / 2;
    const half = (((hi0 - lo0) / 2) || 1) * 1.08 / win.yZoom;
    const lo = mid - half;
    const hi = mid + half;

    const plotW = W - PAD.left - PAD.right;
    const plotH = H - PAD.top - PAD.bottom;
    const volH = plotH * VOL_SHARE;
    const priceH = plotH - volH - GAP;

    const y = (p: number) => PAD.top + ((hi - p) / (hi - lo)) * priceH;
    const step = plotW / shown.length;
    const x = (i: number) => PAD.left + i * step + step / 2;
    const bodyW = Math.max(1, Math.min(11, step * 0.66));

    const maxVol = Math.max(...shown.map((b) => b.volume), 1);
    const volTop = PAD.top + priceH + GAP;
    const volY = (v: number) => volTop + volH - (v / maxVol) * volH;

    const ticks: number[] = [];
    const rough = (hi - lo) / 4;
    const mag = Math.pow(10, Math.floor(Math.log10(rough)));
    const stepPrice = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((sp) => sp >= rough) ?? rough;
    for (let p = Math.ceil(lo / stepPrice) * stepPrice; p <= hi; p += stepPrice) ticks.push(p);

    const timeTicks = [0, Math.floor(shown.length / 3), Math.floor((shown.length * 2) / 3), shown.length - 1]
      .filter((i, n, a) => i >= 0 && a.indexOf(i) === n)
      .map((i) => ({ i, bar: shown[i]! }));

    return { shown, lo, hi, y, x, step, bodyW, ticks, timeTicks, volY, volTop, volH, priceH };
  }, [win, spot]);

  /**
   * Where a level is drawn: on the axis if the scale reaches it, pinned inside
   * the price area's edge if it does not.
   *
   * Well inside, not on the edge. At 7px the bottom pin, the volume baseline
   * and the lowest gridline label all landed within a few pixels of each other
   * and drew over one another.
   */
  const levelY = (value: number): number | null => {
    if (!geom) return null;
    if (value >= geom.lo && value <= geom.hi) return geom.y(value);
    return value > geom.hi ? PAD.top + 11 : PAD.top + geom.priceH - 11;
  };

  /** Every level's tag position, so a price label never draws under one. */
  const pinned = geom
    ? [support, resistance, spot]
        .filter((v): v is number => v !== null)
        .map(levelY)
        .filter((v): v is number => v !== null)
    : [];

  const level = (value: number, colour: string, label: string) => {
    if (!geom) return null;
    const inside = value >= geom.lo && value <= geom.hi;
    const yPos = levelY(value)!;
    const away = ((value - spot) / spot) * 100;
    const text = inside ? label : `${value > geom.hi ? '▲' : '▼'} ${label}`;
    return (
      <g>
        <line
          x1={PAD.left} x2={W - PAD.right} y1={yPos} y2={yPos}
          stroke={colour} strokeWidth={inside ? 1.5 : 1} strokeDasharray={inside ? '6 4' : '2 4'}
          opacity={inside ? 1 : 0.65}
        />
        <rect x={W - PAD.right + 3} y={yPos - 8} width={PAD.right - 6} height="16" rx="3" fill={colour} />
        <text
          x={W - PAD.right + 3 + (PAD.right - 6) / 2} y={yPos + 4}
          textAnchor="middle" fontSize="10.5" fontWeight="600" fill="var(--bg)"
        >
          {text}
        </text>
        {!inside && (
          <text
            x={PAD.left + 4}
            y={value > geom.hi ? yPos + 15 : yPos - 7}
            fontSize="10" fill={colour} opacity="0.85"
          >
            {label} · {Math.abs(away).toFixed(1)}% away, off the scale
          </text>
        )}
      </g>
    );
  };

  /** Viewport x for a client x, so zoom happens about the pointer. */
  const vx = (clientX: number): number | null => {
    const el = svgRef.current;
    if (!el) return null;
    const box = el.getBoundingClientRect();
    if (!box.width) return null;
    return ((clientX - box.left) / box.width) * W;
  };

  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    if (!geom || !win) return;
    const at = vx(e.clientX);
    if (at === null) return;

    if (drag.current) {
      const moved = Math.round((drag.current.x - at) / geom.step);
      setView({
        count: win.count,
        yZoom: win.yZoom,
        from: clamp(drag.current.from + moved, 0, Math.max(0, bars.length - win.count)),
      });
      return;
    }

    const i = Math.round((at - PAD.left - geom.step / 2) / geom.step);
    setHover(i >= 0 && i < geom.shown.length ? i : null);
  };

  /*
   * Held in a ref and attached natively, because React's `onWheel` lands in a
   * passive listener and `preventDefault` inside one does nothing: the page
   * scrolled, and with ctrl held the whole browser zoomed, while the chart
   * zoomed underneath it. A chart that moves the page it is on is unusable.
   */
  const wheelRef = useRef<(e: WheelEvent) => void>(() => {});
  wheelRef.current = (e: WheelEvent) => {
    if (!win || !bars.length) return;
    const at = vx(e.clientX);
    if (at === null) return;
    e.preventDefault();

    // Over the price axis, or with shift held: the price scale stretches.
    if (at > W - PAD.right || e.shiftKey) {
      setView(zoomVertically(win, e.deltaY > 0));
      return;
    }

    // Otherwise the window narrows or widens about whatever is under the cursor.
    const anchor = clamp((at - PAD.left) / (W - PAD.left - PAD.right), 0, 1);
    setView(zoomHorizontally(win, bars.length, { anchor, out: e.deltaY > 0 }));
  };

  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const on = (e: WheelEvent) => wheelRef.current(e);
    el.addEventListener('wheel', on, { passive: false });
    return () => el.removeEventListener('wheel', on);
    // Re-bound whenever the element appears or goes: the chart unmounts behind
    // the fold and on a feed error, and a listener on a detached node is a leak.
  }, [open, error, bars.length === 0]);

  const onDown = (e: React.PointerEvent<SVGSVGElement>) => {
    if (!win) return;
    const at = vx(e.clientX);
    if (at === null || at > W - PAD.right) return;
    drag.current = { x: at, from: win.from };
    svgRef.current?.setPointerCapture?.(e.pointerId);
  };

  const endDrag = (e: React.PointerEvent<SVGSVGElement>) => {
    drag.current = null;
    svgRef.current?.releasePointerCapture?.(e.pointerId);
  };

  const shown = hover !== null && geom ? geom.shown[hover] : geom?.shown.at(-1);
  const shownUp = shown ? shown.close >= shown.open : true;
  const zoomed = view !== null;

  return (
    <Collapsible.Root open={open} onOpenChange={setOpen} className="price-chart">
      <div className="price-chart-head">
        <Collapsible.Trigger className="price-chart-title" aria-label="price chart">
          <ChevronDown className={`smr-chev${open ? '' : ' shut'}`} size={13} aria-hidden />
          BTC · {tf === '1d' ? 'daily' : tf}
          {support !== null && resistance !== null && (
            <span className="dim"> · walls {fmtStrike(support)}–{fmtStrike(resistance)}</span>
          )}
        </Collapsible.Trigger>

        {zoomed && (
          <button type="button" className="chain-chip" onClick={() => setView(null)}>
            <Maximize2 size={12} aria-hidden /> Fit
          </button>
        )}

        <ToggleGroup
          type="single"
          value={tf}
          onValueChange={(v) => v && onTf(v as ChartTf)}
          aria-label="chart timeframe"
        >
          {CHART_TFS.map((t) => (
            <ToggleGroupItem key={t} value={t}>{t === '1d' ? '1D' : t}</ToggleGroupItem>
          ))}
        </ToggleGroup>
      </div>

      <Collapsible.Content>
      {/* The bar under the pointer, or the last one — always saying which. */}
      {shown && !error && (
        <div className="price-chart-ohlc">
          <span className="dim">{hover === null ? 'last' : IST_FULL.format(shown.time * 1000)}</span>
          <span>O <b>{fmtStrike(Math.round(shown.open))}</b></span>
          <span>H <b>{fmtStrike(Math.round(shown.high))}</b></span>
          <span>L <b>{fmtStrike(Math.round(shown.low))}</b></span>
          <span>C <b className={shownUp ? 'up' : 'down'}>{fmtStrike(Math.round(shown.close))}</b></span>
          {win && <span className="dim">{win.count} of {bars.length} bars</span>}
        </div>
      )}

      {error ? (
        <div className="note" style={{ padding: '10px 12px', margin: 0 }}>
          The price feed did not answer, so the chart is empty. Everything below still reads
          from the chain.
        </div>
      ) : !geom ? (
        <div className="price-chart-empty">{loading ? 'Loading bars…' : 'No bars for this range.'}</div>
      ) : (
        <svg
          ref={svgRef}
          viewBox={`0 0 ${W} ${H}`}
          className="price-chart-svg"
          role="img"
          onPointerMove={onMove}
          onPointerDown={onDown}
          onPointerUp={endDrag}
          onPointerLeave={(e) => { endDrag(e); setHover(null); }}
          onDoubleClick={() => setView(null)}
          aria-label={`BTC ${tf} candles, ${geom.shown.length} of ${bars.length} bars shown, with open-interest walls at ${support ?? '—'} and ${resistance ?? '—'}`}
        >
          {geom.ticks.map((p) => (
            <g key={p}>
              <line
                x1={PAD.left} x2={W - PAD.right} y1={geom.y(p)} y2={geom.y(p)}
                stroke="var(--line-soft)" strokeWidth="1"
              />
              <text
                x={W - PAD.right + 6} y={geom.y(p) + 4}
                fontSize="10.5" fill="var(--dim)"
                /* The level tags own the right-hand gutter; a price label under
                   one is unreadable, so it gives way rather than overlapping. */
                opacity={pinned.some((q) => Math.abs(q - geom.y(p)) < 11) ? 0 : 1}
              >
                {fmtStrike(Math.round(p))}
              </text>
            </g>
          ))}

          {/*
            What the options are pricing, behind what BTC has done. Drawn first
            so the candles sit on top of it: it is the backdrop the bars are
            read against, not a mark of its own.
          */}
          {expectedMove !== null && expectedMove > 0 && (
            <g>
              <rect
                x={PAD.left}
                y={Math.max(PAD.top, geom.y(spot + expectedMove))}
                width={W - PAD.right - PAD.left}
                height={Math.max(
                  0,
                  Math.min(PAD.top + geom.priceH, geom.y(spot - expectedMove))
                    - Math.max(PAD.top, geom.y(spot + expectedMove)),
                )}
                fill="var(--accent)"
                opacity="0.055"
              />
              <text x={PAD.left + 4} y={PAD.top + geom.priceH - 4} fontSize="9.5" fill="var(--dim)">
                shaded: ±${Math.round(expectedMove).toLocaleString()} expected by expiry
              </text>
            </g>
          )}

          {/* volume, under its own baseline */}
          <line
            x1={PAD.left} x2={W - PAD.right} y1={geom.volTop + geom.volH} y2={geom.volTop + geom.volH}
            stroke="var(--line)" strokeWidth="1"
          />
          {geom.shown.map((b, i) => (
            <rect
              key={`v${b.time}`}
              x={geom.x(i) - geom.bodyW / 2}
              y={geom.volY(b.volume)}
              width={geom.bodyW}
              height={Math.max(0.5, geom.volTop + geom.volH - geom.volY(b.volume))}
              fill={b.close >= b.open ? 'var(--up)' : 'var(--down)'}
              opacity="0.32"
            />
          ))}

          {/* candles */}
          {geom.shown.map((b, i) => {
            const colour = b.close >= b.open ? 'var(--up)' : 'var(--down)';
            const top = geom.y(Math.max(b.open, b.close));
            const bottom = geom.y(Math.min(b.open, b.close));
            return (
              <g key={b.time}>
                <line
                  x1={geom.x(i)} x2={geom.x(i)} y1={geom.y(b.high)} y2={geom.y(b.low)}
                  stroke={colour} strokeWidth="1"
                />
                <rect
                  x={geom.x(i) - geom.bodyW / 2}
                  y={top}
                  width={geom.bodyW}
                  height={Math.max(1, bottom - top)}
                  fill={colour}
                  rx={geom.bodyW > 5 ? 1 : 0}
                />
              </g>
            );
          })}

          {support !== null && level(support, 'var(--up)', fmtStrike(support))}
          {resistance !== null && level(resistance, 'var(--down)', fmtStrike(resistance))}
          {level(spot, 'var(--accent)', fmtStrike(Math.round(spot)))}

          {/* crosshair */}
          {hover !== null && geom.shown[hover] && (
            <g pointerEvents="none">
              <line
                x1={geom.x(hover)} x2={geom.x(hover)} y1={PAD.top} y2={geom.volTop + geom.volH}
                stroke="var(--muted)" strokeWidth="1" strokeDasharray="3 3"
              />
              <line
                x1={PAD.left} x2={W - PAD.right}
                y1={geom.y(geom.shown[hover]!.close)} y2={geom.y(geom.shown[hover]!.close)}
                stroke="var(--muted)" strokeWidth="1" strokeDasharray="3 3"
              />
            </g>
          )}

          {geom.timeTicks.map(({ i, bar }) => (
            <text
              key={bar.time}
              x={geom.x(i)}
              y={H - 8}
              fontSize="10.5"
              fill="var(--dim)"
              textAnchor={i === 0 ? 'start' : i === geom.shown.length - 1 ? 'end' : 'middle'}
            >
              {tf === '1d' ? IST_DAY.format(bar.time * 1000) : IST_TIME.format(bar.time * 1000)}
            </text>
          ))}
        </svg>
      )}

      <div className="price-chart-key">
        <span><i style={{ background: 'var(--up)' }} /> support · heaviest put strike</span>
        <span><i style={{ background: 'var(--down)' }} /> resistance · heaviest call strike</span>
        <span className="dim">
          scroll to zoom · drag to pan · shift-scroll or the price axis for the price scale ·
          double-click to fit
        </span>
        <span className="dim">where open interest sits, not where BTC will settle · times IST</span>
      </div>
      </Collapsible.Content>
    </Collapsible.Root>
  );
}
