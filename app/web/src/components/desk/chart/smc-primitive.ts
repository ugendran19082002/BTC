import type {
  IChartApi, IPrimitivePaneRenderer, IPrimitivePaneView, ISeriesApi, ISeriesPrimitive, Logical,
  PrimitivePaneViewZOrder, SeriesAttachedParameter, SeriesType, Time,
} from 'lightweight-charts';
import { placeLabels, stacked, type LabelRequest, type Rect } from './label-layout';
import type { SceneBox, SceneBubble, SceneHeat, SceneItem, SceneLine, SceneMark, SceneProfile } from './scene';

/**
 * Draws a scene (scene.ts) on the chart's own canvas, as a series primitive.
 *
 * Every frame converts the scene's bar indices and prices to pixels with the
 * chart's own scales, so the shapes pan and zoom with the candles exactly --
 * no DOM overlay to fall a frame behind, and nothing clamped to the edge at a
 * price it does not have: a shape off the visible range is simply not drawn.
 *
 * Boxes and the volume profile go behind the candles (`drawBackground`);
 * lines, marks, big-trade bubbles and labels in front. Labels are placed by priority (label-layout.ts), clear of `reserved`
 * -- the HUD's corner.
 */

type Target = Parameters<IPrimitivePaneRenderer['draw']>[0];
type Ctx = CanvasRenderingContext2D;
type Scope = { context: Ctx; mediaSize: { width: number; height: number } };

/** Big-trade colours: apart from the candles' green / red. */
const BUY = '#3b82f6';
const SELL = '#d946ef';
const FONT = '600 10px ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif';
const LABEL_H = 15;
const LABEL_PAD = 5;

type Label = { id: number; priority: number; text: string; color: string; candidates: Rect[]; faint?: boolean };

export class SmcPrimitive implements ISeriesPrimitive<Time> {
  private chart: IChartApi | null = null;
  private series: ISeriesApi<SeriesType> | null = null;
  private requestUpdate: (() => void) | null = null;
  private scene: readonly SceneItem[] = [];
  private reserved: Rect[] = [];
  /** Where each bubble was last drawn, for the hover. */
  private hits: { x: number; y: number; r: number; tip: string }[] = [];
  private readonly views: IPrimitivePaneView[];

  constructor() {
    const back: IPrimitivePaneView = { zOrder: () => 'bottom' as PrimitivePaneViewZOrder, renderer: () => this.renderer('back') };
    const front: IPrimitivePaneView = { zOrder: () => 'top' as PrimitivePaneViewZOrder, renderer: () => this.renderer('front') };
    this.views = [back, front];
  }

  attached(p: SeriesAttachedParameter<Time>) {
    this.chart = p.chart as IChartApi;
    this.series = p.series as ISeriesApi<SeriesType>;
    this.requestUpdate = p.requestUpdate;
  }

  detached() {
    this.chart = null;
    this.series = null;
    this.requestUpdate = null;
  }

  paneViews() { return this.views; }

  setScene(scene: readonly SceneItem[]) {
    this.scene = scene;
    this.requestUpdate?.();
  }

  /** The detail of the bubble under a point (pane CSS pixels), the smallest when they overlap; null when none. */
  bubbleAt(x: number, y: number): string | null {
    let best: { r: number; tip: string } | null = null;
    for (const h of this.hits) {
      if (Math.hypot(h.x - x, h.y - y) <= h.r + 3 && (!best || h.r < best.r)) best = h;
    }
    return best?.tip ?? null;
  }

  /** Screen areas labels must stay out of (in the pane's CSS pixels). */
  setReserved(rects: Rect[]) {
    this.reserved = rects;
    this.requestUpdate?.();
  }

  private renderer(which: 'back' | 'front'): IPrimitivePaneRenderer {
    return {
      draw: (target: Target) => { if (which === 'front') target.useMediaCoordinateSpace((s) => this.drawFront(s as Scope)); },
      drawBackground: (target: Target) => { if (which === 'back') target.useMediaCoordinateSpace((s) => this.drawBack(s as Scope)); },
    };
  }

  // ---------------------------------------------------------------- geometry

  private x(i: number | 'right', width: number): number | null {
    if (i === 'right') return width;
    const v = this.chart?.timeScale().logicalToCoordinate(i as Logical);
    return v == null ? null : Number(v);
  }

  private y(price: number): number | null {
    const v = this.series?.priceToCoordinate(price);
    return v == null ? null : Number(v);
  }

  /** Both ends in pixels, or null when the span is wholly off screen. */
  private span(x1: number, x2: number | 'right', width: number): [number, number] | null {
    const a = this.x(x1, width);
    const b = this.x(x2, width);
    if (a === null || b === null) return null;
    const lo = Math.max(0, Math.min(a, b));
    const hi = Math.min(width, Math.max(a, b));
    return hi - lo < 1 && x2 !== x1 ? null : [lo, Math.max(hi, lo + 1)];
  }

  // ---------------------------------------------------------------- back

  private drawBack({ context: ctx, mediaSize }: Scope) {
    // The heatmap first: under the zones, the profile and the candles.
    for (const it of this.scene) if (it.t === 'heat') this.heat(ctx, it, mediaSize.width);
    for (const it of this.scene) {
      if (it.t === 'profile') { this.profile(ctx, it, mediaSize.width); continue; }
      if (it.t !== 'box') continue;
      const sx = this.span(it.x1, it.x2, mediaSize.width);
      const y1 = this.y(it.y1);
      const y2 = this.y(it.y2);
      if (!sx || y1 === null || y2 === null) continue;
      const top = Math.min(y1, y2);
      const h = Math.max(1, Math.abs(y2 - y1));
      ctx.save();
      if (it.faint) ctx.globalAlpha = 0.5;
      ctx.fillStyle = it.fill;
      ctx.fillRect(sx[0], top, sx[1] - sx[0], h);
      if (it.stroke) {
        ctx.save();
        ctx.strokeStyle = it.stroke;
        ctx.globalAlpha = it.layer === 'entry' ? 0.9 : 0.45;
        ctx.lineWidth = it.layer === 'entry' ? 1.5 : 1;
        ctx.setLineDash(it.dash ? [4, 3] : []);
        ctx.strokeRect(Math.round(sx[0]) + 0.5, Math.round(top) + 0.5, Math.round(sx[1] - sx[0]), Math.round(h));
        ctx.restore();
      }
      ctx.restore();
    }
  }

  // ---------------------------------------------------------------- front

  private drawFront({ context: ctx, mediaSize }: Scope) {
    const { width, height } = mediaSize;
    ctx.font = FONT;
    ctx.textBaseline = 'middle';
    const labels: Label[] = [];
    let id = 0;
    const measure = (t: string) => Math.ceil(ctx.measureText(t).width) + LABEL_PAD * 2;
    this.hits = [];

    for (const it of this.scene) {
      if (it.t === 'line') this.line(ctx, it, width, labels, () => id++, measure);
      else if (it.t === 'path') this.path(ctx, it.points, it.color, width, it.label, it.priority, labels, () => id++, measure);
      else if (it.t === 'mark') this.mark(ctx, it, labels, () => id++, measure);
      else if (it.t === 'box' && it.label) this.boxLabel(it, width, labels, () => id++, measure);
      else if (it.t === 'bubble') this.bubble(ctx, it, labels, () => id++, measure);
    }

    const reqs: LabelRequest[] = labels.map((l) => ({ id: l.id, priority: l.priority, candidates: l.candidates }));
    const where = placeLabels(reqs, { x: 0, y: 0, w: width, h: height }, this.reserved);
    for (const l of labels) {
      const r = where.get(l.id);
      if (!r) continue;
      ctx.save();
      if (l.faint) ctx.globalAlpha = 0.5;
      pill(ctx, r, l.text, l.color);
      ctx.restore();
    }
  }

  private line(ctx: Ctx, it: SceneLine, width: number, labels: Label[], nextId: () => number, measure: (t: string) => number) {
    const sx = this.span(it.x1, it.x2, width);
    const y = this.y(it.y);
    if (!sx || y === null) return;
    ctx.save();
    if (it.faint) ctx.globalAlpha = 0.45;
    ctx.strokeStyle = it.color;
    ctx.lineWidth = it.width ?? 1;
    ctx.setLineDash(it.dash === 'dash' ? [6, 4] : it.dash === 'dot' ? [2, 3] : []);
    ctx.beginPath();
    ctx.moveTo(sx[0], Math.round(y) + 0.5);
    ctx.lineTo(sx[1], Math.round(y) + 0.5);
    ctx.stroke();
    ctx.restore();
    if (!it.label) return;
    const w = measure(it.label);
    const above = it.labelSide !== 'below';
    const ly = above ? y - LABEL_H - 2 : y + 2;
    const lx = it.labelAt === 'end' ? Math.min(sx[1], width) - w - 4 : (sx[0] + sx[1]) / 2 - w / 2;
    const first: Rect = { x: lx, y: ly, w, h: LABEL_H };
    const other: Rect = { ...first, y: above ? y + 2 : y - LABEL_H - 2 };
    labels.push({
      id: nextId(), priority: it.priority - (it.faint ? 30 : 0), text: it.label, color: it.color, faint: it.faint,
      candidates: it.labelAt === 'end' ? [first, other, ...stacked(first, LABEL_H + 2).slice(1)] : [first, other],
    });
  }

  /**
   * Each candle's column of resting size, a cell per price step, coloured from
   * deep blue through cyan to yellow as it nears the cap -- the usual heatmap
   * scale -- by the square root, so middling walls still read. Faint cells are
   * not drawn at all, and the strongest stays translucent over the candles.
   */
  private heat(ctx: Ctx, it: SceneHeat, width: number) {
    const a = this.x(0, Infinity);
    const b = this.x(1, Infinity);
    const spacing = a !== null && b !== null ? Math.abs(b - a) : 8;
    ctx.save();
    for (const col of it.cols) {
      const cx = this.x(col.x, Infinity);
      if (cx === null || cx < -spacing || cx > width + spacing) continue;
      for (const [k, v] of col.cells) {
        const t = Math.sqrt(Math.min(1, v / it.cap));
        if (t < 0.15) continue;
        const y1 = this.y((k + 1) * it.step);
        const y2 = this.y(k * it.step);
        if (y1 === null || y2 === null) continue;
        ctx.fillStyle = heatColor(t);
        ctx.fillRect(cx - spacing / 2, Math.min(y1, y2), spacing + 0.5, Math.max(1, Math.abs(y2 - y1)));
      }
    }
    ctx.restore();
  }

  /** Right-anchored, at most a fifth of the width, so the latest candles stay readable through it. */
  private profile(ctx: Ctx, it: SceneProfile, width: number) {
    if (!(it.max > 0)) return;
    const w = Math.min(width * 0.2, 170);
    ctx.save();
    for (const b of it.bins) {
      const y1 = this.y(b.hi);
      const y2 = this.y(b.lo);
      if (y1 === null || y2 === null || !(b.v > 0)) continue;
      const len = (w * b.v) / it.max;
      const poc = it.poc >= b.lo && it.poc < b.hi;
      const top = Math.min(y1, y2) + 0.5;
      const h = Math.max(1, Math.abs(y2 - y1) - 1);
      // Split by the aggressor where most of the bin's volume has a recorded split: buyers nearest
      // the price scale (blue), sellers beyond (fuchsia), as the bubbles; grey where it was not recorded.
      if (b.known !== undefined && b.buy !== undefined && b.known >= b.v * 0.5 && b.known > 0) {
        const a = b.value ? 0.42 : 0.2;
        const buyLen = len * (b.buy / b.known);
        ctx.fillStyle = `rgba(59,130,246,${a})`;
        ctx.fillRect(width - buyLen, top, buyLen, h);
        ctx.fillStyle = `rgba(217,70,239,${a})`;
        ctx.fillRect(width - len, top, len - buyLen, h);
        if (poc) { ctx.strokeStyle = 'rgba(251,191,36,0.9)'; ctx.lineWidth = 1; ctx.strokeRect(width - len + 0.5, top, len - 1, h); }
      } else {
        ctx.fillStyle = poc ? 'rgba(251,191,36,0.42)' : b.value ? 'rgba(148,163,184,0.26)' : 'rgba(148,163,184,0.11)';
        ctx.fillRect(width - len, top, len, h);
      }
    }
    // Nodes: a short tick at the profile's left edge -- amber for acceptance (HVN), cyan for a thin area (LVN).
    const tick = (price: number, color: string) => {
      const y = this.y(price);
      if (y === null) return;
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(width - w - 10, Math.round(y) + 0.5);
      ctx.lineTo(width - w, Math.round(y) + 0.5);
      ctx.stroke();
    };
    for (const p of it.hvn) tick(p, 'rgba(251,191,36,0.8)');
    for (const p of it.lvn) tick(p, 'rgba(56,189,248,0.9)');
    ctx.restore();
  }

  /**
   * The biggest bubble is about one candle wide, 6-18 px; the rest scale down
   * by the square root of their size (area in proportion), never under a
   * third of it. Blue for buyers, fuchsia for sellers -- not the candles'
   * green and red, so a bubble never reads as a candle -- as a hollow ring
   * with a light fill and a dot at the exact price, so the candle shows
   * through.
   */
  private bubble(ctx: Ctx, it: SceneBubble, labels: Label[], nextId: () => number, measure: (t: string) => number) {
    const x = this.x(it.x, Infinity);
    const next = this.x(it.x + 1, Infinity);
    const y = this.y(it.y);
    if (x === null || y === null) return;
    const spacing = next === null ? 8 : Math.abs(next - x);
    const maxR = Math.min(18, Math.max(6, spacing * 1.1));
    const r = Math.max(2.5, maxR * 0.3, maxR * it.rel);
    const color = it.side === 'buy' ? BUY : SELL;
    ctx.save();
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.globalAlpha = it.faint ? 0.06 : 0.16;
    ctx.fill();
    ctx.globalAlpha = it.faint ? 0.4 : 0.95;
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = color;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(x, y, 1.6, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    if (it.tip) this.hits.push({ x, y, r, tip: it.tip });
    if (!it.label) return;
    const w = measure(it.label);
    const first: Rect = { x: x - w / 2, y: y - r - LABEL_H - 3, w, h: LABEL_H };
    labels.push({ id: nextId(), priority: it.priority - (it.faint ? 30 : 0), text: it.label, color, faint: it.faint, candidates: [first, { ...first, y: y + r + 3 }] });
  }

  private path(ctx: Ctx, points: [number, number][], color: string, width: number, label: string | undefined, priority: number, labels: Label[], nextId: () => number, measure: (t: string) => number) {
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.3;
    ctx.globalAlpha = 0.85;
    ctx.beginPath();
    let started = false;
    let lastXY: [number, number] | null = null;
    for (const [i, p] of points) {
      const x = this.x(i, width);
      const y = this.y(p);
      if (x === null || y === null) { started = false; continue; }
      if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
      lastXY = [x, y];
    }
    ctx.stroke();
    ctx.restore();
    if (label && lastXY && lastXY[0] >= 0 && lastXY[0] <= width) {
      const w = measure(label);
      const first: Rect = { x: lastXY[0] + 4, y: lastXY[1] - LABEL_H / 2, w, h: LABEL_H };
      labels.push({ id: nextId(), priority, text: label, color, candidates: stacked(first, LABEL_H + 2, 2) });
    }
  }

  private mark(ctx: Ctx, it: SceneMark, labels: Label[], nextId: () => number, measure: (t: string) => number) {
    const x = this.x(it.x, Infinity);
    const y = this.y(it.y);
    if (x === null || y === null) return;
    const above = it.side === 'above';
    if (it.glyph) {
      ctx.save();
      ctx.fillStyle = it.color;
      ctx.font = '700 11px ui-sans-serif, system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(it.glyph, x, above ? y - 7 : y + 8);
      ctx.restore();
      ctx.font = FONT;
    }
    const w = measure(it.text);
    const gap = it.glyph ? 15 : 4;
    const first: Rect = { x: x - w / 2, y: above ? y - gap - LABEL_H : y + gap, w, h: LABEL_H };
    const further: Rect = { ...first, y: above ? first.y - LABEL_H - 2 : first.y + LABEL_H + 2 };
    labels.push({ id: nextId(), priority: it.priority - (it.faint ? 30 : 0), text: it.text, color: it.color, candidates: [first, further], faint: it.faint });
  }

  private boxLabel(it: SceneBox, width: number, labels: Label[], nextId: () => number, measure: (t: string) => number) {
    const sx = this.span(it.x1, it.x2, width);
    const y1 = this.y(it.y1);
    const y2 = this.y(it.y2);
    if (!sx || y1 === null || y2 === null || !it.label) return;
    const top = Math.min(y1, y2);
    const h = Math.abs(y2 - y1);
    const w = measure(it.label);
    const x = it.x2 === 'right' && it.layer === 'pd' ? sx[1] - w - 4 : sx[0] + 3;
    const inside: Rect = { x, y: top + 2, w, h: LABEL_H };
    const above: Rect = { x, y: top - LABEL_H - 2, w, h: LABEL_H };
    labels.push({
      id: nextId(), priority: it.priority - (it.faint ? 30 : 0), faint: it.faint, text: it.label, color: it.labelColor ?? it.stroke ?? '#e5e7eb',
      candidates: h >= LABEL_H + 4 ? [inside, above] : [above, { ...above, y: top + h + 2 }],
    });
  }
}

/** 0-1 to the heatmap scale: deep blue, cyan, yellow; alpha rising with it. */
function heatColor(t: number): string {
  const stops: [number, number, number][] = [[30, 58, 138], [6, 182, 212], [250, 204, 21]];
  const f = Math.min(1, Math.max(0, t)) * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(f));
  const u = f - i;
  const [r, g, b] = stops[i]!.map((c, j) => Math.round(c + (stops[i + 1]![j]! - c) * u));
  return `rgba(${r},${g},${b},${(0.06 + 0.36 * t).toFixed(3)})`;
}

function pill(ctx: Ctx, r: Rect, text: string, color: string) {
  ctx.save();
  ctx.fillStyle = 'rgba(10,14,23,0.86)';
  ctx.strokeStyle = color;
  ctx.globalAlpha = 1;
  ctx.lineWidth = 1;
  roundRect(ctx, r.x + 0.5, r.y + 0.5, r.w - 1, r.h - 1, 3);
  ctx.fill();
  ctx.globalAlpha = 0.7;
  ctx.stroke();
  ctx.globalAlpha = 1;
  ctx.fillStyle = color;
  ctx.font = FONT;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  ctx.fillText(text, r.x + LABEL_PAD, r.y + r.h / 2 + 0.5);
  ctx.restore();
}

function roundRect(ctx: Ctx, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
