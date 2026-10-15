import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { DayTradesSheet } from '@/components/report/DayTrades';
import { Table } from '@/components/report/backtest-parts';
import type { BtDayTrades, BtRow, BtTradeRow } from '@/types/signal-backtest';

const T0 = Date.parse('2026-10-13T16:30:00Z'); // 10:00 PM IST
const trade = (i: number, o: Partial<BtTradeRow> = {}): BtTradeRow => ({
  at: T0 + i * 60_000, method: 'z-reversion', name: '#33 Z-score reversion', tf: '30m', dir: 1,
  perpEntry: 82_782, perpSl: 82_295.5, perpTgt: 83_563.7, cp: 'P', strike: 81_400, lots: 2,
  entryAt: T0 + i * 60_000, entry: 43, exitAt: T0 + i * 60_000 + 8_340_000, exit: 73.126, by: 'perp-sl',
  optTgt: 12.9, optStop: 111.8, perpPts: -486.4, netUsd: -0.07, chargesUsd: 0.0096, ...o,
});
const day = (trades: BtTradeRow[], total = trades.length): BtDayTrades => ({ day: '2026-10-14', total, trades });

describe('a day of the backtest, trade by trade (14 Oct 2026)', () => {
  it('[critical] a trade says what was sold on which signal, in and out with the times, why it closed, its levels and its money', async () => {
    const read = vi.fn(async () => day([trade(0), trade(1, { netUsd: 0.05, by: 'perp-tgt', perpPts: 391, dir: -1, cp: 'C', strike: 85_000 })]));
    render(<DayTradesSheet day="2026-10-14" read={read} onClose={() => {}} />);
    const list = await screen.findByRole('list', { name: 'Trades' });
    expect(read).toHaveBeenCalledWith('2026-10-14');
    expect(screen.getByRole('dialog')).toHaveTextContent('Wed 14 Oct · trade by trade');
    expect(screen.getByRole('dialog')).toHaveTextContent('2 trades · 50% won');
    const first = within(list).getAllByRole('listitem')[0]!;
    expect(first).toHaveTextContent('10:00 PM · #33 Z-score reversion');
    expect(first).toHaveTextContent('30m · BUY · sold PE 81,400 × 2');
    expect(first).toHaveTextContent('Entry43.0 at 10:00 PM');
    expect(first).toHaveTextContent('Exit73.13 at 12:19 AM');
    expect(first).toHaveTextContent('Closed byPerp SL');
    expect(first).toHaveTextContent('Perp pts−486 pts');
    expect(first).toHaveTextContent('Perp SL · TGT82,296 · 83,564');
    expect(first).toHaveTextContent('Option SL · TGT111.8 · 12.9');
  });

  it('[critical] narrowed by result or by how it closed, ordered by money, fifty at a time', async () => {
    const trades = Array.from({ length: 120 }, (_, i) => trade(i, i % 3 === 0 ? { netUsd: 0.1 + i / 1_000, by: 'option-tgt' } : {}));
    render(<DayTradesSheet day="2026-10-14" read={async () => day(trades)} onClose={() => {}} />);
    const list = await screen.findByRole('list', { name: 'Trades' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(50);
    fireEvent.click(screen.getByRole('button', { name: 'Show 50 more of 70' }));
    expect(within(list).getAllByRole('listitem')).toHaveLength(100);
    fireEvent.click(screen.getByRole('button', { name: /^Won 40:/ }));
    expect(within(screen.getByRole('list', { name: 'Trades' })).getAllByRole('listitem')).toHaveLength(40);
    // by how it closed: the 80 the perp's SL closed, fifty again to begin with
    fireEvent.click(screen.getByRole('button', { name: /^Perp SL 80:/ }));
    expect(within(screen.getByRole('list', { name: 'Trades' })).getAllByRole('listitem')).toHaveLength(50);
    expect(screen.getByRole('button', { name: 'Show 30 more of 30' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /^All 120:/ }));
    fireEvent.change(screen.getByLabelText('Order the trades'), { target: { value: 'best' } });
    expect(within(screen.getByRole('list', { name: 'Trades' })).getAllByRole('listitem')[0]!).toHaveAttribute('aria-label', expect.stringMatching(/\+₹/));
  });

  it('[critical] every tab says what its trades made; the line under them says what is shown (15 Oct 2026)', async () => {
    const trades = [trade(0, { netUsd: 0.1, by: 'perp-tgt' }), trade(1, { netUsd: -0.04 }), trade(2, { netUsd: 0.06, by: 'option-tgt' })];
    render(<DayTradesSheet day="2026-10-14" read={async () => day(trades)} onClose={() => {}} />);
    await screen.findByRole('list', { name: 'Trades' });
    const tabs = within(screen.getByRole('group', { name: 'Show' }));
    expect(tabs.getAllByRole('button').map((b) => b.getAttribute('aria-label'))).toEqual([
      expect.stringMatching(/^All 3: \+₹/), expect.stringMatching(/^Won 2: \+₹/), expect.stringMatching(/^Lost 1: −₹/),
      expect.stringMatching(/^Perp TGT 1: \+₹/), expect.stringMatching(/^Perp SL 1: −₹/), expect.stringMatching(/^Option TGT 1: \+₹/),
    ]);
    fireEvent.click(tabs.getByRole('button', { name: /^Lost 1:/ }));
    expect(screen.getByLabelText('What is shown')).toHaveTextContent(/^Showing 1 trade · 0% won · −₹/);
  });

  it('[critical] by method: a pick of several with each one\'s record, and a table of them, the best first -- a row a tap from its trades (15 Oct 2026)', async () => {
    const trades = [
      trade(0, { method: 'breakout', name: '#1 Breakout', netUsd: 0.2 }), trade(1, { method: 'breakout', name: '#1 Breakout', netUsd: -0.05 }),
      trade(2, { method: 'gamma', name: '#50 Gamma wall reaction', netUsd: -0.3 }),
    ];
    render(<DayTradesSheet day="2026-10-14" read={async () => day(trades)} onClose={() => {}} />);
    await screen.findByRole('list', { name: 'Trades' });
    const table = screen.getByRole('table', { name: "The day's trades by method" });
    const rows = within(table).getAllByRole('row').slice(1).map((r) => r.textContent);
    expect(rows[0]).toMatch(/^#1 Breakout250%\+₹/);
    expect(rows[1]).toMatch(/^#50 Gamma wall reaction10%−₹/);
    fireEvent.click(within(table).getByRole('button', { name: 'Only #50 Gamma wall reaction' }));
    expect(within(screen.getByRole('list', { name: 'Trades' })).getAllByRole('listitem')).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Method filter: #50 Gamma wall reaction' })).toBeInTheDocument();
    // the tabs follow the pick: its one trade, lost
    expect(within(screen.getByRole('group', { name: 'Show' })).getByRole('button', { name: /^All 1:/ })).toBeInTheDocument();
    // and the pick opens with each method's record and the Win tab
    fireEvent.click(screen.getByRole('button', { name: 'Method filter: #50 Gamma wall reaction' }));
    expect(within(screen.getByRole('listbox')).getByText(/^2 trades · 50% won · \+₹/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Win ≥30%/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Clear all' }));
    expect(within(screen.getByRole('list', { name: 'Trades' })).getAllByRole('listitem')).toHaveLength(3);
  });

  it('in a run together, whose trades they are is a pick of its own', async () => {
    const trades = [trade(0, { member: '1h time' }), trade(1, { member: '2h time', netUsd: 0.4 })];
    render(<DayTradesSheet day="2026-10-14" read={async () => day(trades)} onClose={() => {}} />);
    await screen.findByRole('list', { name: 'Trades' });
    fireEvent.click(screen.getByRole('button', { name: 'Strategy filter: All strategies' }));
    fireEvent.click(within(screen.getByRole('listbox')).getByText('2h time'));
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(within(screen.getByRole('list', { name: 'Trades' })).getAllByRole('listitem')).toHaveLength(1);
  });

  it('a day cut short says how many there were; a failed read says why', async () => {
    const { unmount } = render(<DayTradesSheet day="2026-10-14" read={async () => day([trade(0)], 4_000)} onClose={() => {}} />);
    expect(await screen.findByText(/The first 1 of 4,000 trades/)).toBeInTheDocument();
    unmount();
    render(<DayTradesSheet day="2026-10-14" read={async () => { throw new Error('the backtest took too long'); }} onClose={() => {}} />);
    await waitFor(() => expect(screen.getByRole('dialog')).toHaveTextContent('the backtest took too long'));
  });

  it('[critical] a day row\'s trade count opens its trades', () => {
    const onCount = vi.fn();
    const row: BtRow = { key: '2026-10-14', name: 'Wed 14 Oct', n: 64, wins: 42, losses: 22, net: 0.6, won: 1, lost: 0.4, perpPts: 0, charges: 0.3, exits: {} };
    render(<Table caption="by day" first="Expiry day" rows={[row]} onCount={onCount} />);
    fireEvent.click(screen.getByRole('button', { name: 'See the 64 trades of Wed 14 Oct' }));
    expect(onCount).toHaveBeenCalledWith('2026-10-14');
  });
});
