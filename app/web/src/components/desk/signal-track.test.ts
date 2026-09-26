import { describe, expect, it } from 'vitest';
import { trackFor } from '@/components/desk/signal-track';

/*
 * The track under each signal: trigger at one end, target at the other, a dot
 * for where price reached. A dot on the wrong side of a trigger is a row that
 * says the opposite of the truth, which is why this is arithmetic and not a
 * stylesheet.
 */
const watch = { side: 'UP' as const, trigger: 84_532, target: 84_731, outcome: null };

describe('the signal track', () => {
  it('[critical] a setup short of its trigger sits at the start, and says how far short', () => {
    const t = trackFor({ ...watch, price: 84_436 })!;
    expect(t.reached).toBe(false);
    expect(t.at).toBe(0);
    expect(t.shortBy).toBe(96);
    expect(t.tone).toBe('flat');
  });

  it('[critical] once through the trigger the dot moves towards the target', () => {
    const half = trackFor({ ...watch, price: 84_632 })!;
    expect(half.reached).toBe(true);
    expect(half.at).toBeCloseTo(0.5, 2);
    expect(half.shortBy).toBeNull();
  });

  it('an overshoot sits at the end rather than running off it', () => {
    expect(trackFor({ ...watch, price: 85_200, outcome: 'TARGET_HIT' })!.at).toBe(1);
  });

  it('[critical] a breakdown runs the other way, and the same arithmetic holds', () => {
    const down = { side: 'DOWN' as const, trigger: 84_309, target: 84_111, outcome: null };
    expect(trackFor({ ...down, price: 84_412 })).toMatchObject({ reached: false, shortBy: 103, at: 0 });
    expect(trackFor({ ...down, price: 84_210 })!.at).toBeCloseTo(0.5, 2);
  });

  it('the colour follows what happened, not which way it was pointing', () => {
    // A breakdown that reached its target is green: the call came good.
    const down = { side: 'DOWN' as const, trigger: 84_309, target: 84_111 };
    expect(trackFor({ ...down, price: 84_100, outcome: 'TARGET_HIT' })!.tone).toBe('up');
    expect(trackFor({ ...down, price: 84_450, outcome: 'INVALIDATED' })!.tone).toBe('down');
  });

  it('nothing to draw is nothing, not a track at zero', () => {
    expect(trackFor({ ...watch, price: null })).toBeNull();
    expect(trackFor({ ...watch, trigger: null, price: 1 })).toBeNull();
    expect(trackFor({ side: null, trigger: 1, target: 2, price: 1, outcome: null })).toBeNull();
    expect(trackFor({ ...watch, target: 84_532, price: 84_532 })).toBeNull();
  });
});
