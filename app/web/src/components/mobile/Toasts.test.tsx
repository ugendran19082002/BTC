import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Trade } from '@/types/trade';

/**
 * The phone's live toasts (owner, 6 Oct 2026): what changed between two readings of the open trades, said once on
 * whatever screen is open, and pushed away with a finger.
 */

const getTradeDetail = vi.fn();
vi.mock('@/api/phone', () => ({ getTradeDetail: (...a: unknown[]) => getTradeDetail(...a) }));

const { Toasts, TOAST_MS } = await import('@/components/mobile/Toasts');
const { useTradeToasts } = await import('@/components/mobile/useTradeToasts');

const trade = (over: Partial<Trade> = {}): Trade => ({
  tradeId: 't1', symbol: 'P-BTC-84600-071026', productId: 1, optionSide: 'PE', phase: 'protected',
  position: -500, requestedSize: 500, entrySize: 500, entryAvgPrice: 45.2, exitSize: 0, exitAvgPrice: null,
  protection: { takeProfit: 'tp', stopLoss: 'sl' }, realisedPnl: 0, fills: [], note: null, alarm: null, updatedAt: 0,
  plan: {
    lots: 500, strategyName: 'Evening sell', entry: { type: 'limit', limitPrice: 45.2, timeoutMs: 5000, marketFallback: false }, takeProfitPrice: 30, stopPrice: 62,
    signal: { method: 'breakout', n: 1, name: 'Breakout', mode: 'single', tf: '5m', dir: -1, triggerTime: 1 },
  },
  ...over,
});
const waiting = () => trade({ phase: 'entry_pending', position: 0, entrySize: 0, entryAvgPrice: null });

const opened = vi.fn();
function Harness({ open, scope = 'all' }: { open: Trade[] | undefined; scope?: string }) {
  const live = useTradeToasts(open, scope);
  return <Toasts toasts={live.toasts} onOpen={opened} onDismiss={live.dismiss} />;
}

beforeEach(() => { vi.clearAllMocks(); });
afterEach(() => vi.useRealTimers());

describe('live toasts', () => {
  it('[critical] says an order waiting, then filled, then closed with how it ended and what it made', async () => {
    getTradeDetail.mockResolvedValue({
      trade: trade({
        position: 0, exitSize: 500, exitAvgPrice: 30, netRealisedUsd: 7.45, exitBy: 'option-tgt',
        fills: [{ orderId: 'e', role: 'entry', side: 'sell', size: 500, price: 45.2, ts: 0 }, { orderId: 'x', role: 'take_profit', side: 'buy', size: 500, price: 30, ts: 24 * 60_000 }],
      } as Partial<Trade>),
      events: [],
    });
    const { rerender } = render(<Harness open={[]} />);
    expect(screen.queryByText(/Order/)).toBeNull();

    rerender(<Harness open={[waiting()]} />);
    expect(await screen.findByText('Order waiting')).toBeInTheDocument();
    expect(screen.getByText('SELL 84,600 PE × 500 @ 45.20')).toBeInTheDocument();
    expect(screen.getByText('#1 Breakout · 5m · Evening sell')).toBeInTheDocument();

    rerender(<Harness open={[trade()]} />);
    expect(await screen.findByText('Order filled')).toBeInTheDocument();
    expect(screen.getByText(/TGT 30\.00 · SL 62\.00/)).toBeInTheDocument();

    rerender(<Harness open={[]} />);
    // said at once, then completed from the trade's own record
    expect(await screen.findByText('Target hit')).toBeInTheDocument();
    expect(screen.getByText('+₹633')).toBeInTheDocument(); // $7.45 at ₹85
    expect(screen.getByText('in 45.20 → out 30.00 · held 24m 00s')).toBeInTheDocument();
    expect(getTradeDetail).toHaveBeenCalledWith('t1');
  });

  it('[critical] the first reading and a change of account are only a baseline: no burst of toasts', () => {
    const { rerender } = render(<Harness open={undefined} />);
    rerender(<Harness open={[trade(), trade({ tradeId: 't2' })]} />);
    expect(screen.queryByText('Order filled')).toBeNull();
    rerender(<Harness open={[trade({ tradeId: 't9' })]} scope="2" />);
    expect(screen.queryByText(/Order|Position/)).toBeNull();
  });

  it('a tap opens the trade', async () => {
    const { rerender } = render(<Harness open={[]} />);
    rerender(<Harness open={[trade()]} />);
    fireEvent.click(await screen.findByRole('button', { name: /^Order filled/ }));
    expect(opened).toHaveBeenCalledWith('t1');
  });

  it('[critical] pushed far enough to a side, or up, it leaves; let go early, it stays', async () => {
    const { rerender } = render(<Harness open={[]} />);
    rerender(<Harness open={[trade()]} />);
    const card = (await screen.findByText('Order filled')).closest('.m-toast') as HTMLElement;

    // a short push: it comes back, and is not taken for a tap
    fireEvent.pointerDown(card, { clientX: 100, clientY: 100, pointerId: 1 });
    fireEvent.pointerMove(card, { clientX: 130, clientY: 100, pointerId: 1 });
    fireEvent.pointerUp(card, { clientX: 130, clientY: 100, pointerId: 1 });
    fireEvent.click(screen.getByRole('button', { name: /^Order filled/ }));
    expect(opened).not.toHaveBeenCalled();
    expect(screen.getByText('Order filled')).toBeInTheDocument();

    // a real swipe to the side
    fireEvent.pointerDown(card, { clientX: 100, clientY: 100, pointerId: 1 });
    fireEvent.pointerMove(card, { clientX: 220, clientY: 104, pointerId: 1 });
    fireEvent.pointerUp(card, { clientX: 220, clientY: 104, pointerId: 1 });
    await waitFor(() => expect(screen.queryByText('Order filled')).toBeNull());

    // and upward
    rerender(<Harness open={[trade(), trade({ tradeId: 't2', symbol: 'C-BTC-85200-071026' })]} />);
    const second = (await screen.findByText('Order filled')).closest('.m-toast') as HTMLElement;
    fireEvent.pointerDown(second, { clientX: 100, clientY: 100, pointerId: 2 });
    fireEvent.pointerMove(second, { clientX: 102, clientY: 40, pointerId: 2 });
    fireEvent.pointerUp(second, { clientX: 102, clientY: 40, pointerId: 2 });
    await waitFor(() => expect(screen.queryByText('Order filled')).toBeNull());
  });

  it('left alone it goes by itself, and the cross closes it', async () => {
    vi.useFakeTimers();
    const { rerender } = render(<Harness open={[]} />);
    rerender(<Harness open={[trade()]} />);
    expect(screen.getByText('Order filled')).toBeInTheDocument();
    act(() => { vi.advanceTimersByTime(TOAST_MS + 400); });
    expect(screen.queryByText('Order filled')).toBeNull();

    rerender(<Harness open={[trade(), trade({ tradeId: 't3' })]} />);
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    act(() => { vi.advanceTimersByTime(400); });
    expect(screen.queryByText('Order filled')).toBeNull();
  });
});
