/**
 * What the chart draws over its candles, in data coordinates (bar index,
 * price): the entry section's chosen setup -- its entry zone as a box, its
 * entry, stop and targets as lines (entry-layer.ts). Pure: no canvas, no chart
 * -- `scene-primitive.ts` turns it into pixels.
 *
 * Until 4 Oct 2026 this also held the chart's fifteen layers -- structure,
 * liquidity, zones, the book heatmap, big trades, the profile and the rest.
 * They were context no study found an edge in, and were removed; the setup is
 * the one thing drawn.
 */

/** What an item belongs to: the entry section's setup. */
export type SceneLayer = 'entry';

/** 'right' runs to the chart's right edge: a level still in play. */
type XEnd = number | 'right';

export type SceneBox = {
  t: 'box'; layer: SceneLayer; x1: number; x2: XEnd; y1: number; y2: number;
  fill: string; stroke?: string; dash?: boolean; label?: string; labelColor?: string; priority: number;
};
export type SceneLine = {
  t: 'line'; layer: SceneLayer; x1: number; x2: XEnd; y: number; color: string; width?: number; dash?: 'dash' | 'dot';
  label?: string; labelAt?: 'mid' | 'end'; labelSide?: 'above' | 'below'; priority: number;
};
export type SceneItem = SceneBox | SceneLine;

/** The chart's colours: the candles' green and red, and the labels' text. */
export const C = { bull: '#26a17b', bear: '#e2504f', text: '#e5e7eb', muted: '#94a3b8' } as const;
