import { describe, expect, it } from 'vitest';
import {
  CALLOUT_W, MIN_ZONE_PX, calloutShapes, lineShapes, zoneShapes, type Converters,
} from '@/components/desk/chart-overlay';

/*
 * The library draws the candles onto a canvas a test cannot read. What it has
 * no opinion about -- where a level band, a swing line or a target callout
 * goes -- is laid out here in pixels, and that arithmetic is exactly the part
 * that can be wrong, so it is the part that is pinned.
 *
 * A plot 400 wide and 300 tall showing 80,000 at the top and 70,000 at the
 * bottom: a dollar is 0.03 of a pixel.
 */
const at = (price: number) => ((80_000 - price) / 10_000) * 300;
const c: Converters = {
  width: 400,
  height: 300,
  y: (price) => (price > 80_000 || price < 70_000 ? null : at(price)),
  x: (barsAgo) => (barsAgo > 50 ? null : 380 - barsAgo * 6),
};

describe('the level bands', () => {
  it('[critical] a band too thin to see is opened out about its own middle', () => {
    // A tenth of an ATR on a one-minute chart is a couple of pixels, and a
    // zone nobody can see is a zone nobody can use.
    const [band] = zoneShapes([{ from: 75_000, to: 75_020, label: 'Resistance zone', tone: 'up' }], c);
    expect(band!.height).toBeCloseTo(MIN_ZONE_PX, 5);
    // still centred where the prices are
    expect(band!.top + band!.height / 2).toBeCloseTo(at(75_010), 5);
  });

  it('a band wide enough is left the size it is', () => {
    const [band] = zoneShapes([{ from: 74_000, to: 76_000, label: 'Support zone', tone: 'down' }], c);
    expect(band!.height).toBeCloseTo(at(74_000) - at(76_000), 5);
  });

  it('[critical] a band off the scale is dropped, not pinned to the edge', () => {
    // Pinned, it reads as "price is right at this level", which is the
    // opposite of the truth when the level is miles away.
    expect(zoneShapes([{ from: 120_000, to: 121_000, label: 'Far above', tone: 'up' }], c)).toEqual([]);
  });

  it('the dashed edge is the side price has to get through', () => {
    const [ceiling] = zoneShapes([{ from: 76_000, to: 76_400, label: 'R', tone: 'up' }], c);
    expect(ceiling!.edge).toBeCloseTo(ceiling!.top, 5);
    const [floor] = zoneShapes([{ from: 74_000, to: 74_400, label: 'S', tone: 'down' }], c);
    expect(floor!.edge).toBeCloseTo(floor!.top + floor!.height, 5);
  });

  it('the tag sits outside the band, over a ceiling and under a floor', () => {
    const [ceiling] = zoneShapes([{ from: 76_000, to: 76_400, label: 'R', tone: 'up' }], c);
    expect(ceiling!.tagY).toBeLessThan(ceiling!.top);
    const [floor] = zoneShapes([{ from: 74_000, to: 74_400, label: 'S', tone: 'down' }], c);
    expect(floor!.tagY).toBeGreaterThan(floor!.top);
  });
});

describe('the swing lines', () => {
  it('[critical] both ends are placed from bars back, not from prices alone', () => {
    const [line] = lineShapes([{
      kind: 'support', from: { barsAgo: 10, price: 74_000 }, to: { barsAgo: 0, price: 75_000 },
    }], c);
    expect(line!.x1).toBe(320);
    expect(line!.x2).toBe(380);
    // rising: the newer end is higher up the plot, which is a smaller y
    expect(line!.y2).toBeLessThan(line!.y1);
  });

  it('a line whose bars are off the window is left out', () => {
    expect(lineShapes([{
      kind: 'resistance', from: { barsAgo: 90, price: 76_000 }, to: { barsAgo: 0, price: 76_000 },
    }], c)).toEqual([]);
  });
});

describe('the target callouts', () => {
  const p = { up: { trigger: 76_000, target1: 77_000 }, down: { trigger: 74_000, target1: 73_000 }, range: { from: 74_000, to: 76_000 } };

  it('[critical] each says which way, the price and how far that is from here', () => {
    // A five-digit target alone leaves the reader doing arithmetic against a
    // spot that is moving.
    const shapes = calloutShapes(p, 75_000, c);
    const up = shapes.find((s) => s.key === 'up')!;
    expect(up.title).toContain('Breakout');
    expect(up.price).toBe(77_000);
    expect(up.awayPct).toBeCloseTo(2.667, 2);
    const down = shapes.find((s) => s.key === 'down')!;
    expect(down.awayPct).toBeCloseTo(-2.667, 2);
  });

  it('names the range between them, because waiting is a reading too', () => {
    const range = calloutShapes(p, 75_000, c).find((s) => s.key === 'range')!;
    expect(range.low).toBe(74_000);
    expect(range.high).toBe(76_000);
    expect(range.y).toBeCloseTo(at(75_000), 5);
  });

  it('[critical] a target off the scale is drawn at the edge, with its number', () => {
    // Losing it would read as there being no target at all.
    const shapes = calloutShapes({ up: { trigger: 79_000, target1: 200_000 }, down: null }, 75_000, c);
    const up = shapes.find((s) => s.key === 'up')!;
    expect(up.price).toBe(200_000);
    expect(up.y).toBeGreaterThanOrEqual(0);
    expect(up.y).toBeLessThan(60);
  });

  it('every box is in the gutter kept clear to the right', () => {
    for (const s of calloutShapes(p, 75_000, c)) {
      expect(s.x + CALLOUT_W).toBeLessThanOrEqual(c.width);
      expect(s.x).toBeGreaterThan(c.width / 2);
    }
  });

  it('draws nothing when there is no projection', () => {
    expect(calloutShapes(null, 75_000, c)).toEqual([]);
  });
});
