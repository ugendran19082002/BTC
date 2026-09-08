import { describe, expect, it } from 'vitest';
import { toCsv } from '@/lib/csv';

type Row = { symbol: string; lots: number; note: string | null; pnl: number | null };

const columns = [
  { header: 'symbol', value: (r: Row) => r.symbol },
  { header: 'lots', value: (r: Row) => r.lots },
  { header: 'note', value: (r: Row) => r.note },
  { header: 'profit usd', value: (r: Row) => r.pnl },
];

const row = (over: Partial<Row> = {}): Row => ({
  symbol: 'C-BTC-81000-090926', lots: 2, note: null, pnl: 0.003, ...over,
});

describe('the header and the rows', () => {
  it('writes the headers first, then a line per row', () => {
    const csv = toCsv([row(), row({ lots: 5 })], columns);
    const lines = csv.split('\r\n');
    expect(lines[0]).toBe('symbol,lots,note,profit usd');
    expect(lines).toHaveLength(3);
  });

  it('uses CRLF, which is what Excel expects', () => {
    expect(toCsv([row()], columns)).toContain('\r\n');
  });

  it('writes headers alone when there is nothing to report', () => {
    expect(toCsv([], columns)).toBe('symbol,lots,note,profit usd');
  });
});

describe('fields that would otherwise break the sheet', () => {
  it('quotes a comma, so one note cannot shift every column after it', () => {
    const csv = toCsv([row({ note: 'refused: spread 18%, limit 4%' })], columns);
    expect(csv).toContain('"refused: spread 18%, limit 4%"');
    // four headers, and still four fields on the row
    expect(csv.split('\r\n')[1]!.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/)).toHaveLength(4);
  });

  it('doubles a quote inside a quoted field', () => {
    expect(toCsv([row({ note: 'said "no"' })], columns)).toContain('"said ""no"""');
  });

  it('quotes a newline rather than starting a new record', () => {
    const csv = toCsv([row({ note: 'line one\nline two' })], columns);
    expect(csv).toContain('"line one\nline two"');
    expect(csv.split('\r\n')).toHaveLength(2);
  });
});

describe('numbers and blanks', () => {
  it('writes numbers unformatted, so the sheet can add them up', () => {
    // no currency symbol, no thousands separator: the formatting is the screen's job
    const csv = toCsv([row({ pnl: 1234.5678 })], columns);
    expect(csv).toContain('1234.5678');
    expect(csv).not.toContain('$');
  });

  it('leaves a missing value empty rather than writing "null"', () => {
    const csv = toCsv([row({ note: null, pnl: null })], columns);
    expect(csv.split('\r\n')[1]).toBe('C-BTC-81000-090926,2,,');
  });

  it('does not confuse a real zero with a missing one', () => {
    expect(toCsv([row({ pnl: 0 })], columns).split('\r\n')[1]).toMatch(/,0$/);
  });
});
