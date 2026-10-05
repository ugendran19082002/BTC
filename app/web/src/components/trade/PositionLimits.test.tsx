import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { AccountCard } from '@/components/trade/AccountCard';
import type { TradeStatus } from '@/types/trade';

const setShortCap = vi.fn(), setLongCap = vi.fn();
vi.mock('@/api/desk', () => ({
  getSettings: () => Promise.resolve({ settings: {}, shortCap: { inForce: 159, ceiling: 3000, chosen: 159 }, longCap: { inForce: 40, chosen: 40 } }),
  setShortCap: (...a: unknown[]) => setShortCap(...a),
  setLongCap: (...a: unknown[]) => setLongCap(...a),
}));

const status = (): TradeStatus => ({
  mode: 'live', live: true, canGoLive: true, switchBlockedBy: null, balanceUsd: 28.81, walletUsd: 75.68, marginUsedUsd: 46.87,
  open: [], positions: [], alarms: [], realisedTodayUsd: 0, lossTodayUsd: 0,
  today: { realisedUsd: 0, lossUsd: 0, profitUsd: 0, unrealisedUsd: 0, chargesUsd: 0, netUsd: 0 },
  limits: { maxLeverage: 200, maxQuoteAgeMs: 3000, maxSpreadPct: 0.15, minBookCoverage: 0.5, maxShortContracts: 159, maxLongContracts: 40, maxDailyLossUsd: 37.84, minPremiumUsd: 5, allowPyramiding: false },
  room: {
    freeUsd: 28.81,
    sell: { limit: 159, held: 97, byLimit: 62, byMargin: 66, perLotUsd: 0.43, lots: 62 },
    buy: { limit: 40, held: 0, byLimit: 40, lossRoomUsd: 37.84, byPremium: [
      { premium: 50, perLotUsd: 0.052, lots: 40, byFree: 554, byLoss: 727 },
      { premium: 200, perLotUsd: 0.208, lots: 40, byFree: 138, byLoss: 181 },
    ] },
  },
} as unknown as TradeStatus);

beforeEach(() => { vi.clearAllMocks(); localStorage.clear(); });
const limits = () => within(screen.getByRole('tablist', { name: 'position limits' }));

describe('the position limits on Positions', () => {
  it('[critical] SELL first: the short limit and how many lots can still be sold', async () => {
    render(<AccountCard status={status()} />);
    expect(limits().getByRole('tab', { name: 'SELL · short limit' })).toHaveAttribute('aria-selected', 'true');
    expect(await screen.findByLabelText('short cap')).toHaveTextContent('97 of 159 contracts');
    expect(screen.getByLabelText('room to sell')).toHaveTextContent('Can still sell 62 lotsLimit leaves 62Margin carries 66 at 200x');
  });

  it('[critical] BUY: the long limit, lots you can buy by premium, and the tab remembered', async () => {
    const { unmount } = render(<AccountCard status={status()} />);
    fireEvent.click(limits().getByRole('tab', { name: 'BUY · long limit' }));
    expect(await screen.findByLabelText('long cap')).toHaveTextContent('0 of 40 contracts');
    // One line, and the table closed until asked for.
    expect(screen.getByLabelText('room to buy')).toHaveTextContent('Limit leaves 40 lotsFree ₹2,449Loss budget ₹3,216 left');
    expect(screen.queryByRole('table', { name: 'lots you can buy, by premium' })).toBeNull();
    const toggle = screen.getByRole('button', { name: 'Show lots by premium' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(toggle);
    expect(screen.getByRole('button', { name: 'Hide lots by premium' })).toHaveAttribute('aria-expanded', 'true');
    const rows = within(screen.getByRole('table', { name: 'lots you can buy, by premium' })).getAllByRole('row');
    expect(rows[1]).toHaveTextContent('$50');
    expect(rows[1]).toHaveTextContent('40 lots');
    unmount();
    render(<AccountCard status={status()} />);
    expect(limits().getByRole('tab', { name: 'BUY · long limit' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('table', { name: 'lots you can buy, by premium' })).toBeInTheDocument(); // left open: stays open
  });

  it('the long limit is edited on its own tab and saved through its own call', async () => {
    setLongCap.mockResolvedValue({ ok: true, key: 'max_long_contracts', value: '25', longCap: { inForce: 25, chosen: 25 } });
    render(<AccountCard status={status()} />);
    fireEvent.click(limits().getByRole('tab', { name: 'BUY · long limit' }));
    await screen.findByLabelText('long cap');
    fireEvent.click(screen.getByRole('button', { name: 'Edit the long limit' }));
    fireEvent.change(screen.getByLabelText('most contracts long'), { target: { value: '25' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(setLongCap).toHaveBeenCalledWith(25));
    expect(setShortCap).not.toHaveBeenCalled();
    expect(await screen.findByLabelText('long cap')).toHaveTextContent('0 of 25 contracts');
  });
});
