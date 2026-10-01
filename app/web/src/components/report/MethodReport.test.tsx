import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MethodReport, sortRows } from '@/components/report/MethodReport';
import type { MethodReportResponse, MethodReportRow } from '@/types/entry';

const getMethodReport = vi.fn();
vi.mock('@/api/entry', () => ({ getMethodReport: (...a: unknown[]) => getMethodReport(...a) }));

const row = (n: number, name: string, o: Partial<MethodReportRow> = {}): MethodReportRow => ({
  n, method: name.toLowerCase(), name, signals: 0, trades: 0, wins: 0, losses: 0, winPct: null,
  profitPts: 0, lossPts: 0, netPts: 0, profitR: 0, lossR: 0, netR: 0, ...o,
});
const rows = [
  row(1, 'Breakout', { signals: 4, trades: 3, wins: 1, losses: 2, winPct: 100 / 3, profitPts: 150, lossPts: 120, netPts: 30, profitR: 1.5, lossR: 1.2, netR: 0.3 }),
  row(2, 'Retest', { signals: 5, trades: 2, wins: 2, losses: 0, winPct: 100, profitPts: 200, netPts: 200, profitR: 3, netR: 3 }),
  row(3, 'Momentum'),
];
const total = row(0, 'All 3 methods', { n: null, signals: 9, trades: 5, wins: 3, losses: 2, winPct: 60, profitPts: 350, lossPts: 120, netPts: 230, profitR: 4.5, lossR: 1.2, netR: 3.3 });
const report = (): MethodReportResponse => ({
  tf: null,
  sections: [
    { mode: 'mtf', label: 'With the timeframe chain', rows, total },
    { mode: 'single', label: 'Without the timeframe chain', rows, total },
  ],
});

beforeEach(() => { localStorage.clear(); getMethodReport.mockReset(); getMethodReport.mockResolvedValue(report()); });

describe('the Methods report', () => {
  it('[critical] two sections, every method a line, and the totals', async () => {
    render(<MethodReport />);
    const chain = await screen.findByRole('region', { name: 'With the timeframe chain' });
    const alone = screen.getByRole('region', { name: 'Without the timeframe chain' });
    for (const s of [chain, alone]) {
      expect(within(s).getAllByRole('row')).toHaveLength(1 + rows.length + 1); // header, methods, total
      expect(within(s).getByText('All 3 methods')).toBeInTheDocument();
    }
    const breakout = within(chain).getByText('Breakout').closest('tr')!;
    expect(breakout).toHaveTextContent('33.3%');
    expect(breakout).toHaveTextContent('+30');
    expect(breakout).toHaveTextContent('+0.30R');
  });

  it('[critical] a method with no trade shows no win rate rather than 0%', async () => {
    render(<MethodReport />);
    const chain = await screen.findByRole('region', { name: 'With the timeframe chain' });
    expect(within(chain).getByText('Momentum').closest('tr')).toHaveTextContent('—');
  });

  it('a timeframe asks the server for that timeframe', async () => {
    render(<MethodReport />);
    await screen.findByRole('region', { name: 'With the timeframe chain' });
    expect(getMethodReport).toHaveBeenLastCalledWith(null);
    fireEvent.click(screen.getByRole('button', { name: '15m' }));
    await waitFor(() => expect(getMethodReport).toHaveBeenLastCalledWith('15m'));
  });

  it('hiding methods with no trades keeps the totals', async () => {
    render(<MethodReport />);
    await screen.findByRole('region', { name: 'With the timeframe chain' });
    fireEvent.click(screen.getByRole('switch', { name: /Hide methods with no trades/ }));
    const chain = screen.getByRole('region', { name: 'With the timeframe chain' });
    expect(within(chain).queryByText('Momentum')).toBeNull();
    expect(within(chain).getByText('All 3 methods')).toBeInTheDocument();
  });

  it('sorting puts methods without a trade last, whichever way', () => {
    expect(sortRows(rows, 'netR', false).map((r) => r.name)).toEqual(['Retest', 'Breakout', 'Momentum']);
    expect(sortRows(rows, 'netR', true).map((r) => r.name)).toEqual(['Breakout', 'Retest', 'Momentum']);
    expect(sortRows(rows, 'n', true).map((r) => r.n)).toEqual([1, 2, 3]);
  });
});
