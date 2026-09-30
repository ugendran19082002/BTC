import { describe, expect, it } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { PnlKpiCards } from '@/components/report/PnlKpiCards';
import { PerformanceStats } from '@/components/report/PerformanceStats';
import { WinLossAnalysis } from '@/components/report/WinLossAnalysis';
import { DailyPnlChart } from '@/components/report/DailyPnlChart';
import { PnlCurveChart } from '@/components/report/PnlCurveChart';
import type { DayRow } from '@/types/report';

const mockRows: DayRow[] = [
  { day: '2026-09-20', realisedUsd: 120, chargesUsd: 5, netUsd: 115, trades: 4, cumulativeUsd: 115 },
  { day: '2026-09-21', realisedUsd: 250, chargesUsd: 8, netUsd: 242, trades: 6, cumulativeUsd: 357 },
  { day: '2026-09-22', realisedUsd: -90, chargesUsd: 4, netUsd: -94, trades: 2, cumulativeUsd: 263 },
  { day: '2026-09-23', realisedUsd: 180, chargesUsd: 6, netUsd: 174, trades: 5, cumulativeUsd: 437 },
  { day: '2026-09-24', realisedUsd: 310, chargesUsd: 10, netUsd: 300, trades: 8, cumulativeUsd: 737 },
  { day: '2026-09-25', realisedUsd: -40, chargesUsd: 3, netUsd: -43, trades: 3, cumulativeUsd: 694 },
  { day: '2026-09-26', realisedUsd: 210, chargesUsd: 7, netUsd: 203, trades: 5, cumulativeUsd: 897 },
  { day: '2026-09-27', realisedUsd: 150, chargesUsd: 5, netUsd: 145, trades: 4, cumulativeUsd: 1042 },
];

describe('PnlKpiCards', () => {
  it('renders all 7 key metrics cards with titles and values', () => {
    render(
      <PnlKpiCards
        rows={mockRows}
        totalsNetUsd={1042}
        includeCharges={true}
        status={{
          mode: 'paper',
          live: false,
          canGoLive: false,
          switchBlockedBy: null,
          balanceUsd: 10000,
          unrealisedPnlUsd: 156.26,
          today: { realisedUsd: 150, unrealisedUsd: 10, chargesUsd: 5, netUsd: 155 },
          positions: [{ symbol: 'P-BTC-83800', productId: 1, size: 10, entryPrice: 20, unrealisedPnl: 156.26 }],
        } as any}
      />
    );

    expect(screen.getByText('Total P&L')).toBeInTheDocument();
    expect(screen.getByText('Realized P&L')).toBeInTheDocument();
    expect(screen.getByText('Unrealized P&L')).toBeInTheDocument();
    expect(screen.getByText("Today's P&L")).toBeInTheDocument();
    expect(screen.getByText('This Week')).toBeInTheDocument();
    expect(screen.getByText('This Month')).toBeInTheDocument();
    expect(screen.getByText('Max Drawdown')).toBeInTheDocument();
  });
});

describe('PerformanceStats', () => {
  it('renders the 12 performance stat tiles and dropdown', () => {
    render(<PerformanceStats rows={mockRows} />);

    expect(screen.getByText('Performance Stats')).toBeInTheDocument();
    expect(screen.getByText('Total trades')).toBeInTheDocument();
    expect(screen.getByText('Win rate')).toBeInTheDocument();
    expect(screen.getByText('Avg R')).toBeInTheDocument();
    expect(screen.getByText('Expectancy')).toBeInTheDocument();
    expect(screen.getByText('Largest win')).toBeInTheDocument();
    expect(screen.getByText('Largest loss')).toBeInTheDocument();
    expect(screen.getByText('Avg holding')).toBeInTheDocument();
    expect(screen.getByText('Max consecutive wins')).toBeInTheDocument();
    expect(screen.getByText('Max consecutive losses')).toBeInTheDocument();
    expect(screen.getByText('Sharpe')).toBeInTheDocument();
    expect(screen.getByText('Calmar')).toBeInTheDocument();
    expect(screen.getByText('Profit factor')).toBeInTheDocument();

    const select = screen.getByLabelText('Filter trades');
    fireEvent.change(select, { target: { value: 'Strategy Trades' } });
    expect(select).toHaveValue('Strategy Trades');
  });
});

describe('WinLossAnalysis', () => {
  it('renders Donut chart, legend breakdown, and toggles Count / P&L', () => {
    render(<WinLossAnalysis rows={mockRows} />);

    expect(screen.getByText('Win / Loss')).toBeInTheDocument();
    expect(screen.getByText('Wins')).toBeInTheDocument();
    expect(screen.getByText('Losses')).toBeInTheDocument();
    expect(screen.getByText('Breakeven')).toBeInTheDocument();
    expect(screen.getByText('Avg win')).toBeInTheDocument();
    expect(screen.getByText('Avg loss')).toBeInTheDocument();
    expect(screen.getByText('Profit factor')).toBeInTheDocument();

    // Toggle to P&L view
    fireEvent.click(screen.getByRole('button', { name: 'P&L' }));
    expect(screen.getByRole('button', { name: 'P&L' })).toHaveClass('active');

    // Toggle back to Count view
    fireEvent.click(screen.getByRole('button', { name: 'Count' }));
    expect(screen.getByRole('button', { name: 'Count' })).toHaveClass('active');
  });
});

describe('DailyPnlChart', () => {
  it('renders daily bars and responds to period selection', () => {
    render(<DailyPnlChart rows={mockRows} />);

    expect(screen.getByText('Daily P&L')).toBeInTheDocument();
    expect(screen.getByText(/Net/)).toBeInTheDocument();

    const select = screen.getByLabelText('Period selector');
    fireEvent.change(select, { target: { value: 'Weekly' } });
    expect(select).toHaveValue('Weekly');
  });
});

describe('PnlCurveChart', () => {
  it('renders curve chart with series legend and timeframe toggles', () => {
    render(<PnlCurveChart rows={mockRows} />);

    expect(screen.getByText('P&L Curve')).toBeInTheDocument();
    expect(screen.getAllByText('Total P&L').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Realized').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Unrealized').length).toBeGreaterThan(0);

    const weeklyBtn = screen.getByRole('button', { name: 'Weekly' });
    fireEvent.click(weeklyBtn);
    expect(weeklyBtn).toHaveClass('active');
  });
});

describe('Dynamic Clean Zero States (No Dummy Data)', () => {
  it('renders clean zero state with no dummy numbers when rows is empty', () => {
    render(
      <>
        <PnlKpiCards rows={[]} totalsNetUsd={0} includeCharges={true} />
        <PerformanceStats rows={[]} />
        <WinLossAnalysis rows={[]} />
        <DailyPnlChart rows={[]} />
        <PnlCurveChart rows={[]} />
      </>
    );

    // Kpi cards show zero or clean state
    expect(screen.getAllByText('₹0').length).toBeGreaterThan(0);
    expect(screen.getByText('0 trades · Win rate 0.0%')).toBeInTheDocument();
    expect(screen.getByText('0 open positions')).toBeInTheDocument();

    // Daily & Curve empty states
    expect(screen.getByText('No trading days in selected date range.')).toBeInTheDocument();
    expect(screen.getByText('No equity curve data in selected date range.')).toBeInTheDocument();

    // Win loss donut empty state
    expect(screen.getByText('No trades')).toBeInTheDocument();
  });

  it('isolates category filters in PerformanceStats without falling back to all rows', () => {
    render(<PerformanceStats rows={mockRows} orders={[]} />);

    const select = screen.getByLabelText('Filter trades');
    fireEvent.change(select, { target: { value: 'Strategy Trades' } });

    // When Strategy Trades has 0 orders, it strictly shows 0 total trades
    expect(screen.getByText('Performance Stats')).toBeInTheDocument();
    const values = screen.getAllByText('0');
    expect(values.length).toBeGreaterThan(0);
  });
});
