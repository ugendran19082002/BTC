/**
 * Everything drawn *on* the chart rather than by it.
 *
 * The candles, the volume, the axes, the zoom and the crosshair come from
 * `lightweight-charts`. None of the rest does: a shaded level band, a line
 * through the last two swings, a target callout in the right-hand gutter. So
 * those are laid out here as plain rectangles, lines and boxes in pixels, and
 * drawn as one SVG over the canvas.
 *
 * Kept pure, and away from the component, for the usual reason: the library
 * draws to a canvas that a test cannot read, but the arithmetic that decides
 * *where* a band or a target goes is exactly the part that can be wrong. It
 * takes the two converters the chart hands out -- price to y, bar time to x --
 * so it never needs the chart itself.
 */

export type Zone = { from: number; to: number; label: string; tone: 'up' | 'down' };
export type TrendLine = {
  kind: 'support' | 'resistance';
  from: { barsAgo: number; price: number };
  to: { barsAgo: number; price: number };
};
export type Projection = {
  up: { trigger: number; target1: number } | null;
  down: { trigger: number; target1: number } | null;
  range?: { from: number; to: number } | null;
};

export type ZoneShape = {
  label: string; tone: 'up' | 'down';
  top: number; height: number; edge: number;
  tagY: number; low: number; high: number;
};
export type LineShape = { kind: 'support' | 'resistance'; x1: number; y1: number; x2: number; y2: number };
export type CalloutShape = {
  key: 'up' | 'down' | 'range';
  title: string; price: number | null; awayPct: number | null;
  low: number | null; high: number | null;
  x: number; y: number; fromY: number;
};

/** How thin a band may be drawn before it stops being visible at all. */
export const MIN_ZONE_PX = 18;
/** The callout boxes, and the gutter they live in. */
export const CALLOUT_W = 104;
export const CALLOUT_H = 38;

export type Converters = {
  /** Price to a y in the plot, or null when it is off the scale. */
  y: (price: number) => number | null;
  /** Bars back from the newest bar to an x, or null when it is off the window. */
  x: (barsAgo: number) => number | null;
  width: number;
  height: number;
  /**
   * The price axis on the right, in pixels.
   *
   * Nothing may be drawn over it: the axis is where the reader looks to check
   * a number, and a callout box across it hides the very prices it is quoting.
   */
  gutter?: number;
};

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/**
 * The level bands.
 *
 * A band whose prices are off the scale is dropped rather than pinned to the
 * edge, because an edge-pinned band reads as "price is right at this level"
 * when the truth is the opposite. A band that is on the scale but only a pixel
 * or two tall -- a tenth of an ATR on a one-minute chart -- is opened out about
 * its own middle instead: a zone nobody can see is a zone nobody can use.
 */
export function zoneShapes(zones: readonly Zone[], c: Converters): ZoneShape[] {
  const out: ZoneShape[] = [];
  for (const z of zones) {
    const high = Math.max(z.from, z.to);
    const low = Math.min(z.from, z.to);
    const yHigh = c.y(high);
    const yLow = c.y(low);
    if (yHigh === null || yLow === null) continue;
    if (yLow < 0 || yHigh > c.height) continue;
    const grow = Math.max(0, MIN_ZONE_PX - (yLow - yHigh)) / 2;
    const top = clamp(yHigh - grow, 0, c.height);
    const bottom = clamp(yLow + grow, 0, c.height);
    if (!(bottom > top)) continue;
    const edge = z.tone === 'up' ? top : bottom;
    // The tag sits outside the band -- over a ceiling, under a floor -- so it
    // never has to be read through the candles it is labelling.
    const tagY = clamp(z.tone === 'up' ? top - 30 : bottom + 4, 0, Math.max(0, c.height - 28));
    out.push({ label: z.label, tone: z.tone, top, height: bottom - top, edge, tagY, low, high });
  }
  return out;
}

/**
 * The lines through the swings.
 *
 * Both ends are given in bars back from the newest bar, so a window that has
 * been panned or zoomed still puts them on the right candles. A line with one
 * end off the window keeps the end that is on it: half a trendline is still
 * the half price is trading against.
 */
export function lineShapes(lines: readonly TrendLine[], c: Converters): LineShape[] {
  const out: LineShape[] = [];
  for (const l of lines) {
    const x1 = c.x(l.from.barsAgo);
    const x2 = c.x(l.to.barsAgo);
    const y1 = c.y(l.from.price);
    const y2 = c.y(l.to.price);
    if (x1 === null || x2 === null || y1 === null || y2 === null) continue;
    out.push({
      kind: l.kind,
      x1: clamp(x1, 0, c.width), y1: clamp(y1, 0, c.height),
      x2: clamp(x2, 0, c.width), y2: clamp(y2, 0, c.height),
    });
  }
  return out;
}

/**
 * The target callouts, in the empty gutter kept to the right of the newest bar.
 *
 * Each says which way, the price and how far that is from here -- the last
 * because a five-digit target alone leaves the reader doing arithmetic against
 * a spot that is moving. A target above or below the visible scale is drawn at
 * the edge *with its number*: losing it would read as there being no target.
 */
export function calloutShapes(p: Projection | null, spot: number, c: Converters): CalloutShape[] {
  if (!p) return [];
  const x = c.width - (c.gutter ?? 0) - CALLOUT_W - 10;
  const inPlot = (y: number) => clamp(y, CALLOUT_H / 2 + 2, c.height - CALLOUT_H / 2 - 2);
  const at = (price: number) => inPlot(c.y(price) ?? (price > spot ? 0 : c.height));
  const fromY = inPlot(c.y(spot) ?? c.height / 2);
  const out: CalloutShape[] = [];

  if (p.up) {
    out.push({
      key: 'up', title: 'Breakout ↑', price: p.up.target1, low: null, high: null,
      awayPct: spot > 0 ? ((p.up.target1 - spot) / spot) * 100 : 0,
      x, y: at(p.up.target1), fromY,
    });
  }
  if (p.range) {
    const mid = (Math.max(p.range.from, p.range.to) + Math.min(p.range.from, p.range.to)) / 2;
    out.push({
      key: 'range', title: 'Possible range', price: null, awayPct: null,
      low: Math.min(p.range.from, p.range.to), high: Math.max(p.range.from, p.range.to),
      x, y: at(mid), fromY,
    });
  }
  if (p.down) {
    out.push({
      key: 'down', title: 'Breakdown ↓', price: p.down.target1, low: null, high: null,
      awayPct: spot > 0 ? ((p.down.target1 - spot) / spot) * 100 : 0,
      x, y: at(p.down.target1), fromY,
    });
  }
  return spread(out, c.height);
}

/**
 * Push the boxes apart so none is drawn over another.
 *
 * On a quiet chart the two targets and the range between them are a few
 * hundredths of the scale apart, and three boxes at the same height are one
 * unreadable box. They are laid out top to bottom in the order they were
 * added -- breakout, range, breakdown, which is the order they sit in price --
 * each pushed down to clear the one above it, then the whole stack lifted if
 * it has run off the bottom. Every box keeps its arrow to where it belongs, so
 * moving one costs nothing but a slightly longer line.
 */
function spread(shapes: CalloutShape[], height: number): CalloutShape[] {
  const gap = CALLOUT_H + 6;
  const out = shapes.map((s) => ({ ...s }));
  for (let i = 1; i < out.length; i++) {
    const above = out[i - 1]!;
    const here = out[i]!;
    if (here.y - above.y < gap) here.y = above.y + gap;
  }
  const last = out[out.length - 1];
  const over = last ? last.y + CALLOUT_H / 2 + 2 - height : 0;
  if (over > 0) for (const s of out) s.y -= over;
  return out.map((s) => ({ ...s, y: Math.max(CALLOUT_H / 2 + 2, s.y) }));
}
