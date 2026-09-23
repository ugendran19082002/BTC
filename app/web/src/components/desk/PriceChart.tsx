import { useEffect, useMemo, useRef, useState } from 'react';
import * as Collapsible from '@radix-ui/react-collapsible';
import { ChevronDown, Expand, Maximize2, Minimize, Minus, Move, Lock, Plus } from 'lucide-react';
import { usePersisted } from '@/hooks/usePersisted';
import type { Candle } from '@/types/desk';
import { strike as fmtStrike } from '@/lib/format';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';

export type ChartTf = '1m' | '5m' | '15m' | '30m' | '1h' | '4h' | '1d';

export const CHART_TFS: readonly ChartTf[] = ['1m', '5m', '15m', '30m', '1h', '4h', '1d'];

/**
 * The canvas is drawn at the size it is shown.
 *
 * It used to be a fixed 780x360 viewBox scaled to fit, which on a 360-pixel
 * phone shrank every label to under five pixels and every wick to a hair --
 * responsive in the sense of fitting, unreadable in every other. The width now
 * follows the card and the height follows the width, so text is drawn at text
 * size on every screen. `DEFAULT_W` is what a chart that has not been measured
 * yet (and every test) draws at.
 */
const DEFAULT_W = 780;
const MIN_W = 320;
const sizeFor = (width: number, tallest = 360) => {
  const W = Math.max(MIN_W, Math.round(width) || DEFAULT_W);
  // A wide card beside the summary gets a taller plot, so the chart fills the row
  // rather than leaving a gap under it; the default width keeps the usual cap.
  const cap = W >= 900 ? Math.max(tallest, 440) : tallest;
  return { W, H: clamp(Math.round(W * 0.46), 250, cap) };
};
const PAD = { top: 10, right: 74, bottom: 26, left: 8 };
/**
 * Empty plot kept to the right of the newest bar.
 *
 * Without it the last candle is drawn hard against the price axis and its own
 * price tag, which is where the eye goes first and the one bar that most wants
 * room around it. Every charting tool leaves this gap; levels and gridlines
 * still run the full width into the axis, so nothing is shortened but the bars.
 */
const RIGHT_GAP = 26;
/** The bottom fifth is volume. Price gets the rest. */
const VOL_SHARE = 0.2;
const GAP = 8;

/** Fewer than this and the bars are wider than they are tall. */
const MIN_BARS = 12;

/**
 * How wide a candle has to be before it is a candle.
 *
 * Under about nine pixels the body, the two wicks and the gap beside it stop
 * being separate things and the chart reads as a smear of colour.
 */
const BAR_W = 9;

/**
 * How many bars a chart nobody has zoomed shows: as many as fit at a readable
 * width, newest first.
 *
 * It used to open on the whole series -- 432 five-minute candles across six
 * hundred pixels, which is more than one bar per pixel. Every bar was on
 * screen and not one of them could be read, which is the wrong trade for a
 * chart somebody is deciding on. The rest is one press of Whole series away,
 * and zooming out still reaches it.
 */
export const barsThatFit = (plotW: number, total: number) =>
  clamp(Math.floor(plotW / BAR_W), Math.min(MIN_BARS, total), total);

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

/**
 * The price scale after one notch.
 *
 * `floor` is how far out this particular chart may be pulled — far enough to
 * bring its walls onto the scale, which on a quiet hour is a long way past the
 * 0.4 that used to be hard-coded here.
 */
export const zoomVertically = (win: View, out: boolean, floor = 0.4): View =>
  ({ ...win, yZoom: clamp(win.yZoom * (out ? 0.9 : 1.1), Math.min(floor, 0.4), 8) });

/**
 * The window after the + or − button.
 *
 * Anchored on the newest bar while the newest bar is on screen -- that is the
 * bar somebody pressing + wants a closer look at -- and on the middle of the
 * window once it has been panned back into history, where "newest on screen"
 * is nothing in particular.
 */
export function zoomByButton(win: View, total: number, out: boolean): View {
  const atLatest = win.from + win.count >= total;
  return zoomHorizontally(win, total, { anchor: atLatest ? 1 : 0.5, out });
}

/**
 * The window under a pinch: the bars between two fingers stay between them.
 *
 * `anchor` is where the pinch began, as a fraction of the plot; `ratio` is the
 * fingers' starting distance over their distance now, so spreading them (ratio
 * under 1) shows fewer bars. Measured from the pinch's start rather than step
 * by step, so a gesture that returns to where it began returns the window too.
 */
export function pinchZoom(start: View, total: number, o: { anchor: number; ratio: number }): View {
  const floor = Math.min(MIN_BARS, total);
  const count = clamp(Math.round(start.count * o.ratio), floor, total);
  const keep = start.from + o.anchor * start.count;
  return {
    count,
    yZoom: start.yZoom,
    from: clamp(Math.round(keep - o.anchor * count), 0, Math.max(0, total - count)),
  };
}

/**
 * The price scale under a drag on the axis: down stretches it out, up pulls it
 * in, the way every charting tool's axis works. `dy` is in canvas pixels from
 * where the drag began; a hundred of them is one e-fold, so the height of a
 * phone's plot pulls the scale out far enough to reach the walls.
 */
export const stretchByDrag = (start: View, dy: number, floor = 0.4): View =>
  ({ ...start, yZoom: clamp(start.yZoom * Math.exp(-dy / 100), Math.min(floor, 0.4), 8) });

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
 * The + and − buttons always work, and need nothing turned on: they zoom about
 * the newest bar, which is the one thing everyone wants a closer look at. The
 * gestures need zoom armed, because they fight the page otherwise: the wheel
 * over the plot zooms about the cursor, a drag pans, a pinch zooms about the
 * fingers, and a drag on the price axis (or shift and the wheel, or the wheel
 * over the axis) stretches the price scale. Double-click or double-tap, or
 * Fit, puts everything back.
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
  levels = [],
  zones = [],
  projection = null,
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
  /** Other levels worth a thin line: previous day's high and low, the session's, max pain. Drawn only when on the scale. */
  levels?: readonly { price: number; label: string; colour?: string }[];
  /**
   * The bands the market-state card is judging price against, shaded behind
   * the candles: the resistance it is pushing at and the support under it.
   *
   * A band rather than a line on purpose. A level is never one price -- it is
   * where a cluster of highs sit -- and a hairline invites an argument about
   * whether a wick that went two dollars through it counts. The band is drawn
   * to the same tolerance the engine breaks it by, so what you see is what it
   * measured.
   */
  zones?: readonly { from: number; to: number; label: string; tone: 'up' | 'down' }[];
  /**
   * Where it goes if it goes, drawn off the right-hand edge.
   *
   * An arrow out of the last bar to each target with the number in a box, and
   * the range between the levels shaded as the place where neither has
   * happened yet. It is the same plan the market-state card gives in words --
   * drawn, because a target is a price on a chart before it is a sentence.
   */
  projection?: {
    up: { trigger: number; target1: number } | null;
    down: { trigger: number; target1: number } | null;
    /** Where price sits while neither level has gone: drawn as its own box. */
    range?: { from: number; to: number } | null;
  } | null;
  tf: ChartTf;
  onTf: (tf: ChartTf) => void;
  loading?: boolean;
  error?: string;
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(DEFAULT_W);
  /*
   * Full screen is the card itself, so the header, the tools and the legend come
   * with it. In it the canvas may use the height of the screen; out of it the
   * usual cap keeps the chart from pushing the page down.
   */
  const [full, setFull] = useState(false);
  useEffect(() => {
    const on = () => setFull(document.fullscreenElement === cardRef.current && cardRef.current !== null);
    document.addEventListener('fullscreenchange', on);
    return () => document.removeEventListener('fullscreenchange', on);
  }, []);
  const toggleFull = () => {
    if (document.fullscreenElement) void document.exitFullscreen?.();
    else void cardRef.current?.requestFullscreen?.();
  };
  const { W, H } = sizeFor(width, full ? Math.max(360, (globalThis.innerHeight || 800) - 170) : 360);
  const [hover, setHover] = useState<number | null>(null);
  const [open, setOpen] = usePersisted('open:price-chart', true);

  /** Null means "all of it, fitted" — where a fresh load and a reset sit. */
  const [view, setView] = useState<View | null>(null);
  const drag = useRef<{ x: number; from: number } | null>(null);
  /** A drag on the price axis, stretching the scale. */
  const axisDrag = useRef<{ y: number; start: View } | null>(null);
  /** Every finger on the plot, so two of them can be read as a pinch. */
  const fingers = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef<{ dist: number; anchor: number; start: View } | null>(null);
  const lastTap = useRef(0);

  // Draw at the size shown. The observer is a no-op under jsdom, so tests draw
  // at the default and the geometry they pin stays put.
  useEffect(() => {
    const el = cardRef.current;
    if (!el) return;
    const measure = () => {
      // The card's own side padding, which changes at phone width.
      const cs = getComputedStyle(el);
      const w = el.clientWidth - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0);
      if (w > 0) setWidth(w);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  /*
   * Zoom and pan are off until they are asked for.
   *
   * The chart is in the middle of a long scrolling page, so a wheel that always
   * zooms is a wheel that stops the page dead wherever the pointer happens to
   * be resting -- and on a phone, `touch-action: none` meant a drag over the
   * plot scrolled nothing at all and the page felt stuck. Off, the chart is a
   * picture and the page behaves like a page; on, it takes the pointer and says
   * so. The choice is remembered, because somebody who wants it wants it every
   * time.
   *
   * Turning it off keeps the view exactly where it was. The first version
   * snapped back to the whole series, on the theory that a window nobody can
   * pan out of is a trap -- but the reason to turn zoom off is to *stop* the
   * wheel moving the chart, which is the opposite of wanting it moved. The
   * range somebody pulled into is the picture they want left alone; Fit is
   * there when they want the whole series back.
   */
  const [zoomOn, setZoomOn] = usePersisted('zoom:price-chart', false);

  // A new timeframe is a new series; a window into the old one would land you
  // somewhere arbitrary in it.
  useEffect(() => { setView(null); }, [tf]);

  const win = useMemo(() => {
    if (!bars.length) return null;
    const fits = barsThatFit(W - PAD.left - PAD.right - RIGHT_GAP, bars.length);
    const count = clamp(view?.count ?? fits, Math.min(MIN_BARS, bars.length), bars.length);
    const from = clamp(view?.from ?? bars.length - count, 0, Math.max(0, bars.length - count));
    return { from, count, slice: bars.slice(from, from + count), yZoom: view?.yZoom ?? 1 };
  }, [bars, view, W]);

  const geom = useMemo(() => {
    if (!win || !win.slice.length) return null;
    const shown = win.slice;

    // The scale is what is on screen, plus the spot line which is always near it.
    const lo0 = Math.min(...shown.map((b) => b.low), spot);
    const hi0 = Math.max(...shown.map((b) => b.high), spot);
    const mid = (lo0 + hi0) / 2;
    const fitHalf = (((hi0 - lo0) / 2) || 1) * 1.08;
    const half = fitHalf / win.yZoom;
    const lo = mid - half;
    const hi = mid + half;

    /*
     * How far out the price scale may be pulled: far enough to reach the walls.
     *
     * The floor was a flat 0.4, which widens a quiet hour's 600-dollar range to
     * 1,500 — nowhere near a wall six thousand dollars away. So the two levels
     * stayed pinned to the edges reading "off the scale" however hard you
     * zoomed out, and the one thing zooming out is *for* on this chart could
     * not be done. The limit is now whatever it takes to bring the furthest
     * wall inside with a little air around it, and never tighter than before.
     */
    const reach = Math.max(
      fitHalf,
      ...[support, resistance]
        .filter((v): v is number => v !== null)
        .map((v) => Math.abs(v - mid)),
    );
    const yFloor = clamp(fitHalf / (reach * 1.12), 0.02, 0.4);

    const plotW = W - PAD.left - PAD.right - RIGHT_GAP;
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

    /*
     * The price axis gets finer as you zoom, not just shorter.
     *
     * Four lines over the whole day and four lines over ten minutes read the
     * same, which is the opposite of what zooming in is for: the reason to pull
     * into a range is to see levels inside it. The target is a line every ~46
     * pixels, so a taller plot and a narrower range both buy detail, and the
     * ladder carries halves and quarters so a $40 range lands on $10s rather
     * than being rounded up to $50s.
     */
    const want = clamp(Math.round(priceH / 46), 4, 9);
    const rough = (hi - lo) / want;
    const mag = Math.pow(10, Math.floor(Math.log10(rough)));
    const stepPrice =
      [1, 1.25, 2, 2.5, 4, 5, 10].map((m) => m * mag).find((sp) => sp >= rough) ?? rough;
    const ticks: number[] = [];
    for (let p = Math.ceil(lo / stepPrice) * stepPrice; p <= hi; p += stepPrice) ticks.push(p);

    const timeTicks = [0, Math.floor(shown.length / 3), Math.floor((shown.length * 2) / 3), shown.length - 1]
      .filter((i, n, a) => i >= 0 && a.indexOf(i) === n)
      .map((i) => ({ i, bar: shown[i]! }));

    return {
      shown, lo, hi, y, x, step, bodyW, ticks, timeTicks, volY, volTop, volH, priceH, yFloor,
      // Where the newest bar is, for anything drawn out of it into the gap.
      lastX: shown.length ? x(shown.length - 1) : null,
    };
  }, [win, spot, support, resistance, W, H]);

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

  const level = (value: number, colour: string, label: string, isWall = false) => {
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
        {inside && isWall && (
          <text x={PAD.left + 4} y={yPos - 5} fontSize="10.5" fontWeight="600" fill={colour}>
            {label} ({away >= 0 ? '+' : '−'}{Math.abs(away).toFixed(1)}% away)
          </text>
        )}
      </g>
    );
  };

  /** Canvas coordinates for a client point, so zoom happens about the pointer. */
  const vpoint = (clientX: number, clientY: number): { x: number; y: number } | null => {
    const el = svgRef.current;
    if (!el) return null;
    const box = el.getBoundingClientRect();
    if (!box.width) return null;
    return { x: ((clientX - box.left) / box.width) * W, y: ((clientY - box.top) / box.width) * W };
  };
  const vx = (clientX: number): number | null => vpoint(clientX, 0)?.x ?? null;
  const plotW = W - PAD.left - PAD.right - RIGHT_GAP;
  const anchorAt = (x: number) => clamp((x - PAD.left) / plotW, 0, 1);
  const current = (): View | null => (win ? { from: win.from, count: win.count, yZoom: win.yZoom } : null);

  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    if (!geom || !win) return;
    const at = vpoint(e.clientX, e.clientY);
    if (at === null) return;

    if (fingers.current.has(e.pointerId)) fingers.current.set(e.pointerId, at);
    if (pinch.current && fingers.current.size >= 2) {
      const [a, b] = [...fingers.current.values()];
      const dist = Math.hypot(a!.x - b!.x, a!.y - b!.y);
      if (dist > 0) {
        setView(pinchZoom(pinch.current.start, bars.length, {
          anchor: pinch.current.anchor,
          ratio: pinch.current.dist / dist,
        }));
      }
      return;
    }

    if (axisDrag.current) {
      setView(stretchByDrag(axisDrag.current.start, at.y - axisDrag.current.y, geom.yFloor));
      return;
    }

    if (drag.current) {
      const moved = Math.round((drag.current.x - at.x) / geom.step);
      setView({
        count: win.count,
        yZoom: win.yZoom,
        from: clamp(drag.current.from + moved, 0, Math.max(0, bars.length - win.count)),
      });
      return;
    }

    const i = Math.round((at.x - PAD.left - geom.step / 2) / geom.step);
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
    // Not armed: no preventDefault, so the wheel belongs to the page.
    if (!zoomOn || !win || !bars.length) return;
    const at = vx(e.clientX);
    if (at === null) return;
    e.preventDefault();

    // Over the price axis, or with shift held: the price scale stretches.
    if (at > W - PAD.right || e.shiftKey) {
      setView(zoomVertically(win, e.deltaY > 0, geom?.yFloor));
      return;
    }

    // Otherwise the window narrows or widens about whatever is under the cursor.
    setView(zoomHorizontally(win, bars.length, { anchor: anchorAt(at), out: e.deltaY > 0 }));
  };

  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const on = (e: WheelEvent) => wheelRef.current(e);
    el.addEventListener('wheel', on, { passive: false });
    return () => el.removeEventListener('wheel', on);
    // Re-bound whenever the element appears or goes: the chart unmounts behind
    // the fold and on a feed error, and a listener on a detached node is a leak.
  }, [open, error, bars.length === 0, zoomOn]);

  const onDown = (e: React.PointerEvent<SVGSVGElement>) => {
    if (!zoomOn || !win) return;
    const at = vpoint(e.clientX, e.clientY);
    const start = current();
    if (at === null || !start) return;
    svgRef.current?.setPointerCapture?.(e.pointerId);

    if (e.pointerType === 'touch') {
      fingers.current.set(e.pointerId, at);
      if (fingers.current.size === 2) {
        // A second finger turns a pan into a pinch, anchored between them.
        const [a, b] = [...fingers.current.values()];
        drag.current = null;
        axisDrag.current = null;
        pinch.current = {
          dist: Math.max(1, Math.hypot(a!.x - b!.x, a!.y - b!.y)),
          anchor: anchorAt((a!.x + b!.x) / 2),
          start,
        };
        return;
      }
    }

    if (at.x > W - PAD.right) {
      axisDrag.current = { y: at.y, start };
      return;
    }
    drag.current = { x: at.x, from: win.from };
  };

  const endDrag = (e: React.PointerEvent<SVGSVGElement>) => {
    svgRef.current?.releasePointerCapture?.(e.pointerId);
    const wasPinch = pinch.current !== null;
    fingers.current.delete(e.pointerId);
    if (fingers.current.size < 2) pinch.current = null;
    // A lifted finger ends every gesture: the one left behind starts afresh
    // on its next move rather than jumping the window to where it now is.
    drag.current = null;
    axisDrag.current = null;

    // Two quick taps put the chart back, since a phone has no double-click.
    if (e.pointerType === 'touch' && !wasPinch && fingers.current.size === 0 && zoomOn) {
      const now = Date.now();
      if (now - lastTap.current < 350) { setView(null); lastTap.current = 0; }
      else lastTap.current = now;
    }
  };

  const zoomButton = (out: boolean) => {
    const start = current();
    if (start) setView(zoomByButton(start, bars.length, out));
  };

  const shown = hover !== null && geom ? geom.shown[hover] : geom?.shown.at(-1);
  const shownUp = shown ? shown.close >= shown.open : true;
  // The bar's move from the one before it: what the "−102 (−0.13%)" in the header says.
  const shownAt = hover ?? (geom ? geom.shown.length - 1 : -1);
  const previous = geom && shownAt > 0 ? geom.shown[shownAt - 1] : undefined;
  const change = shown && previous ? shown.close - previous.close : null;
  const changePct = change !== null && previous ? (change / previous.close) * 100 : null;
  const zoomed = view !== null;

  return (
    <Collapsible.Root ref={cardRef} open={open} onOpenChange={setOpen} className="price-chart">
      <div className="price-chart-head">
        <div className="price-chart-headline">
          <Collapsible.Trigger className="price-chart-title" aria-label="price chart">
            <ChevronDown className={`smr-chev${open ? '' : ' shut'}`} size={13} aria-hidden />
            BTC <span className="price-chart-dot" aria-hidden>•</span> {tf === '1d' ? '1D' : tf}
          </Collapsible.Trigger>

          {/* The bar under the pointer, or the last one — always saying which. */}
          {open && shown && !error && (
            <div className="price-chart-ohlc">
              <span className="dim">{hover === null ? 'last' : IST_FULL.format(shown.time * 1000)}</span>
              <span>O <b>{fmtStrike(Math.round(shown.open))}</b></span>
              <span>H <b>{fmtStrike(Math.round(shown.high))}</b></span>
              <span>L <b>{fmtStrike(Math.round(shown.low))}</b></span>
              <span>C <b className={shownUp ? 'up' : 'down'}>{fmtStrike(Math.round(shown.close))}</b></span>
              {change !== null && (
                <b className={`price-chart-change ${change >= 0 ? 'up' : 'down'}`}>
                  {change >= 0 ? '+' : '−'}{fmtStrike(Math.round(Math.abs(change)))} ({change >= 0 ? '+' : '−'}{Math.abs(changePct!).toFixed(2)}%)
                </b>
              )}
              {win && <span className="dim">{win.count} of {bars.length} bars</span>}
            </div>
          )}
        </div>

        <div className="price-chart-controls">
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

          <div className="price-chart-tools" role="group" aria-label="zoom">
            <button
              type="button"
              className={`chain-chip${zoomOn ? ' on' : ''}`}
              aria-pressed={zoomOn}
              aria-label={zoomOn ? 'Zoom on' : 'Zoom off'}
              title={zoomOn
                ? 'Zoom and pan are on: scroll or pinch to zoom, drag to pan. Turn off to scroll the page over the chart.'
                : 'Zoom and pan are off, so the page scrolls over the chart. Turn on to scroll, drag and pinch the chart. The + and − work either way.'}
              onClick={() => setZoomOn(!zoomOn)}
            >
              {zoomOn ? <Move size={13} aria-hidden /> : <Lock size={13} aria-hidden />}
            </button>
            <button
              type="button" className="chain-chip" aria-label="zoom out" title="Zoom out: more bars"
              disabled={!win || win.count >= bars.length}
              onClick={() => zoomButton(true)}
            >
              <Minus size={13} aria-hidden />
            </button>
            <button
              type="button" className="chain-chip" aria-label="zoom in" title="Zoom in: fewer bars, about the newest"
              disabled={!win || win.count <= Math.min(MIN_BARS, bars.length)}
              onClick={() => zoomButton(false)}
            >
              <Plus size={13} aria-hidden />
            </button>
            <button
              type="button" className="chain-chip" aria-label={full ? 'exit full screen' : 'full screen'}
              title={full ? 'Exit full screen' : 'Full screen'}
              onClick={toggleFull}
            >
              {full ? <Minimize size={13} aria-hidden /> : <Expand size={13} aria-hidden />}
            </button>
            <button
              type="button" className="chain-chip"
              title="Show every bar loaded, however thin they get"
              onClick={() => setView({ from: 0, count: bars.length, yZoom: 1 })}
            >
              <Maximize2 size={12} aria-hidden /> All
            </button>
            <button
              type="button" className="chain-chip" disabled={!zoomed}
              title="Back to the default window, at a readable candle width"
              onClick={() => setView(null)}
            >
              <Minimize size={12} aria-hidden /> Fit
            </button>
          </div>
        </div>
      </div>

      <Collapsible.Content>
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
          className={`price-chart-svg${zoomOn ? ' armed' : ''}`}
          role="img"
          onPointerMove={onMove}
          onPointerDown={onDown}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onPointerLeave={(e) => { endDrag(e); setHover(null); }}
          onDoubleClick={() => zoomOn && setView(null)}
          aria-label={`BTC ${tf} candles, ${geom.shown.length} of ${bars.length} bars shown, with open-interest walls at ${support ?? '—'} and ${resistance ?? '—'}`}
        >
          {/* Arrowheads for the projection legs. Two, because they are coloured. */}
          <defs>
            {(['up', 'down'] as const).map((tone) => (
              <marker
                key={tone} id={`price-chart-arrow-${tone}`} viewBox="0 0 8 8" refX="6" refY="4"
                markerWidth="5" markerHeight="5" orient="auto-start-reverse"
              >
                <path d="M 0 1 L 7 4 L 0 7 z" fill={tone === 'up' ? 'var(--up)' : 'var(--down)'} />
              </marker>
            ))}
          </defs>
          {/*
            The price axis is a control -- the wheel over it stretches the
            scale -- so it gets a target of its own and a cursor that says so.
            Behind the gridlines, so it never eats a click meant for a candle.
          */}
          <rect
            x={W - PAD.right} y={PAD.top}
            width={PAD.right} height={geom.priceH}
            fill="transparent" className="price-axis-grip"
          />

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

          {/*
            The level bands, behind the candles and over the expected-move
            shading: the two prices the state engine is actually judging
            against, drawn where it judges them.
          */}
          {zones.map((z) => {
            const top = Math.max(PAD.top, geom.y(Math.max(z.from, z.to)));
            const bottom = Math.min(PAD.top + geom.priceH, geom.y(Math.min(z.from, z.to)));
            if (!(bottom > top)) return null;
            const colour = z.tone === 'up' ? 'var(--down)' : 'var(--up)';
            // The dashed edge is the side price has to get through: the top of
            // a resistance band, the bottom of a support one.
            const edge = z.tone === 'up' ? top : bottom;
            // Two lines, inside the band: what it is, then the prices it runs
            // between -- a band labelled with one price is half a label.
            const nameY = z.tone === 'up' ? top + 11 : bottom - 13;
            return (
              <g key={z.label} data-zone={z.label}>
                <rect
                  x={PAD.left} y={top} width={W - PAD.right - PAD.left} height={bottom - top}
                  fill={colour} opacity="0.1"
                />
                <line x1={PAD.left} x2={W - PAD.right} y1={edge} y2={edge}
                  stroke={colour} strokeWidth="1" strokeDasharray="4 3" opacity="0.8" />
                <text x={PAD.left + 5} y={nameY} fontSize="9.5" fontWeight="600" fill={colour}>{z.label}</text>
                <text x={PAD.left + 5} y={nameY + 10} fontSize="9" fill={colour} opacity="0.85">
                  {fmtStrike(Math.round(Math.min(z.from, z.to)))} – {fmtStrike(Math.round(Math.max(z.from, z.to)))}
                </text>
              </g>
            );
          })}

          {/*
            The projection: an arrow out of the newest bar to each target, with
            the price in a box against the right edge.

            Drawn in the gap kept clear to the right of the last candle, so it
            never covers a bar. Clamped to the plot: a target off the top of
            the scale is drawn at the top with its number, which is the honest
            way to say "further than this chart goes" -- better than vanishing.
          */}
          {projection && geom.lastX !== null && (() => {
            const fromX = geom.lastX;
            const toX = W - PAD.right - 2;
            const BOX_W = 92;
            const clampY = (p: number) => clamp(geom.y(p), PAD.top + 20, PAD.top + geom.priceH - 20);
            const legs = [
              projection.up ? { key: 'up', tone: 'up' as const, title: 'Breakout ↑', price: projection.up.target1 } : null,
              projection.down ? { key: 'down', tone: 'down' as const, title: 'Breakdown ↓', price: projection.down.target1 } : null,
            ].filter((v): v is { key: string; tone: 'up' | 'down'; title: string; price: number } => v !== null)
              .map((l) => ({ ...l, y: clampY(l.price), away: spot > 0 ? ((l.price - spot) / spot) * 100 : 0 }));
            const fromY = clampY(spot);
            const range = projection.range ?? null;
            const rangeTop = range ? clampY(Math.max(range.from, range.to)) : 0;
            const rangeBottom = range ? clampY(Math.min(range.from, range.to)) : 0;
            return (
              <g className="price-chart-projection" aria-hidden>
                {/*
                  Where price is while neither level has gone. Named on the
                  chart because "nothing has happened yet" is a reading too,
                  and the one most often mistaken for a signal.
                */}
                {range && (
                  <g data-leg="range">
                    <rect
                      x={toX - BOX_W} y={(rangeTop + rangeBottom) / 2 - 15} width={BOX_W} height={30} rx={4}
                      fill="var(--panel)" stroke="var(--line)" strokeWidth="1" opacity="0.95"
                    />
                    <text x={toX - BOX_W + 6} y={(rangeTop + rangeBottom) / 2 - 3} fontSize="9" fill="var(--muted)">
                      Possible range
                    </text>
                    <text x={toX - BOX_W + 6} y={(rangeTop + rangeBottom) / 2 + 9} fontSize="9.5" fill="var(--text)">
                      {fmtStrike(Math.round(Math.min(range.from, range.to)))} – {fmtStrike(Math.round(Math.max(range.from, range.to)))}
                    </text>
                  </g>
                )}
                {legs.map((leg) => {
                  const colour = leg.tone === 'up' ? 'var(--up)' : 'var(--down)';
                  const midX = (fromX + toX) / 2;
                  return (
                    <g key={leg.key} data-leg={leg.key}>
                      <path
                        d={`M ${fromX} ${fromY} Q ${midX} ${fromY} ${toX - BOX_W - 4} ${leg.y}`}
                        fill="none" stroke={colour} strokeWidth="1.6" opacity="0.85"
                        markerEnd={`url(#price-chart-arrow-${leg.tone})`}
                      />
                      <rect
                        x={toX - BOX_W} y={leg.y - 17} width={BOX_W} height={34} rx={4}
                        fill="var(--panel)" stroke={colour} strokeWidth="1" opacity="0.97"
                      />
                      <text x={toX - BOX_W + 6} y={leg.y - 6} fontSize="9" fontWeight="600" fill={colour}>{leg.title}</text>
                      <text x={toX - BOX_W + 6} y={leg.y + 6} fontSize="9" fill="var(--muted)">Target</text>
                      <text x={toX - 6} y={leg.y + 6} fontSize="10" textAnchor="end" fill="var(--text)">
                        {Math.round(leg.price).toLocaleString('en-US')}
                      </text>
                      <text x={toX - 6} y={leg.y + 15} fontSize="8.5" textAnchor="end" fill={colour}>
                        ({leg.away >= 0 ? '+' : '−'}{Math.abs(leg.away).toFixed(2)}%)
                      </text>
                    </g>
                  );
                })}
              </g>
            );
          })()}

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
              className="vol-bar"
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
                  className="candle-body"
                />
              </g>
            );
          })}

          {geom && levels.filter((l) => l.price >= geom.lo && l.price <= geom.hi).map((l) => {
            const y = levelY(l.price)!;
            return (
              <g key={l.label} opacity="0.75">
                <line x1={PAD.left} x2={W - PAD.right} y1={y} y2={y} stroke={l.colour ?? 'var(--muted)'} strokeWidth="1" strokeDasharray="2 3" />
                <text x={W - PAD.right - 4} y={y - 3} textAnchor="end" fontSize="9.5" fill={l.colour ?? 'var(--muted)'}>{l.label} {fmtStrike(Math.round(l.price))}</text>
              </g>
            );
          })}
          {support !== null && level(support, 'var(--up)', fmtStrike(support), true)}
          {resistance !== null && level(resistance, 'var(--down)', fmtStrike(resistance), true)}
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
        <div className="price-chart-legend">
          <span><i className="dot" style={{ background: 'var(--accent)' }} /> Spot <b>{fmtStrike(Math.round(spot))}</b></span>
          {support !== null && <span><i className="dot" style={{ background: 'var(--up)' }} /> Support <b>{fmtStrike(support)}</b></span>}
          {resistance !== null && <span><i className="dot" style={{ background: 'var(--down)' }} /> Resistance <b>{fmtStrike(resistance)}</b></span>}
          <span><i className="dot" style={{ background: 'var(--dim)' }} /> Volume</span>
        </div>
        <span className="dim">
          support · heaviest put strike · resistance · heaviest call strike — where open interest sits, not where BTC will settle · times IST
        </span>
        <span className="dim">
          {zoomOn
            ? 'scroll or pinch to zoom · drag to pan · drag or scroll the price axis to stretch it, out far enough and the walls come onto it · double-click or double-tap to fit'
            : 'zoom is off, so the page scrolls over the chart — + and − still zoom about the newest bar; turn it on to scroll, drag and pinch the chart'}
        </span>
      </div>
      </Collapsible.Content>
    </Collapsible.Root>
  );
}
