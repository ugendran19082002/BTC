import type { Candle } from '@/types/desk';
import type { EntryOverlay } from '@/types/entry';
import { C, type SceneItem } from './scene';

/**
 * The chosen entry setup, drawn on the chart: the entry zone as a box from
 * the bar the setup was anchored to, the stop and the targets as lines to the
 * right edge. Drawn only for a TRADE -- a WAIT has no levels to draw (TEST.md).
 */

const fmt = (p: number) => Math.round(p).toLocaleString('en-US');

export function entryScene(e: EntryOverlay, bars: readonly Candle[]): SceneItem[] {
  if (!bars.length) return [];
  const long = e.dir === 'long';
  let x1 = Math.max(0, bars.length - 6);
  if (e.triggerTime !== null) {
    const i = bars.findIndex((b) => b.time >= e.triggerTime!);
    if (i >= 0) x1 = i;
  }
  const items: SceneItem[] = [
    {
      t: 'box', layer: 'trade', x1, x2: 'right', y1: e.entryLo, y2: Math.max(e.entryHi, e.entryLo + 1),
      fill: long ? C.bullFill : C.bearFill, stroke: long ? C.bull : C.bear,
      label: `${long ? 'LONG' : 'SHORT'} ${e.label} · entry ${fmt(e.entryLo)}–${fmt(e.entryHi)}`, labelColor: C.text, priority: 96,
    },
    { t: 'line', layer: 'trade', x1, x2: 'right', y: e.stop, color: C.bear, width: 1.5, label: `SL ${fmt(e.stop)}`, labelAt: 'end', priority: 95 },
    { t: 'line', layer: 'trade', x1, x2: 'right', y: e.tp1, color: C.bull, width: 1.5, label: `TP1 ${fmt(e.tp1)} · R:R ${e.rr.toFixed(1)}`, labelAt: 'end', priority: 95 },
  ];
  if (e.tp2 !== null) items.push({ t: 'line', layer: 'trade', x1, x2: 'right', y: e.tp2, color: C.bull, dash: 'dash', label: `TP2 ${fmt(e.tp2)}`, labelAt: 'end', priority: 94 });
  if (e.tp3 !== null) items.push({ t: 'line', layer: 'trade', x1, x2: 'right', y: e.tp3, color: C.muted, dash: 'dot', label: `TP3 ${fmt(e.tp3)} (expected move)`, labelAt: 'end', priority: 93 });
  return items;
}
