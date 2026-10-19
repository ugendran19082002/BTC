import { describe, expect, it } from 'vitest';
import { overQuery } from '@/api/backtest-saves';

/** Methods by win % for a run together, as it is asked of the server (19 Oct 2026). */
describe('overQuery, methods by win %', () => {
  it('[critical] the days before or the first days: their count; custom: its first and last day, not a count', () => {
    expect(overQuery({ winPick: { pct: 60, minTrades: 3, on: 'first', days: 10 } })).toEqual({ o_win: '60', o_wintrades: '3', o_winon: 'first', o_windays: '10' });
    expect(overQuery({ winPick: { pct: 60, minTrades: 3, on: 'custom', days: 7, pickFrom: '2026-10-03', pickTo: '2026-10-12' } }))
      .toEqual({ o_win: '60', o_wintrades: '3', o_winon: 'custom', o_winfrom: '2026-10-03', o_winto: '2026-10-12' });
  });
});
