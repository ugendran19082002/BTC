import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { CloseAllButton } from '@/components/trade/CloseAllButton';
import { swipe } from '@/test/swipe';
import type { Trade } from '@/types/trade';

const closeAllTrades = vi.fn();
vi.mock('@/api/trade', () => ({ closeAllTrades: (...a: unknown[]) => closeAllTrades(...a) }));

/**
 * Close all: see what "all" is, and what it leaves, before agreeing -- and agree
 * with a swipe, never a tap.
 */

const base = (over: Partial<Trade>): Trade => ({
  tradeId: 't', symbol: 'C-BTC-78400-110926', productId: 1, optionSide: 'CE', phase: 'protected',
  position: -425, requestedSize: 425, entrySize: 425, entryAvgPrice: 11, exitSize: 0, exitAvgPrice: null,
  protection: { takeProfit: 'tp', stopLoss: null }, realisedPnl: 0, fills: [], note: null, alarm: null,
  updatedAt: Date.now(), ...over,
});

const ce = base({ tradeId: 'ce', live: { markPrice: 4, unrealisedPnl: 2.975, decayed: 0.6, liquidationPrice: null, netIfClosedUsd: 2.8 } });
const pe = base({
  tradeId: 'pe', symbol: 'P-BTC-74000-110926', optionSide: 'PE', position: -222, entryAvgPrice: 12,
  live: { markPrice: 1.46, unrealisedPnl: 2.34, decayed: 0.88, liquidationPrice: null, netIfClosedUsd: 4.4 },
});
const waiting = base({ tradeId: 'w', symbol: 'C-BTC-80000-110926', position: 0, entrySize: 0, phase: 'entry_pending',
  plan: { lots: 10, entry: { type: 'limit', limitPrice: 9, timeoutMs: 0, marketFallback: false }, takeProfitPrice: null, stopPrice: null } });

beforeEach(() => {
  vi.clearAllMocks();
  closeAllTrades.mockResolvedValue({ ok: true, closed: ['ce', 'pe'], cancelled: ['w'], failed: [] });
});

const openSheet = (trades: Trade[]) => {
  render(<CloseAllButton trades={trades} />);
  fireEvent.click(screen.getByRole('button', { name: 'Close all' }));
};

describe('close all', () => {
  it('[critical] the button only asks', () => {
    openSheet([ce, pe]);
    expect(closeAllTrades).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: 'Close all positions and orders?' })).toBeInTheDocument();
  });

  it('[critical] lists every position with its live P&L and what closing it leaves, and the total', () => {
    openSheet([ce, pe, waiting]);
    const dialog = within(screen.getByRole('dialog'));
    expect(dialog.getByText('Short 425 @ 11.00 · now 4.00')).toBeInTheDocument();
    expect(dialog.getByText('Short 222 @ 12.00 · now 1.46')).toBeInTheDocument();
    expect(dialog.getByText('+₹253')).toBeInTheDocument();     // 2.975 x 85
    expect(dialog.getByText('+₹374')).toBeInTheDocument();     // 4.4 x 85
    // (2.8 + 4.4) x 85 = 612
    expect(within(dialog.getByLabelText('if everything closes now')).getByText('+₹612')).toBeInTheDocument();
    expect(dialog.getByText('Selling 10 lots @ 9.00')).toBeInTheDocument();
  });

  it('does not add up a total with a price missing', () => {
    openSheet([ce, { ...pe, live: { ...pe.live!, netIfClosedUsd: null } }]);
    expect(within(screen.getByLabelText('if everything closes now')).getByText('waiting for every price')).toBeInTheDocument();
  });

  it('[critical] a part-way swipe closes nothing; a full swipe closes all and reports', async () => {
    openSheet([ce, pe, waiting]);
    const control = screen.getByRole('slider', { name: /Swipe to close all 3/ });
    fireEvent.click(control);
    swipe(control, 0.8);
    expect(closeAllTrades).not.toHaveBeenCalled();
    swipe(control, 1);
    await waitFor(() => expect(closeAllTrades).toHaveBeenCalledTimes(1));
    expect(await screen.findByText('All closed')).toBeInTheDocument();
  });

  it('Keep them sends nothing', () => {
    openSheet([ce]);
    fireEvent.click(screen.getByRole('button', { name: 'Keep them' }));
    expect(closeAllTrades).not.toHaveBeenCalled();
  });
});
