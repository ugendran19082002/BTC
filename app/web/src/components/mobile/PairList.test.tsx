import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { PairList } from '@/components/mobile/PairList';
import type { PairStat } from '@/lib/method-pairs';
import { signedInr, usdToInr } from '@/lib/format';

/** The phone's best and worst pairs (owner, 6 Oct 2026): what a row says, and how many rows show. */

const pair = (n: number, o: Partial<PairStat> = {}): PairStat => ({
  key: `m${n}|single|15m`, name: `#${n} Method ${n}`, tf: '15m', trades: 20, wins: 18, losses: 2, winRate: 0.9, profitFactor: 12, net: 1.1, ...o,
});
const rupees = (p: PairStat) => signedInr(usdToInr(p.net));

describe('PairList', () => {
  it('[critical] a row: the method, its time frame, what it made, trades, won and lost, win rate and profit factor', () => {
    render(<PairList title="Best pairs" tone="up" pairs={[pair(63, { name: '#63 Initial balance failed break' })]} empty="none" amount={rupees} />);
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
    render(<PairList title="Best pairs" tone="up" pairs={[pair(1, { trades: 1, wins: 1, losses: 0, winRate: 1, profitFactor: null })]} empty="none" amount={rupees} />);
    const row = screen.getByRole('listitem');
    expect(row).toHaveTextContent('1 trade');
    expect(row).not.toHaveTextContent('1 trades');
    expect(row).toHaveTextContent('1 trade · 100% won · no loss');
  });

  it('the caller says what a pair made and may add a note: points and R for the signal history', () => {
    render(<PairList title="Worst pairs" tone="down" pairs={[pair(71, { net: -1240, profitFactor: 0.42 })]} empty="none" amount={(p) => `${p.net} pts`} note={() => '−3.1R'} />);
    const row = screen.getByRole('listitem');
    expect(row).toHaveTextContent('-1240 pts');
    expect(row).toHaveTextContent('PF 0.42 · −3.1R');
    // with nothing to say for the two ends, there is no line for them
    expect(screen.queryByLabelText(/^won /)).toBeNull();
  });

  it('what the winners made and the losers gave back sit under the two ends of the bar', () => {
    render(<PairList title="Best pairs" tone="up" pairs={[pair(63)]} empty="none" amount={() => '+11,840 pts'} ends={() => ({ won: '+12,480 pts', lost: '−640 pts' })} />);
    expect(screen.getByLabelText('won +12,480 pts')).toHaveTextContent('+12,480 pts');
    expect(screen.getByLabelText('lost −640 pts')).toHaveTextContent('−640 pts');
  });

  it('five to begin with; the rest on a tap, and back again', () => {
    render(<PairList title="Worst pairs" tone="down" pairs={[1, 2, 3, 4, 5, 6, 7].map((n) => pair(n, { net: -n }))} empty="none" amount={rupees} />);
    expect(screen.getAllByRole('listitem')).toHaveLength(5);
    expect(screen.getByText('7 in loss')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Show all 7' }));
    expect(screen.getAllByRole('listitem')).toHaveLength(7);
    fireEvent.click(screen.getByRole('button', { name: 'Show the first 5' }));
    expect(screen.getAllByRole('listitem')).toHaveLength(5);
  });

  it('five or fewer: no button; none at all: the reason, and no list', () => {
    const { unmount } = render(<PairList title="Best pairs" tone="up" pairs={[pair(1), pair(2)]} empty="none" amount={rupees} />);
    expect(screen.queryByRole('button')).toBeNull();
    unmount();
    render(<PairList title="Worst pairs" tone="down" pairs={[]} empty="No method and time frame is in loss today." amount={rupees} />);
    expect(screen.getByText('No method and time frame is in loss today.')).toBeInTheDocument();
    expect(screen.queryByRole('list')).toBeNull();
  });
});
