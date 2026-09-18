import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MarketHead } from '@/components/desk/MarketHead';
import type { MarketRead, SnapshotMeta } from '@/types/desk';

/**
 * The head of the Market card: BTC, its price and its day, beside the four
 * facts about the contract. The facts must be the same four the card always
 * carried; the change must be the same 24-hour return the BTC summary uses.
 */

const snap = {
  ts: 1_789_620_900, expiryTs: 1_789_646_400, expiry: '170926', hoursToExpiry: 10.9,
  spot: 76_232.94, atm: 76_200,
} as unknown as SnapshotMeta;
const market = (return24h: number | null) => ({ return24h } as unknown as MarketRead);

describe('the market head', () => {
  it('[critical] the price is grouped with one decimal, and the 24h change is in dollars and percent', () => {
    render(<MarketHead snap={snap} market={market(0.41)} />);
    expect(screen.getByLabelText('spot')).toHaveTextContent('76,232.9');
    // 76,232.94 − 76,232.94 ÷ 1.0041 = 311.3
    expect(screen.getByLabelText('24 hour change')).toHaveTextContent('+311 +0.41% (24h)');
  });

  it('a falling day carries the desk minus sign and the down colour', () => {
    render(<MarketHead snap={snap} market={market(-1.2)} />);
    const change = screen.getByLabelText('24 hour change');
    expect(change).toHaveTextContent('−926 −1.20% (24h)');
    expect(change).toHaveClass('down');
  });

  it('with no 24-hour reading the change is left out rather than shown as zero', () => {
    render(<MarketHead snap={snap} market={null} />);
    expect(screen.queryByLabelText('24 hour change')).toBeNull();
  });

  it('[critical] keeps the contract facts: settles, contract and time left, as of, ATM', () => {
    render(<MarketHead snap={snap} market={market(0.41)} />);
    expect(screen.getByText('Settles').nextSibling).toHaveTextContent(/IST$/);
    expect(screen.getByText('Contract').nextSibling).toHaveTextContent('170926 · 10.9h left');
    expect(screen.getByText('As of').nextSibling).toHaveTextContent(/IST$/);
    expect(screen.getByText('ATM strike').nextSibling).toHaveTextContent('76,200');
  });

  it('a contract two days out counts in days', () => {
    render(<MarketHead snap={{ ...snap, hoursToExpiry: 60 }} market={null} />);
    expect(screen.getByText('Contract').nextSibling).toHaveTextContent('170926 · 3 days left');
  });
});
