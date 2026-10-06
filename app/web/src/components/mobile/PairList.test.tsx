import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { PairList } from '@/components/mobile/PairList';
import type { Pair } from '@/lib/method-pairs';

/** The phone's best and worst pairs (owner, 6 Oct 2026): what a row says, and how many rows show. */

const pair = (n: number, o: Partial<Pair> = {}): Pair => ({
  key: `m${n}|single|15m`, name: `#${n} Method ${n}`, tf: '15m', trades: 20, wins: 18, losses: 2, winRate: 0.9,
  grossProfitUsd: 1.2, grossLossUsd: 0.1, profitFactor: 12, avgWinUsd: 0.07, avgLossUsd: 0.05, netUsd: 1.1, bestUsd: 0.3, worstUsd: -0.06, ...o,
});

describe('PairList', () => {
  it('[critical] a row: the method, its time frame, what it made, trades, won and lost, win rate and profit factor', () => {
    render(<PairList title="Best pairs" tone="up" pairs={[pair(63, { name: '#63 Initial balance failed break' })]} empty="none" />);
    const row = within(screen.getByRole('list', { name: 'Best pairs' })).getByRole('listitem');
    expect(row).toHaveTextContent('#63 Initial balance failed break');
    expect(row).toHaveTextContent('15m');
        expect(row).toHaveTextContent('20 trades · 90% won · PF 12.00');
    expect(row).toHaveTextContent('18 won');
    expect(row).toHaveTextContent('2 lost');
    expect(row).toHaveTextContent('+₹93.50'); // $1.10 at ₹85
    expect(within(row).getByRole('img', { name: '18 won, 2 lost of 20' })).toBeInTheDocument();
    expect(screen.getByText('1 in profit')).toBeInTheDocument();
  });

  it('a pair that never lost has no profit factor to give, and says so; one trade is "1 trade"', () => {
    render(<PairList title="Best pairs" tone="up" pairs={[pair(1, { trades: 1, wins: 1, losses: 0, winRate: 1, profitFactor: null })]} empty="none" />);
    const row = screen.getByRole('listitem');
    expect(row).toHaveTextContent('1 trade');
    expect(row).not.toHaveTextContent('1 trades');
    expect(row).toHaveTextContent('1 trade · 100% won · no loss');
  });

  it('five to begin with; the rest on a tap, and back again', () => {
    render(<PairList title="Worst pairs" tone="down" pairs={[1, 2, 3, 4, 5, 6, 7].map((n) => pair(n, { netUsd: -n }))} empty="none" />);
    expect(screen.getAllByRole('listitem')).toHaveLength(5);
    expect(screen.getByText('7 in loss')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Show all 7' }));
    expect(screen.getAllByRole('listitem')).toHaveLength(7);
    fireEvent.click(screen.getByRole('button', { name: 'Show the first 5' }));
    expect(screen.getAllByRole('listitem')).toHaveLength(5);
  });

  it('five or fewer: no button; none at all: the reason, and no list', () => {
    const { unmount } = render(<PairList title="Best pairs" tone="up" pairs={[pair(1), pair(2)]} empty="none" />);
    expect(screen.queryByRole('button')).toBeNull();
    unmount();
    render(<PairList title="Worst pairs" tone="down" pairs={[]} empty="No method and time frame is in loss today." />);
    expect(screen.getByText('No method and time frame is in loss today.')).toBeInTheDocument();
    expect(screen.queryByRole('list')).toBeNull();
  });
});
