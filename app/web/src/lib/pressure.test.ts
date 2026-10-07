import { describe, expect, it } from 'vitest';
import type { ChainResponse, Leg } from '@/types/desk';
import { atmLeg, bookOf, buySellShare, deskLeg, kct, spreadOf } from '@/lib/pressure';

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
});
