import { describe, expect, it } from 'vitest';
import { globalMaxOpenProblem, signalTotals, totalsUnderCap } from '@/lib/strategy-totals';
import { DEFAULT_CONFIG, type Strategy } from '@/types/strategy';

/**
 * The switched-on signal strategies, added up: the owner's five (4 Oct 2026) --
 * 5m 3 lots x 1, 15m 5 x 9, 30m 6 x 10, 1h 5 x 7, 4h 3 x 1.
 */
const sig = (id: string, lots: number, maxOpen: number, enabled = true, trigger: 'signal' | 'time' = 'signal'): Strategy => ({
  id, name: id, enabled, createdAt: 0, updatedAt: 0, lastRunDate: null, ranToday: false, nextEntryAt: null, status: '',
  config: { ...DEFAULT_CONFIG, trigger, lots, signal: { mode: 'single', tf: '5m', methods: ['breakout'], target: 'tp1', maxOpen } },
});
const FIVE = [sig('5m', 3, 1), sig('15m', 5, 9), sig('30m', 6, 10), sig('1h', 5, 7), sig('4h', 3, 1)];
// One lot at 200x on an 85,000 BTC: 85,000 / 200 x 0.001 = $0.425.
const SPOT = 85_000;

describe('the strategies added up', () => {
  it('[critical] entries are the sum of each one\'s limit, lots each one\'s lots times its entries, and the margin all of it open', () => {
    const t = signalTotals(FIVE, 228, SPOT);
    expect(t.strategies).toBe(5);
    expect(t.entries).toBe(28);                                   // 1 + 9 + 10 + 7 + 1
    expect(t.lots).toBe(146);                                     // 3 + 45 + 60 + 35 + 3
    expect(t.marginUsd).toBeCloseTo(146 * 0.425, 6);              // $62.05
    expect(t.marginInr).toBeCloseTo(146 * 0.425 * 85, 4);
    expect(t.share).toBeCloseTo((146 * 0.425) / 228, 6);
  });

  it('[critical] only signal strategies that are switched on are counted', () => {
    const t = signalTotals([...FIVE, sig('off', 50, 50, false), sig('clock', 10, 10, true, 'time')], 228, SPOT);
    expect([t.strategies, t.entries, t.lots]).toEqual([5, 28, 146]);
  });

  it('none on: nothing to add, and no share without a balance', () => {
    expect(signalTotals([sig('off', 3, 5, false)], 228, SPOT)).toMatchObject({ strategies: 0, entries: 0, lots: 0, marginUsd: 0 });
    expect(signalTotals(FIVE, null, SPOT).share).toBeNull();
    expect(signalTotals(FIVE, 228, null).marginUsd).toBe(0);
  });
});

describe('under a desk-wide limit: the worst case', () => {
  it('[critical] the entries are taken from the strategies with the most lots first, each up to its own limit', () => {
    // 6 entries: all from the 30m strategy (6 lots each, allows 10) = 36 lots
    const six = totalsUnderCap(FIVE, 6, 228, SPOT);
    expect([six.entries, six.lots]).toEqual([6, 36]);
    expect(six.marginUsd).toBeCloseTo(36 * 0.425, 6);
    // 12 entries: ten of 6 lots, then two of 5 = 70 lots
    expect(totalsUnderCap(FIVE, 12, 228, SPOT).lots).toBe(70);
  });

  it('no limit, or one at or above what they allow, is the totals themselves', () => {
    const all = signalTotals(FIVE, 228, SPOT);
    expect(totalsUnderCap(FIVE, 0, 228, SPOT)).toEqual(all);
    expect(totalsUnderCap(FIVE, 28, 228, SPOT)).toEqual(all);
    expect(totalsUnderCap(FIVE, 40, 228, SPOT)).toEqual(all);
  });
});

describe('the limit, checked as it is typed -- the server\'s words', () => {
  it('[critical] above what the strategies allow is refused with their sum; the sum itself, anything under it and 0 are fine', () => {
    expect(globalMaxOpenProblem(30, 28, 500)).toBe('The strategies switched on allow 28 entries between them, so a limit above 28 changes nothing. Enter 28 or less.');
    for (const ok of [0, 1, 6, 28]) expect(globalMaxOpenProblem(ok, 28, 500)).toBeNull();
    expect(globalMaxOpenProblem(2, 1, 500)).toMatch(/allow 1 entry between them/);
  });

  it('not a whole number from 0 to the most allowed is said as that', () => {
    for (const bad of [-1, 501, 2.5, NaN]) expect(globalMaxOpenProblem(bad, 28, 500)).toBe('At most open at once, across all strategies, must be a whole number from 0 (no limit) to 500.');
  });

  it('with no strategy switched on there is no sum to hold it to', () => {
    expect(globalMaxOpenProblem(40, 0, 500)).toBeNull();
  });
});
