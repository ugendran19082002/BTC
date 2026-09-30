import { describe, expect, it } from 'vitest';
import { entryScene } from './entry-layer';
import type { EntryOverlay } from '@/types/entry';

const bars = Array.from({ length: 20 }, (_, i) => ({ time: 1_000 + i * 300, open: 1, high: 2, low: 0, close: 1, volume: 1 }));
const long: EntryOverlay = { dir: 'long', entryLo: 84_120, entryHi: 84_160, stop: 83_980, tp1: 84_300, tp2: 84_500, tp3: null, rr: 2.4, label: '#3 Liquidity sweep', triggerTime: 1_000 + 12 * 300 };

describe('the entry setup on the chart', () => {
  it('[critical] an entry box from the trigger bar, the stop and each target as a line to the right edge', () => {
    const items = entryScene(long, bars);
    const box = items.find((x) => x.t === 'box');
    expect(box).toMatchObject({ x1: 12, x2: 'right', y1: 84_120, y2: 84_160 });
    const lines = items.filter((x) => x.t === 'line').map((x) => (x.t === 'line' ? x.label : ''));
    expect(lines).toEqual(['SL 83,980', 'TP1 84,300 · R:R 2.4', 'TP2 84,500']);
  });

  it('a TP3 only when there is one, and nothing without candles', () => {
    expect(entryScene({ ...long, tp3: 85_000 }, bars).some((x) => x.t === 'line' && x.label?.startsWith('TP3'))).toBe(true);
    expect(entryScene(long, [])).toEqual([]);
  });
});
