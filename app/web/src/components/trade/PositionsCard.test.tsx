import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { PositionsCard } from '@/components/trade/PositionsCard';
import { swipe } from '@/test/swipe';
import { AlarmBanner } from '@/components/trade/ModeBanner';
import { ModeSwitch } from '@/components/trade/ModeSwitch';
import type { Trade, TradeStatus } from '@/types/trade';

const closeTrade = vi.fn();
const cancelTrade = vi.fn();
const closeAllTrades = vi.fn();
const setTradeMode = vi.fn();
const previewAdd = vi.fn();
const addToPosition = vi.fn();
const reconcileTrade = vi.fn();
const previewClose = vi.fn();
const cancelAdd = vi.fn();
vi.mock('@/api/trade', () => ({
  closeTrade: (...a: unknown[]) => closeTrade(...a),
  cancelTrade: (...a: unknown[]) => cancelTrade(...a),
  closeAllTrades: (...a: unknown[]) => closeAllTrades(...a),
  setTradeMode: (...a: unknown[]) => setTradeMode(...a),
  previewAdd: (...a: unknown[]) => previewAdd(...a),
  addToPosition: (...a: unknown[]) => addToPosition(...a),
  reconcileTrade: (...a: unknown[]) => reconcileTrade(...a),
  previewClose: (...a: unknown[]) => previewClose(...a),
  cancelAdd: (...a: unknown[]) => cancelAdd(...a),
}));

const trade = (over: Partial<Trade> = {}): Trade => ({
  tradeId: 't1',
  symbol: 'C-BTC-80000-080926',
  productId: 1,
  optionSide: 'CE',
  phase: 'protected',
  position: -100,
  requestedSize: 100,
  entrySize: 100,
  entryAvgPrice: 10.5,
  exitSize: 0,
  exitAvgPrice: null,
  protection: { takeProfit: 'tp', stopLoss: 'sl' },
  realisedPnl: 0,
  fills: [],
  note: null,
  alarm: null,
  updatedAt: Date.now(),
  plan: { lots: 100, entry: { type: 'limit', timeoutMs: 5000, marketFallback: false }, takeProfitPrice: 0.5, stopPrice: 26 },
  onBook: { target: 0.5, stop: 26 },
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  closeTrade.mockResolvedValue({ ok: true });
  cancelTrade.mockResolvedValue({ ok: true });
  closeAllTrades.mockResolvedValue({ ok: true, closed: ['t1'], cancelled: [], failed: [] });
});

/** A trade whose order is on the book and has not traded. */
const working = (over: Partial<Trade> = {}): Trade => trade({
  phase: 'entry_pending',
  position: 0,
  entrySize: 0,
  entryAvgPrice: null,
  protection: { takeProfit: null, stopLoss: null },
  plan: { lots: 2, entry: { type: 'limit', limitPrice: 27, timeoutMs: 0, marketFallback: false }, takeProfitPrice: null, stopPrice: null },
  ...over,
});

describe('an order that has not traded', () => {
  it('is not called a position, and does not say "short 0"', () => {
    render(<PositionsCard trades={[working()]} />);
    expect(screen.getByText('Orders waiting')).toBeInTheDocument();
    expect(screen.queryByText('Open positions')).toBeNull();
    expect(screen.queryByText(/short 0/)).toBeNull();
  });

  it('says what is being offered and that nothing has filled', () => {
    render(<PositionsCard trades={[working()]} />);
    expect(screen.getByText(/Selling 2 lots @ 27.00 · not filled yet/)).toBeInTheDocument();
    expect(screen.getByText('waiting')).toBeInTheDocument();
  });

  it('can be pulled off the book', async () => {
    const onChanged = vi.fn();
    render(<PositionsCard trades={[working()]} onChanged={onChanged} />);
    fireEvent.click(screen.getByRole('button', { name: /cancel order/i }));
    await waitFor(() => expect(cancelTrade).toHaveBeenCalledWith('t1'));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it('offers no close-now, because there is nothing to close', () => {
    render(<PositionsCard trades={[working()]} />);
    expect(screen.queryByRole('button', { name: /close now/i })).toBeNull();
  });

  it('sits in its own list alongside a real position', () => {
    render(<PositionsCard trades={[working(), trade({ tradeId: 't2' })]} />);
    expect(screen.getByText('Orders waiting')).toBeInTheDocument();
    expect(screen.getByText('Open positions')).toBeInTheDocument();
  });
});

describe('a protected position', () => {
  it('names the contract, the size and where the stop is', () => {
    render(<PositionsCard trades={[trade()]} />);
    expect(screen.getByText('80,000 CE')).toBeInTheDocument();
    expect(screen.getByText(/Sold 100 @ 10.50/)).toBeInTheDocument();
    expect(screen.getByText('26.00')).toBeInTheDocument();
  });
});

/*
 * 11 September: 425 sold at 12.00, 203 bought back at the 0.70 target, 222 left.
 * The card said "Sold 222 @ 12.00", which reads as a smaller trade, not a
 * bigger one half-closed.
 */
describe('a position the target has partly bought back', () => {
  const half = trade({
    symbol: 'P-BTC-74000-110926', optionSide: 'PE', position: -222, requestedSize: 425,
    entrySize: 425, entryAvgPrice: 12, exitSize: 203, exitAvgPrice: 0.7, realisedPnl: 2.2939,
    protection: { takeProfit: 'tp', stopLoss: null },
    plan: { lots: 425, entry: { type: 'limit', timeoutMs: 0, marketFallback: false }, takeProfitPrice: 0.7, stopPrice: null },
    onBook: { target: 0.7, stop: null },
    live: { markPrice: 1.46, unrealisedPnl: 2.34, decayed: 0.88, liquidationPrice: null, netIfClosedUsd: 4.4 },
  });

  it('says what was sold, what was bought back and what is left', () => {
    render(<PositionsCard trades={[half]} />);
    expect(screen.getByText(/Sold 425 @ 12.00 · 203 bought back @ 0.70/)).toBeInTheDocument();
    expect(screen.getByText('222 left')).toBeInTheDocument();
    expect(screen.queryByText(/Sold 222/)).toBeNull();
  });

  it('calls the live figure the open part, beside what is booked', () => {
    render(<PositionsCard trades={[half]} />);
    expect(screen.getByText('Open P&L')).toBeInTheDocument();
    expect(screen.getByText(/Booked \+₹195/)).toBeInTheDocument();
  });

  it('still shows the target resting for the rest', () => {
    render(<PositionsCard trades={[half]} />);
    expect(screen.getByText('0.70', { selector: 'span' })).toBeInTheDocument();
  });
});

describe('what it is worth right now', () => {
  const live = trade({
    live: { markPrice: 6.5, unrealisedPnl: 0.4, decayed: 0.381, liquidationPrice: 215.6 },
  });

  it('shows the price now, the P&L and how much premium is earned', () => {
    render(<PositionsCard trades={[live]} />);
    expect(screen.getByText('6.50')).toBeInTheDocument();
    expect(screen.getByText('+₹34.00')).toBeInTheDocument();   // rupees lead
    expect(screen.getByText('+$0.400')).toBeInTheDocument();   // dollars beside
    expect(screen.getByText('38%')).toBeInTheDocument();
  });

  it('colours a loss red and a gain green, and leaves nothing neutral', () => {
    const { rerender } = render(<PositionsCard trades={[live]} />);
    expect(screen.getByText('+₹34.00').className).toContain('--up');

    rerender(<PositionsCard trades={[trade({
      live: { markPrice: 14, unrealisedPnl: -0.35, decayed: -0.333, liquidationPrice: 215.6 },
    })]} />);
    expect(screen.getByText('−₹29.75').className).toContain('--down');
  });

  it('shows a loss as a loss when the option has got dearer', () => {
    // sold at 10.50, marked at 12.00: a short is down, and the card said "up"
    render(<PositionsCard trades={[trade({
      live: { markPrice: 12, unrealisedPnl: -0.15, decayed: -0.1428, liquidationPrice: 215.6 },
    })]} />);
    expect(screen.getByText('−₹12.75').className).toContain('--down');
    expect(screen.getByText('-14%').className).toContain('--down');
  });

  it('names the close-out, which is the real exit when there is no stop', () => {
    render(<PositionsCard trades={[live]} />);
    expect(screen.getByText('215.60')).toBeInTheDocument();
  });

  it('shows what closing now would leave, after charges in and out, and the charges themselves', () => {
    render(<PositionsCard trades={[trade({
      live: { markPrice: 6.5, unrealisedPnl: 0.4, decayed: 0.381, liquidationPrice: 215.6, netIfClosedUsd: 0.25 },
      charges: { entryUsd: 0.1, exitUsd: 0, paidUsd: 0.1, toCloseUsd: 0.05 },
    })]} />);
    expect(screen.getByText('+₹21.25').className).toContain('--up');
    expect(screen.getByText(/Charges/)).toHaveTextContent('Charges ₹8.50 paid · ₹4.25 to close');
  });

  it('shows a dash rather than a zero before the exchange has answered', () => {
    render(<PositionsCard trades={[trade()]} />);
    // "$0.00 profit" would be a claim; there is simply no number yet
    const dashes = screen.getAllByText('—');
    expect(dashes.length).toBeGreaterThanOrEqual(2);
  });
});

describe('a position with no stop behind it', () => {
  const naked = trade({
    phase: 'unprotected', protection: { takeProfit: null, stopLoss: null },
    onBook: { target: null, stop: null }, alarm: 'POSITION UNPROTECTED: API down',
  });

  it('says NO STOP in words rather than leaving a blank', () => {
    render(<PositionsCard trades={[naked]} />);
    expect(screen.getByText('NO STOP')).toBeInTheDocument();
    expect(screen.getByText('Stop').textContent).toContain('none');
    expect(screen.getByText('POSITION UNPROTECTED: API down')).toBeInTheDocument();
  });

  it('is still detected when the phase looks fine but the stop is gone', () => {
    // the phase can lag a reconcile by one poll; the missing stop cannot
    render(<PositionsCard trades={[trade({
      protection: { takeProfit: 'tp', stopLoss: null }, onBook: { target: 0.5, stop: null },
    })]} />);
    expect(screen.getByText('Stop').textContent).toContain('none');
    expect(screen.getByText('NO STOP')).toBeInTheDocument();
  });

  it('does not cry wolf over a trade that chose to run without one', () => {
    // painting a deliberate choice red every time is what makes a real alarm
    // get ignored
    render(<PositionsCard trades={[trade({
      protection: { takeProfit: 'tp', stopLoss: null },
      plan: { lots: 1, entry: { type: 'limit', timeoutMs: 0, marketFallback: false }, takeProfitPrice: 1.1, stopPrice: null },
      onBook: { target: 1.1, stop: null },
    })]} />);
    expect(screen.getByText('Stop').textContent).toContain('none');
    expect(screen.queryByText('NO STOP')).toBeNull();
    expect(screen.getByText('open')).toBeInTheDocument();
  });

  it('interrupts the page from the banner, naming the contract', () => {
    render(<AlarmBanner status={{ open: [naked] } as TradeStatus} />);
    expect(screen.getByText('A position has no stop-loss')).toBeInTheDocument();
    expect(screen.getByText(/C-BTC-80000-080926/)).toBeInTheDocument();
  });

  it('says nothing at all when every position is covered', () => {
    const { container } = render(<AlarmBanner status={{ open: [trade()] } as TradeStatus} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe('what the resting exits are worth', () => {
  /*
   * "Target 0.80" left the arithmetic to the reader: 0.80 against an average of
   * 13.00 over 1,400 contracts, less what Delta takes. The ticket shows this
   * while the bar is being dragged and stopped showing it the moment the order
   * was resting -- which is when it is worth most.
   */
  const resting = (over: Partial<Trade> = {}) => trade({
    onBook: { target: 0.8, stop: 26 },
    protection: { takeProfit: 'tp', stopLoss: 'sl' },
    ifExits: { target: 17.02, stop: -18.4 },
    ...over,
  });

  it('[critical] says what the target keeps and what the stop loses', () => {
    render(<PositionsCard trades={[resting()]} />);
    const target = screen.getByText(/^Target/).closest('span')!;
    expect(target).toHaveTextContent('Target 0.80 → keep ₹1,447');
    expect(within(target).getByText(/keep ₹1,447/).className).toContain('--up');
    const stop = screen.getByText(/^Stop/).closest('span')!;
    expect(stop).toHaveTextContent('Stop 26.00 → lose ₹1,564');
    expect(within(stop).getByText(/lose ₹1,564/).className).toContain('--down');
  });

  it('a target that would still be a loss says lose, not keep', () => {
    render(<PositionsCard trades={[resting({ ifExits: { target: -2, stop: -18.4 } })]} />);
    expect(screen.getByText(/^Target/).closest('span')).toHaveTextContent('→ lose ₹170');
  });

  it('says nothing about money for an exit that is not on the book', () => {
    render(<PositionsCard trades={[resting({ onBook: { target: 0.8, stop: null } })]} />);
    expect(screen.getByText(/^Stop/).closest('span')).toHaveTextContent('Stop none');
    expect(screen.getByText(/^Stop/).closest('span')).not.toHaveTextContent('lose');
  });

  it('[critical] shows the price alone when the money cannot be worked out', () => {
    // No entry average yet, or a book that could not be read: a number that
    // cannot be computed is left out rather than shown as zero.
    render(<PositionsCard trades={[resting({ ifExits: { target: null, stop: null } })]} />);
    expect(screen.getByText(/^Target/).closest('span')).toHaveTextContent('Target 0.80');
    expect(screen.getByText(/^Target/).closest('span')).not.toHaveTextContent('keep');
  });
});

describe('the charges line', () => {
  /*
   * "₹8.43 paid · ₹7.88 to close" is two numbers going out and nothing coming
   * back. The answer to the question that raises -- so what do I keep? -- was
   * in a panel above it under a different name.
   */
  const withCharges = (over: Partial<Trade> = {}) => trade({
    charges: { entryUsd: 0.1, exitUsd: 0, paidUsd: 0.1, toCloseUsd: 0.09 },
    live: { markPrice: 11.23, unrealisedPnl: 0.155, decayed: 0.06, liquidationPrice: 201.33, netIfClosedUsd: 8.62 },
    ...over,
  });

  it('[critical] says what closing now would leave, beside the charges that come off it', () => {
    render(<PositionsCard trades={[withCharges()]} />);
    const line = screen.getByText(/Charges/);
    expect(line).toHaveTextContent('₹8.50 paid · ₹7.65 to close · close now → keep ₹733');
    expect(within(line).getByText(/keep ₹733/).className).toContain('--up');
  });

  it('[critical] a position under water says lose, not keep', () => {
    render(<PositionsCard trades={[withCharges({
      live: { markPrice: 14, unrealisedPnl: -0.3, decayed: -0.1, liquidationPrice: 201.33, netIfClosedUsd: -0.4 },
    })]} />);
    const line = screen.getByText(/Charges/);
    expect(line).toHaveTextContent('close now → lose ₹34.00');
    expect(within(line).getByText(/lose ₹34\.00/).className).toContain('--down');
  });

  it('says nothing about closing when there is no price to close at', () => {
    render(<PositionsCard trades={[withCharges({
      live: { markPrice: null, unrealisedPnl: null, decayed: null, liquidationPrice: null, netIfClosedUsd: null },
    })]} />);
    expect(screen.getByText(/Charges/)).not.toHaveTextContent('close now');
  });
});

describe('a working add', () => {
  /*
   * An add can now work for up to four hours, so "an add is working" with no
   * clock beside it stops meaning anything ten minutes in -- and the only way
   * to stop one was to wait for its window to close.
   */
  const working = (over: Partial<NonNullable<Trade['adding']>> = {}) => trade({
    adding: {
      size: 100, limitPrice: 28, floorPrice: 27,
      deadline: Date.now() + 42 * 60_000,
      source: { manual: true },
      ...over,
    },
  });

  it('[critical] says how long the add has left', () => {
    render(<PositionsCard trades={[working()]} />);
    expect(screen.getByText(/Adding 100 @ 28\.00/)).toHaveTextContent('41m');
  });

  it('[critical] Stop add stops it, and tells the desk to refresh', async () => {
    const onChanged = vi.fn();
    cancelAdd.mockResolvedValue({ ok: true });
    render(<PositionsCard trades={[working()]} onChanged={onChanged} />);
    fireEvent.click(screen.getByRole('button', { name: 'Stop add' }));
    await waitFor(() => expect(cancelAdd).toHaveBeenCalledWith('t1'));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it('cannot be pressed twice into the same add', async () => {
    let release: (v: unknown) => void = () => {};
    cancelAdd.mockReturnValue(new Promise((r) => { release = r; }));
    render(<PositionsCard trades={[working()]} />);
    const stop = screen.getByRole('button', { name: 'Stop add' });
    fireEvent.click(stop);
    expect(screen.getByRole('button', { name: 'Stopping…' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Stopping…' }));
    expect(cancelAdd).toHaveBeenCalledTimes(1);
    release({ ok: true });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Stop add' })).toBeEnabled());
  });

  it('a strategy add says which target sent it, and can be stopped too', () => {
    render(<PositionsCard trades={[working({ source: { tradeId: 'CE-1', optionSide: 'CE', boughtBack: 425 } })]} />);
    expect(screen.getByText(/the CE target bought back 425/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Stop add' })).toBeInTheDocument();
  });

  it('nothing to stop when nothing is adding', () => {
    render(<PositionsCard trades={[trade()]} />);
    expect(screen.queryByRole('button', { name: 'Stop add' })).toBeNull();
  });
});

describe('closing out', () => {
  /*
   * Close now used to buy the position back on the first tap. Now the tap asks,
   * with the position and its live figures, and closing takes a swipe.
   */
  const half = trade({
    symbol: 'P-BTC-74000-110926', optionSide: 'PE', position: -222, entrySize: 425, entryAvgPrice: 12,
    exitSize: 203, exitAvgPrice: 0.7, realisedPnl: 2.2939,
    protection: { takeProfit: 'tp', stopLoss: null },
    onBook: { target: 0.7, stop: null },
    live: { markPrice: 1.46, unrealisedPnl: 2.34, decayed: 0.88, liquidationPrice: null, netIfClosedUsd: 4.4 },
    charges: { entryUsd: 0.2, exitUsd: 0.01, paidUsd: 0.21, toCloseUsd: 0.02 },
  });

  /** What the server answers for `lots` of the 222 held. */
  const previewOf = (lots: number, netUsd = 1.1) => ({
    ok: true, reason: null, held: 222, lots, remaining: 222 - lots, closesAll: lots >= 222,
    buysBackAt: 1.5, atMark: false, bookedUsd: netUsd + 0.02, chargesUsd: 0.02, netUsd,
  });
  beforeEach(() => { previewClose.mockResolvedValue(previewOf(222)); });

  it('[critical] tapping Close now sends nothing: it asks first', () => {
    render(<PositionsCard trades={[half]} />);
    fireEvent.click(screen.getByRole('button', { name: /close now/i }));
    expect(closeTrade).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: 'Close 74,000 PE?' })).toBeInTheDocument();
  });

  it('[critical] the question shows the order and what closing leaves, live', () => {
    const { rerender } = render(<PositionsCard trades={[half]} />);
    fireEvent.click(screen.getByRole('button', { name: /close now/i }));
    const dialog = within(screen.getByRole('dialog'));
    expect(dialog.getByText('Buys back 222 at the market price.')).toBeInTheDocument();
    const details = within(dialog.getByLabelText('position details'));
    expect(details.getByText('425 sold · 203 bought back')).toBeInTheDocument();
    expect(details.getByText('12.00')).toBeInTheDocument();
    expect(details.getByText('1.46')).toBeInTheDocument();
    expect(details.getByText('+₹199')).toBeInTheDocument();       // open P&L, 2.34 x 85
    expect(details.getByText('+₹195')).toBeInTheDocument();       // booked
    expect(within(dialog.getByLabelText('if closed now')).getByText('+₹374')).toBeInTheDocument();
    // the next poll moves the price: the open question follows it
    rerender(<PositionsCard trades={[{ ...half, live: { ...half.live!, markPrice: 2.1, unrealisedPnl: 2.2, netIfClosedUsd: 4.2 } }]} />);
    expect(within(screen.getByLabelText('if closed now')).getByText('+₹357')).toBeInTheDocument();
    expect(within(screen.getByLabelText('position details')).getByText('2.10')).toBeInTheDocument();
  });

  it('[critical] a part-way swipe does not close; a full one does, then refreshes', async () => {
    const onChanged = vi.fn();
    render(<PositionsCard trades={[half]} onChanged={onChanged} />);
    fireEvent.click(screen.getByRole('button', { name: /close now/i }));
    const control = screen.getByRole('slider', { name: /Swipe to close 222/ });
    swipe(control, 0.5);
    expect(closeTrade).not.toHaveBeenCalled();
    swipe(control, 1);
    // no size: the desk closes what is actually there, not what this screen saw
    await waitFor(() => expect(closeTrade).toHaveBeenCalledWith('t1', undefined));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  /*
   * How much of it.
   *
   * The box opens on the whole position, so the old one-swipe close costs
   * nothing. A smaller number closes that many and leaves the rest -- which is
   * a different trade in every respect that matters, so the sheet has to say
   * so and the money has to follow the number.
   */
  const openSheet = (t = half) => {
    render(<PositionsCard trades={[t]} />);
    fireEvent.click(screen.getByRole('button', { name: /close now/i }));
    return screen.getByLabelText('lots to close') as HTMLInputElement;
  };

  it('[critical] opens on the whole position, so closing everything is still one swipe', () => {
    expect(openSheet().value).toBe('222');
    expect(screen.getByText('Buys back 222 at the market price.')).toBeInTheDocument();
    expect(screen.getByRole('slider', { name: /Swipe to close 222/ })).toBeInTheDocument();
  });

  it('[critical] a smaller size closes that many and says what is left behind', async () => {
    const box = openSheet();
    fireEvent.change(box, { target: { value: '50' } });
    expect(screen.getByText(/Buys back 50 of 222 at the market price\. 172 stays short\./)).toBeInTheDocument();
    expect(within(screen.getByLabelText('position details')).getByText('172')).toBeInTheDocument();
    swipe(screen.getByRole('slider', { name: /Swipe to close 50/ }), 1);
    await waitFor(() => expect(closeTrade).toHaveBeenCalledWith('t1', 50));
  });

  it('Half fills in half of what is held, and All puts it back', () => {
    const box = openSheet();
    fireEvent.click(screen.getByRole('button', { name: 'Half' }));
    expect(box.value).toBe('111');
    fireEvent.click(screen.getByRole('button', { name: 'All' }));
    expect(box.value).toBe('222');
  });

  it('[critical] the money follows the size, from the server rather than the card', async () => {
    previewClose.mockResolvedValue(previewOf(50, 1.1));
    const box = openSheet();
    // all of it: the card's own "if closed now" figure, 4.4 x 85
    expect(within(screen.getByLabelText('if closed now')).getByText('+₹374')).toBeInTheDocument();
    fireEvent.change(box, { target: { value: '50' } });
    await waitFor(() => expect(previewClose).toHaveBeenCalledWith('t1', 50));
    const panel = within(await screen.findByLabelText('if closed now'));
    expect(await panel.findByText('+₹93.50')).toBeInTheDocument();   // 1.1 x 85
    expect(screen.getByText(/Closing 50 books/)).toBeInTheDocument();
  });

  it('[critical] refuses more than is held, and a size that is not a whole number', () => {
    const box = openSheet();
    fireEvent.change(box, { target: { value: '223' } });
    expect(screen.getByText('Only 222 held.')).toBeInTheDocument();
    expect(screen.getByRole('slider', { name: /Swipe to close/ })).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByText('Check the lots')).toBeInTheDocument();
    fireEvent.change(box, { target: { value: '2.5' } });
    expect(screen.getByText('A whole number of lots, at least 1.')).toBeInTheDocument();
    fireEvent.change(box, { target: { value: '0' } });
    expect(screen.getByText('A whole number of lots, at least 1.')).toBeInTheDocument();
    expect(closeTrade).not.toHaveBeenCalled();
  });

  it('an emptied box means the whole position again, not nothing', () => {
    const box = openSheet();
    fireEvent.change(box, { target: { value: '' } });
    expect(screen.getByRole('slider', { name: /Swipe to close 222/ })).not.toHaveAttribute('aria-disabled');
  });

  it('says the resting orders are replaced rather than cancelled when part is left', () => {
    const box = openSheet();
    expect(within(screen.getByLabelText('position details')).getByText('· cancelled')).toBeInTheDocument();
    fireEvent.change(box, { target: { value: '50' } });
    expect(within(screen.getByLabelText('position details')).getByText('· replaced')).toBeInTheDocument();
    expect(screen.getByText(/172 stays short, and its target and stop are put back over it/)).toBeInTheDocument();
  });

  it('a fill landing while the sheet is open does not overwrite a size being typed', () => {
    const { rerender } = render(<PositionsCard trades={[half]} />);
    fireEvent.click(screen.getByRole('button', { name: /close now/i }));
    fireEvent.change(screen.getByLabelText('lots to close'), { target: { value: '50' } });
    rerender(<PositionsCard trades={[{ ...half, position: -200 }]} />);
    expect((screen.getByLabelText('lots to close') as HTMLInputElement).value).toBe('50');
  });

  it('Keep it closes the question and nothing else', () => {
    render(<PositionsCard trades={[half]} />);
    fireEvent.click(screen.getByRole('button', { name: /close now/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Keep it' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(closeTrade).not.toHaveBeenCalled();
  });

  it('shows nothing at all for a trade that is already finished', () => {
    render(<PositionsCard trades={[trade({ position: 0, phase: 'flat' })]} />);
    expect(screen.getByText('No open positions.')).toBeInTheDocument();
  });
});

describe('an empty desk', () => {
  it('says so rather than showing an empty box', () => {
    render(<PositionsCard trades={[]} />);
    expect(screen.getByText('No open positions.')).toBeInTheDocument();
  });
});

describe('the mode switch', () => {
  const status = (over: Partial<TradeStatus> = {}): TradeStatus => ({
    mode: 'paper', live: false, canGoLive: true, switchBlockedBy: null,
    balanceUsd: 50, positions: [], open: [], alarms: [],
    limits: {
      maxLeverage: 200, maxQuoteAgeMs: 3000, maxSpreadPct: 0.04, minBookCoverage: 0.5,
      maxShortContracts: 500, maxDailyLossUsd: 5000, minPremiumUsd: 5, allowPyramiding: false,
    },
    ...over,
  });

  beforeEach(() => setTradeMode.mockResolvedValue({ ok: true, mode: 'live' }));

  it('calls paper Paper, and live Live', () => {
    const { rerender } = render(<ModeSwitch status={status()} />);
    expect(screen.getByText('Paper')).toBeInTheDocument();
    rerender(<ModeSwitch status={status({ mode: 'live', live: true })} />);
    expect(screen.getByText('Live')).toBeInTheDocument();
  });

  it('shows nothing before the server has answered, rather than guessing paper', () => {
    // guessing "paper" while the answer is still in flight is the one wrong
    // default here: it would say the desk is safe before anyone has checked
    const { container } = render(<ModeSwitch status={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('will not go live on one tap', async () => {
    render(<ModeSwitch status={status()} />);
    fireEvent.click(screen.getByRole('button', { name: /paper/i }));
    await waitFor(() => expect(screen.getByText('Switch to live trading?')).toBeInTheDocument());
    expect(setTradeMode).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: /go live/i }));
    await waitFor(() => expect(setTradeMode).toHaveBeenCalledWith('live'));
  });

  it('goes back to paper on one tap, because leaving live is never the risky direction', async () => {
    setTradeMode.mockResolvedValue({ ok: true, mode: 'paper' });
    render(<ModeSwitch status={status({ mode: 'live', live: true })} />);
    fireEvent.click(screen.getByRole('button', { name: /live/i }));
    await waitFor(() => expect(setTradeMode).toHaveBeenCalledWith('paper'));
    expect(screen.queryByText('Switch to live trading?')).toBeNull();
  });

  it('refuses to switch while a position is open, and says why', async () => {
    render(<ModeSwitch status={status({ switchBlockedBy: 'Close 1 open position first.' })} />);
    fireEvent.click(screen.getByRole('button', { name: /paper/i }));
    await waitFor(() => expect(screen.getByText('Close 1 open position first.')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: /go live/i })).toBeDisabled();
  });

  it('is dead when the server cannot go live at all', () => {
    render(<ModeSwitch status={status({ canGoLive: false })} />);
    expect(screen.getByRole('button', { name: /paper/i })).toBeDisabled();
  });

  it('surfaces the server’s refusal rather than pretending it worked', async () => {
    setTradeMode.mockResolvedValue({ ok: false, mode: 'paper', reason: 'No Delta credentials configured.' });
    render(<ModeSwitch status={status()} />);
    fireEvent.click(screen.getByRole('button', { name: /paper/i }));
    fireEvent.click(await screen.findByRole('button', { name: /go live/i }));
    await waitFor(() => expect(screen.getByText('No Delta credentials configured.')).toBeInTheDocument());
  });
});

describe('several positions', () => {
  it('counts them on the card', () => {
    render(<PositionsCard trades={[trade(), trade({ tradeId: 't2', symbol: 'P-BTC-77000-080926', optionSide: 'PE' })]} />);
    const heading = screen.getByText('Open positions').closest('div')!;
    expect(within(heading).getByText('2')).toBeInTheDocument();
  });
});


describe('closing everything', () => {
  it('is not offered when there is nothing on', () => {
    render(<PositionsCard trades={[]} />);
    expect(screen.queryByRole('button', { name: /close all/i })).toBeNull();
  });

  it('does not act on the first tap', async () => {
    render(<PositionsCard trades={[trade()]} />);
    fireEvent.click(screen.getByRole('button', { name: /close all/i }));
    await waitFor(() => expect(screen.getByText('Close all positions and orders?')).toBeInTheDocument());
    expect(closeAllTrades).not.toHaveBeenCalled();
  });

  it('names every position and order that would go', async () => {
    render(<PositionsCard trades={[
      trade(),
      trade({ tradeId: 't2', symbol: 'P-BTC-77000-090926', optionSide: 'PE', phase: 'entry_pending', position: 0,
        plan: { lots: 3, entry: { type: 'limit', limitPrice: 24, timeoutMs: 0, marketFallback: false }, takeProfitPrice: null, stopPrice: null } }),
    ]} />);
    fireEvent.click(screen.getByRole('button', { name: /close all/i }));
    await waitFor(() => expect(screen.getByText('1 position and 1 order')).toBeInTheDocument());
    // scoped to the sheet: "cancel order" also sits on the row behind it
    const sheet = within(screen.getByRole('dialog'));
    expect(sheet.getByText('buy back')).toBeInTheDocument();
    expect(sheet.getByText('cancel')).toBeInTheDocument();
    expect(sheet.getByText(/Selling 3 lots @ 24.00/)).toBeInTheDocument();
  });

  it('warns that the spread is paid and that it cannot be undone', async () => {
    render(<PositionsCard trades={[trade()]} />);
    fireEvent.click(screen.getByRole('button', { name: /close all/i }));
    await waitFor(() => expect(screen.getByText(/pay the spread on each/)).toBeInTheDocument());
    expect(screen.getByText(/cannot be undone/)).toBeInTheDocument();
  });

  it('runs on a full swipe, not a tap, and reports what went through', async () => {
    render(<PositionsCard trades={[trade()]} />);
    fireEvent.click(screen.getByRole('button', { name: /close all/i }));
    swipe(await screen.findByRole('slider', { name: /Swipe to close all/ }));
    await waitFor(() => expect(closeAllTrades).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByText('All closed')).toBeInTheDocument());
  });

  it('says which ones are still on rather than reporting a clean sweep', async () => {
    closeAllTrades.mockResolvedValue({
      ok: false, closed: ['t1'], cancelled: [],
      failed: [{ tradeId: 't2', reason: 'still holding -2' }],
    });
    render(<PositionsCard trades={[trade()]} />);
    fireEvent.click(screen.getByRole('button', { name: /close all/i }));
    swipe(await screen.findByRole('slider', { name: /Swipe to close all/ }));
    await waitFor(() => expect(screen.getByText('Some are still open')).toBeInTheDocument());
    expect(screen.getByText(/t2 — still holding -2/)).toBeInTheDocument();
    expect(screen.getByText(/Close the rest manually/)).toBeInTheDocument();
  });
});

/*
 * The CE target bought back 425, so 425 more PE were sold at 7 and appended to
 * the PE sold at 15 that morning: one position of 850 at an 11.00 average.
 */
describe('a position that was added to', () => {
  const added = trade({
    symbol: 'P-BTC-74000-110926', optionSide: 'PE', position: -850, requestedSize: 425,
    entrySize: 850, entryAvgPrice: 11, addedSize: 425,
    protection: { takeProfit: 'tp', stopLoss: null },
    plan: { lots: 425, entry: { type: 'limit', timeoutMs: 0, marketFallback: false }, takeProfitPrice: 0.7, stopPrice: null },
    onBook: { target: 0.7, stop: null },
  });

  it('says the whole size at its average, and how much of it was added', () => {
    render(<PositionsCard trades={[added]} />);
    expect(screen.getByText(/Sold 850 @ 11.00 avg/)).toBeInTheDocument();
    expect(screen.getByText('425 added')).toBeInTheDocument();
  });

  it('says an add is working, at what price, never below what, and why', () => {
    render(<PositionsCard trades={[trade({
      ...added, position: -425, entrySize: 425, entryAvgPrice: 15, addedSize: 0,
      adding: { size: 425, limitPrice: 7.5, floorPrice: 3, deadline: Date.now() + 300_000, source: { tradeId: 'CE-1', optionSide: 'CE', boughtBack: 425 } },
    })]} />);
    expect(screen.getByText(/Adding 425 @ 7.50 \(never below 3.00\) — the CE target bought back 425/)).toBeInTheDocument();
  });
});

/**
 * The book, on a card that used to show only the mark.
 *
 * "Price now" was the mark, which is the one price nobody transacts at.
 * Closing a short is a buy, so the ask is what leaving costs — the same reason
 * the board shows a seller the bid — and the gap between the two is the cost of
 * leaving, which on a thin far strike is most of the decision.
 */
describe('the book on an open position', () => {
  const withBook = (bid: number | null, ask: number | null) =>
    trade({ live: { markPrice: 10.95, bid, ask, unrealisedPnl: -0.617, decayed: null, liquidationPrice: null } } as Partial<Trade>);

  it('shows both sides under the mark', () => {
    render(<PositionsCard trades={[withBook(10.5, 11.4)]} onChanged={() => {}} />);
    expect(screen.getByText('bid 10.50 · ask 11.40')).toBeInTheDocument();
  });

  it('says how wide the book is, because that is paid on the way out', () => {
    render(<PositionsCard trades={[withBook(10.5, 11.4)]} onChanged={() => {}} />);
    expect(screen.getByText('8.2%')).toBeInTheDocument();
  });

  it('[critical] marks a spread wide enough to matter', () => {
    render(<PositionsCard trades={[withBook(9, 12)]} onChanged={() => {}} />);
    expect(screen.getByText('28.6%')).toHaveClass('text-[var(--warn)]');
  });

  it('[critical] one side alone is not a book, and is not drawn as one', () => {
    render(<PositionsCard trades={[withBook(10.5, null)]} onChanged={() => {}} />);
    expect(screen.queryByText(/bid 10\.50/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Spread/)).not.toBeInTheDocument();
    // the mark is still there; it is the book that is absent
    expect(screen.getByText('10.95')).toBeInTheDocument();
  });
});


/**
 * Adding by hand.
 *
 * The button offers only what the engine will take: a short that is open and
 * not already adding. It opens a sheet and sends nothing itself.
 */
describe('adding lots from the card', () => {
  it('offers Add lots on an open short', () => {
    render(<PositionsCard trades={[trade()]} onChanged={() => {}} />);
    expect(screen.getByRole('button', { name: /Add lots/ })).toBeEnabled();
  });

  it('[critical] does not offer it while an add is already working', () => {
    render(<PositionsCard trades={[trade({
      adding: { size: 50, limitPrice: 9.9, floorPrice: 9, deadline: Date.now() + 60_000, source: { manual: true } },
    })]} onChanged={() => {}} />);
    expect(screen.getByRole('button', { name: /Add lots/ })).toBeDisabled();
    expect(screen.getByText(/added by hand/)).toBeInTheDocument();
  });

  it('does not offer it on an order that has not filled', () => {
    render(<PositionsCard trades={[working()]} onChanged={() => {}} />);
    expect(screen.queryByRole('button', { name: /Add lots/ })).not.toBeInTheDocument();
  });

  it('does not offer it while the position is closing', () => {
    render(<PositionsCard trades={[trade({ phase: 'exit_pending' })]} onChanged={() => {}} />);
    expect(screen.getByRole('button', { name: /Add lots/ })).toBeDisabled();
  });

  it('opens the sheet, and sends nothing from the card itself', () => {
    render(<PositionsCard trades={[trade()]} onChanged={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: /Add lots/ }));
    expect(screen.getByText(/Add lots · /)).toBeInTheDocument();
    expect(addToPosition).not.toHaveBeenCalled();
  });
});


describe('when the exchange holds more than the record sold', () => {
  it('[critical] says so, with the difference, rather than showing a smaller trade', () => {
    // 14 Sep 2026: Delta held 1,500 CE, the record had sold 1,400. The card
    // read "Sold 1,400" over a 1,500 position and nothing said why.
    render(<PositionsCard trades={[trade({ position: -1500, entrySize: 1400, addedSize: 750 })]} onChanged={() => {}} />);
    expect(screen.getByText(/Delta holds 1,500 — 100 more than this record sold/)).toBeInTheDocument();
  });

  it('offers to re-read the position from Delta, and refreshes after', async () => {
    reconcileTrade.mockResolvedValue({ ok: true });
    const onChanged = vi.fn();
    render(<PositionsCard trades={[trade({ position: -1500, entrySize: 1400 })]} onChanged={onChanged} />);
    fireEvent.click(screen.getByRole('button', { name: /Re-read from Delta/ }));
    await waitFor(() => expect(reconcileTrade).toHaveBeenCalledWith('t1'));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it('says nothing when the two agree', () => {
    render(<PositionsCard trades={[trade()]} onChanged={() => {}} />);
    expect(screen.queryByText(/more than this record sold/)).not.toBeInTheDocument();
  });
});

/*
 * "It has not filled yet."
 *
 * A typed price is also the add's floor, so an add started at that price can
 * never walk toward the bid. The card is where somebody looks when it has been
 * sitting there for an hour, so the card is where it has to be said.
 */
describe('an add that cannot walk', () => {
  const working = (over: Record<string, unknown> = {}) => trade({
    adding: { size: 200, limitPrice: 20, floorPrice: 20, deadline: Date.now() + 3_600_000, source: { manual: true } },
    ...over,
  });

  it('[critical] says the price is its own floor, so it is resting rather than crossing', () => {
    render(<PositionsCard trades={[working()]} />);
    expect(screen.getByText(/Resting at 20.00 — it cannot walk toward the bid, because that price is also its floor/))
      .toBeInTheDocument();
  });

  it('an add with room to walk says nothing extra', () => {
    render(<PositionsCard trades={[working({
      adding: { size: 200, limitPrice: 20, floorPrice: 19, deadline: Date.now() + 3_600_000, source: { manual: true } },
    })]} />);
    expect(screen.queryByText(/Resting at/)).toBeNull();
  });
});

