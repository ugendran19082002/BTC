import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { PlacedLine, StrategyTag, placedBy } from '@/components/mobile/StrategyTag';

/**
 * The strategy's name as a tag on the phone's Positions, Orders and Trade history (owner, 8 Oct 2026).
 */
describe('StrategyTag', () => {
  it('[critical] says who placed the trade: the strategy by name, "By hand", or "Best pick"', () => {
    expect(placedBy({ origin: 'strategy', strategyId: '2h-time-copy', strategyName: '2h time delta' })).toEqual({ kind: 'strategy', label: '2h time delta' });
    expect(placedBy({ origin: 'manual' })).toEqual({ kind: 'manual', label: 'By hand' });
    expect(placedBy({ origin: 'best-pick' })).toEqual({ kind: 'best-pick', label: 'Best pick' });
    expect(placedBy(undefined)).toEqual({ kind: 'manual', label: 'By hand' });
    // A trade from before the name was kept shows its id; one from before the origin was written is a strategy's if it carries one.
    expect(placedBy({ origin: 'strategy', strategyId: '5-01-copy' })).toEqual({ kind: 'strategy', label: '5-01-copy' });
    expect(placedBy({ strategyId: 's1', strategyName: 'Evening sell' })).toEqual({ kind: 'strategy', label: 'Evening sell' });
    expect(placedBy({ origin: 'strategy' })).toEqual({ kind: 'strategy', label: 'Strategy' });
  });

  it('[critical] the tag reads the name out whole, and cuts a long one inside itself rather than growing', () => {
    const long = 'All time frame delta — the evening window, both accounts';
    render(<StrategyTag plan={{ origin: 'strategy', strategyName: long }} />);
    const tag = screen.getByLabelText(`Strategy: ${long}`);
    expect(tag).toHaveTextContent(long);
    expect(tag).toHaveAttribute('title', long);
    expect(tag.className).toMatch(/max-w-full/);
    expect(tag.querySelector('span')!.className).toMatch(/truncate/);
  });

  it('a trade by hand is tagged in grey, a strategy\'s in the accent colour', () => {
    const { unmount } = render(<StrategyTag plan={{ origin: 'manual' }} />);
    expect(screen.getByLabelText('Placed by hand').className).toMatch(/text-muted-foreground/);
    unmount();
    render(<StrategyTag plan={{ origin: 'strategy', strategyName: '1h time' }} />);
    expect(screen.getByLabelText('Strategy: 1h time').className).toMatch(/text-\[var\(--accent\)\]/);
  });

  it('[critical] the line: the tag first, then the signal and the account, and nothing after the tag when there is nothing to add', () => {
    const { container, unmount } = render(
      <PlacedLine plan={{ origin: 'strategy', strategyName: '2h time delta' }} rest={['#53 Microprice / queue imbalance · 2h', null, 'High Win%']} />,
    );
    expect(container.textContent).toBe('2h time delta#53 Microprice / queue imbalance · 2h · High Win%');
    // the tag keeps at most 45% of the line and its group's tag (10 Oct 2026) up to a third, so all three show their start
    expect(screen.getByLabelText('Strategy: 2h time delta').className).toMatch(/max-w-\[45%\]/);
    unmount();
    const alone = render(<PlacedLine plan={{ origin: 'manual' }} rest={[null, false]} />);
    expect(alone.container.textContent).toBe('By hand');
  });
});
