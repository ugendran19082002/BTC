import { describe, expect, it } from 'vitest';
import { markerPctOf, markerPctWords, railOf } from '@/lib/exit-rail';

describe('railOf: the price between its target and its stop', () => {
  // A sold option, as in the owner's reference: in at 45.2, target 30, stop 62.
  const short = { entry: 45.2, target: 30, stop: 62 };

  it('the target at the left, the stop at the right, the entry between them in proportion', () => {
    const r = railOf({ ...short, current: 45.2 })!;
    expect(r.targetAt).toBe(8);
    expect(r.stopAt).toBe(92);
    // 15.2 of the 32 points from target to stop: 47.5% of the way along the line
    expect(r.entryAt).toBeCloseTo(8 + 84 * (15.2 / 32), 5);
    expect(r.currentAt).toBeCloseTo(r.entryAt!, 5);
    expect(r.side).toBeNull();
    expect(r.hit).toBeNull();
  });

  it('[critical] moves left and green toward the target, right and red toward the stop', () => {
    const win = railOf({ ...short, current: 38.4 })!;
    expect(win.side).toBe('target');
    expect(win.currentAt!).toBeLessThan(win.entryAt!);
    expect(win.toTarget!.points).toBeCloseTo(8.4, 5);
    expect(win.toStop!.points).toBeCloseTo(23.6, 5);
    const lose = railOf({ ...short, current: 59.1 })!;
    expect(lose.side).toBe('stop');
    expect(lose.currentAt!).toBeGreaterThan(lose.entryAt!);
    expect(lose.toStop!.points).toBeCloseTo(2.9, 5);
    expect(lose.toStop!.pct).toBeCloseTo(2.9 / 59.1, 5);
  });

  it('[critical] says when a level is hit, and stays on the line when the price runs past it', () => {
    expect(railOf({ ...short, current: 30 })).toMatchObject({ hit: 'target', currentAt: 8, toTarget: { points: 0 } });
    const past = railOf({ ...short, current: 70 })!;
    expect(past.hit).toBe('stop');
    expect(past.currentAt).toBe(98);
    expect(past.toStop).toEqual({ points: 0, pct: 0 });
  });

  it('reads the same for a long: its target above, its stop below, still left and right', () => {
    // A BUY view on the perp: in at 62,400, target 63,500, stop 62,000.
    const long = { entry: 62_400, target: 63_500, stop: 62_000 };
    const up = railOf({ ...long, current: 62_950 })!;
    expect(up.side).toBe('target');
    expect(up.currentAt!).toBeLessThan(up.entryAt!);
    expect(up.toTarget!.points).toBe(550);
    expect(railOf({ ...long, current: 61_990 })!.hit).toBe('stop');
  });

  it('draws with one level only, with no entry, and not at all with neither', () => {
    const stopOnly = railOf({ entry: 45, target: null, stop: 60, current: 50 })!;
    expect(stopOnly).toMatchObject({ targetAt: null, entryAt: 8, stopAt: 92, side: 'stop', toTarget: null });
    expect(stopOnly.currentAt).toBeCloseTo(8 + 84 / 3, 5);
    const noEntry = railOf({ entry: null, target: 30, stop: 60, current: 45 })!;
    expect(noEntry).toMatchObject({ entryAt: null, currentAt: 50, side: null });
    expect(railOf({ entry: 45, target: null, stop: null, current: 50 })).toBeNull();
    expect(railOf({ ...short, current: null })).toMatchObject({ currentAt: null, toStop: null });
  });

  it('keeps the entry clear of the ends when one level is far nearer than the other', () => {
    expect(railOf({ entry: 31, target: 30, stop: 90, current: 31 })!.entryAt).toBe(28);
    expect(railOf({ entry: 89, target: 30, stop: 90, current: 89 })!.entryAt).toBe(72);
  });
});

/** The live % on the marker (22 Nov 2026): + toward the target, − toward the stop. */
describe('markerPctOf', () => {
  // The owner's card: a PE sold at 80, target 4 (95% kept), stop 214 (+167%... the rail's own levels).
  const sale = { entry: 80, target: 4, stop: 214 };

  it('[critical] the option, premium kept: a sale at 80 is +8.75% at 73, +95% at its target, −18% at 94.4, and its stop is the stop\'s share', () => {
    expect(markerPctWords(markerPctOf('kept', { ...sale, current: 73 })!)).toBe('+9%');
    expect(markerPctOf('kept', { ...sale, current: 4 })).toBeCloseTo(0.95, 9);
    expect(markerPctWords(markerPctOf('kept', { ...sale, current: 94.4 })!)).toBe('−18%');
    expect(markerPctWords(markerPctOf('kept', { entry: 76, target: 3.8, stop: 266, current: 266 })!)).toBe('−250%');
    expect(markerPctWords(markerPctOf('kept', { ...sale, current: 80 })!)).toBe('0%');
    // An option bought: profit is the price above the entry.
    expect(markerPctWords(markerPctOf('kept', { entry: 20, target: 30, stop: 15, current: 25 })!)).toBe('+25%');
    expect(markerPctWords(markerPctOf('kept', { entry: 20, target: null, stop: 15, current: 18 })!)).toBe('−10%');
  });

  it('[critical] the perp, how far along: +100% at the target, −100% at the stop, either way round', () => {
    const long = { entry: 60_000, target: 60_500, stop: 59_600 };
    expect(markerPctWords(markerPctOf('progress', { ...long, current: 60_250 })!)).toBe('+50%');
    expect(markerPctWords(markerPctOf('progress', { ...long, current: 59_800 })!)).toBe('−50%');
    expect(markerPctWords(markerPctOf('progress', { ...long, current: 60_500 })!)).toBe('+100%');
    const short = { entry: 60_000, target: 59_000, stop: 60_400 };
    expect(markerPctWords(markerPctOf('progress', { ...short, current: 59_750 })!)).toBe('+25%');
    expect(markerPctWords(markerPctOf('progress', { ...short, current: 60_400 })!)).toBe('−100%');
  });

  it('nothing to say without an entry, a price or a direction', () => {
    expect(markerPctOf('kept', { ...sale, current: null })).toBeNull();
    expect(markerPctOf('kept', { entry: null, target: 4, stop: 214, current: 50 })).toBeNull();
    expect(markerPctOf('kept', { entry: 80, target: null, stop: null, current: 50 })).toBeNull();
    expect(markerPctOf('progress', { entry: 80, target: null, stop: null, current: 50 })).toBeNull();
  });
});
