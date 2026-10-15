import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { SessionTable, sessionsOf, sessionWords, slotTime } from '@/components/report/SessionTable';
import type { BtSlotRow } from '@/types/signal-backtest';

beforeEach(() => window.localStorage.clear());

// Slot 16 is 9:30 PM IST (5:30 PM + 16 quarters); 17 is 9:45 PM; 20 is 10:30 PM; 64 is 9:30 AM.
const row = (slot: number, method: string, n: number, wins: number, net: number): BtSlotRow => ({ slot, method, name: `#${method.length} ${method}`, n, wins, net, charges: n * 0.01 });
const rows = [row(16, 'breakout', 4, 3, 0.5), row(17, 'breakout', 2, 2, 0.3), row(17, 'gamma', 3, 1, -0.4), row(20, 'gamma', 5, 5, 1.2), row(64, 'trap', 2, 0, -0.6)];

describe('the backtest by session of the day (15 Oct 2026)', () => {
  it('[critical] a session is so many fifteen-minute slots from the daily contract\'s 5:30 PM, in the day\'s order', () => {
    expect(slotTime(0)).toBe('5:30 PM');
    expect(slotTime(16)).toBe('9:30 PM');
    expect(sessionWords(16, 19)).toBe('9:30 PM – 10:30 PM');
    const hours = sessionsOf(rows, 60);
    expect(hours.map((s) => [s.from, s.to, s.sum.n])).toEqual([[16, 19, 9], [20, 23, 5], [64, 67, 2]]);
    // its methods, the best first, each added up across its slots
    expect(hours[0]!.methods.map((m) => [m.method, m.n, Math.round(m.net * 100) / 100])).toEqual([['breakout', 6, 0.8], ['gamma', 3, -0.4]]);
    expect(sessionsOf(rows, 15).length).toBe(4);
    expect(sessionsOf(rows, 240).map((s) => [s.from, s.sum.n])).toEqual([[16, 14], [64, 2]]);
  });

  it('[critical] 1h to begin with, 15m to 6h to choose, kept; a session opens to its methods; a count opens its trades', () => {
    const onOpen = vi.fn();
    render(<SessionTable rows={rows} onOpen={onOpen} />);
    const length = screen.getByRole('combobox', { name: 'Session length' });
    expect(length).toHaveValue('60');
    expect(within(length).getAllByRole('option').map((o) => o.textContent)).toEqual(['15m', '30m', '1h', '2h', '3h', '4h', '6h']);
    expect(screen.getByText('best session')).toBeInTheDocument();
    expect(screen.getByText('worst session')).toBeInTheDocument();          // 9:30 AM lost money
    // a session's count: its trades, every day
    fireEvent.click(screen.getByRole('button', { name: 'See the 9 trades of 9:30 PM – 10:30 PM' }));
    expect(onOpen).toHaveBeenLastCalledWith({ slotFrom: 16, slotTo: 19 }, '9:30 PM – 10:30 PM · every day');
    // opened: its methods, the best first, each count its own trades in that session
    fireEvent.click(screen.getByRole('button', { name: '9:30 PM – 10:30 PM: its methods' }));
    expect(screen.getByRole('button', { name: '9:30 PM – 10:30 PM: its methods' })).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'See the 3 trades of #5 gamma in 9:30 PM – 10:30 PM' }));
    expect(onOpen).toHaveBeenLastCalledWith({ slotFrom: 16, slotTo: 19, method: 'gamma' }, '#5 gamma · 9:30 PM – 10:30 PM');
    // another length: the same figures regrouped, and remembered in this browser
    fireEvent.change(length, { target: { value: '240' } });
    expect(screen.getByRole('button', { name: 'See the 14 trades of 9:30 PM – 1:30 AM' })).toBeInTheDocument();
    expect(Object.entries(window.localStorage).some(([k, v]) => k.endsWith('backtest.sessionMinutes') && v === '240')).toBe(true);
  });

  it('every session in profit: the lowest is not called the worst', () => {
    render(<SessionTable rows={[row(16, 'a', 2, 2, 0.5), row(20, 'a', 2, 2, 0.1), row(24, 'a', 2, 2, 0.3)]} onOpen={() => {}} />);
    expect(screen.queryByText('worst session')).toBeNull();
    expect(screen.getByText('lowest session')).toBeInTheDocument();
  });
});
