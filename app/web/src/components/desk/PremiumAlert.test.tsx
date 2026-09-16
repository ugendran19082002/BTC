import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { PremiumAlert } from '@/components/desk/PremiumAlert';

const getPremiumAlerts = vi.fn();
const addPremiumAlert = vi.fn();
const deletePremiumAlert = vi.fn();
vi.mock('@/api/trade', () => ({
  getPremiumAlerts: (...a: unknown[]) => getPremiumAlerts(...a),
  addPremiumAlert: (...a: unknown[]) => addPremiumAlert(...a),
  deletePremiumAlert: (...a: unknown[]) => deletePremiumAlert(...a),
}));

/**
 * "Tell me when this strike pays 5."
 *
 * A doorbell on the best-trade card. What must hold: it opens on the desk's
 * premium floor, it refuses a level the bid is already past, it is honest when
 * nothing will actually be sent, and it lists what rang and when.
 */
const SYMBOL = 'P-BTC-74000-160926';
const telegram = { configured: true, on: true };

beforeEach(() => {
  vi.clearAllMocks();
  getPremiumAlerts.mockResolvedValue({ alerts: [], telegram });
  addPremiumAlert.mockResolvedValue({ ok: true });
  deletePremiumAlert.mockResolvedValue({ ok: true });
});

describe('the premium alert', () => {
  it('[critical] opens on the premium floor and sets an alert on the bid, once', async () => {
    render(<PremiumAlert symbol={SYMBOL} bidNow={2.6} />);
    expect((screen.getByLabelText('alert when the bid reaches') as HTMLInputElement).value).toBe('5');
    expect(screen.getByText(/On the bid, once\. The desk keeps trading either way/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Set alert/ }));
    await waitFor(() => expect(addPremiumAlert).toHaveBeenCalledWith(SYMBOL, 5));
  });

  it('[critical] refuses a level the bid is already past, and says to pick a higher one', () => {
    render(<PremiumAlert symbol={SYMBOL} bidNow={7.8} />);
    expect(screen.getByRole('button', { name: /Set alert/ })).toBeDisabled();
    expect(screen.getByText(/The bid is already 7\.80/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('alert when the bid reaches'), { target: { value: '9' } });
    expect(screen.getByRole('button', { name: /Set alert/ })).toBeEnabled();
  });

  it('refuses nothing, or a price of nothing', () => {
    render(<PremiumAlert symbol={SYMBOL} bidNow={2.6} />);
    fireEvent.change(screen.getByLabelText('alert when the bid reaches'), { target: { value: '0' } });
    expect(screen.getByRole('button', { name: /Set alert/ })).toBeDisabled();
    expect(screen.getByText('A price above zero.')).toBeInTheDocument();
  });

  it('[critical] says when nothing will be sent, rather than letting the alert look armed', async () => {
    getPremiumAlerts.mockResolvedValue({ alerts: [], telegram: { configured: true, on: false } });
    render(<PremiumAlert symbol={SYMBOL} bidNow={2.6} />);
    expect(await screen.findByText(/Alerts are switched off in the header/)).toBeInTheDocument();
    getPremiumAlerts.mockResolvedValue({ alerts: [], telegram: { configured: false, on: true } });
    render(<PremiumAlert symbol="C-BTC-80000-160926" bidNow={1} />);
    expect(await screen.findByText(/No Telegram bot on this server/)).toBeInTheDocument();
  });

  it('[critical] lists what is waiting and what rang, for this strike only', async () => {
    getPremiumAlerts.mockResolvedValue({
      alerts: [
        { id: 1, symbol: SYMBOL, threshold: 5, expiryTs: 0, createdAt: 0, firedAt: null, firedBid: null },
        { id: 2, symbol: SYMBOL, threshold: 4, expiryTs: 0, createdAt: 0, firedAt: Date.UTC(2026, 8, 16, 3, 40), firedBid: 4.2 },
        { id: 3, symbol: 'C-BTC-80000-160926', threshold: 9, expiryTs: 0, createdAt: 0, firedAt: null, firedBid: null },
      ],
      telegram,
    });
    render(<PremiumAlert symbol={SYMBOL} bidNow={2.6} />);
    const list = within(await screen.findByLabelText('alerts on this strike'));
    expect(list.getByText(/waiting for/)).toHaveTextContent('5.00');
    expect(list.getByText(/rang at/)).toHaveTextContent('4.20');
    expect(list.getByText(/rang at/)).toHaveTextContent('09:10');
    expect(list.queryByText(/9\.00/)).toBeNull();
  });

  it('a waiting alert can be removed', async () => {
    getPremiumAlerts.mockResolvedValue({
      alerts: [{ id: 7, symbol: SYMBOL, threshold: 5, expiryTs: 0, createdAt: 0, firedAt: null, firedBid: null }],
      telegram,
    });
    render(<PremiumAlert symbol={SYMBOL} bidNow={2.6} />);
    fireEvent.click(await screen.findByRole('button', { name: /Remove the alert at 5\.00/ }));
    await waitFor(() => expect(deletePremiumAlert).toHaveBeenCalledWith(7));
  });

  it('a refusal from the desk is shown', async () => {
    addPremiumAlert.mockRejectedValue(new Error('that contract has already settled'));
    render(<PremiumAlert symbol={SYMBOL} bidNow={2.6} />);
    fireEvent.click(screen.getByRole('button', { name: /Set alert/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent('that contract has already settled');
  });
});
