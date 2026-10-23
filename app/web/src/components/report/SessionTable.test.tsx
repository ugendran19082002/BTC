import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { SessionTable, baseOf, baseSessions, ptsChange, sessionsOf, sessionWords, slotTime } from '@/components/report/SessionTable';
import { moneyText } from '@/lib/market-report';
import type { BtSlotRow } from '@/types/signal-backtest';

beforeEach(() => window.localStorage.clear());

// Slot 16 is 9:30 PM IST (5:30 PM + 16 quarters); 17 is 9:45 PM; 20 is 10:30 PM; 64 is 9:30 AM.
const row = (slot: number, method: string, n: number, wins: number, net: number, stops = 0): BtSlotRow => ({ slot, method, name: `#${method.length} ${method}`, n, wins, net, charges: n * 0.01, stops });
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

  it('an older server sends no stops: no SL column rather than an SL of none', () => {
    render(<SessionTable rows={rows.map(({ stops: _, ...r }) => r)} onOpen={() => {}} />);
    expect(screen.queryByRole('columnheader', { name: 'SL' })).toBeNull();
    expect(screen.queryByRole('region', { name: 'Baseline' })).toBeNull();
  });
});

describe('the sessions against a baseline (23 Oct 2026: net, win % and SL % change per session)', () => {
  const about = { words: 'these settings', from: '2026-10-01', to: '2026-10-21' };
  // the baseline: 9:30 PM 4 trades, 2 won, 2 stopped, $0.4; 10:30 PM 5 trades, all won; 9:30 AM 2 lost, both stopped
  const before = [row(16, 'breakout', 4, 2, 0.4, 2), row(20, 'gamma', 5, 5, 1.2), row(64, 'trap', 2, 0, -0.6, 2)];
  // the run after a change: 9:30 PM better (4 of 4 won, 1 stopped, $0.9); 10:30 PM the same; 9:30 AM not traded at all
  const after = [row(16, 'breakout', 4, 4, 0.9, 1), row(20, 'gamma', 5, 5, 1.2)];

  it('[critical] the baseline is a line a slot, regrouped by any session length; a change is in percentage points', () => {
    const b = baseOf([...before, row(16, 'gamma', 1, 1, 0.1, 0)], about, 5);
    expect(b.slots).toEqual([{ slot: 16, n: 5, wins: 3, net: 0.5, stops: 2 }, { slot: 20, n: 5, wins: 5, net: 1.2, stops: 0 }, { slot: 64, n: 2, wins: 0, net: -0.6, stops: 2 }]);
    expect([b.words, b.from, b.to, b.at]).toEqual(['these settings', '2026-10-01', '2026-10-21', 5]);
    expect([...baseSessions(b, 60).keys()]).toEqual([16, 20, 64]);
    expect(baseSessions(b, 240).get(16)).toMatchObject({ n: 10, wins: 8, stops: 2 });
    expect([ptsChange(1, 0.5), ptsChange(0.25, 0.5), ptsChange(0.5, 0.5), ptsChange(null, 0.5)]).toEqual(['+50 pts', '−25 pts', '±0', null]);
  });

  it('[critical] keep a run, run again: each session\'s net, win % and SL % with its change, and the whole of it', () => {
    const { rerender } = render(<SessionTable rows={before} about={about} onOpen={() => {}} />);
    expect(screen.getByRole('columnheader', { name: 'SL' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Keep as baseline' }));
    // kept by the desk's settings, so it is there after a reload and on another screen
    expect(Object.keys(window.localStorage).some((k) => k.endsWith('backtest.sessionBase'))).toBe(true);
    rerender(<SessionTable rows={after} about={about} onOpen={() => {}} />);
    const whole = screen.getByLabelText('The whole run against the baseline');
    expect(whole).toHaveTextContent(`Net ${moneyText(2.1 - 1)} (${moneyText(1)} → ${moneyText(2.1)})`);
    expect(whole).toHaveTextContent('Won 64% → 100%');
    expect(whole).toHaveTextContent('SL 36% → 11%');
    expect(whole).toHaveTextContent('better in 2 sessions, worse in 0');
    // 9:30 PM: won 50% → 100%, SL 50% → 25%, net +$0.5
    const evening = screen.getByRole('row', { name: /9:30 PM – 10:30 PM/ });
    expect(within(evening).getByLabelText('Won +50 pts against the baseline')).toHaveClass('text-[var(--up)]');
    expect(within(evening).getByLabelText('SL −25 pts against the baseline')).toHaveClass('text-[var(--up)]');
    expect(within(evening).getByLabelText(`Net ${moneyText(0.5)} against the baseline`)).toBeInTheDocument();
    // 10:30 PM unchanged
    expect(within(screen.getByRole('row', { name: /10:30 PM – 11:30 PM/ })).getByLabelText('Won ±0 against the baseline')).toBeInTheDocument();
    // 9:30 AM traded only in the baseline: a row still, with no trade, and the money it no longer loses
    const morning = screen.getByRole('row', { name: /9:30 AM – 10:30 AM/ });
    expect(within(morning).getByLabelText('Trades −2 against the baseline')).toBeInTheDocument();
    expect(within(morning).getByLabelText(`Net ${moneyText(0.6)} against the baseline`)).toHaveClass('text-[var(--up)]');
    expect(screen.queryByText(/The baseline is of other days/)).toBeNull();
    // of other days: said so
    rerender(<SessionTable rows={after} about={{ ...about, from: '2026-10-05' }} onOpen={() => {}} />);
    expect(screen.getByText(/The baseline is of other days/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    expect(screen.queryByLabelText('The whole run against the baseline')).toBeNull();
    expect(screen.getByRole('button', { name: 'Keep as baseline' })).toBeInTheDocument();
  });

  it('the single backtest\'s baseline and the portfolio\'s are kept apart; not kept while the run is being worked again', () => {
    const { rerender } = render(<SessionTable rows={before} about={about} baseKey="portfolio" busy onOpen={() => {}} />);
    expect(screen.getByRole('button', { name: 'Keep as baseline' })).toBeDisabled();
    rerender(<SessionTable rows={before} about={about} baseKey="portfolio" onOpen={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Keep as baseline' }));
    expect(Object.keys(window.localStorage).some((k) => k.endsWith('portfolio.sessionBase'))).toBe(true);
    expect(Object.keys(window.localStorage).some((k) => k.endsWith('backtest.sessionBase'))).toBe(false);
  });
});
