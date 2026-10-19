import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { BacktestSave } from '@/types/signal-backtest';

const getSignalBacktest = vi.fn();
vi.mock('@/api/signal-backtest', () => ({ getSignalBacktest: (...a: unknown[]) => getSignalBacktest(...a) }));
const getBacktestSaves = vi.fn();
const saveBacktest = vi.fn();
vi.mock('@/api/backtest-saves', () => ({ getBacktestSaves: (...a: unknown[]) => getBacktestSaves(...a), saveBacktest: (...a: unknown[]) => saveBacktest(...a) }));

const { SavedMethodsPicker, periodRange, lastFinishedDay } = await import('@/components/report/SavedMethodsPicker');
const { WinPickResult } = await import('@/components/report/WinPickResult');

/** A saved backtest's methods picked in the portfolio (19 Oct 2026): by its own record, the Win tab included, kept on Update. */
const SAVE: BacktestSave = {
  id: 's1', name: '15m time', group: null, createdAt: 0, updatedAt: 0,
  query: { params: { rule: 'delta', value: 0.1, lots: 10, targetPct: 0.9, stopPct: 3, window: 'desk', deskMax: 0, cePct: 100, pePct: 100 }, tfs: ['15m'], methods: ['bos'], strategy: null },
} as BacktestSave;
const NOW = Date.parse('2026-10-19T12:00:00+05:30');

describe('a saved backtest\'s methods, picked in the portfolio', () => {
  it('[critical] the days: finished ones only -- today\'s expiry counts after 5:30 PM IST', () => {
    expect(lastFinishedDay(NOW)).toBe('2026-10-18');
    expect(lastFinishedDay(Date.parse('2026-10-19T18:00:00+05:30'))).toBe('2026-10-19');
    expect(periodRange(7, NOW)).toEqual({ from: '2026-10-12', to: '2026-10-18' });
    expect(periodRange(0, NOW)).toEqual({ from: '2026-10-01', to: '2026-10-18' });
  });

  it('[critical] its own record by its own settings, the Win tab\'s "only these" a tap, kept on Update', async () => {
    getSignalBacktest.mockResolvedValue({ choices: { methods: [
      { key: 'breakout', name: '#1 Breakout', n: 10, wins: 8, net: 5 }, { key: 'bos', name: '#6 BOS', n: 6, wins: 1, net: -3 }, { key: 'trap', name: '#9 Trap', n: 4, wins: 3, net: 1 },
    ] } });
    const onUpdate = vi.fn();
    render(<SavedMethodsPicker save={SAVE} onUpdate={onUpdate} onClose={() => {}} now={NOW} />);
    await waitFor(() => expect(getSignalBacktest).toHaveBeenCalledWith({ from: '2026-10-05', to: '2026-10-18', params: SAVE.query.params, tfs: ['15m'], methods: [], strategy: null }));
    // the picker opened, its Win tab, and only those that won 70% or more
    fireEvent.click(await screen.findByRole('button', { name: /^Method filter/ }));
    fireEvent.click(screen.getByRole('button', { name: /^Win ≥/ }));
    fireEvent.change(screen.getByLabelText('Win rate at least, percent'), { target: { value: '70' } });
    fireEvent.click(screen.getByText(/^Only the 2 that won 70% or more/));
    fireEvent.click(screen.getByRole('button', { name: 'Update its methods (2)' }));
    expect(onUpdate).toHaveBeenCalledWith(expect.arrayContaining(['breakout', 'trap']));
    expect(onUpdate.mock.calls[0]![0]).toHaveLength(2);
  });

  it('[critical] a run\'s pick kept on the saved backtest with a tap', async () => {
    getBacktestSaves.mockResolvedValue({ saves: [SAVE], portfolios: [] });
    saveBacktest.mockResolvedValue({ ok: true });
    render(<WinPickResult pick={{ pct: 75, minTrades: 3, on: 'before', from: '2026-10-11', to: '2026-10-17', picked: { s1: ['breakout', 'trap'] }, own: [] }}
      members={[{ id: 's1', name: '15m time', problem: null }]} nameOf={(id) => `#${id}`} />);
    expect(screen.getByText(/the days before the run, so it is run on days that took no part/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Keep these 2 on it' }));
    await waitFor(() => expect(saveBacktest).toHaveBeenCalledWith({ id: 's1', name: '15m time', query: { ...SAVE.query, methods: ['breakout', 'trap'] } }));
    expect(await screen.findByRole('button', { name: 'Kept on it' })).toBeDisabled();
  });
});
