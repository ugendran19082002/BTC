import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { AutoTradeSettings } from '@/components/desk/AutoTradeSettings';

const getAutoTrade = vi.fn();
const setAutoTrade = vi.fn();
const clearAutoTrade = vi.fn();
vi.mock('@/api/trade', () => ({
  getAutoTrade: (...a: unknown[]) => getAutoTrade(...a),
  setAutoTrade: (...a: unknown[]) => setAutoTrade(...a),
  clearAutoTrade: (...a: unknown[]) => clearAutoTrade(...a),
}));

/**
 * The switch that sells the best pick by itself.
 *
 * What these pin is the reading of it, because this is the one control on the
 * desk that places an order with nobody watching: off until armed, the live
 * warning in words, and the exact order it would place shown before it places
 * one. The rules it obeys are the server's, and tested there.
 */

const defaults = { on: false, lots: 5, targetPct: 95, stopPct: 0, chaseSeconds: 5, maxPerContract: 1 };
const limits = { maxLots: 1_000, minTargetPct: 1, maxTargetPct: 99, maxStopPct: 500, maxChaseSec: 600, maxPerContract: 10 };
const state = (over: Record<string, unknown> = {}) => ({
  settings: { ...defaults }, defaults, limits, mode: 'live', done: {}, ...over,
});
const pick = { side: 'CE' as const, strike: 78_600, premiumUsd: 10.1 };

const show = (over: Record<string, unknown> = {}) => {
  getAutoTrade.mockResolvedValue(state(over));
  return render(<AutoTradeSettings pick={pick} />);
};

beforeEach(() => {
  vi.clearAllMocks();
  setAutoTrade.mockImplementation(async (p: Record<string, unknown>) => ({ ok: true, settings: { ...defaults, ...p } }));
  clearAutoTrade.mockResolvedValue({ ok: true });
});

describe('selling the best pick automatically', () => {
  it('[critical] is off until it is armed, and says so', async () => {
    show();
    const sw = await screen.findByRole('switch', { name: /Sell this pick automatically/ });
    expect(sw).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByText(/Off — the card only names the trade/)).toBeInTheDocument();
    expect(screen.queryByText(/armed/)).toBeNull();
  });

  it('[critical] armed in live mode it says real orders, in those words', async () => {
    show({ settings: { ...defaults, on: true } });
    expect(await screen.findByText(/the desk places a real order for the pick, 5 lots, target 95%/)).toBeInTheDocument();
    expect(screen.getByText('armed — real orders')).toBeInTheDocument();
  });

  it('paper mode says the order is simulated', async () => {
    show({ mode: 'paper', settings: { ...defaults, on: true } });
    expect(await screen.findByText(/paper mode, so the order is simulated/)).toBeInTheDocument();
    expect(screen.getByText('armed — paper')).toBeInTheDocument();
  });

  it('[critical] arming sends only the switch, with the defaults left alone', async () => {
    show();
    fireEvent.click(await screen.findByRole('switch'));
    await waitFor(() => expect(setAutoTrade).toHaveBeenCalledWith({ on: true }));
  });

  it('[critical] the popup shows the order it would place, in the ticket\'s words', async () => {
    show();
    fireEvent.click(await screen.findByRole('button', { name: /Settings/ }));
    const popup = within(await screen.findByLabelText('auto-trade options'));
    expect(popup.getByLabelText('Lots')).toHaveValue('5');
    expect(popup.getByLabelText('Target %')).toHaveValue('95');
    // 95% of 10.10 kept: bought back near 0.51
    expect(popup.getByText(/Sell CE 78,600 — 5 lots, target 95% \(buy back near 0.51\), no stop\./)).toBeInTheDocument();
  });

  it('a number outside the limits is refused before it is sent', async () => {
    show();
    fireEvent.click(await screen.findByRole('button', { name: /Settings/ }));
    const box = await screen.findByLabelText('Lots');
    fireEvent.change(box, { target: { value: '99999' } });
    fireEvent.blur(box);
    expect(setAutoTrade).not.toHaveBeenCalled();
    expect(screen.getByText('1 to 1000')).toBeInTheDocument();
  });

  it('a changed number is saved when the box is left', async () => {
    show();
    fireEvent.click(await screen.findByRole('button', { name: /Settings/ }));
    const box = await screen.findByLabelText('Lots');
    fireEvent.change(box, { target: { value: '10' } });
    fireEvent.blur(box);
    await waitFor(() => expect(setAutoTrade).toHaveBeenCalledWith({ lots: 10 }));
  });

  it('[critical] what it has already done on this contract is shown, with a way back', async () => {
    show({
      settings: { ...defaults, on: true },
      done: {
        'CE-79000': { at: 1, status: 'placed', tradeId: 't1' },
        'PE-75000': { at: 2, status: 'refused', detail: 'not enough margin' },
      },
    });
    const done = within(await screen.findByLabelText('already decided on this contract'));
    expect(done.getByText(/Sold automatically: CE-79000\./)).toBeInTheDocument();
    expect(done.getByText(/Refused: PE-75000 \(not enough margin\)\./)).toBeInTheDocument();
    fireEvent.click(done.getByRole('button', { name: /consider them again/ }));
    await waitFor(() => expect(clearAutoTrade).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByLabelText('already decided on this contract')).toBeNull());
  });

  it('with nothing on the card it says so rather than describing an order', async () => {
    getAutoTrade.mockResolvedValue(state());
    render(<AutoTradeSettings pick={null} />);
    fireEvent.click(await screen.findByRole('button', { name: /Settings/ }));
    expect(await screen.findByText('Nothing on the card to sell right now.')).toBeInTheDocument();
  });

  it('a server that cannot be reached draws nothing at all', async () => {
    getAutoTrade.mockRejectedValue(new Error('offline'));
    const { container } = render(<AutoTradeSettings pick={pick} />);
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });
});
