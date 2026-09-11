import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { PositionsCard } from '@/components/trade/PositionsCard';
import { AlarmBanner } from '@/components/trade/ModeBanner';
import { ModeSwitch } from '@/components/trade/ModeSwitch';
import type { Trade, TradeStatus } from '@/types/trade';

const closeTrade = vi.fn();
const cancelTrade = vi.fn();
const closeAllTrades = vi.fn();
const setTradeMode = vi.fn();
vi.mock('@/api/trade', () => ({
  closeTrade: (...a: unknown[]) => closeTrade(...a),
  cancelTrade: (...a: unknown[]) => cancelTrade(...a),
  closeAllTrades: (...a: unknown[]) => closeAllTrades(...a),
  setTradeMode: (...a: unknown[]) => setTradeMode(...a),
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
    expect(screen.getByText('Charges ₹8.50 paid · ₹4.25 to close')).toBeInTheDocument();
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

describe('closing out', () => {
  it('sends the trade id and refreshes', async () => {
    const onChanged = vi.fn();
    render(<PositionsCard trades={[trade()]} onChanged={onChanged} />);
    fireEvent.click(screen.getByRole('button', { name: /close now/i }));
    await waitFor(() => expect(closeTrade).toHaveBeenCalledWith('t1'));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
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

  it('runs on the second tap and reports what went through', async () => {
    render(<PositionsCard trades={[trade()]} />);
    fireEvent.click(screen.getByRole('button', { name: /close all/i }));
    fireEvent.click(await screen.findByRole('button', { name: /^yes, close all$/i }));
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
    fireEvent.click(await screen.findByRole('button', { name: /^yes, close all$/i }));
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
