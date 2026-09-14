import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { AddLotsSheet } from '@/components/trade/AddLotsSheet';
import { swipe } from '@/test/swipe';
import type { AddPreview, Trade } from '@/types/trade';

const previewAdd = vi.fn();
const addToPosition = vi.fn();
vi.mock('@/api/trade', () => ({
  previewAdd: (...a: unknown[]) => previewAdd(...a),
  addToPosition: (...a: unknown[]) => addToPosition(...a),
}));

/**
 * Selling more of what is held, by hand.
 *
 * What must not happen: an add sent on a tap, an add sent that the gates would
 * refuse, or a preview that shows a size the server then turns down. The
 * preview and the add send the same body, and the swipe is only live once the
 * preview has said yes.
 */

/** Short 1,300 CE 78,800 at 9.95 average, the book at 25 / 28. */
const trade = (over: Partial<Trade> = {}): Trade => ({
  tradeId: 't1',
  symbol: 'C-BTC-78800-140926',
  productId: 1,
  optionSide: 'CE',
  phase: 'protected',
  position: -1300,
  requestedSize: 650,
  entrySize: 1300,
  entryAvgPrice: 9.95,
  exitSize: 0,
  exitAvgPrice: null,
  protection: { takeProfit: 'tp', stopLoss: null },
  realisedPnl: 0,
  fills: [],
  note: null,
  alarm: null,
  addedSize: 650,
  updatedAt: Date.now(),
  live: { markPrice: 25.33, bid: 25, ask: 28, unrealisedPnl: -19.99, decayed: null, liquidationPrice: 200.94 },
  ...over,
});

const ok = (over: Partial<AddPreview> = {}): AddPreview => ({
  mode: 'live', ok: true, reason: null, failures: [],
  startPrice: 28, floorPrice: 25,
  size: 100, newSize: 1400, newAvgPrice: 11.24,
  creditUsd: 2.8, entryChargesUsd: 0.21, marginUsd: 21.4,
  ...over,
});

const show = (t: Trade = trade()) => {
  const onAdded = vi.fn();
  const onOpenChange = vi.fn();
  render(<AddLotsSheet trade={t} open onOpenChange={onOpenChange} onAdded={onAdded} />);
  return { onAdded, onOpenChange };
};

const typeLots = (n: string) => fireEvent.change(screen.getByLabelText('lots to add'), { target: { value: n } });
const slider = () => screen.getByRole('slider', { name: /add/i });

beforeEach(() => {
  vi.clearAllMocks();
  previewAdd.mockResolvedValue(ok());
  addToPosition.mockResolvedValue({ mode: 'live', ok: true, trade: trade({ position: -1400 }) });
});

describe('before a size is typed', () => {
  it('shows the book and what is held, and asks nothing of the server', () => {
    show();
    expect(screen.getByText('Bid').nextSibling).toHaveTextContent('25.00');
    expect(screen.getByText('Ask').nextSibling).toHaveTextContent('28.00');
    expect(screen.getByText('Held').nextSibling).toHaveTextContent('1,300');
    expect(previewAdd).not.toHaveBeenCalled();
  });

  it('[critical] cannot be sent', () => {
    show();
    expect(slider()).toHaveAttribute('aria-disabled', 'true');
    swipe(slider());
    expect(addToPosition).not.toHaveBeenCalled();
  });
});

describe('the preview', () => {
  it('[critical] sends the body the add will send, and prices it in money', async () => {
    show();
    typeLots('100');
    await waitFor(() => expect(previewAdd).toHaveBeenCalledWith({ tradeId: 't1', lots: 100, limitPrice: null }));
    const dl = within(screen.getByLabelText('what this add does'));
    await waitFor(() => expect(dl.getByText('Starts at').nextSibling).toHaveTextContent('28.00'));
    expect(dl.getByText('Position after').nextSibling).toHaveTextContent('1,400 @ 11.24 avg');
    expect(dl.getByText('Premium collected').nextSibling).toHaveTextContent('$2.80');
    expect(dl.getByText('Charges to open').nextSibling).toHaveTextContent('₹');
    expect(dl.getByText('Margin held').nextSibling).toHaveTextContent('$21.40');
  });

  it('a typed price is sent, and named as the floor', async () => {
    show();
    typeLots('100');
    fireEvent.change(screen.getByLabelText('add price'), { target: { value: '27.5' } });
    await waitFor(() => expect(previewAdd).toHaveBeenLastCalledWith({ tradeId: 't1', lots: 100, limitPrice: 27.5 }));
    expect(screen.getByText(/Never sold under 27\.50/)).toBeInTheDocument();
  });

  it('asks nothing for a size that is not a size', async () => {
    show();
    typeLots('0');
    typeLots('abc');
    await act(async () => { await new Promise((r) => setTimeout(r, 300)); });
    expect(previewAdd).not.toHaveBeenCalled();
  });

  it('[critical] says why the gates refuse, and keeps the swipe dead', async () => {
    previewAdd.mockResolvedValue(ok({
      ok: false, reason: 'refused',
      failures: [{ code: 'MARGIN', message: 'Needs $2,140 of margin against $228 available.' }],
    }));
    show();
    typeLots('10000');
    await screen.findByText('Needs $2,140 of margin against $228 available.');
    expect(slider()).toHaveAttribute('aria-disabled', 'true');
    swipe(slider());
    expect(addToPosition).not.toHaveBeenCalled();
  });

  it('says when the trade itself cannot take an add', async () => {
    previewAdd.mockResolvedValue(ok({ ok: false, reason: 'an add is already working on this position', failures: [] }));
    show();
    typeLots('10');
    await screen.findByText('an add is already working on this position');
  });
});

describe('sending', () => {
  it('[critical] a tap sends nothing: it has to be swiped', async () => {
    show();
    typeLots('100');
    await waitFor(() => expect(slider()).toHaveAttribute('aria-disabled', 'false'));
    fireEvent.click(slider());
    expect(addToPosition).not.toHaveBeenCalled();
  });

  it('[critical] a full swipe sends the previewed body, once, and closes', async () => {
    const { onAdded, onOpenChange } = show();
    typeLots('100');
    await waitFor(() => expect(slider()).toHaveAttribute('aria-disabled', 'false'));
    swipe(slider());
    await waitFor(() => expect(addToPosition).toHaveBeenCalledTimes(1));
    expect(addToPosition).toHaveBeenCalledWith({ tradeId: 't1', lots: 100, limitPrice: null });
    await waitFor(() => expect(onAdded).toHaveBeenCalled());
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('[critical] a refusal at the moment of sending is shown, and the sheet stays open', async () => {
    addToPosition.mockResolvedValue({
      mode: 'live', ok: false, error: 'refused',
      failures: [{ code: 'DAILY_LOSS', message: 'The day is already down $50, at its limit.' }],
    });
    const { onAdded, onOpenChange } = show();
    typeLots('100');
    await waitFor(() => expect(slider()).toHaveAttribute('aria-disabled', 'false'));
    swipe(slider());
    await screen.findByText('The day is already down $50, at its limit.');
    expect(onAdded).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });
});
