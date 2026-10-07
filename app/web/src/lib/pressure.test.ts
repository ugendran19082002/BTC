import { describe, expect, it } from 'vitest';
import type { ChainResponse, Leg } from '@/types/desk';
import { atmLeg, bookOf, buySellShare, deltaBars, deskLeg, kct, sideRead, spreadOf } from '@/lib/pressure';

const leg = (cp: 'C' | 'P', strike: number, o: Partial<Leg> = {}): Leg => ({ cp, strike, bid: 40, ask: 41, bidSize: 60, askSize: 40, mark: 40.5, ...o } as Leg);
const chain = (o: { sides?: { side: 'CE' | 'PE'; leg: Leg | null }[]; legs?: Leg[]; pick?: { cp: 'C' | 'P'; strike: number } | null; bestOfNone?: boolean }) => ({
  recommendation: { sides: o.sides ?? [] }, legs: o.legs ?? [], best: { pick: o.pick ?? null, bestOfNone: o.bestOfNone ?? false },
}) as unknown as Pick<ChainResponse, 'recommendation' | 'legs' | 'best'>;

describe('pressure readings', () => {
  it('[critical] the early warning\'s strike is the desk\'s own pick, the put before the call', () => {
    const pe = leg('P', 83_200), ce = leg('C', 87_000);
    expect(deskLeg(chain({ sides: [{ side: 'CE', leg: ce }, { side: 'PE', leg: pe }], legs: [pe, ce] }))).toBe(pe);
    expect(deskLeg(chain({ sides: [{ side: 'CE', leg: ce }, { side: 'PE', leg: null }], legs: [ce] }))).toBe(ce);
    // no side recommended and no leg to fall back on: the best trade's pick, unless it is only the best of none
    const picked = leg('C', 86_400);
    expect(deskLeg(chain({ legs: [], pick: { cp: 'C', strike: 86_400 } }))).toBeNull();
    expect(deskLeg({ ...chain({ pick: { cp: 'C', strike: 86_400 } }), legs: [] })).toBeNull();
    expect(deskLeg(chain({ pick: null }))).toBeNull();
    expect(picked.strike).toBe(86_400);
  });

  it('the at-the-money option stands for a side\'s book: its imbalance and its spread', () => {
    const legs = [leg('C', 83_800), leg('P', 83_800, { bidSize: 10, askSize: 30, bid: 39, ask: 41 }), leg('C', 84_000)];
    expect(atmLeg(legs, 'P', 83_800)!.cp).toBe('P');
    expect(atmLeg(legs, 'P', 84_000)).toBeNull();
    expect(bookOf(legs[0]!)).toBeCloseTo(0.2, 6);
    expect(bookOf(legs[1]!)).toBeCloseTo(-0.5, 6);
    expect(spreadOf(legs[1]!)).toBeCloseTo(0.05, 6);
    expect(bookOf(leg('C', 1, { bidSize: 0, askSize: 0 }))).toBeNull();
    expect(bookOf(leg('C', 1, { bidSize: null }))).toBeNull();
    expect(spreadOf(leg('C', 1, { bid: null }))).toBeNull();
    expect(bookOf(null)).toBeNull();
    expect(spreadOf(null)).toBeNull();
  });

  it('contracts said short, and buy against sell as two shares of one bar', () => {
    expect(kct(1_606_500)).toBe('1,606.5K');
    expect(kct(2_063_100)).toBe('2,063.1K');
    expect(kct(940)).toBe('940');
    expect(buySellShare(1_606.5, 2_063.1).buy).toBeCloseTo(0.4378, 4);
    expect(buySellShare(1, 3)).toEqual({ buy: 0.25, sell: 0.75 });
    expect(buySellShare(0, 0)).toEqual({ buy: 0, sell: 0 });
  });

  it('[critical] a side as its card says it: the word, the share of the side that leads, and where the mark sits', () => {
    expect(sideRead({ pressure: 'SELL PRESSURE', aggressorBuyPct: 0.28 })).toEqual({ word: 'SELL', sub: 'pressure', tone: 'down', buyShare: 0.28, leadPct: 72, leadWords: '72% sells' });
    expect(sideRead({ pressure: 'BUY PRESSURE', aggressorBuyPct: 0.68 })).toMatchObject({ word: 'BUY', tone: 'up', buyShare: 0.68, leadPct: 68, leadWords: '68% buys' });
    expect(sideRead({ pressure: 'BALANCED', aggressorBuyPct: 0.51 })).toMatchObject({ word: 'BALANCED', sub: 'both sides', tone: 'flat', leadPct: 51 });
    // no prints is not "balanced"
    for (const x of [null, undefined, { pressure: null, aggressorBuyPct: null }, { pressure: 'BUY PRESSURE' as const, aggressorBuyPct: null }]) {
      expect(sideRead(x)).toMatchObject({ word: '—', sub: 'no prints', buyShare: null, leadPct: null });
    }
  });

  it('a side\'s delta minute by minute as a few bars: each the sum of its minutes, sized against the largest', () => {
    const d = (...v: number[]) => v.map((delta) => ({ delta }));
    expect(deltaBars(d(4, -2, 1))).toEqual([{ up: true, size: 1 }, { up: false, size: 0.5 }, { up: true, size: 0.25 }]);
    // sixty minutes into twelve bars of five
    const hour = deltaBars(Array.from({ length: 60 }, (_, i) => ({ delta: i < 5 ? 2 : -1 })));
    expect(hour).toHaveLength(12);
    expect(hour[0]).toEqual({ up: true, size: 1 });
    expect(hour[1]).toEqual({ up: false, size: 0.5 });
    expect(deltaBars([])).toEqual([]);
    expect(deltaBars(d(0, 0))).toEqual([{ up: true, size: 0 }, { up: true, size: 0 }]);
  });
});
