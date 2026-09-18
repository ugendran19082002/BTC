import { beforeEach, describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { MoveSection } from '@/components/desk/MoveSection';
import { TODAY_MOVE, type MarketRead, type SnapshotMeta } from '@/types/desk';

/**
 * How far BTC has moved, and how far it can move from here: two cards of their
 * own. The figures are the ones the section always showed; what is pinned here
 * is that they still read right, grouped, signed, and folded where asked.
 */

const snap = { spot: 76_233, atmIv: 0.3, hoursToExpiry: 10.9, expectedMove: 800 } as unknown as SnapshotMeta;
const market = {
  moves: [
    { hours: 1 / 60, label: 'last 1m', changeUsd: -8, changePct: -0.01, rangeUsd: 9, rangePct: 0.01 },
    { hours: 12, label: 'last 12h', changeUsd: 581, changePct: 0.77, rangeUsd: 1515, rangePct: 2 },
    { hours: 24, label: 'last 24h', changeUsd: 738, changePct: 0.97, rangeUsd: 1515, rangePct: 2 },
    { hours: 1.1, label: TODAY_MOVE, changeUsd: -17, changePct: -0.02, rangeUsd: 86, rangePct: 0.1 },
  ],
  max24hRangeUsd: 6547, max24hRangePct: 8.97,
} as unknown as MarketRead;

beforeEach(() => localStorage.clear());

describe('the move cards', () => {
  it('[critical] the table groups thousands and signs both columns with the desk minus', () => {
    render(<MoveSection market={market} snap={snap} />);
    const table = within(screen.getByRole('table', { name: 'how far BTC has moved' }));
    const twelve = table.getByText('last 12h').closest('tr')!;
    expect(twelve).toHaveTextContent('+$581+0.77%$1,515');
    const minute = table.getByText('last 1m').closest('tr')!;
    expect(minute).toHaveTextContent('−$8−0.01%$9');
    expect(screen.getByText('Biggest day this month').nextSibling).toHaveTextContent('$6,547 · 8.97%');
  });

  it('today since 05:30 stands out and says how far into the day it is', () => {
    render(<MoveSection market={market} snap={snap} />);
    const today = screen.getByText(TODAY_MOVE).closest('tr')!;
    expect(today).toHaveClass('today');
    expect(today).toHaveTextContent('1.1h in');
  });

  it('[critical] the ladder ends at the expiry move, centred on spot', () => {
    render(<MoveSection market={market} snap={snap} />);
    const ladder = within(screen.getByLabelText('how far it can move from here'));
    // 76,233 × 0.30 × √(10.9 ÷ 8760) = 806.7
    expect(ladder.getByText('By expiry').parentElement).toHaveTextContent('±$807');
    expect(ladder.getByText('75,426')).toBeInTheDocument();
    expect(ladder.getByText('77,040')).toBeInTheDocument();
    expect(ladder.getByText("Direction can't be predicted — only distance.")).toBeInTheDocument();
  });

  it('with no volatility there is no ladder card, and the table still shows', () => {
    render(<MoveSection market={market} snap={{ ...snap, atmIv: null }} />);
    expect(screen.queryByText('How far it can move from here')).toBeNull();
    expect(screen.getByText('How far BTC has moved')).toBeInTheDocument();
  });

  it('folded by default where asked, as on a phone', () => {
    render(<MoveSection market={market} snap={snap} defaultOpen={false} />);
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.getByText('How far BTC has moved')).toBeInTheDocument();
  });
});
