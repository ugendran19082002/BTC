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
    await waitFor(() => expect(previewAdd).toHaveBeenCalledWith({ tradeId: 't1', lots: 100, limitPrice: null, timeoutMin: 60, chaseSeconds: 5 }));
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
    await waitFor(() => expect(previewAdd).toHaveBeenLastCalledWith({ tradeId: 't1', lots: 100, limitPrice: 27.5, timeoutMin: 60, chaseSeconds: 5 }));
    expect(screen.getByText(/Never sold under 27\.50/)).toBeInTheDocument();
  });

  /*
   * How long the add works for.
   *
   * The window is the whole point of an add by hand: "sell more of this if the
   * price comes to me". It used to be five minutes, unasked and unshown, which
   * is long enough for the chase and nothing else.
   */
  it('[critical] defaults to an hour, and says what happens when it runs out', async () => {
    show();
    expect((screen.getByLabelText('how long the add works for') as HTMLInputElement).value).toBe('60');
    expect(screen.getByText(/Rests until it fills or 1h passes, then whatever is left is cancelled/)).toBeInTheDocument();
    expect(screen.getByText(/stopped from the position card/)).toBeInTheDocument();
  });

  it('[critical] the window is sent with the add', async () => {
    show();
    typeLots('100');
    fireEvent.change(screen.getByLabelText('how long the add works for'), { target: { value: '15' } });
    await waitFor(() => expect(previewAdd).toHaveBeenLastCalledWith({ tradeId: 't1', lots: 100, limitPrice: null, timeoutMin: 15, chaseSeconds: 5 }));
    swipe(slider());
    await waitFor(() => expect(addToPosition).toHaveBeenCalledWith({ tradeId: 't1', lots: 100, limitPrice: null, timeoutMin: 15, chaseSeconds: 5 }));
  });

  it('the chips fill in the windows anyone actually picks', async () => {
    show();
    const box = screen.getByLabelText('how long the add works for') as HTMLInputElement;
    fireEvent.click(screen.getByRole('button', { name: '15m' }));
    expect(box.value).toBe('15');
    fireEvent.click(screen.getByRole('button', { name: '4h' }));
    expect(box.value).toBe('240');
    expect(screen.getByText(/or 4h passes/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '1h' }));
    expect(box.value).toBe('60');
  });

  it('[critical] refuses a window past four hours, or none at all, and sends nothing', async () => {
    show();
    typeLots('100');
    for (const bad of ['241', '0', '']) {
      fireEvent.change(screen.getByLabelText('how long the add works for'), { target: { value: bad } });
      expect(screen.getByText(/A window of more than 0 and at most 240 minutes/)).toBeInTheDocument();
      expect(slider()).toHaveAttribute('aria-disabled', 'true');
    }
    swipe(slider());
    expect(addToPosition).not.toHaveBeenCalled();
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
    await waitFor(() => expect(slider()).not.toHaveAttribute('aria-disabled'));
    fireEvent.click(slider());
    expect(addToPosition).not.toHaveBeenCalled();
  });

  it('[critical] a full swipe sends the previewed body, once, and closes', async () => {
    const { onAdded, onOpenChange } = show();
    typeLots('100');
    await waitFor(() => expect(slider()).not.toHaveAttribute('aria-disabled'));
    swipe(slider());
    await waitFor(() => expect(addToPosition).toHaveBeenCalledTimes(1));
    expect(addToPosition).toHaveBeenCalledWith({ tradeId: 't1', lots: 100, limitPrice: null, timeoutMin: 60, chaseSeconds: 5 });
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
    await waitFor(() => expect(slider()).not.toHaveAttribute('aria-disabled'));
    swipe(slider());
    await screen.findByText('The day is already down $50, at its limit.');
    expect(onAdded).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });
});

/*
 * "If not filled, sell at bid after N seconds".
 *
 * The same control the order ticket carries, because an add by hand does the
 * same thing: it rests at the offer with nobody watching it. On at five
 * seconds, which is what every add by hand has done; off rests at the ask and
 * only the window ends it. The typed price stays the floor either way.
 */
describe('selling at the bid if it does not fill', () => {
  it('[critical] is on at five seconds, and the seconds it is set to are sent', async () => {
    show();
    fireEvent.change(screen.getByLabelText('lots to add'), { target: { value: '100' } });
    const box = screen.getByLabelText('seconds before selling at the bid');
    expect(box).toHaveValue('5');
    fireEvent.change(box, { target: { value: '45' } });
    await waitFor(() => expect(previewAdd).toHaveBeenLastCalledWith(
      { tradeId: 't1', lots: 100, limitPrice: null, timeoutMin: 60, chaseSeconds: 45 },
    ));
    expect(screen.getByText(/walks toward the bid over 45 seconds/)).toBeInTheDocument();
  });

  it('[critical] switched off it rests at the ask: nothing crosses the spread', async () => {
    show();
    fireEvent.change(screen.getByLabelText('lots to add'), { target: { value: '100' } });
    fireEvent.click(screen.getByRole('checkbox', { name: /If not filled, sell at bid after/ }));
    await waitFor(() => expect(previewAdd).toHaveBeenLastCalledWith(
      { tradeId: 't1', lots: 100, limitPrice: null, timeoutMin: 60, chaseSeconds: 0 },
    ));
    expect(screen.getByText(/Rests at the ask and never crosses/)).toBeInTheDocument();
    expect(screen.getByLabelText('seconds before selling at the bid')).toBeDisabled();
  });

  it('keeps the seconds inside 1 and 600, whatever is typed', () => {
    show();
    const box = screen.getByLabelText('seconds before selling at the bid');
    fireEvent.change(box, { target: { value: '0' } });
    expect(box).toHaveValue('1');
    fireEvent.change(box, { target: { value: '9000' } });
    expect(box).toHaveValue('600');
    fireEvent.change(box, { target: { value: 'abc' } });
    expect(box).toHaveValue('1');
  });

  /*
   * 18 September: "sell at bid after 5 sec" was on, the add rested at 20.00
   * with the bid at 19.00 for an hour, and nothing crossed. The typed price is
   * also the floor, so it forbade the crossing the switch asked for. The sheet
   * has to say that before the order is sent.
   */
  it('[critical] a price with nothing to walk to says so, in the words of the book', async () => {
    previewAdd.mockResolvedValue(ok({ startPrice: 20, floorPrice: 20, bid: 19, ask: 20, canWalk: false }));
    show();
    fireEvent.change(screen.getByLabelText('lots to add'), { target: { value: '200' } });
    fireEvent.change(screen.getByLabelText('add price'), { target: { value: '20' } });
    expect(await screen.findByText(/Nothing to walk to: 20.00 is also the floor, and the bid is 19.00/))
      .toBeInTheDocument();
    expect(screen.getByText(/Leave the price blank, or set it under the ask, for it to cross/)).toBeInTheDocument();
  });

  it('[critical] with room to walk it says the range it will walk', async () => {
    previewAdd.mockResolvedValue(ok({ startPrice: 20, floorPrice: 19, bid: 19, ask: 20, canWalk: true }));
    show();
    fireEvent.change(screen.getByLabelText('lots to add'), { target: { value: '200' } });
    expect(await screen.findByText(/Walks 20.00 → 19.00 over 5 seconds, and never under 19.00/)).toBeInTheDocument();
  });

  it('switched off, the walk is not described at all', async () => {
    previewAdd.mockResolvedValue(ok({ startPrice: 20, floorPrice: 20, bid: 19, ask: 20, canWalk: false }));
    show();
    fireEvent.change(screen.getByLabelText('lots to add'), { target: { value: '200' } });
    await screen.findByText(/Nothing to walk to/);
    fireEvent.click(screen.getByRole('checkbox', { name: /If not filled, sell at bid after/ }));
    expect(screen.queryByText(/Nothing to walk to/)).toBeNull();
    expect(screen.getByText('Left at the ask until it fills or the window ends.')).toBeInTheDocument();
  });

  it('a typed price is still the floor when it crosses', async () => {
    show();
    fireEvent.change(screen.getByLabelText('lots to add'), { target: { value: '100' } });
    fireEvent.change(screen.getByLabelText('add price'), { target: { value: '27.5' } });
    expect(screen.getByText(/never under \$27.50/)).toBeInTheDocument();
  });

  it('opens fresh: yesterday\'s seconds are not today\'s', () => {
    const t = trade();
    const { rerender } = render(<AddLotsSheet trade={t} open onOpenChange={() => {}} onAdded={() => {}} />);
    fireEvent.change(screen.getByLabelText('seconds before selling at the bid'), { target: { value: '90' } });
    rerender(<AddLotsSheet trade={t} open={false} onOpenChange={() => {}} onAdded={() => {}} />);
    rerender(<AddLotsSheet trade={t} open onOpenChange={() => {}} onAdded={() => {}} />);
    expect(screen.getByLabelText('seconds before selling at the bid')).toHaveValue('5');
  });
});

