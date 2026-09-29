import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { TradesDialog } from './TradesDialog';
import type { HistoryRow } from '@/lib/smc/readout';

const row = (id: string, resultR: number, dir: 'bull' | 'bear' = 'bull'): HistoryRow => ({
  id, dir, time: 1_790_000_000 + Number(id) * 300, entry: 83_000, stop: 82_700, tp1: 83_600, exit: 83_300, resultR, mfeR: 1.2, maeR: 0.4, minutes: 35, path: 'TP1 → BE → stopped',
});
const history = [row('3', -1), row('2', 1.4, 'bear'), row('1', 0.2)];
const open = (extra: Partial<Parameters<typeof TradesDialog>[0]> = {}) =>
  render(<TradesDialog open onOpenChange={vi.fn()} history={history} record={null} {...extra} />);
const rowsOf = () => within(screen.getByRole('dialog')).getAllByRole('row').slice(1);

describe('the trades dialog', () => {
  beforeEach(() => { try { localStorage.clear(); } catch { /* none */ } });

  it('[critical] lists every SMC trade with its figures, and the record counts them all', () => {
    open();
    expect(rowsOf()).toHaveLength(3);
    const stats = screen.getByLabelText('SMC record on this chart').textContent ?? '';
    expect(stats).toContain('Trades3');
    expect(stats).toContain('Total+0.6R');
  });

  it('[critical] a row can be hidden and restored; the record still counts it', () => {
    open();
    fireEvent.click(screen.getAllByRole('button', { name: /Hide the .* trade/ })[0]!);
    expect(rowsOf()).toHaveLength(2);
    expect(screen.getByText('1 hidden')).toBeTruthy();
    expect(screen.getByLabelText('SMC record on this chart').textContent).toContain('Trades3');
    fireEvent.click(screen.getByRole('button', { name: /Restore all/ }));
    expect(rowsOf()).toHaveLength(3);
  });

  it('[critical] clear all asks first, then hides every row; shown again on request', () => {
    open();
    fireEvent.click(screen.getByRole('button', { name: 'Clear all' }));
    expect(rowsOf()).toHaveLength(3);
    fireEvent.click(screen.getByRole('button', { name: 'Yes, clear' }));
    expect(screen.getByText(/Every trade here is hidden/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Show hidden' }));
    expect(rowsOf()).toHaveLength(3);
  });

  it('shows a trade on the chart and closes', () => {
    const onJump = vi.fn();
    const onOpenChange = vi.fn();
    open({ onJump, onOpenChange });
    fireEvent.click(screen.getAllByRole('button', { name: /on the chart/ })[1]!);
    expect(onJump).toHaveBeenCalledWith(history[1]!.time);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('[critical] the trend tab: the live forward test apart from replayed trades, each marked', () => {
    open({
      paper: {
        summary: [{ tf: '1H', live: 2, closed: 1, open: 1, wins: 1, netR: 1.3, replayed: 1 }],
        trades: [
          { tf: '1H', entryTime: 1_790_010_000, dir: 1, entry: 83_000, stop0: 82_500, risk: 500, stop: 82_900, exitTime: null, exit: null, rNet: null, live: true, firstSeen: 1, volBurst: true, session: true },
          { tf: '1H', entryTime: 1_790_000_000, dir: -1, entry: 84_000, stop0: 84_500, risk: 500, stop: 84_100, exitTime: 1, exit: 83_300, rNet: 1.3, live: false, firstSeen: 1, volBurst: false, session: false },
        ],
      },
    });
    fireEvent.click(screen.getByRole('tab', { name: /Trend plan/ }));
    expect(screen.getByLabelText('Trend plan paper record').textContent).toContain('1 closed · +1.3R');
    expect(screen.getByLabelText('Trend plan paper record').textContent).toContain('1 replayed, not counted');
    const rows = rowsOf();
    expect(rows[0]!.textContent).toContain('open');
    expect(rows[0]!.textContent).toContain('live');
    expect(rows[0]!.textContent).toContain('volume burst · London / NY');
    expect(rows[1]!.textContent).toContain('replayed');
  });
});
