import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { BacktestPortfolioResult, BacktestSave, BtTot } from '@/types/signal-backtest';

const getSignalBacktest = vi.fn();
vi.mock('@/api/signal-backtest', () => ({ getSignalBacktest: (...a: unknown[]) => getSignalBacktest(...a) }));
const getBacktestPortfolio = vi.fn();
const saveBacktest = vi.fn();
vi.mock('@/api/backtest-saves', () => ({ getBacktestPortfolio: (...a: unknown[]) => getBacktestPortfolio(...a), saveBacktest: (...a: unknown[]) => saveBacktest(...a) }));

const { MethodsBoard } = await import('@/components/report/MethodsBoard');

/**
 * Methods -- pick by win %, every strategy side by side (owner, 20 Oct 2026: "strategies across, down the side win %,
 * trades, profit, loss, loss trades, PF; a tap on any strategy changes its methods").
 */
const params = { rule: 'delta', value: 0.1, lots: 1, targetPct: 0.9, stopPct: 3, window: 'desk', deskMax: 0, cePct: 100, pePct: 100 };
const save = (id: string, name: string, methods: string[], strategy: string | null = null): BacktestSave =>
  ({ id, name, group: null, createdAt: 0, updatedAt: 1, query: { params, tfs: ['15m'], methods, strategy } } as BacktestSave);
const SAVES = [save('a', '4h time', ['trap', 'bos']), save('b', '5m time', []), save('c', 'By a strategy', [], 'st1')];
const tot = (o: Partial<BtTot>): BtTot => ({ n: 0, wins: 0, losses: 0, net: 0, won: 0, lost: 0, perpPts: 0, charges: 0, exits: {}, ...o } as BtTot);
const RESULT = {
  from: '2026-10-05', to: '2026-10-18', shared: null, bySession: [], signals: 0, skipped: {}, days: [], breakdown: {},
  members: [
    { id: 'a', name: '4h time', problem: null, signals: 60, total: tot({ n: 50, wins: 45, losses: 5, net: 6, won: 8, lost: 2, charges: 0.5 }), marginPeakUsd: 300, priced: null },
    { id: 'b', name: '5m time', problem: null, signals: 900, total: tot({ n: 500, wins: 400, losses: 100, net: 10, won: 30, lost: 20, charges: 3 }), marginPeakUsd: 900, priced: null },
  ],
  total: tot({ n: 550, wins: 445, losses: 105, net: 16, won: 38, lost: 22, charges: 3.5 }),
  margin: { peakUsd: 1000, peakDay: null, peakAt: null, peakOpen: 0, avgDailyPeakUsd: 0, sumOfPeaksUsd: 1200 },
} as unknown as BacktestPortfolioResult;
const NOW = Date.parse('2026-10-19T12:00:00+05:30');

beforeEach(() => {
  window.localStorage.clear();
  getBacktestPortfolio.mockReset().mockResolvedValue(RESULT);
  saveBacktest.mockReset().mockResolvedValue({ ok: true });
  getSignalBacktest.mockReset().mockResolvedValue({ choices: { methods: [
    { key: 'trap', name: '#9 Trap', n: 10, wins: 9, net: 5 }, { key: 'bos', name: '#6 BOS', n: 6, wins: 1, net: -3 },
  ] } });
});

describe('MethodsBoard', () => {
  it('[critical] strategies across, the figures down the side: each by its own settings and methods, alone on its own limit, over the days chosen', async () => {
    render(<MethodsBoard saves={SAVES} now={NOW} />);
    await waitFor(() => expect(getBacktestPortfolio).toHaveBeenCalledWith(['a', 'b'], { from: '2026-10-05', to: '2026-10-18' }, 'own'));
    const table = await screen.findByRole('table');
    expect(within(table).getAllByRole('columnheader').map((x) => x.textContent)).toEqual(['Figure', '4h time2 methods ✎', '5m timeevery method ✎', 'Total']);
    const row = (label: string) => within(table).getByRole('rowheader', { name: label }).closest('tr')!;
    expect(within(row('Win %')).getAllByRole('cell').map((x) => x.textContent)).toEqual(['90% (best)▲', '80%', '81%']);
    expect(within(row('Trades')).getAllByRole('cell').map((x) => x.textContent)).toEqual(['50', '500', '550']);
    expect(within(row('Lost trades')).getAllByRole('cell').map((x) => x.textContent)).toEqual(['5', '100', '105']);
    expect(within(row('PF')).getAllByRole('cell').map((x) => x.textContent)).toEqual(['4.00 (best)▲', '1.50', '1.73']);
    expect(row('Net')).toHaveTextContent(/\(best\)/);
    for (const label of ['Profit', 'Loss', 'Charges', 'Net / trade', 'Avg win', 'Avg loss', 'Margin peak']) expect(row(label)).toBeInTheDocument();
    // one worked by a strategy keeps the strategy's methods: not a column, and said
    expect(screen.getByText(/1 worked by a strategy keep the strategy's methods/)).toBeInTheDocument();
    // the days: the same chips as each one's method picker
    fireEvent.click(screen.getByRole('button', { name: 'Since 1 Oct' }));
    await waitFor(() => expect(getBacktestPortfolio).toHaveBeenLastCalledWith(['a', 'b'], { from: '2026-10-01', to: '2026-10-18' }, 'own'));
  });

  it('[critical] a tap on a strategy opens its methods, picked by win % on the same days, and Update keeps them on it', async () => {
    const onChanged = vi.fn();
    render(<MethodsBoard saves={SAVES} now={NOW} onChanged={onChanged} />);
    fireEvent.click(await screen.findByRole('button', { name: /^4h time: its methods, 2 picked/ }));
    const picker = await screen.findByRole('region', { name: 'Methods of 4h time' });
    await waitFor(() => expect(getSignalBacktest).toHaveBeenCalledWith(expect.objectContaining({ from: '2026-10-05', to: '2026-10-18', tfs: ['15m'] })));
    // the days changed in the picker are the board's too
    fireEvent.click(within(picker).getByRole('button', { name: 'Last 7 days' }));
    await waitFor(() => expect(getBacktestPortfolio).toHaveBeenLastCalledWith(['a', 'b'], { from: '2026-10-12', to: '2026-10-18' }, 'own'));
    fireEvent.click(within(picker).getByRole('button', { name: /^Method filter/ }));
    // the method list opens in a sheet of its own
    fireEvent.click(screen.getByRole('button', { name: /^Win ≥/ }));
    fireEvent.change(screen.getByLabelText('Win rate at least, percent'), { target: { value: '70' } });
    fireEvent.click(screen.getByText(/^Only the 1 that won 70% or more/));
    fireEvent.click(screen.getByRole('button', { name: 'Update its methods (1)', hidden: true }));
    await waitFor(() => expect(saveBacktest).toHaveBeenCalledWith({ id: 'a', name: '4h time', query: { ...SAVES[0]!.query, methods: ['trap'] } }));
    expect(await screen.findByText('Kept 1 method on "4h time".')).toBeInTheDocument();
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('region', { name: 'Methods of 4h time' })).toBeNull();
  });

  it('none saved by settings: said, and nothing asked', () => {
    render(<MethodsBoard saves={[SAVES[2]!]} now={NOW} />);
    expect(screen.getByText(/No saved backtest by settings yet/)).toBeInTheDocument();
    expect(getBacktestPortfolio).not.toHaveBeenCalled();
  });
});
