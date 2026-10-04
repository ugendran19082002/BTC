import { describe, expect, it } from 'vitest';
import { globalMaxOpenProblem, roomLeft, signalTotals } from '@/lib/strategy-totals';
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

describe('what can still open, at worst -- the number to hold against the free margin', () => {
  const holding = (s: Strategy, trades: number): Strategy => ({ ...s, open: { trades, lots: trades * s.config.lots } });

  it('[critical] nothing open, no limit: every entry the strategies allow', () => {
    const r = roomLeft(FIVE, 0, 0, SPOT);
    expect([r.entries, r.lots]).toEqual([28, 146]);
    expect(r.marginUsd).toBeCloseTo(146 * 0.425, 6);
  });

  it('[critical] under a limit: only the places it leaves, taken from the largest lots first', () => {
    // limit 6, nothing open: six entries of the 6-lot strategy
    expect(roomLeft(FIVE, 6, 0, SPOT)).toMatchObject({ entries: 6, lots: 36 });
    // limit 12: ten of 6 lots, then two of 5
    expect(roomLeft(FIVE, 12, 0, SPOT)).toMatchObject({ entries: 12, lots: 70 });
  });

  it('[critical] what is already open is not counted again: the limit less the desk\'s open trades, each strategy\'s limit less its own', () => {
    // 30m holds 4 of its 10 (6 lots each), 15m holds 3 of its 9 (5 lots); 7 open on the desk, limit 12: five places left
    const now = FIVE.map((s) => (s.id === '30m' ? holding(s, 4) : s.id === '15m' ? holding(s, 3) : s));
    const r = roomLeft(now, 12, 7, SPOT);
    expect([r.entries, r.lots]).toEqual([5, 30]);                 // five more of the 6-lot strategy, which has room for six
    expect(r.marginUsd).toBeCloseTo(30 * 0.425, 6);
    // a trade from the ticket takes a place too: 8 open on the desk leaves four
    expect(roomLeft(now, 12, 8, SPOT)).toMatchObject({ entries: 4, lots: 24 });
  });

  it('[critical] at the limit, or with every strategy full: nothing more can open', () => {
    expect(roomLeft(FIVE, 6, 6, SPOT)).toEqual({ entries: 0, lots: 0, marginUsd: 0 });
    expect(roomLeft(FIVE, 6, 9, SPOT)).toEqual({ entries: 0, lots: 0, marginUsd: 0 });
    expect(roomLeft(FIVE.map((s) => holding(s, s.config.signal!.maxOpen)), 0, 28, SPOT)).toEqual({ entries: 0, lots: 0, marginUsd: 0 });
  });

  it('a strategy holding more than its limit (the limit lowered since) has no room, not negative room', () => {
    const over = FIVE.map((s) => (s.id === '4h' ? holding(s, 3) : s));
    expect(roomLeft(over, 0, 3, SPOT).entries).toBe(27);           // 28 less the 4h strategy's one place
  });

  it('[critical] the owner\'s desk, 4 Oct: 54 allowed, 12 open (65 lots), limit 28 -- the 16 places left, not the whole requirement', () => {
    // five strategies adding to 54 entries and 265 lots; what is open adds to 12 trades and 65 lots
    const desk = [holding(sig('a', 8, 12), 2), holding(sig('b', 5, 14), 5), holding(sig('c', 6, 10), 3), holding(sig('d', 3, 3), 2), holding(sig('e', 2, 15), 0)];
    const t = signalTotals(desk, null, SPOT);
    expect([t.entries, t.lots]).toEqual([54, 265]);
    const r = roomLeft(desk, 28, 12, SPOT);
    // 16 places left: ten more of the 8-lot strategy, then six of the 6-lot one
    expect([r.entries, r.lots]).toEqual([16, 116]);
    expect(r.marginUsd * 85).toBeCloseTo(4_190.5, 1);
    // what is open (65 lots) is already margined, and is no part of this number
    expect(desk.reduce((n, x) => n + x.open!.lots, 0)).toBe(65);
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
