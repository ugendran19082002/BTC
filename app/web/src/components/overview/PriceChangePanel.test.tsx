import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { PriceChangePanel } from '@/components/overview/MarketPanels';
import type { PriceChange } from '@/api/desk';

/** The Live screen's "Price change" card: one tile a window, side by side, then the desk's own marks. */
const at = Date.UTC(2026, 9, 4, 6, 0, 0);
const row = (minutes: number | null, mark: PriceChange['mark'], then: number | null, now = 85_000): PriceChange =>
  ({ minutes, mark, at: at - (minutes ?? 90) * 60_000, then, pts: then === null ? null : now - then, pct: then === null ? null : (now / then - 1) * 100 });
const tiles = () => within(screen.getByRole('list', { name: 'price change' })).getAllByRole('listitem');

describe('the price change card', () => {
  it('[critical] a tile a window -- minutes, then hours -- with the move in points and percent; up and down told apart by arrow and sign, not colour alone', () => {
    render(<PriceChangePanel spot={85_000} price={{ spot: 85_000, rows: [row(1, null, 84_990), row(5, null, 85_100), row(60, null, 84_500), row(720, null, null)] }} />);
    expect(tiles().map((t) => t.textContent)).toEqual(['1m▲+10+0.01%', '5m▼-100-0.12%', '1h▲+500+0.59%', '12h——']);
    expect(tiles()[0]).toHaveClass('ov-pc-up');
    expect(tiles()[1]).toHaveClass('ov-pc-down');
    expect(tiles()[3]).toHaveClass('ov-pc-flat');
    expect(tiles()[0]).toHaveAttribute('title', expect.stringMatching(/^BTC was 84,990 at \d\d:\d\d IST$/));
  });

  it('[critical] the desk\'s marks are tiles of their own, named: since the entry, and the last settlement', () => {
    render(<PriceChangePanel spot={85_000} price={{ spot: 85_000, rows: [row(1, null, 84_990), row(null, 'entry', 84_800), row(null, 'dayStart', 84_000)] }} />);
    expect(tiles()[1]).toHaveTextContent(/^Since entry \d\d:\d\d▲\+200\+0\.24%$/);
    expect(tiles()[2]).toHaveTextContent('Last settlement 17:30▲+1,000+1.19%');
    expect(tiles()[1]).toHaveClass('ov-pc-mark');
    expect(tiles()[0]).not.toHaveClass('ov-pc-mark');
  });

  it('nothing read yet says so, with the price the screen already has', () => {
    render(<PriceChangePanel spot={85_123} price={null} />);
    expect(screen.getByText('No price record yet.')).toBeInTheDocument();
    expect(screen.getByText('BTC 85,123')).toBeInTheDocument();
  });
});
