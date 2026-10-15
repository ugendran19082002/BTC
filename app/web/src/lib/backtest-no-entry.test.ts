import { describe, expect, it } from 'vitest';
import { backtestHours, backtestNoEntryProblems, noEntryQuery } from '@/lib/backtest-no-entry';
import { overQuery } from '@/api/backtest-saves';
import type { BacktestParams } from '@/types/signal-backtest';

const P = { rule: 'delta', value: 0.1, lots: 2, targetPct: 0.7, stopPct: 1.6, window: 'desk', deskMax: 0, cePct: 100, pePct: 100 } as BacktestParams;
const windows = (...w: [string, string][]) => ({ on: true, windows: w.map(([from, to]) => ({ from, to })) });

describe('the backtest\'s no-entry windows (15 Oct 2026)', () => {
  it('[critical] held to the backtest\'s hours, in the strategy form\'s own words', () => {
    expect(backtestHours(P)).toEqual({ entryTime: '21:30', exitTime: '15:59' });
    expect(backtestHours({ ...P, window: 'all' })).toEqual({ entryTime: '17:30', exitTime: '17:25' });
    expect(backtestHours({ ...P, window: 'custom', hoursFrom: '22:00', hoursTo: '02:00' })).toEqual({ entryTime: '22:00', exitTime: '02:00' });
    expect(backtestNoEntryProblems({ ...P, noEntry: windows(['00:30', '01:30']) })).toEqual([]);
    expect(backtestNoEntryProblems({ ...P, noEntry: windows(['18:00', '19:00']) })[0]).toMatch(/must lie inside the hours' 9:30 PM – 3:59 PM/);
    expect(backtestNoEntryProblems({ ...P, noEntry: windows(['00:30', '01:30'], ['01:00', '02:00']) })[0]).toMatch(/overlap/);
    expect(backtestNoEntryProblems({ ...P, noEntry: windows(['21:30', '15:59']) })[0]).toMatch(/covers all .* Take the window off instead\./);
  });

  it('[critical] asked of the server only when on and right for the hours', () => {
    expect(noEntryQuery({ ...P, noEntry: windows(['00:30', '01:30'], ['03:00', '04:00']) })).toBe('00:30-01:30,03:00-04:00');
    expect(noEntryQuery({ ...P, noEntry: { ...windows(['00:30', '01:30']), on: false } })).toBeNull();
    expect(noEntryQuery({ ...P, noEntry: windows(['18:00', '19:00']) })).toBeNull();
    expect(noEntryQuery(P)).toBeNull();
  });

  it('over a run together: the windows for every one of them, held to the whole day', () => {
    expect(overQuery({ noEntry: windows(['18:00', '19:00']) })).toEqual({ o_noentry: '18:00-19:00' });
    expect(overQuery({ noEntry: windows(['18:00', '18:00']) })).toEqual({});
  });
});
