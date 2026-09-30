import { describe, expect, it } from 'vitest';
import { ENTRY, entryScene } from './entry-layer';
import type { EntryOverlay } from '@/types/entry';

const bars = Array.from({ length: 20 }, (_, i) => ({ time: 1_000 + i * 300, open: 1, high: 2, low: 0, close: 1, volume: 1 }));
const long: EntryOverlay = { dir: 'long', entryLo: 84_120, entryHi: 84_160, stop: 83_980, tp1: 84_300, tp2: 84_500, tp3: null, rr: 2.4, label: '#3 Liquidity sweep', triggerTime: 1_000 + 12 * 300 };

describe('the entry setup on the chart', () => {
  it('[critical] an entry box from the trigger bar, the stop and each target as a line to the right edge', () => {
    const items = entryScene(long, bars);
    const box = items.find((x) => x.t === 'box');
    expect(box).toMatchObject({ x1: 12, x2: 'right', y1: 84_120, y2: 84_160 });
    const lines = items.filter((x) => x.t === 'line').map((x) => (x.t === 'line' ? x.label : ''));
    // Each level in R from the fill (84,160 for a long) and in points: risk 180.
    expect(lines).toEqual(['ENTRY 84,160', 'SL 83,980 · −1.0R · 180 pts', 'TP1 84,300 · +0.8R · 140 pts · R:R 2.4 after fees', 'TP2 84,500 · +1.9R · 340 pts']);
  });

  it('[critical] the entry has its own colour -- blue -- apart from the red stop and the green targets; its line is where the trade fills', () => {
    const items = entryScene(long, bars);
    const box = items.find((x) => x.t === 'box')!;
    const line = (l: string) => items.find((x) => x.t === 'line' && x.label?.startsWith(l)) as Extract<typeof items[number], { t: 'line' }>;
    expect(box.t === 'box' && box.stroke).toBe(ENTRY);
    expect(line('ENTRY').color).toBe(ENTRY);
    expect(line('ENTRY').y).toBe(84_160); // a long fills at the top of its zone
    expect(line('SL').color).not.toBe(ENTRY);
    expect(line('TP1').color).not.toBe(ENTRY);
    const short = entryScene({ ...long, dir: 'short', stop: 84_300, tp1: 84_000, tp2: null }, bars);
    expect((short.find((x) => x.t === 'line' && x.label?.startsWith('ENTRY')) as { y: number }).y).toBe(84_120); // a short at the bottom
  });

  it('a TP3 only when there is one, and nothing without candles', () => {
    expect(entryScene({ ...long, tp3: 85_000 }, bars).some((x) => x.t === 'line' && x.label?.startsWith('TP3'))).toBe(true);
    expect(entryScene(long, [])).toEqual([]);
  });
});
