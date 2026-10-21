import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { AccountCard } from '@/components/trade/AccountCard';
import type { TradeStatus } from '@/types/trade';

const setShortCap = vi.fn();
vi.mock('@/api/desk', () => ({
  getSettings: () => Promise.resolve({ settings: {}, shortCap: { inForce: 159, ceiling: 3000, chosen: 159 } }),
  setShortCap: (...a: unknown[]) => setShortCap(...a),
}));

const status = (): TradeStatus => ({
  mode: 'live', live: true, canGoLive: true, switchBlockedBy: null, balanceUsd: 28.81, walletUsd: 75.68, marginUsedUsd: 46.87,
  open: [], positions: [], alarms: [], realisedTodayUsd: 0, lossTodayUsd: 0,
  today: { realisedUsd: 0, lossUsd: 0, profitUsd: 0, unrealisedUsd: 0, chargesUsd: 0, netUsd: 0 },
  limits: { maxLeverage: 200, maxQuoteAgeMs: 3000, maxSpreadPct: 0.15, minBookCoverage: 0.5, maxShortContracts: 159, maxDailyLossUsd: 37.84, minPremiumUsd: 5, allowPyramiding: false },
  room: {
    freeUsd: 28.81,
    sell: { limit: 159, held: 97, byLimit: 62, byMargin: 66, perLotUsd: 0.43, lots: 62 },
  },
} as unknown as TradeStatus);

beforeEach(() => { vi.clearAllMocks(); localStorage.clear(); });

describe('the position limits on Positions', () => {
  it('[critical] selling only: the short limit and how many lots can still be sold, and no BUY side at all', async () => {
    render(<AccountCard status={status()} />);
    expect(await screen.findByLabelText('short cap')).toHaveTextContent('97 of 159 contracts');
    expect(screen.getByLabelText('room to sell')).toHaveTextContent('Can still sell 62 lotsLimit leaves 62Margin carries 66 at 200x');
    // 21 Oct 2026: "SELL choice only, no BUY": no tabs, no long limit, no room to buy.
    expect(screen.queryByRole('tablist')).toBeNull();
    expect(screen.queryByLabelText('long cap')).toBeNull();
    expect(screen.queryByLabelText('room to buy')).toBeNull();
  });
});

describe('several accounts together ("All accounts")', () => {
  const combined = (): TradeStatus => ({
    ...status(), room: undefined,
    positions: [{ symbol: 'P', size: -11 }, { symbol: 'C', size: 1 }],
    limits: { ...status().limits, maxShortContracts: 126, maxDailyLossUsd: 26.83 },
    combined: {
      lossLeftUsd: 25.65, lossLimitUsd: 26.83,
      accounts: [
        { id: 1, name: 'SELL', totalUsd: 75.47, availableUsd: 51.29, openPnlUsd: 1.4, netTodayUsd: 6.16, positions: 2 },
        { id: 2, name: 'BUY', totalUsd: 2.39, availableUsd: 2.35, openPnlUsd: 0.005, netTodayUsd: -2.997, positions: 1 },
      ],
    },
  } as unknown as TradeStatus);

  it('[critical] the card says it is all of them, lists each account\'s own figures, and its limits are read, not edited', async () => {
    render(<AccountCard status={combined()} />);
    expect(screen.getByText('Account · all 2 accounts')).toBeInTheDocument();
    const rows = within(screen.getByRole('table', { name: 'by account' })).getAllByRole('row');
    expect(rows[1]).toHaveTextContent('SELL2 open₹6,415+₹119+₹524');
    expect(rows[2]).toHaveTextContent('BUY1 open₹203');
    // The summed short limit, counted from the positions (a long held is not counted); no Edit, and no one account's setting read over them.
    expect(await screen.findByLabelText('short cap')).toHaveTextContent('11 of 126 contracts');
    expect(screen.queryByRole('button', { name: 'Edit the short limit' })).toBeNull();
    expect(screen.getByLabelText('loss budget left')).toHaveTextContent('₹2,180 of ₹2,281 left');
  });
});
