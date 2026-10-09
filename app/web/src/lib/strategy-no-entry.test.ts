import { describe, expect, it } from 'vitest';
import { nextWindow, noEntryProblems, noEntryWindowAt, pickerBounds, suggestedWindow } from '@/lib/strategy-no-entry';
import { minutesOf } from '@/lib/time';
import type { NoEntry } from '@/types/strategy';

/** The browser's copy of the server's no-entry rules: the same verdicts in the same words (server: test/strategy/no-entry.test.ts). */
const on = (...w: [string, string][]): NoEntry => ({ on: true, windows: w.map(([from, to]) => ({ from, to })) });
const p = (n: NoEntry, entry = '05:30', exit = '17:29') => noEntryProblems(n, entry, exit);

describe('no-entry windows', () => {
  it('[critical] wholly inside the strategy\'s entry and exit, never all of it, never overlapping -- the server\'s words', () => {
    expect(p(on(['17:00', '17:29']))).toEqual([]);
    expect(p(on(['17:00', '18:00']))).toEqual(['The no-entry window (5:00 PM – 6:00 PM) must lie inside this strategy\'s 5:30 AM – 5:29 PM: from 5:30 AM or later, until 5:29 PM or earlier.']);
    expect(p(on(['05:30', '17:29']))).toEqual(['The no-entry window (5:30 AM – 5:29 PM) covers all of 5:30 AM – 5:29 PM: no signal could be taken. Switch the strategy off instead.']);
    expect(p(on(['10:00', '11:00'], ['09:00', '10:30']))).toEqual(['No-entry windows 1 and 2 overlap: make them one window.']);
    expect(p(on(['10:00', '10:00']))).toEqual(['The no-entry window is empty: from and until are both 10:00 AM.']);
    expect(p(on())).toEqual(['Add a no-entry window, or switch it off.']);
    expect(p({ on: false, windows: [{ from: '18:00', to: '19:00' }] })).toEqual([]);
    expect(p(on(['23:45', '00:15']), '23:30', '05:29')).toEqual([]);
  });

  it('[critical] which window now: from in, until out, off is none', () => {
    const n = on(['17:00', '18:00']);
    expect(noEntryWindowAt({ noEntry: n }, minutesOf('17:00'))).toEqual({ from: '17:00', to: '18:00' });
    expect(noEntryWindowAt({ noEntry: n }, minutesOf('18:00'))).toBeNull();
    expect(noEntryWindowAt({ noEntry: { ...n, on: false } }, minutesOf('17:30'))).toBeNull();
  });

  it('the suggestions and the pickers stay inside the strategy, and a second window does not overlap the first', () => {
    expect(suggestedWindow('05:30', '17:29')).toEqual({ from: '16:59', to: '17:29' });
    // A short strategy: half of it, never all.
    expect(suggestedWindow('17:00', '17:20')).toEqual({ from: '17:10', to: '17:20' });
    expect(nextWindow([{ from: '16:59', to: '17:29' }], '05:30', '17:29')).toEqual({ from: '16:29', to: '16:59' });
    expect(p(on(['16:59', '17:29'], ['16:29', '16:59']))).toEqual([]);
    expect(pickerBounds('05:30', '17:29', '16:59')).toEqual({ fromMin: '05:30', fromMax: '17:28', toMin: '17:00', toMax: '17:29' });
  });
});
