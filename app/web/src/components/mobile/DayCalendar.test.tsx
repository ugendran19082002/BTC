import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { DayCalendar } from '@/components/mobile/DayCalendar';
import type { DayRow } from '@/types/report';

/** The phone's P&L calendar (owner, 6 Oct 2026): a figure in every traded day's square, and a day's numbers on a tap. */

const row = (day: string, netInr: number, o: Partial<DayRow> = {}): DayRow => ({
  day, netUsd: netInr / 85, realisedUsd: (netInr + 17) / 85, chargesUsd: 17 / 85, profitUsd: Math.max(0, netInr + 17) / 85 + 1,
  lossUsd: 1 + Math.max(0, -(netInr + 17)) / 85, trades: 4, cumulativeUsd: netInr / 85, ...o,
});
// Sat 3 Oct .. Tue 6 Oct 2026; the 5th had no trade.
const ROWS = [row('2026-10-03', 425), row('2026-10-04', -1240, { trades: 7 }), row('2026-10-05', 0, { trades: 0, chargesUsd: 0, realisedUsd: 0 }), row('2026-10-06', 85, { trades: 1 })];
const show = (rows = ROWS, from = '2026-09-30', to = '2026-10-06') => render(<DayCalendar from={from} to={to} rows={rows} today="2026-10-06" />);

describe('DayCalendar', () => {
  it('[critical] each traded day is a button with its figure in it and its numbers said; a day with no trade is not', () => {
    show();
    const oct = within(screen.getByRole('region', { name: 'OCT 26' }));
    expect(oct.getByRole('button', { name: 'Sat, 3 Oct: +₹425, 4 trades' })).toHaveTextContent('3+425');
    expect(oct.getByRole('button', { name: 'Sun, 4 Oct: −₹1,240, 7 trades' })).toHaveTextContent('4−1.2K');
    expect(oct.getByRole('button', { name: 'Tue, 6 Oct: +₹85.00, 1 trade' })).toHaveTextContent('6+85');
    expect(oct.getByLabelText('Mon, 5 Oct: no trades')).toHaveTextContent('5');
    expect(oct.queryByRole('button', { name: /5 Oct/ })).toBeNull();
    expect(oct.getAllByRole('button')).toHaveLength(3);
  });

  it('each month says what it made and how its days went', () => {
    show();
    expect(screen.getByRole('region', { name: 'OCT 26' })).toHaveTextContent('−₹730 · 2 up · 1 down');
    // September is in the range for one day, with no trade: its name and its week, no total.
    expect(screen.getByRole('region', { name: 'SEP 26' })).not.toHaveTextContent('up');
    expect(within(screen.getByRole('region', { name: 'SEP 26' })).getByLabelText('Wed, 30 Sep: no trades')).toBeInTheDocument();
  });

  it('the last day traded is open to begin with; a tap opens another', () => {
    show();
    const detail = () => screen.getByText(/Tap a day/).parentElement!;
    expect(detail()).toHaveTextContent('Tue, 6 Oct · today');
    expect(detail()).toHaveTextContent('+₹85.00');
    expect(screen.getByRole('button', { name: /6 Oct/ })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByRole('button', { name: /4 Oct/ }));
    expect(detail()).toHaveTextContent('Sun, 4 Oct');
    expect(detail()).not.toHaveTextContent('today');
    expect(detail()).toHaveTextContent('−₹1,240');
    expect(detail()).toHaveTextContent('Trades7');
    expect(detail()).toHaveTextContent('Charges−₹17.00');
    expect(screen.getByRole('button', { name: /4 Oct/ })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: /6 Oct/ })).toHaveAttribute('aria-pressed', 'false');
  });

  it('a chosen day that leaves the range gives way to the last day traded', () => {
    const { rerender } = show();
    fireEvent.click(screen.getByRole('button', { name: /3 Oct/ }));
    rerender(<DayCalendar from="2026-10-04" to="2026-10-06" rows={ROWS.slice(1)} today="2026-10-06" />);
    expect(screen.getByRole('button', { name: /6 Oct/ })).toHaveAttribute('aria-pressed', 'true');
  });

  it('only the weeks that hold a day of the range are drawn: seven days are not a month of blanks', () => {
    show(ROWS, '2026-10-04', '2026-10-06');
    expect(screen.queryByRole('region', { name: 'SEP 26' })).toBeNull();
    const oct = screen.getByRole('region', { name: 'OCT 26' });
    // One week: Sun 4 .. Sat 10, of which three days are in the range.
    expect(within(oct).getAllByLabelText(/Oct:/)).toHaveLength(3);
  });

  it('rows from outside the range (the last range\'s answer, still on screen) are not drawn, counted or opened', () => {
    show(ROWS, '2026-10-05', '2026-10-06');
    expect(screen.getAllByRole('button')).toHaveLength(1);
    expect(screen.getByRole('region', { name: 'OCT 26' })).toHaveTextContent('+₹85.00 · 1 up · 0 down');
    expect(screen.getByRole('button', { name: /6 Oct/ })).toHaveAttribute('aria-pressed', 'true');
  });

  it('today is marked, traded or not; a range with no trade says so and draws no detail', () => {
    show([], '2026-10-04', '2026-10-06');
    expect(screen.getByLabelText('Tue, 6 Oct: no trades')).toHaveAttribute('aria-current', 'date');
    expect(screen.getByText('No day in this range has a trade yet.')).toBeInTheDocument();
    expect(screen.queryByText(/Tap a day/)).toBeNull();
  });
});
