import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AccountCard } from '@/components/trade/AccountCard';
import type { TradeStatus } from '@/types/trade';

/** A <dd> has no role, so getByLabelText cannot reach it. Query it directly. */
const budgetLine = (c: HTMLElement) => c.querySelector('[aria-label="loss budget left"]');

const status = (over: Partial<TradeStatus> = {}): TradeStatus => ({
  mode: 'live', live: true, canGoLive: true, switchBlockedBy: null,
  balanceUsd: 0.59, unrealisedPnlUsd: -0.0016, realisedTodayUsd: 0,
  positions: [], open: [], alarms: [],
  limits: {
    maxLeverage: 200, maxQuoteAgeMs: 3000, maxSpreadPct: 0.04, minBookCoverage: 0.5,
    maxShortContracts: 500, maxDailyLossUsd: 5, minPremiumUsd: 5, allowPyramiding: false,
  },
  ...over,
});

describe('the money, in both currencies', () => {
  it('shows what is free in dollars and rupees', () => {
    render(<AccountCard status={status()} />);
    // three places under a dollar: on this account the tenths of a cent matter
    expect(screen.getByText('$0.590')).toBeInTheDocument();
    expect(screen.getByText('₹50.15')).toBeInTheDocument();
  });

  it('shows a loss as a loss, in both', () => {
    render(<AccountCard status={status()} />);
    const dollars = screen.getByText('−$0.002');
    expect(dollars.className).toContain('--down');
    expect(screen.getByText('−₹0.14')).toBeInTheDocument();
  });

  it('shows a gain in green', () => {
    render(<AccountCard status={status({ unrealisedPnlUsd: 0.4 })} />);
    expect(screen.getByText('+$0.400').className).toContain('--up');
  });

  it('says nothing at all before the server has answered', () => {
    const { container } = render(<AccountCard status={null} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe("the day's loss budget", () => {
  it('is whole while nothing has been lost', () => {
    const { container } = render(<AccountCard status={status()} />);
    expect(budgetLine(container)).toHaveTextContent('$5.00 of $5.00 left');
  });

  it('counts down as losses are booked, and says what happens at the end', () => {
    const { container } = render(<AccountCard status={status({ realisedTodayUsd: -4 })} />);
    expect(budgetLine(container)).toHaveTextContent('$1.00 of $5.00 left');
    expect(screen.getByText(/80% used/)).toBeInTheDocument();
    expect(screen.getByText(/New trades stop when it runs out/)).toBeInTheDocument();
  });

  it('does not go negative when the day has gone past the limit', () => {
    const { container } = render(<AccountCard status={status({ realisedTodayUsd: -9 })} />);
    expect(budgetLine(container)).toHaveTextContent('$0.00 of $5.00 left');
    // past the limit the percentage stops being the point: the gate is shut
    expect(screen.getByText(/Budget spent\. New trades are blocked/)).toBeInTheDocument();
  });

  it('a profitable day does not eat the budget', () => {
    const { container } = render(<AccountCard status={status({ realisedTodayUsd: 3 })} />);
    expect(budgetLine(container)).toHaveTextContent('$5.00 of $5.00 left');
    expect(screen.queryByText(/used/)).toBeNull();
  });
});

describe('what is held', () => {
  it('says nothing is open when nothing is', () => {
    render(<AccountCard status={status()} />);
    expect(screen.getByText('nothing open')).toBeInTheDocument();
  });

  it('counts the contracts that are', () => {
    render(<AccountCard status={status({
      positions: [{ symbol: 'C-BTC-81000-090926', productId: 1, size: -3, entryPrice: 19, unrealisedPnl: null }],
    })} />);
    expect(screen.getByText('3 contracts')).toBeInTheDocument();
  });
});

describe('the mode', () => {
  it('says which book this is', () => {
    const { rerender } = render(<AccountCard status={status()} />);
    expect(screen.getByText('real money')).toBeInTheDocument();
    rerender(<AccountCard status={status({ mode: 'paper', live: false })} />);
    expect(screen.getByText('paper')).toBeInTheDocument();
  });
});
