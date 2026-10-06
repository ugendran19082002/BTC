import { beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { DailyPnlChart, bucketsOf, compactInr, niceTicks } from '@/components/report/DailyPnlChart';
import type { DayRow } from '@/types/report';

/**
 * The daily chart (6 Oct 2026): each day three bars side by side -- booked profit up in green, booked loss down in
 * red, the charges down in a milder red -- and the running total they add up to as a line over the same bars.
 */
const day = (d: string, profitUsd: number, lossUsd: number, chargesUsd: number, trades = 3): DayRow =>
  ({ day: d, realisedUsd: profitUsd - lossUsd, profitUsd, lossUsd, chargesUsd, netUsd: profitUsd - lossUsd - chargesUsd, trades, cumulativeUsd: 0 });
// ₹85 to the dollar. 2 Oct: ₹1,020 won and ₹170 lost (+₹850 booked); 5 Oct: ₹85 won, ₹510 lost (−₹425); 6 Oct: ₹170 won.
const ROWS = [day('2026-10-02', 12, 2, 1), day('2026-10-05', 1, 6, 0.5, 2), day('2026-10-06', 2, 0, 0.2, 1)];

beforeEach(() => localStorage.clear());

describe('the days as bars', () => {
  it('[critical] a day is its booked figure, its charges, and the net of the two; the running total adds the nets', () => {
    const b = bucketsOf(ROWS, 'Daily');
    expect(b.map((x) => [x.label, x.profit, x.loss, x.booked, x.charges, x.net, x.cumulative])).toEqual([
      ['2 Oct', 1020, 170, 850, 85, 765, 765], ['5 Oct', 85, 510, -425, 42.5, -467.5, 297.5], ['6 Oct', 170, 0, 170, 17, 153, 450.5],
    ]);
    // A server from before the split sends only the day's booked figure: it is then all profit, or all loss.
    const old = bucketsOf([{ day: '2026-10-05', realisedUsd: -5, chargesUsd: 0.5, netUsd: -5.5, trades: 2, cumulativeUsd: 0 }], 'Daily')[0]!;
    expect([old.profit, old.loss, old.booked]).toEqual([0, 425, -425]);
    expect(b[1]!.title).toBe('Mon, 5 Oct 2026');
    // Before charges, the running total is the booked figures alone.
    expect(bucketsOf(ROWS, 'Daily', false).map((x) => x.cumulative)).toEqual([850, 425, 595]);
  });

  it('weeks and months add their days, and a week across a year end is one week', () => {
    // 2 Oct is a Friday (week 40); 5 and 6 Oct are the next week.
    expect(bucketsOf(ROWS, 'Weekly').map((x) => [x.label, x.profit, x.loss, x.booked, x.trades])).toEqual([['W40', 1020, 170, 850, 3], ['W41', 255, 510, -255, 3]]);
    expect(bucketsOf(ROWS, 'Monthly').map((x) => [x.label, x.title, x.net])).toEqual([["Oct '26", 'October 2026', 450.5]]);
    const across = bucketsOf([day('2026-12-31', 1, 0, 0), day('2027-01-01', 1, 0, 0)], 'Weekly');
    expect(across.map((x) => x.key)).toEqual(['2026-W53']);
  });

  it('[critical] the scale is the data\'s own, to a round step with zero on it -- not the next ₹50,000', () => {
    expect(niceTicks(-467, 850)).toEqual([-500, 0, 500, 1000]);
    expect(niceTicks(0, 5447)).toEqual([0, 2000, 4000, 6000]);
    expect(niceTicks(0, 0)).toContain(0);
    expect([compactInr(950), compactInr(1500), compactInr(-12000), compactInr(250000), compactInr(0)]).toEqual(['₹950', '₹1.5K', '−₹12K', '₹2.5L', '₹0']);
  });
});

describe('the chart', () => {
  it('[critical] names every mark, and reads a day out: booked, charges, net, the running total and its trades', () => {
    render(<DailyPnlChart rows={ROWS} />);
    expect(within(screen.getByRole('list', { name: 'legend' })).getAllByRole('listitem').map((l) => l.textContent))
      .toEqual(['Booked profit', 'Booked loss', 'Charges', 'Cumulative net']);
    expect(screen.getByText('Net +₹451')).toBeInTheDocument();
    // By the keyboard, as by the pointer: End is the last day, Left the one before.
    const plot = screen.getByRole('group', { name: /Daily P&L, 3 days/ });
    fireEvent.keyDown(plot, { key: 'End' });
    expect(screen.getByRole('status')).toHaveTextContent('Tue, 6 Oct 2026Booked profit+₹170Booked loss₹0Charges−₹17.00Net+₹153Cumulative+₹451Trades1');
    fireEvent.keyDown(plot, { key: 'ArrowLeft' });
    expect(screen.getByRole('status')).toHaveTextContent('Mon, 5 Oct 2026Booked profit+₹85.00Booked loss−₹510Charges−₹42.50Net−₹468Cumulative+₹298Trades2');
    fireEvent.keyDown(plot, { key: 'Escape' });
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('[critical] every figure is in a table too, newest first, and the choice is remembered', () => {
    const { unmount } = render(<DailyPnlChart rows={ROWS} />);
    fireEvent.click(screen.getByRole('button', { name: 'Table' }));
    const rows = within(screen.getByRole('table', { name: 'Daily P&L table' })).getAllByRole('row');
    expect(rows[0]).toHaveTextContent('DayProfitLossChargesNetCumulativeTrades');
    expect(rows[1]).toHaveTextContent('Tue, 6 Oct 2026+₹170₹0−₹17.00+₹153+₹4511');
    expect(rows[2]).toHaveTextContent('Mon, 5 Oct 2026+₹85.00−₹510−₹42.50−₹468+₹2982');
    unmount();
    render(<DailyPnlChart rows={ROWS} />);
    expect(screen.getByRole('table', { name: 'Daily P&L table' })).toBeInTheDocument();
  });

  it('before charges it says Gross, and the running total leaves them out', () => {
    render(<DailyPnlChart rows={ROWS} includeCharges={false} />);
    expect(screen.getByText('Gross +₹595')).toBeInTheDocument();
    expect(screen.getByText('Cumulative gross')).toBeInTheDocument();
  });
});

describe('one plot, one scale', () => {
  it('[critical] the bars and the line are drawn in one chart: three bars to a day, the line through every day', () => {
    const { container } = render(<DailyPnlChart rows={ROWS} />);
    const svgs = container.querySelectorAll('svg[role="img"]');
    expect(svgs).toHaveLength(1);
    const fills = [...svgs[0]!.querySelectorAll('path[fill^="var(--"]')].map((p) => p.getAttribute('fill'));
    // 2 Oct: profit, loss, charges. 5 Oct: all three. 6 Oct: profit and charges -- no loss, so no bar for one.
    expect(fills).toEqual(['var(--up)', 'var(--down)', 'var(--charge)', 'var(--up)', 'var(--down)', 'var(--charge)', 'var(--up)', 'var(--charge)']);
    const line = svgs[0]!.querySelector('path[stroke="var(--accent)"]')!;
    expect(line.getAttribute('d')!.match(/[ML]/g)).toHaveLength(3);
  });
});
