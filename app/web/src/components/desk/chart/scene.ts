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

/**
 * The chart's colours, for each theme (20 Oct 2026, light and dark): the candles' green and red, the labels' text, the
 * entry's grey, a label's ground, and the chart's own ground, axis, grid and volume. A canvas reads no CSS, so they
 * are here as colours; `setChartTheme` puts a theme's into `C`, which every layer reads as it draws.
 */
export type ChartPalette = {
  bull: string; bear: string; text: string; muted: string; entry: string; entryFill: string; pill: string;
  ground: string; axisText: string; axisLine: string; grid: string; volUp: string; volDown: string;
};
export const CHART_PALETTES: Record<'dark' | 'light', ChartPalette> = {
  dark: {
    bull: '#26a17b', bear: '#e2504f', text: '#e5e7eb', muted: '#94a3b8', entry: '#c9d1d9', entryFill: 'rgba(201,209,217,0.12)',
    pill: 'rgba(10, 13, 16, 0.86)', ground: '#0a0d10', axisText: 'rgba(206, 216, 230, 0.85)', axisLine: 'rgba(255,255,255,0.12)',
    grid: 'rgba(255,255,255,0.04)', volUp: 'rgba(38,161,123,0.45)', volDown: 'rgba(226,80,79,0.45)',
  },
  light: {
    bull: '#089981', bear: '#e0324a', text: '#1e2329', muted: '#57606a', entry: '#57606a', entryFill: 'rgba(87,96,106,0.10)',
    pill: 'rgba(255, 255, 255, 0.92)', ground: '#ffffff', axisText: 'rgba(30, 35, 41, 0.85)', axisLine: 'rgba(30,35,41,0.16)',
    grid: 'rgba(30,35,41,0.06)', volUp: 'rgba(8,153,129,0.35)', volDown: 'rgba(224,50,74,0.35)',
  },
};
export const C: ChartPalette = { ...CHART_PALETTES.dark };
/** Every layer drawn after this in the theme's colours. */
export function setChartTheme(theme: 'dark' | 'light'): void { Object.assign(C, CHART_PALETTES[theme]); }
