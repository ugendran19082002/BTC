import { describe, expect, it } from 'vitest';
import { SIGNAL_COLUMNS, csvNameFor, istDay, signalsToCsv } from '@/components/desk/signal-export';
import type { StateHistoryRow } from '@/api/desk';

const row = (over: Partial<StateHistoryRow> = {}): StateHistoryRow => ({
  id: 1, at: Date.UTC(2026, 8, 26, 9, 45), tf: '5m', event: 'BREAKOUT_WATCH', stage: 'WATCH',
  side: 'UP', confirmed: false, confidence: 35, close: 84_436,
  plan: { side: 'UP', trigger: 84_532, target1: 84_731, target2: 84_900, invalidation: 84_309 },
  outcome: 'NOT_TRIGGERED', gradedAt: null, resolvedClose: 84_380, movePts: -56, ...over,
});
const words = (o: string | null) => (o === 'NOT_TRIGGERED' ? 'Not triggered' : o ?? 'Waiting');

describe('the signal history as a file', () => {
  it('[critical] carries what the screen shows, plus the exact time and the stored outcome', () => {
    // A trader checking last Tuesday against their broker statement needs the
    // timestamp and the verdict, not a list they have to scroll and retype.
    const csv = signalsToCsv([row()], words);
    const [header, first] = csv.trim().split('\n');
    expect(header).toBe(SIGNAL_COLUMNS.join(','));
    expect(first).toContain('2026-09-26 15:15');   // 09:45 UTC is 15:15 IST
    expect(first).toContain('5m');
    expect(first).toContain('BREAKOUT_WATCH');
    expect(first).toContain('Not triggered');
    expect(first).toContain('84532');
    expect(first).toContain('-56');
  });

  it('[critical] a comma inside a field cannot break the columns', () => {
    /*
     * An unquoted comma silently gains a column, and every row after it is
     * wrong -- in a file somebody is reconciling money against.
     */
    const csv = signalsToCsv([row({ event: 'BREAKOUT, CONFIRMED' })], words);
    expect(csv).toContain('"BREAKOUT, CONFIRMED"');
    expect(csv.trim().split('\n')[1]!.split(',').length).toBe(SIGNAL_COLUMNS.length + 1);
  });

  it('a row with nothing to say leaves the cell empty rather than writing zero', () => {
    // Zero points is a real reading; "not measured" is not, and a spreadsheet
    // cannot tell them apart once both are 0.
    const csv = signalsToCsv([row({ plan: null, resolvedClose: null, movePts: null })], words);
    const cells = csv.trim().split('\n')[1]!.split(',');
    expect(cells[6]).toBe('');
    expect(cells[11]).toBe('');
  });

  it('ends with a newline, since some tools drop the last row without one', () => {
    expect(signalsToCsv([row()], words).endsWith('\n')).toBe(true);
  });

  it('the file name carries the day and the timeframe', () => {
    expect(csvNameFor('15m', Date.UTC(2026, 8, 26, 9, 45))).toBe('btc-signals-15m-2026-09-26.csv');
    // 18:40 UTC is past midnight in IST: the day is the trader's, not the server's
    expect(istDay(Date.UTC(2026, 8, 26, 18, 40))).toBe('2026-09-27');
  });
});
