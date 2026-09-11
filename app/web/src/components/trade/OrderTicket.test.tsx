import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { OrderTicket, type TicketSeed } from '@/components/trade/OrderTicket';
import { swipe } from '@/test/swipe';
import type { Preview } from '@/types/trade';

/**
 * What the ticket must never do:
 *   - offer a live sell control when the server said the trade is blocked
 *   - sell on a tap: it has to be swiped all the way
 *   - carry the last contract's size onto the next one
 *   - price at the offer while claiming to be at the market
 */

const previewOrder = vi.fn();
const placeOrder = vi.fn();
const getTradeQuote = vi.fn();
vi.mock('@/api/trade', () => ({
  previewOrder: (...a: unknown[]) => previewOrder(...a),
  placeOrder: (...a: unknown[]) => placeOrder(...a),
  getTradeQuote: (...a: unknown[]) => getTradeQuote(...a),
}));

const seed: TicketSeed = {
  symbol: 'C-BTC-80000-080926',
  side: 'CE',
  strike: 80_000,
  expiryTs: 1_700_040_000,
  bid: 9,
  ask: 11,
  mark: 10,
};

const ok = (over: Partial<Preview> = {}): Preview => ({
  mode: 'paper',
  ok: true,
  failures: [],
  quote: { symbol: seed.symbol, bid: 9, ask: 11, bidSize: 500, askSize: 500, mark: 10, ts: Date.now() },
  product: {
    symbol: seed.symbol, productId: 1, underlying: 'BTC', optionSide: 'CE', strike: 80_000,
    expiryTs: seed.expiryTs, tickSize: 0.1, lotSize: 1, contractValue: 0.001, state: 'live',
  },
  size: 1,
  contractValue: 0.001,
  creditUsd: 0.009,
  worstCaseLossUsd: 13.5,
  stopPrice: 22.5,
  takeProfitPrice: 4.5,
  targetProfitUsd: 4.5,
  leverage: 10,
  spot: 78_405.5,
  marginUsd: 7.84,
  liquidationPrice: 3_929.3,
  maxLots: 6,
  ...over,
});

const show = (props: Partial<React.ComponentProps<typeof OrderTicket>> = {}) =>
  render(<OrderTicket seed={seed} open onOpenChange={() => {}} {...props} />);

beforeEach(() => {
  // usePersisted writes to localStorage, so one test's tick box would otherwise
  // arrive already ticked in the next
  localStorage.clear();
  vi.clearAllMocks();
  previewOrder.mockResolvedValue(ok());
  // no fresher book than the seed unless a test says so
  getTradeQuote.mockResolvedValue({ quote: null, product: null });
  placeOrder.mockResolvedValue({ mode: 'paper', ok: true, trade: { position: -1, entryAvgPrice: 9 } });
});

describe('the ticket opens ready to trade', () => {
  it('names the contract and opens on the offer, not the bid', async () => {
    show();
    expect(screen.getByText('Sell 80,000 CE')).toBeInTheDocument();
    // selling at the bid gives away the spread on every single trade
    expect(screen.getByRole('radio', { name: 'Offer' })).toHaveAttribute('data-state', 'on');
    await waitFor(() => expect(previewOrder).toHaveBeenCalled());
    expect(previewOrder.mock.calls.at(-1)![0]).toMatchObject({ limitPrice: 11, lots: 1 });
  });

  it('falls back to taking the bid when the contract has no offer', async () => {
    getTradeQuote.mockResolvedValue({ quote: null, product: null });
    render(<OrderTicket seed={{ ...seed, symbol: 'C-BTC-1', ask: null }} open onOpenChange={() => {}} />);
    expect(screen.getByRole('radio', { name: 'Bid' })).toHaveAttribute('data-state', 'on');
    // a limit AT the bid, not a market order: immediate, but with a floor
    await waitFor(() =>
      expect(previewOrder.mock.calls.at(-1)![0]).toMatchObject({ limitPrice: 9 }),
    );
  });

  it('opens with both exits off', async () => {
    show();
    expect(screen.getByRole('checkbox', { name: /take profit/i })).not.toBeChecked();
    expect(screen.getByRole('checkbox', { name: /stop loss/i })).not.toBeChecked();
    await waitFor(() =>
      expect(previewOrder.mock.calls.at(-1)![0]).toMatchObject({ takeProfitPct: 0, stopLossPct: 0 }),
    );
  });

  it('shows Delta charges to open, fee and GST, before the button', async () => {
    previewOrder.mockResolvedValue(ok({ entryChargesUsd: 0.02 }));
    show();
    // 0.02 x 85 = 1.70
    await waitFor(() => expect(screen.getByText('Delta charges to open')).toBeInTheDocument());
    expect(screen.getByText('₹1.70')).toBeInTheDocument();
  });

  it('shows the whole book, so a price is one tap away', () => {
    show();
    expect(screen.getByText('9.00')).toBeInTheDocument();
    expect(screen.getByText('10.00')).toBeInTheDocument();
    expect(screen.getByText('11.00')).toBeInTheDocument();
  });
});

describe('the book while the ticket is open', () => {
  it('follows the exchange rather than the price you tapped', async () => {
    // the seed is whatever the chain last fetched, and that can be five seconds
    // old by the time you have tapped it
    getTradeQuote.mockResolvedValue({
      quote: { symbol: seed.symbol, bid: 32, ask: 34, bidSize: 100, askSize: 100, mark: 33.74, ts: Date.now() },
      product: null,
    });
    show();
    await waitFor(() => expect(screen.getByText('34.00')).toBeInTheDocument());
    expect(screen.getByText('32.00')).toBeInTheDocument();
    expect(screen.getByText('33.74')).toBeInTheDocument();
  });

  it('prices the order at the book it is showing, not the one it opened with', async () => {
    getTradeQuote.mockResolvedValue({
      quote: { symbol: seed.symbol, bid: 32, ask: 34, bidSize: 100, askSize: 100, mark: 33.74, ts: Date.now() },
      product: null,
    });
    show();
    await waitFor(() =>
      expect(previewOrder.mock.calls.at(-1)![0]).toMatchObject({ limitPrice: 34 }),
    );
  });

  it('falls back to the tapped price when the exchange has not answered', async () => {
    show();
    expect(screen.getByText('11.00')).toBeInTheDocument();
    // the preview is debounced, so wait for it rather than for the text
    await waitFor(() =>
      expect(previewOrder.mock.calls.at(-1)![0]).toMatchObject({ limitPrice: 11 }),
    );
  });
});

describe('choosing a price', () => {
  it('sends the offer when the offer is chosen', async () => {
    show();
    fireEvent.click(screen.getByRole('radio', { name: 'Offer' }));
    expect(screen.getByText(/Offers at 11.00/)).toBeInTheDocument();
    await waitFor(() =>
      expect(previewOrder.mock.calls.at(-1)![0]).toMatchObject({ limitPrice: 11 }),
    );
  });

  it('"now" is a limit at the bid, not a market order', async () => {
    // case 07 walks a market sell through three levels for a quarter-point of
    // slippage; a limit at the bid is just as immediate and has a floor
    show();
    fireEvent.click(screen.getByRole('radio', { name: 'Bid' }));
    expect(screen.getByText(/Never below it, so no slippage/)).toBeInTheDocument();
    await waitFor(() =>
      expect(previewOrder.mock.calls.at(-1)![0]).toMatchObject({ limitPrice: 9 }),
    );
  });

  it('offers no market order at all', () => {
    show();
    expect(screen.queryByRole('radio', { name: 'market' })).toBeNull();
  });

  it('treats an unparseable custom price as no price rather than as zero', async () => {
    show();
    fireEvent.click(screen.getByRole('radio', { name: 'My price' }));
    fireEvent.change(screen.getByLabelText('limit price'), { target: { value: 'abc' } });
    await waitFor(() =>
      expect(previewOrder.mock.calls.at(-1)![0]).toMatchObject({ limitPrice: null }),
    );
  });
});

describe('converting to market', () => {
  it('is on by default, because the arithmetic says so', async () => {
    // resting earns ~12% on a 6-13% wide book and Delta charges the same to
    // make or take; crossing after a wait means there is no day it is worse
    show();                                    // opens on the offer, which rests
    expect(screen.getByRole('checkbox', { name: /sell at bid after/i })).toBeChecked();
    await waitFor(() =>
      expect(previewOrder.mock.calls.at(-1)![0]).toMatchObject({ convertToMarketAfterSec: 30 }),
    );
  });

  it('can be turned off, and then says the order may never fill', async () => {
    show();
    fireEvent.click(screen.getByRole('checkbox', { name: /sell at bid after/i }));
    expect(screen.getByText(/may never fill/i)).toBeInTheDocument();
    await waitFor(() =>
      expect(previewOrder.mock.calls.at(-1)![0]).toMatchObject({ convertToMarketAfterSec: 0 }),
    );
  });

  it('is not offered on an order that is taken immediately', () => {
    show();
    fireEvent.click(screen.getByRole('radio', { name: 'Bid' }));
    expect(screen.queryByRole('checkbox', { name: /sell at bid after/i })).toBeNull();
  });

  it('says what the wait is worth on this book', async () => {
    show();
    // bid 9, ask 11: resting is worth 22% more premium than taking the bid
    await waitFor(() => expect(screen.getByText(/about 22% more premium/i)).toBeInTheDocument());
    expect(screen.getByText(/then sells at the bid/i)).toBeInTheDocument();
  });

  it('takes a different wait', async () => {
    show();
    fireEvent.change(screen.getByLabelText('seconds before crossing'), { target: { value: '5' } });
    await waitFor(() =>
      expect(previewOrder.mock.calls.at(-1)![0]).toMatchObject({ convertToMarketAfterSec: 5 }),
    );
  });

  it('treats a price set below the bid as crossing, so nothing to convert', () => {
    show();
    fireEvent.click(screen.getByRole('radio', { name: 'My price' }));
    fireEvent.change(screen.getByLabelText('limit price'), { target: { value: '5' } });
    expect(screen.queryByRole('checkbox', { name: /sell at bid after/i })).toBeNull();
  });
});

describe('size', () => {
  it('steps up and down and never goes below one lot', () => {
    show();
    const lots = screen.getByLabelText('lots') as HTMLInputElement;
    expect(lots.value).toBe('1');
    fireEvent.click(screen.getByLabelText('one more lot'));
    expect(lots.value).toBe('2');
    fireEvent.click(screen.getByLabelText('one fewer lot'));
    fireEvent.click(screen.getByLabelText('one fewer lot'));
    expect(lots.value).toBe('1');
  });

  it('lets you go past what the balance covers, and says so', async () => {
    // Delta's own ticket does this: type any size, then "Insufficient Balance".
    // Clamping instead made the plus button dead exactly when a small account
    // most wants to see what a bigger size would cost.
    previewOrder.mockResolvedValue(ok({ maxLots: 3 }));
    show();
    const lots = screen.getByLabelText('lots') as HTMLInputElement;
    for (let i = 0; i < 5; i++) fireEvent.click(screen.getByLabelText('one more lot'));
    expect(lots.value).toBe('6');
    await waitFor(() => expect(screen.getByText(/needs more margin than that/)).toBeInTheDocument());
  });

  it('still increases when the server could not work out a cap', async () => {
    // a balance the server could not read came back as maxLots 0, and clamping
    // to it pinned the size at zero and made the plus button do nothing
    previewOrder.mockResolvedValue(ok({ maxLots: 0 }));
    show();
    await waitFor(() => expect(previewOrder).toHaveBeenCalled());
    fireEvent.click(screen.getByLabelText('one more lot'));
    expect((screen.getByLabelText('lots') as HTMLInputElement).value).toBe('2');
  });

  it('the quick chips add rather than replace, and say so', async () => {
    // a chip that sets on the first tap and adds on the second is a rule
    // nobody can see; "+5" is a rule anybody can
    show();
    const lots = screen.getByLabelText('lots') as HTMLInputElement;
    fireEvent.click(screen.getByLabelText('add 5 lots'));
    expect(lots.value).toBe('6');
    fireEvent.click(screen.getByLabelText('add 5 lots'));
    expect(lots.value).toBe('11');
    fireEvent.click(screen.getByLabelText('add 25 lots'));
    expect(lots.value).toBe('36');
  });

  it('max jumps straight to what the balance covers', async () => {
    previewOrder.mockResolvedValue(ok({ maxLots: 7 }));
    show();
    fireEvent.click(await screen.findByLabelText('as many lots as the balance covers'));
    expect((screen.getByLabelText('lots') as HTMLInputElement).value).toBe('7');
  });

  it('offers no max chip when the balance is unknown', () => {
    show();
    expect(screen.queryByLabelText('as many lots as the balance covers')).toBeNull();
  });

  it('says how many lots the balance actually covers', async () => {
    previewOrder.mockResolvedValue(ok({ maxLots: 7 }));
    show();
    await waitFor(() => expect(screen.getByText(/7 lots at 200x/)).toBeInTheDocument());
  });

  it('can be typed into, cleared and retyped', () => {
    // clamping every keystroke to at least 1 meant backspace did nothing and
    // the field could never be cleared to enter a new number
    show();
    const lots = screen.getByLabelText('lots') as HTMLInputElement;
    fireEvent.change(lots, { target: { value: '' } });
    expect(lots.value).toBe('');
    fireEvent.change(lots, { target: { value: '25' } });
    expect(lots.value).toBe('25');
  });

  it('settles an empty box back to the last real size when it loses focus', () => {
    show();
    const lots = screen.getByLabelText('lots') as HTMLInputElement;
    fireEvent.change(lots, { target: { value: '7' } });
    fireEvent.change(lots, { target: { value: '' } });
    fireEvent.blur(lots);
    expect(lots.value).toBe('7');
  });

  it('ignores anything that is not a digit', () => {
    show();
    const lots = screen.getByLabelText('lots') as HTMLInputElement;
    fireEvent.change(lots, { target: { value: '1e5' } });
    expect(lots.value).toBe('15');
  });

  it('has no spinner arrows to mis-tap', () => {
    show();
    // type=number puts a two-pixel stepper against the value that changes the
    // size by one per click; the buttons beside the field do that job properly
    expect(screen.getByLabelText('lots')).toHaveAttribute('type', 'text');
    expect(screen.getByLabelText('lots')).toHaveAttribute('inputMode', 'numeric');
  });
});

describe('the gates', () => {
  it('kills the button and gives the server’s reason when a trade is refused', async () => {
    previewOrder.mockResolvedValue(
      ok({ ok: false, failures: [{ code: 'SPREAD_TOO_WIDE', message: 'Spread is 18.0%, limit is 4%.' }] }),
    );
    show();
    await waitFor(() => expect(screen.getByText('Spread is 18.0%, limit is 4%.')).toBeInTheDocument());
    const control = screen.getByRole('slider', { name: /Swipe to sell/ });
    expect(control).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByText('Can’t sell')).toBeInTheDocument();
    swipe(control);
    fireEvent.keyDown(control, { key: 'Enter' });
    expect(placeOrder).not.toHaveBeenCalled();
  });

  it('lists every reason, not just the first', async () => {
    previewOrder.mockResolvedValue(ok({
      ok: false,
      failures: [
        { code: 'SPREAD_TOO_WIDE', message: 'Spread is 28.4%, limit is 4% for an order that crosses it.' },
        { code: 'INSUFFICIENT_MARGIN', message: 'Needs $3.93 at 200x, have $0.18.' },
        { code: 'DAILY_LOSS_LIMIT', message: "Worst case $2 exceeds the $1 left in today's loss budget." },
      ],
    }));
    show();
    await waitFor(() => expect(screen.getByText(/Spread is 28.4%/)).toBeInTheDocument());
    expect(screen.getByText(/Needs \$3.93 at 200x/)).toBeInTheDocument();
    expect(screen.getByText(/exceeds the \$1 left/)).toBeInTheDocument();
  });

  it('sends nothing while the gates are still being checked', () => {
    previewOrder.mockReturnValue(new Promise(() => {}));   // never settles
    show();
    swipe(screen.getByRole('slider', { name: /sell/i }));
    fireEvent.keyDown(screen.getByRole('slider', { name: /sell/i }), { key: 'Enter' });
    expect(placeOrder).not.toHaveBeenCalled();
  });

  it('[critical] a tap on the sell control places nothing: it has to be swiped', async () => {
    show();
    const slider = await screen.findByRole('slider', { name: /Swipe to sell/ });
    await waitFor(() => expect(slider).not.toHaveAttribute('aria-disabled'));
    fireEvent.click(slider);
    swipe(slider, 0.6);
    expect(placeOrder).not.toHaveBeenCalled();
  });

  it('places the order and reports the fill once the gates pass', async () => {
    show();
    await waitFor(() => expect(screen.getByRole('slider', { name: /Swipe to sell · ₹0\.76/ })).not.toHaveAttribute('aria-disabled'));
    swipe(screen.getByRole('slider', { name: /Swipe to sell · ₹0\.76/ }));
    await waitFor(() => expect(screen.getByText('Sold 1 at 9.00')).toBeInTheDocument());
    expect(screen.getByText(/You are short 1 contract\./)).toBeInTheDocument();
    expect(placeOrder).toHaveBeenCalledTimes(1);
  });

  it('says plainly when a refusal came back from the place call itself', async () => {
    placeOrder.mockResolvedValue({
      mode: 'paper', ok: false,
      failures: [{ code: 'INSUFFICIENT_MARGIN', message: 'Needs $300, have $120.' }],
      trade: { position: 0 },
    });
    show();
    await waitFor(() => expect(screen.getByRole('slider', { name: /Swipe to sell/ })).not.toHaveAttribute('aria-disabled'));
    swipe(screen.getByRole('slider', { name: /Swipe to sell/ }));
    await waitFor(() => expect(screen.getByText('Nothing was sent')).toBeInTheDocument());
    expect(screen.getByText('Needs $300, have $120.')).toBeInTheDocument();
  });
});

describe('paper mode', () => {
  it('says so after the order, so a paper fill is never mistaken for a real one', async () => {
    show();
    await waitFor(() => expect(screen.getByRole('slider', { name: /Swipe to sell/ })).not.toHaveAttribute('aria-disabled'));
    swipe(screen.getByRole('slider', { name: /Swipe to sell/ }));
    await waitFor(() => expect(screen.getByText(/nothing reached Delta/)).toBeInTheDocument());
  });
});

describe('reopening the ticket', () => {
  it('does not show the last order’s result over a new one', async () => {
    // tapping the same strike twice never changed the symbol, so nothing reset
    const { rerender } = render(<OrderTicket seed={seed} open onOpenChange={() => {}} />);
    await waitFor(() => expect(screen.getByRole('slider', { name: /Swipe to sell/ })).not.toHaveAttribute('aria-disabled'));
    swipe(screen.getByRole('slider', { name: /Swipe to sell/ }));
    await waitFor(() => expect(screen.getByText(/Sold 1 at 9.00/)).toBeInTheDocument());

    rerender(<OrderTicket seed={seed} open={false} onOpenChange={() => {}} />);
    rerender(<OrderTicket seed={seed} open onOpenChange={() => {}} />);
    expect(screen.queryByText(/Sold 1 at 9.00/)).toBeNull();
    expect(screen.getByRole('radio', { name: 'Offer' })).toBeInTheDocument();
  });

  it('starts from one lot again, whatever the last one was', async () => {
    const { rerender } = render(<OrderTicket seed={seed} open onOpenChange={() => {}} />);
    fireEvent.change(screen.getByLabelText('lots'), { target: { value: '9' } });
    rerender(<OrderTicket seed={seed} open={false} onOpenChange={() => {}} />);
    rerender(<OrderTicket seed={seed} open onOpenChange={() => {}} />);
    expect((screen.getByLabelText('lots') as HTMLInputElement).value).toBe('1');
  });
});

describe('a new contract', () => {
  it('resets the size, so the last strike’s ten lots do not carry over', () => {
    const { rerender } = render(<OrderTicket seed={seed} open onOpenChange={() => {}} />);
    fireEvent.change(screen.getByLabelText('lots'), { target: { value: '10' } });
    expect((screen.getByLabelText('lots') as HTMLInputElement).value).toBe('10');

    rerender(<OrderTicket seed={{ ...seed, symbol: 'P-BTC-77000-080926', side: 'PE', strike: 77_000 }} open onOpenChange={() => {}} />);
    expect((screen.getByLabelText('lots') as HTMLInputElement).value).toBe('1');
  });

  it('renders nothing at all without a contract', () => {
    const { container } = render(<OrderTicket seed={null} open onOpenChange={() => {}} />);
    expect(container).toBeEmptyDOMElement();
  });
});
