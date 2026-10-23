import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { SessionStudyLine, SessionStudyResult } from '@/types/signal-backtest';
import { SessionStudy } from '@/components/report/SessionStudy';
import { moneyText } from '@/lib/market-report';

/**
 * The SL, delta and win % by session (owner, 23 Oct 2026: "session based -- delta, SL %, win % -- editable; I will
 * check it by session"): sessions typed and kept, the study asked with a tap, and each session as set beside by
 * session -- trades, won, SL % and net, each with its change.
 */
const read = vi.fn();
const readTrades = vi.fn();
const line = (rule: SessionStudyLine['rule'], o: Partial<SessionStudyLine>): SessionStudyLine => ({
  rule, n: 10, wins: 8, net: 1, charges: 0.1, stops: 2, worstDay: { day: '2026-10-09', net: -0.5 }, maxDrawdown: 0.6, halves: [0.5, 0.5], bySession: [], byDay: [], ...o,
});
const RESULT: SessionStudyResult = {
  from: '2026-10-01', to: '2026-10-21', days: 21, secondHalfFrom: '2026-10-11', sessions: [{ from: '12:00', to: '17:30', delta: null, sl: 1.5, win: null }],
  win: { base: null, minTrades: 3, days: 14 }, fixed: { pct: 3, stepped: false, each: [3] }, signals: 30, sameTrades: true,
  lines: [
    line('fixed', { n: 30, wins: 24, net: 3, stops: 6, halves: [1, 2], bySession: [{ session: 0, n: 10, wins: 6, net: -1, stops: 4 }, { session: -1, n: 20, wins: 18, net: 4, stops: 2 }] }),
    line('by-session', { n: 30, wins: 25, net: 3.5, stops: 5, halves: [1.2, 2.3], bySession: [{ session: 0, n: 10, wins: 7, net: -0.5, stops: 3 }, { session: -1, n: 20, wins: 18, net: 4, stops: 2 }] }),
  ],
};

beforeEach(() => { window.localStorage.clear(); read.mockReset().mockResolvedValue(RESULT); readTrades.mockReset().mockResolvedValue({ day: 'x', total: 0, trades: [] }); });

describe('SessionStudy', () => {
  it('[critical] to begin with the afternoon at SL +150%; sessions added, split and removed, each figure blank for as set; kept by the desk', () => {
    render(<SessionStudy askKey="q" read={read} />);
    expect(screen.getAllByLabelText(/Session 1: from/).length).toBeGreaterThan(0);
    expect(screen.getByLabelText('Session 1: option SL, per cent over the premium')).toHaveValue(150);
    expect(screen.getByLabelText('Session 1: the most delta a strike sold may have')).toHaveValue(null);
    expect(screen.getByLabelText('Session 1: the most delta a strike sold may have')).toHaveAttribute('placeholder', 'as set');
    expect(screen.getByRole('status')).toHaveTextContent('12:00 PM – 5:30 PM SL +150%. A trade keeps its session\'s figures to its exit.');
    fireEvent.click(screen.getByRole('button', { name: 'Add a session' }));
    expect(screen.getByText('Session 2')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Session 2: the most delta a strike sold may have'), { target: { value: '0.08' } });
    expect(screen.getByRole('status')).toHaveTextContent('12:00 PM – 5:30 PM SL +150%; 5:30 PM – 7:30 PM Δ 0.08.');
    expect(Object.entries(window.localStorage).some(([k, v]) => k.endsWith('signalBacktest.sessionStudy.rules') && v.includes('0.08'))).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Remove session 1' }));
    expect(screen.queryByText('Session 2')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Split the whole day into 6-hour sessions' }));
    expect(screen.getAllByRole('button', { name: /^Remove session/ })).toHaveLength(4);
    // Blank everywhere: said, and not asked.
    expect(screen.getByRole('alert')).toHaveTextContent(/blank everywhere is the settings as set/);
    expect(screen.getByRole('button', { name: 'Compare' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Add a session' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Back to the defaults' }));
    expect(screen.getAllByRole('button', { name: /^Remove session/ })).toHaveLength(1);
  });

  it('[critical] Compare asks with the sessions typed; each session as set beside by session, its changes coloured; a count opens its trades', async () => {
    render(<SessionStudy askKey="q" read={read} readTrades={readTrades} />);
    fireEvent.change(screen.getByLabelText('Session 1: the least win per cent of its method'), { target: { value: '70' } });
    fireEvent.click(screen.getByRole('button', { name: 'Compare' }));
    expect(read).toHaveBeenCalledWith({ sessions: [{ from: '12:00', to: '17:30', delta: null, sl: 150, win: 70 }], win: { base: null, minTrades: 3, days: 14 } });
    await waitFor(() => expect(screen.getByLabelText('Each session')).toBeInTheDocument());
    expect(screen.getByText(/By session made/)).toHaveTextContent(`By session made ${moneyText(0.5)} more than as set, and was better in both halves of the days.`);
    const afternoon = screen.getByRole('row', { name: /12:00 PM – 5:30 PM/ });
    expect(within(afternoon).getByLabelText('12:00 PM – 5:30 PM: won +10 points against as set')).toHaveClass('text-[var(--up)]');
    expect(within(afternoon).getByLabelText('12:00 PM – 5:30 PM: SL −10 points against as set')).toHaveClass('text-[var(--up)]');
    expect(within(afternoon).getByLabelText(`12:00 PM – 5:30 PM: net ${moneyText(0.5)} against as set`)).toBeInTheDocument();
    expect(within(screen.getByRole('row', { name: /In no session/ })).getByLabelText('In no session: won ±0 points against as set')).toHaveClass('text-muted-foreground');
    // The whole, the better marked: SL hit fewer by session.
    const sl = within(screen.getByLabelText('The whole')).getByRole('row', { name: /SL hit/ });
    expect(within(sl).getAllByRole('cell')[1]).toHaveTextContent('17% (better)');
    fireEvent.click(within(afternoon).getByRole('button', { name: 'As set: the 10 trades of 12:00 PM – 5:30 PM' }));
    await waitFor(() => expect(readTrades).toHaveBeenCalledWith({ sessions: [{ from: '12:00', to: '17:30', delta: null, sl: 150, win: 70 }], win: { base: null, minTrades: 3, days: 14 } }, { side: 'fixed', session: 0, day: null }));
  });

  it('a change after the comparison: the last one is marked as of other sessions until compared again', async () => {
    render(<SessionStudy askKey="q" read={read} />);
    fireEvent.click(screen.getByRole('button', { name: 'Compare' }));
    await waitFor(() => expect(screen.getByLabelText('Each session')).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText('Session 1: option SL, per cent over the premium'), { target: { value: '120' } });
    expect(screen.getByText(/the sessions changed since/)).toBeInTheDocument();
  });
});
