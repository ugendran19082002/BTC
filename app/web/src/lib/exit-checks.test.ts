import { describe, expect, it } from 'vitest';
import { checkExits } from '@/lib/exit-checks';

/**
 * Every position here is short, so the arithmetic is the opposite way round
 * from the one most people have in their fingers: the target is *below* and
 * the stop is *above*. Getting that backwards is what fired a take-profit at
 * the price a short had just been sold at, twice, on 9 September.
 */

const at = (over: Partial<Parameters<typeof checkExits>[0]> = {}) =>
  checkExits({ mark: 17.5, entry: 19, targetPrice: 16.3, stopPrice: null, ...over });

describe('an ordinary pair of levels', () => {
  it('has nothing to say', () => {
    expect(at()).toEqual([]);
  });

  it('says nothing about a stop above the mark either', () => {
    expect(at({ stopPrice: 22 })).toEqual([]);
  });

  it('or about exits that are switched off', () => {
    expect(at({ targetPrice: null, stopPrice: null })).toEqual([]);
  });
});

describe('a level the mark has already passed', () => {
  it('says a target at or above the mark fills at once', () => {
    const [c] = at({ targetPrice: 18 });
    expect(c).toMatchObject({ leg: 'target', kind: 'now' });
    expect(c!.message).toContain('fills as soon as it is set');
  });

  it('counts exactly at the mark as reached, not as safe', () => {
    // an exact touch is a fill, and rounding will not save it
    expect(at({ targetPrice: 17.5 })).toHaveLength(1);
  });

  it('[critical] says a stop at or below the mark fires at once', () => {
    const [c] = at({ targetPrice: null, stopPrice: 17 });
    expect(c).toMatchObject({ leg: 'stop', kind: 'now' });
    expect(c!.message).toContain('at the market');
  });

  it('points at close now, which is what somebody in that position means', () => {
    expect(at({ targetPrice: null, stopPrice: 17 })[0]!.message).toContain('close now');
  });
});

describe('a level on the wrong side of the entry', () => {
  it('calls a target above the entry what it is: a loss', () => {
    const found = at({ mark: 25, targetPrice: 22 }).find((c) => c.kind === 'wrong-side');
    expect(found?.leg).toBe('target');
    expect(found?.message).toContain('book a loss');
  });

  it('calls a stop below the entry what it is: a target', () => {
    const found = at({ mark: 10, targetPrice: null, stopPrice: 15 })
      .find((c) => c.kind === 'wrong-side');
    expect(found?.message).toContain('That is a target, not a stop');
  });
});

describe('when there is nothing to check against', () => {
  it('claims nothing without a mark', () => {
    expect(at({ mark: null })).toEqual([]);
    expect(at({ mark: undefined })).toEqual([]);
  });

  it('claims nothing on a nonsensical mark', () => {
    expect(at({ mark: 0 })).toEqual([]);
    expect(at({ mark: Number.NaN })).toEqual([]);
  });

  it('still checks the mark when the entry is unknown', () => {
    // a fill that has not been averaged yet must not disable the whole check
    expect(at({ entry: null, targetPrice: 18 })).toHaveLength(1);
  });
});
