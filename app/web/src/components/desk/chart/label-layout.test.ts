import { describe, expect, it } from 'vitest';
import { placeLabels, stacked } from './label-layout';

const bounds = { x: 0, y: 0, w: 500, h: 300 };

describe('placeLabels', () => {
  it('[critical] the higher priority keeps its place and the lower one moves or goes', () => {
    const r = { x: 10, y: 10, w: 60, h: 14 };
    const out = placeLabels([
      { id: 1, priority: 10, candidates: [r] },
      { id: 2, priority: 100, candidates: [r] },
    ], bounds);
    expect(out.get(2)).toEqual(r);
    expect(out.has(1)).toBe(false);
  });

  it('a label slides to its next free position before it is dropped', () => {
    const r = { x: 10, y: 100, w: 60, h: 14 };
    const out = placeLabels([
      { id: 1, priority: 100, candidates: [r] },
      { id: 2, priority: 50, candidates: stacked(r, 16) },
    ], bounds);
    expect(out.get(2)!.y).not.toBe(100);
  });

  it('never places a label outside the pane or over a reserved area', () => {
    const out = placeLabels([
      { id: 1, priority: 1, candidates: [{ x: 490, y: 10, w: 60, h: 14 }] },
      { id: 2, priority: 1, candidates: [{ x: 10, y: 10, w: 60, h: 14 }] },
    ], bounds, [{ x: 0, y: 0, w: 200, h: 80 }]);
    expect(out.size).toBe(0);
  });
});
