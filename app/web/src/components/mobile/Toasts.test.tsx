import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Trade } from '@/types/trade';

/**
 * The phone's live toasts (owner, 6 Oct 2026): what changed between two readings of the open trades, said once on
 * whatever screen is open, and pushed away with a finger. Every rule that keeps them honest and quiet is here.
 */

const getTradeDetail = vi.fn();
vi.mock('@/api/phone', () => ({ getTradeDetail: (...a: unknown[]) => getTradeDetail(...a) }));

const { Toasts, TOAST_MS } = await import('@/components/mobile/Toasts');
const { useTradeToasts, summaryOf, AWAY_MS, REPEAT_MS } = await import('@/components/mobile/useTradeToasts');
type ToastT = import('@/components/mobile/Toasts').Toast;

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
const waiting = (over: Partial<Trade> = {}) => trade({ phase: 'entry_pending', position: 0, entrySize: 0, entryAvgPrice: null, ...over });
const exited = (over: Partial<Trade> = {}) => trade({ phase: 'exit_pending', position: 0, exitSize: 500, exitAvgPrice: 30, ...over });
/** The trade's own record once closed, as GET /api/trade/:id answers. */
const record = (over: Partial<Trade> = {}) => ({
  trade: trade({
    position: 0, exitSize: 500, exitAvgPrice: 30, netRealisedUsd: 7.45, exitBy: 'option-tgt', phase: 'flat',
    fills: [{ orderId: 'e', role: 'entry', side: 'sell', size: 500, price: 45.2, ts: 0 }, { orderId: 'x', role: 'take_profit', side: 'buy', size: 500, price: 30, ts: 24 * 60_000 }],
    ...over,
  } as Partial<Trade>),
  events: [],
});

const opened = vi.fn<(t: ToastT) => void>();
let clock = 1_000_000;
function Harness({ open, scope = 'all' }: { open: Trade[] | undefined; scope?: string }) {
  const live = useTradeToasts(open, scope, () => clock);
  return <Toasts toasts={live.toasts} onOpen={opened} onDismiss={live.dismiss} />;
}
/** The next reading, five seconds on, as the poll gives it. */
const read = (rerender: (ui: React.ReactElement) => void, open: Trade[], o: { scope?: string; after?: number } = {}) => {
  clock += o.after ?? 5_000;
  rerender(<Harness open={open} scope={o.scope} />);
};
const titles = () => screen.queryAllByText(/^(Order waiting|Order filled|Order not filled|Position closed|Target hit|Stop hit|Closed at its exit time|Closed by hand|While you were away|\d+ things just happened)$/).map((n) => n.textContent);

beforeEach(() => { vi.clearAllMocks(); clock = 1_000_000; getTradeDetail.mockResolvedValue(record()); });
afterEach(() => vi.useRealTimers());

describe('what is said', () => {
  it('[critical] an order waiting, then filled, then closed with how it ended and what it made', async () => {
    const { rerender } = render(<Harness open={[]} />);
    expect(titles()).toEqual([]);

    read(rerender, [waiting()]);
    expect(await screen.findByText('Order waiting')).toBeInTheDocument();
    expect(screen.getByText('SELL 84,600 PE × 500 @ 45.20')).toBeInTheDocument();
    expect(screen.getByText('#1 Breakout · 5m · Evening sell')).toBeInTheDocument();

    read(rerender, [trade()]);
    expect(await screen.findByText('Order filled')).toBeInTheDocument();
    expect(screen.getByText(/TGT 30\.00 · SL 62\.00/)).toBeInTheDocument();

    read(rerender, []);
    // said at once, then completed from the trade's own record
    expect(await screen.findByText('Target hit')).toBeInTheDocument();
    expect(screen.getByText('+₹633')).toBeInTheDocument(); // $7.45 at ₹85
    expect(screen.getByText('in 45.20 → out 30.00 · held 24m 00s')).toBeInTheDocument();
    expect(getTradeDetail).toHaveBeenCalledWith('t1');
  });

  it('[critical] a trade closed while the desk still lists it is "closed", never "Order not filled"', async () => {
    // The live desk, 15:21 on 6 Oct 2026: exit filled, position 0, still listed while the other exit comes off.
    const { rerender } = render(<Harness open={[trade()]} />);
    read(rerender, [exited()]);
    expect(await screen.findByText('Target hit')).toBeInTheDocument();
    read(rerender, []);
    expect(titles()).toEqual(['Target hit']);
    expect(screen.queryByText('Order not filled')).toBeNull();
    expect(getTradeDetail).toHaveBeenCalledTimes(1);
  });

  it('how a close ended, in words: stop, exit time, by hand -- and the loss in red', async () => {
    for (const [exitBy, words] of [['perp-sl', 'Stop hit'], ['window-end', 'Closed at its exit time'], ['manual', 'Closed by hand']] as const) {
      getTradeDetail.mockResolvedValue(record({ exitBy, netRealisedUsd: -4.9 }));
      const { rerender, unmount } = render(<Harness open={[trade({ tradeId: exitBy })]} />);
      read(rerender, []);
      const title = await screen.findByText(words);
      expect(title.className).toContain('--down');
      expect(screen.getByText('−₹417')).toBeInTheDocument();
      unmount();
    }
  });

  it('when the trade\'s record does not answer, the first words stand', async () => {
    getTradeDetail.mockRejectedValue(new Error('network'));
    const { rerender } = render(<Harness open={[trade()]} />);
    read(rerender, []);
    expect(await screen.findByText('Position closed')).toBeInTheDocument();
    await act(async () => { await Promise.resolve(); });
    expect(titles()).toEqual(['Position closed']);
  });

  it('an order with no limit, with no exits, placed by hand, on a named account', async () => {
    const hand = { lots: 6, origin: 'manual' as const, entry: { type: 'market' as const, timeoutMs: 0, marketFallback: false }, takeProfitPrice: null, stopPrice: null };
    const { rerender } = render(<Harness open={[]} />);
    read(rerender, [waiting({ plan: hand, account: { id: 2, name: 'BUY' } })]);
    expect(await screen.findByText('SELL 84,600 PE × 500 at market')).toBeInTheDocument();
    expect(screen.getByText('by hand · BUY')).toBeInTheDocument();
    read(rerender, [trade({ plan: hand, account: { id: 2, name: 'BUY' } })]);
    expect(await screen.findByText('Order filled')).toBeInTheDocument();
    expect(screen.queryByText(/TGT|SL /)).toBeNull();
  });

  it('an order that goes unfilled says so', async () => {
    const { rerender } = render(<Harness open={[waiting()]} />);
    read(rerender, []);
    expect(await screen.findByText('Order not filled')).toBeInTheDocument();
    expect(screen.getByText(/cancelled or expired/)).toBeInTheDocument();
    expect(getTradeDetail).not.toHaveBeenCalled();
  });
});

describe('what is not said', () => {
  it('[critical] the first reading and a change of account are only a baseline: no burst of toasts', () => {
    const { rerender } = render(<Harness open={undefined} />);
    read(rerender, [trade(), trade({ tradeId: 't2' })]);
    expect(titles()).toEqual([]);
    read(rerender, [trade({ tradeId: 't9' })], { scope: '2' });
    expect(titles()).toEqual([]);
    // and the reading after that is measured against the new account's own
    read(rerender, [trade({ tradeId: 't9' })], { scope: '2' });
    expect(titles()).toEqual([]);
  });

  it('a reading that did not arrive changes nothing', () => {
    const { rerender } = render(<Harness open={[trade()]} />);
    clock += 5_000;
    rerender(<Harness open={undefined} />);
    expect(titles()).toEqual([]);
    read(rerender, [trade()]);
    expect(titles()).toEqual([]);
  });

  it('[critical] the same thing about the same trade is said once in ten minutes, however the readings flicker', async () => {
    const { rerender } = render(<Harness open={[trade()]} />);
    read(rerender, []);
    await screen.findByText('Target hit');
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    await waitFor(() => expect(titles()).toEqual([]));
    // it flickers back and away again: no second "closed"
    read(rerender, [trade()]);
    read(rerender, []);
    await act(async () => { await Promise.resolve(); });
    expect(titles().filter((t) => t === 'Target hit' || t === 'Position closed')).toEqual([]);
    expect(getTradeDetail).toHaveBeenCalledTimes(1);
    // ten minutes on, it is news again
    read(rerender, [trade()], { after: REPEAT_MS + 1_000 });
    read(rerender, []);
    expect(await screen.findByText(/Target hit|Position closed/)).toBeInTheDocument();
  });

  it('[critical] a close toast pushed away is not brought back when its result arrives', async () => {
    let answer: (v: unknown) => void = () => undefined;
    getTradeDetail.mockReturnValue(new Promise((res) => { answer = res; }));
    const { rerender } = render(<Harness open={[trade()]} />);
    read(rerender, []);
    expect(await screen.findByText('Position closed')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    await waitFor(() => expect(titles()).toEqual([]));
    await act(async () => { answer(record()); await Promise.resolve(); });
    expect(titles()).toEqual([]);
  });
});

describe('many at once', () => {
  it('up to three are each said', async () => {
    const { rerender } = render(<Harness open={[]} />);
    read(rerender, [trade({ tradeId: 'a' }), trade({ tradeId: 'b' }), waiting({ tradeId: 'c' })]);
    await waitFor(() => expect(titles().sort()).toEqual(['Order filled', 'Order filled', 'Order waiting']));
  });

  it('[critical] more than three in one reading are one summary, which opens Orders', async () => {
    const { rerender } = render(<Harness open={[trade({ tradeId: 'a' }), trade({ tradeId: 'b' }), trade({ tradeId: 'c' })]} />);
    read(rerender, [trade({ tradeId: 'd' }), waiting({ tradeId: 'e' })]);
    expect(await screen.findByText('5 things just happened')).toBeInTheDocument();
    expect(screen.getByText('1 order waiting · 1 filled · 3 closed')).toBeInTheDocument();
    expect(titles()).toEqual(['5 things just happened']);
    expect(getTradeDetail).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /open Orders$/ }));
    expect(opened).toHaveBeenCalledWith(expect.objectContaining({ kind: 'summary', to: 'orders' }));
  });

  it('[critical] back after the screen was off: what happened meanwhile is one line, not a stack', async () => {
    const { rerender } = render(<Harness open={[trade({ tradeId: 'a' })]} />);
    read(rerender, [trade({ tradeId: 'b' })], { after: AWAY_MS + 5_000 });
    expect(await screen.findByText('While you were away')).toBeInTheDocument();
    expect(screen.getByText('1 filled · 1 closed')).toBeInTheDocument();
    expect(titles()).toEqual(['While you were away']);
  });

  it('never more than three on the screen', async () => {
    const { rerender } = render(<Harness open={[]} />);
    read(rerender, [trade({ tradeId: 'a' }), trade({ tradeId: 'b' })]);
    read(rerender, [trade({ tradeId: 'a' }), trade({ tradeId: 'b' }), trade({ tradeId: 'c' }), trade({ tradeId: 'd' })]);
    await waitFor(() => expect(document.querySelectorAll('.m-toast')).toHaveLength(3));
  });

  it('the words of a summary, in the order things happen to a trade', () => {
    const ev = (kind: 'waiting' | 'filled' | 'closed' | 'gone') => ({ kind, tradeId: 'x', trade: trade() });
    expect(summaryOf([ev('closed'), ev('waiting'), ev('waiting'), ev('gone'), ev('filled')])).toBe('2 orders waiting · 1 filled · 1 closed · 1 not filled');
    expect(summaryOf([])).toBe('');
  });

  it('one buzz for a reading, however many things it held', async () => {
    const vibrate = vi.fn();
    Object.defineProperty(navigator, 'vibrate', { value: vibrate, configurable: true });
    const { rerender } = render(<Harness open={[]} />);
    read(rerender, [trade({ tradeId: 'a' }), trade({ tradeId: 'b' })]);
    await screen.findAllByText('Order filled');
    expect(vibrate).toHaveBeenCalledTimes(1);
    read(rerender, [trade({ tradeId: 'a' }), trade({ tradeId: 'b' })]);
    expect(vibrate).toHaveBeenCalledTimes(1);
  });
});

describe('the hand', () => {
  it('a tap opens the trade', async () => {
    const { rerender } = render(<Harness open={[]} />);
    read(rerender, [trade()]);
    fireEvent.click(await screen.findByRole('button', { name: /^Order filled/ }));
    expect(opened).toHaveBeenCalledWith(expect.objectContaining({ tradeId: 't1', kind: 'filled' }));
  });

  it('[critical] pushed far enough to a side, or up, it leaves; let go early, it stays and is not taken for a tap', async () => {
    const { rerender } = render(<Harness open={[]} />);
    read(rerender, [trade()]);
    const card = (await screen.findByText('Order filled')).closest('.m-toast') as HTMLElement;

    fireEvent.pointerDown(card, { clientX: 100, clientY: 100, pointerId: 1 });
    fireEvent.pointerMove(card, { clientX: 130, clientY: 100, pointerId: 1 });
    fireEvent.pointerUp(card, { clientX: 130, clientY: 100, pointerId: 1 });
    fireEvent.click(screen.getByRole('button', { name: /^Order filled/ }));
    expect(opened).not.toHaveBeenCalled();
    expect(screen.getByText('Order filled')).toBeInTheDocument();

    fireEvent.pointerDown(card, { clientX: 100, clientY: 100, pointerId: 1 });
    fireEvent.pointerMove(card, { clientX: 220, clientY: 104, pointerId: 1 });
    fireEvent.pointerUp(card, { clientX: 220, clientY: 104, pointerId: 1 });
    await waitFor(() => expect(screen.queryByText('Order filled')).toBeNull());

    // to the other side, and upward
    read(rerender, [trade(), trade({ tradeId: 't2' })]);
    const second = (await screen.findByText('Order filled')).closest('.m-toast') as HTMLElement;
    fireEvent.pointerDown(second, { clientX: 200, clientY: 100, pointerId: 2 });
    fireEvent.pointerMove(second, { clientX: 90, clientY: 100, pointerId: 2 });
    fireEvent.pointerUp(second, { clientX: 90, clientY: 100, pointerId: 2 });
    await waitFor(() => expect(screen.queryByText('Order filled')).toBeNull());

    read(rerender, [trade(), trade({ tradeId: 't2' }), trade({ tradeId: 't3' })]);
    const third = (await screen.findByText('Order filled')).closest('.m-toast') as HTMLElement;
    fireEvent.pointerDown(third, { clientX: 100, clientY: 100, pointerId: 3 });
    fireEvent.pointerMove(third, { clientX: 102, clientY: 40, pointerId: 3 });
    fireEvent.pointerUp(third, { clientX: 102, clientY: 40, pointerId: 3 });
    await waitFor(() => expect(screen.queryByText('Order filled')).toBeNull());
  });

  it('it cannot be pulled down over the screen: a push downward does nothing', async () => {
    const { rerender } = render(<Harness open={[]} />);
    read(rerender, [trade()]);
    const card = (await screen.findByText('Order filled')).closest('.m-toast') as HTMLElement;
    fireEvent.pointerDown(card, { clientX: 100, clientY: 100, pointerId: 1 });
    fireEvent.pointerMove(card, { clientX: 100, clientY: 260, pointerId: 1 });
    fireEvent.pointerUp(card, { clientX: 100, clientY: 260, pointerId: 1 });
    expect(screen.getByText('Order filled')).toBeInTheDocument();
  });
});

describe('its time on the screen', () => {
  it('left alone it goes by itself, and the cross closes it', async () => {
    vi.useFakeTimers();
    const { rerender } = render(<Harness open={[]} />);
    read(rerender, [trade()]);
    expect(screen.getByText('Order filled')).toBeInTheDocument();
    act(() => { vi.advanceTimersByTime(TOAST_MS - 500); });
    expect(screen.getByText('Order filled')).toBeInTheDocument();
    act(() => { vi.advanceTimersByTime(900); });
    expect(screen.queryByText('Order filled')).toBeNull();

    read(rerender, [trade(), trade({ tradeId: 't3' })]);
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    act(() => { vi.advanceTimersByTime(400); });
    expect(screen.queryByText('Order filled')).toBeNull();
  });

  it('[critical] held under a finger it waits, and has its full time again when let go', async () => {
    vi.useFakeTimers();
    const { rerender } = render(<Harness open={[]} />);
    read(rerender, [trade()]);
    const card = screen.getByText('Order filled').closest('.m-toast') as HTMLElement;
    act(() => { vi.advanceTimersByTime(TOAST_MS - 1_000); });
    fireEvent.pointerDown(card, { clientX: 100, clientY: 100, pointerId: 1 });
    act(() => { vi.advanceTimersByTime(TOAST_MS * 2); });
    expect(screen.getByText('Order filled')).toBeInTheDocument(); // held: still here
    fireEvent.pointerUp(card, { clientX: 100, clientY: 100, pointerId: 1 });
    act(() => { vi.advanceTimersByTime(TOAST_MS - 500); });
    expect(screen.getByText('Order filled')).toBeInTheDocument();
    act(() => { vi.advanceTimersByTime(900); });
    expect(screen.queryByText('Order filled')).toBeNull();
  });

  it('a close completed with its result has its time again, to be read', async () => {
    vi.useFakeTimers();
    let answer: (v: unknown) => void = () => undefined;
    getTradeDetail.mockReturnValue(new Promise((res) => { answer = res; }));
    const { rerender } = render(<Harness open={[trade()]} />);
    read(rerender, []);
    act(() => { vi.advanceTimersByTime(TOAST_MS - 1_000); });
    await act(async () => { answer(record()); await Promise.resolve(); await Promise.resolve(); });
    expect(screen.getByText('Target hit')).toBeInTheDocument();
    act(() => { vi.advanceTimersByTime(TOAST_MS - 1_000); });
    expect(screen.getByText('Target hit')).toBeInTheDocument();
    act(() => { vi.advanceTimersByTime(1_500); });
    expect(screen.queryByText('Target hit')).toBeNull();
  });
});

describe('for a screen reader', () => {
  it('a polite live region, each toast one button that says all of it, and a way to dismiss', async () => {
    const { rerender } = render(<Harness open={[trade()]} />);
    read(rerender, []);
    await screen.findByText('Target hit');
    expect(screen.getByRole('status', { name: 'Live events' })).toHaveAttribute('aria-live', 'polite');
    expect(screen.getByRole('button', { name: 'Target hit, +₹633, SELL 84,600 PE × 500, in 45.20 → out 30.00 · held 24m 00s, open the trade' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Dismiss' })).toBeInTheDocument();
  });
});
