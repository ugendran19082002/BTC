import { describe, expect, it } from 'vitest';
import { dayLabel, exitLines, expiryDayOf, netText, pairOf, ptsText, rangeOf, sparkOf, timeIst, winRate } from '@/lib/market-report';
import type { Tot } from '@/types/market-report';

const at = (iso: string) => Date.parse(`${iso}+05:30`);
const tot = (o: Partial<Tot> = {}): Tot => ({ n: 0, wins: 0, losses: 0, open: 0, net: 0, won: 0, lost: 0, netR: 0, exits: {}, ...o });

describe('the expiry day', () => {
  it('runs from 5:30 PM IST to 5:30 PM IST and is named for the day it ends on', () => {
    expect(expiryDayOf(at('2026-10-12T17:29:59'))).toBe('2026-10-12');
    expect(expiryDayOf(at('2026-10-12T17:30:00'))).toBe('2026-10-13');
    expect(expiryDayOf(at('2026-10-13T09:00:00'))).toBe('2026-10-13');
  });
  it('a range ends on the day in progress: since 1 Oct, or the last 7 or 30 expiry days', () => {
    const now = at('2026-10-13T11:00:00');
    expect(rangeOf('all', now)).toEqual({ from: '2026-10-01', to: '2026-10-13' });
    expect(rangeOf('7', now)).toEqual({ from: '2026-10-07', to: '2026-10-13' });
    expect(rangeOf('30', now)).toEqual({ from: '2026-09-14', to: '2026-10-13' });
  });
  it('is said as a date, and a moment as an IST time', () => {
    expect(dayLabel('2026-10-13')).toBe('Tue 13 Oct');
    expect(timeIst(at('2026-10-12T21:45:00'))).toBe('9:45 PM');
    expect(timeIst(at('2026-10-13T00:05:00'))).toBe('12:05 AM');
  });
});

describe('a record\'s figures', () => {
  it('the signal history is in perp points, real orders in rupees', () => {
    expect(ptsText(1240.4)).toBe('+1,240 pts');
    expect(ptsText(-300)).toBe('−300 pts');
    expect(netText('signal', 0)).toBe('0 pts');
    expect(netText('real', 1)).toMatch(/^\+₹/);
    expect(netText('real', -2)).toMatch(/^−₹/);
  });
  it('the win rate is of closed trades, and nothing with none closed', () => {
    expect(winRate(tot({ n: 4, wins: 3 }))).toBe(0.75);
    expect(winRate(tot({ open: 2 }))).toBeNull();
  });
  it('the exits are read in one order, each with its share of the closed trades', () => {
    const lines = exitLines(tot({ n: 10, exits: { 'option-sl': { n: 1, net: -8 }, 'perp-tgt': { n: 3, net: 2 }, 'option-tgt': { n: 6, net: 9 }, manual: { n: 0, net: 0 } } }));
    expect(lines.map((x) => [x.label, x.n, x.share])).toEqual([['Perp TGT', 3, 0.3], ['Option TGT', 6, 0.6], ['Option SL', 1, 0.1]]);
    expect(exitLines(tot())).toEqual([]);
  });
  it('a row reads as a pair: trades, win rate, profit factor', () => {
    expect(pairOf({ ...tot({ n: 4, wins: 3, losses: 1, net: 20, won: 30, lost: 10 }), key: 'k', name: '#1 Breakout', tf: '15m' }))
      .toEqual({ key: 'k', name: '#1 Breakout', tf: '15m', trades: 4, wins: 3, losses: 1, winRate: 0.75, profitFactor: 3, net: 20 });
    expect(pairOf({ ...tot({ n: 1, wins: 1, net: 5, won: 5 }), key: 'k', name: 'x' }).profitFactor).toBeNull();
  });
  it('a day\'s closes become a line, with where its high and low fall', () => {
    const s = sparkOf([10, 30, 20], 100, 50, 0)!;
    expect(s.d).toBe('M0.0,50.0L50.0,0.0L100.0,25.0');
    expect(s.hi).toEqual([50, 0]); expect(s.lo).toEqual([0, 50]);
    expect(sparkOf([5], 100, 50)).toBeNull();
  });
});
