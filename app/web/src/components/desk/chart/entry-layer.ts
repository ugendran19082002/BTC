import type { Candle } from '@/types/desk';
import type { EntryOverlay } from '@/types/entry';
import { C, type SceneItem } from './scene';

/**
 * The chosen entry setup, drawn on the chart: the entry zone as a box from
 * the bar the setup was anchored to, the stop and the targets as lines to the
 * right edge. Drawn only for a TRADE -- a WAIT has no levels to draw (TEST.md).
 */

const fmt = (p: number) => Math.round(p).toLocaleString('en-US');
/** The entry's own colour: blue, apart from the stop (red) and the targets (green) on either side of it. */
export const ENTRY = '#3b82f6';
const ENTRY_FILL = 'rgba(59,130,246,0.14)';

export function entryScene(e: EntryOverlay, bars: readonly Candle[]): SceneItem[] {
  if (!bars.length) return [];
  const long = e.dir === 'long';
  let x1 = Math.max(0, bars.length - 6);
  if (e.triggerTime !== null) {
    const i = bars.findIndex((b) => b.time >= e.triggerTime!);
    if (i >= 0) x1 = i;
  }
  // The entry in its own colour -- blue, never the stop's red or the targets' green -- as a box (the zone)
  // and a solid line where the trade fills: the edge price reaches first (the top for a long).
  const fill = long ? e.entryHi : e.entryLo;
  const items: SceneItem[] = [
    {
      t: 'box', layer: 'entry', x1, x2: 'right', y1: e.entryLo, y2: Math.max(e.entryHi, e.entryLo + 1),
      fill: ENTRY_FILL, stroke: ENTRY,
      label: `${long ? 'LONG' : 'SHORT'} ${e.label} · entry ${fmt(e.entryLo)}–${fmt(e.entryHi)}`, labelColor: C.text, priority: 96,
    },
    { t: 'line', layer: 'entry', x1, x2: 'right', y: fill, color: ENTRY, width: 2, label: `ENTRY ${fmt(fill)}`, labelAt: 'end', priority: 96 },
    { t: 'line', layer: 'entry', x1, x2: 'right', y: e.stop, color: C.bear, width: 1.5, label: `SL ${fmt(e.stop)}`, labelAt: 'end', priority: 95 },
    { t: 'line', layer: 'entry', x1, x2: 'right', y: e.tp1, color: C.bull, width: 1.5, label: `TP1 ${fmt(e.tp1)} · R:R ${e.rr.toFixed(1)}`, labelAt: 'end', priority: 95 },
  ];
  if (e.tp2 !== null) items.push({ t: 'line', layer: 'entry', x1, x2: 'right', y: e.tp2, color: C.bull, dash: 'dash', label: `TP2 ${fmt(e.tp2)}`, labelAt: 'end', priority: 94 });
  if (e.tp3 !== null) items.push({ t: 'line', layer: 'entry', x1, x2: 'right', y: e.tp3, color: C.muted, dash: 'dot', label: `TP3 ${fmt(e.tp3)} (expected move)`, labelAt: 'end', priority: 93 });
  return items;
}
