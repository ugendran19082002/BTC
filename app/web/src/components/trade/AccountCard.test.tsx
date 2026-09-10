import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { AccountCard } from '@/components/trade/AccountCard';
import type { TradeStatus } from '@/types/trade';

/** A <dd> has no role, so getByLabelText cannot reach it. Query it directly. */
const budgetLine = (c: HTMLElement) => c.querySelector('[aria-label="loss budget left"]');
/** One labelled row, so a figure that also appears in "Net today" is not found twice. */
const row = (label: string) => within(screen.getByText(label).closest('div')!);

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
  it('leads with rupees and keeps the dollars beside them', () => {
    render(<AccountCard status={status()} />);
    // the account is Indian; the exchange quotes in dollars
    expect(screen.getByText('₹50.15')).toBeInTheDocument();
    expect(screen.getByText('$0.590')).toBeInTheDocument();
  });

  it('shows a loss as a loss, in both', () => {
    render(<AccountCard status={status()} />);
    expect(row('Open P&L').getByText('−₹0.14').className).toContain('--down');
    expect(row('Open P&L').getByText('−$0.002')).toBeInTheDocument();
  });

  it('shows a gain in green', () => {
    render(<AccountCard status={status({ unrealisedPnlUsd: 0.4 })} />);
    expect(row('Open P&L').getByText('+₹34.00').className).toContain('--up');
  });

  it('nets the day after charges', () => {
    render(<AccountCard status={status({
      unrealisedPnlUsd: 0,
      today: { realisedUsd: 4.25, unrealisedUsd: 0, chargesUsd: 0.25, netUsd: 4 },
    })} />);
    expect(row('Charges today').getByText('−₹21.25').className).toContain('--down');
    expect(row('Net today').getByText('+₹340').className).toContain('--up');
  });

  it('says nothing at all before the server has answered', () => {
    const { container } = render(<AccountCard status={null} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe("the day's loss budget", () => {
  it('is whole while nothing has been lost', () => {
    const { container } = render(<AccountCard status={status()} />);
    expect(budgetLine(container)).toHaveTextContent('₹425 of ₹425 left');
  });

  it('counts down as losses are booked, and says what happens at the end', () => {
    const { container } = render(<AccountCard status={status({ realisedTodayUsd: -4 })} />);
    expect(budgetLine(container)).toHaveTextContent('₹85.00 of ₹425 left');
    expect(screen.getByText(/80% used/)).toBeInTheDocument();
    expect(screen.getByText(/New trades stop at 100%/)).toBeInTheDocument();
  });

  it('does not go negative when the day has gone past the limit', () => {
    const { container } = render(<AccountCard status={status({ realisedTodayUsd: -9 })} />);
    expect(budgetLine(container)).toHaveTextContent('₹0 of ₹425 left');
    // past the limit the percentage stops being the point: the gate is shut
    expect(screen.getByText(/Limit reached\. New trades are blocked/)).toBeInTheDocument();
  });

  it('a profitable day does not eat the budget', () => {
    const { container } = render(<AccountCard status={status({ realisedTodayUsd: 3 })} />);
    expect(budgetLine(container)).toHaveTextContent('₹425 of ₹425 left');
    expect(screen.queryByText(/used/)).toBeNull();
  });
});

describe('what is held', () => {
  it('says nothing is open when nothing is', () => {
    render(<AccountCard status={status()} />);
    expect(screen.getByText('none')).toBeInTheDocument();
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
    expect(screen.getByText('LIVE')).toBeInTheDocument();
    rerender(<AccountCard status={status({ mode: 'paper', live: false })} />);
    expect(screen.getByText('PAPER')).toBeInTheDocument();
  });
});

describe('the short cap, visible before it refuses', () => {
  // The gate lives in the order ticket, so until this row existed the only way
  // to learn the limit was to be turned down by it mid-ticket.
  const position = (size: number): TradeStatus['positions'][number] => ({
    symbol: 'P-BTC-76800-090926', productId: 1, size, entryPrice: 32,
    markPrice: 29.92, unrealisedPnl: 0.854, liquidationPrice: null,
  });

  it('says how much of the cap is used', async () => {
    render(<AccountCard status={status({ positions: [position(-410)] })} />);
    const line = document.querySelector('[aria-label="short cap"]');
    expect(line?.textContent).toContain('410');
    expect(line?.textContent).toContain('of 500 contracts');
  });

  it('counts a short towards the cap by its size, not its sign', async () => {
    // The cap is on contracts short; a negative position is 410 of them, not −410.
    render(<AccountCard status={status({ positions: [position(-410)] })} />);
    expect(document.querySelector('[aria-label="short cap"]')?.textContent).not.toContain('-410');
  });

  it('offers the change control seeded with the limit in force', async () => {
    render(<AccountCard status={status({ positions: [position(-410)] })} />);
    fireEvent.click(screen.getByText('Edit'));
    expect((screen.getByLabelText('most contracts short') as HTMLInputElement).value).toBe('500');
  });

  it('refuses a cap that is not a whole number of contracts, without asking the server', async () => {
    render(<AccountCard status={status()} />);
    fireEvent.click(screen.getByText('Edit'));
    fireEvent.change(screen.getByLabelText('most contracts short'), { target: { value: '2.5' } });
    fireEvent.click(screen.getByText('Save'));
    expect(await screen.findByText(/whole number of contracts/)).toBeInTheDocument();
  });

  it('shows nothing open as zero used rather than as an empty row', async () => {
    render(<AccountCard status={status()} />);
    expect(document.querySelector('[aria-label="short cap"]')?.textContent).toContain('0');
  });
});
