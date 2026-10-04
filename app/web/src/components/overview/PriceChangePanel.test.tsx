import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { PriceChangePanel } from '@/components/overview/MarketPanels';
import type { PriceChange } from '@/api/desk';

/** The Live screen's "Price change" card, back on 4 Oct 2026: BTC now against each window and the desk's marks. */
const at = Date.UTC(2026, 9, 4, 6, 0, 0);
const row = (minutes: number | null, mark: PriceChange['mark'], then: number | null, now = 85_000): PriceChange =>
  ({ minutes, mark, at: at - (minutes ?? 90) * 60_000, then, pts: then === null ? null : now - then, pct: then === null ? null : (now / then - 1) * 100 });

describe('the price change card', () => {
  it('[critical] a row a window -- minutes, then hours -- with where BTC was, the move in points and percent, up and down told apart', () => {
    render(<PriceChangePanel spot={85_000} price={{ spot: 85_000, rows: [row(1, null, 84_990), row(5, null, 85_100), row(60, null, 84_500), row(720, null, null)] }} />);
    const rows = within(screen.getByRole('table', { name: 'price change' })).getAllByRole('row').slice(1);
    expect(rows.map((r) => within(r).getAllByRole('cell')[0]!.textContent)).toEqual(['1m', '5m', '1h', '12h']);
    const cells = (i: number) => within(rows[i]!).getAllByRole('cell').map((c) => c.textContent);
    expect(cells(0)).toEqual(['1m', '84,990', '+10', '+0.01%']);
    expect(cells(1)).toEqual(['5m', '85,100', '-100', '-0.12%']);
    expect(cells(3).slice(2)).toEqual(['—', '—']);
    expect(within(rows[0]!).getAllByRole('cell')[2]).toHaveClass('ov-up');
    expect(within(rows[1]!).getAllByRole('cell')[2]).toHaveClass('ov-down');
    expect(within(rows[3]!).getAllByRole('cell')[2]).toHaveClass('ov-muted');
  });

  it('[critical] the desk\'s marks sit apart, named: since the entry, and the last settlement', () => {
    render(<PriceChangePanel spot={85_000} price={{ spot: 85_000, rows: [row(1, null, 84_990), row(null, 'entry', 84_800), row(null, 'dayStart', 84_000)] }} />);
    const rows = within(screen.getByRole('table', { name: 'price change' })).getAllByRole('row').slice(1);
    expect(rows[1]).toHaveTextContent(/^Since entry \d\d:\d\d84,800\+200\+0\.24%$/);
    expect(rows[2]).toHaveTextContent('last settlement 17:3084,000+1,000+1.19%');
    expect(rows[1]).toHaveClass('ov-pchange-mark');
    expect(rows[0]).not.toHaveClass('ov-pchange-mark');
  });

  it('nothing read yet says so, with the price the screen already has', () => {
    render(<PriceChangePanel spot={85_123} price={null} />);
    expect(screen.getByText('No price record yet.')).toBeInTheDocument();
    expect(screen.getByText('BTC 85,123')).toBeInTheDocument();
  });
});
