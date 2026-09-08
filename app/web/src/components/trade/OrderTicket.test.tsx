import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { OrderTicket, type TicketSeed } from '@/components/trade/OrderTicket';
import type { Preview } from '@/types/trade';

/**
 * What the ticket must never do:
 *   - offer a live Sell button when the server said the trade is blocked
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
    expect(screen.getByRole('radio', { name: 'ask' })).toHaveAttribute('data-state', 'on');
    await waitFor(() => expect(previewOrder).toHaveBeenCalled());
    expect(previewOrder.mock.calls.at(-1)![0]).toMatchObject({ limitPrice: 11, lots: 1 });
  });

  it('falls back to the market when the contract has no offer', async () => {
    render(<OrderTicket seed={{ ...seed, symbol: 'C-BTC-1', ask: null }} open onOpenChange={() => {}} />);
    expect(screen.getByRole('radio', { name: 'market' })).toHaveAttribute('data-state', 'on');
    await waitFor(() =>
      expect(previewOrder.mock.calls.at(-1)![0]).toMatchObject({ limitPrice: null }),
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
  it('sends the offer when the ask is chosen, and says it may not fill', async () => {
    show();
    fireEvent.click(screen.getByRole('radio', { name: 'ask' }));
    expect(screen.getByText(/Rests at 11.00/)).toBeInTheDocument();
    expect(screen.getByText(/may not fill at all/)).toBeInTheDocument();
    await waitFor(() =>
      expect(previewOrder.mock.calls.at(-1)![0]).toMatchObject({ limitPrice: 11 }),
    );
  });

  it('sends the bid when the bid is chosen', async () => {
    show();
    fireEvent.click(screen.getByRole('radio', { name: 'bid' }));
    await waitFor(() =>
      expect(previewOrder.mock.calls.at(-1)![0]).toMatchObject({ limitPrice: 9 }),
    );
  });

  it('treats an unparseable custom price as no price rather than as zero', async () => {
    show();
    fireEvent.click(screen.getByRole('radio', { name: 'set' }));
    fireEvent.change(screen.getByLabelText('limit price'), { target: { value: 'abc' } });
    await waitFor(() =>
      expect(previewOrder.mock.calls.at(-1)![0]).toMatchObject({ limitPrice: null }),
    );
  });
});

describe('converting to market', () => {
  it('is offered on an order that rests, and off until you ask for it', async () => {
    show();                                    // opens on the offer, which rests
    expect(screen.getByRole('checkbox', { name: /cross after/i })).not.toBeChecked();
    await waitFor(() =>
      expect(previewOrder.mock.calls.at(-1)![0]).toMatchObject({ convertToMarketAfterSec: 0 }),
    );
    expect(screen.getByText(/waits for as long as it takes/i)).toBeInTheDocument();
  });

  it('is not offered on an order that is taken immediately', () => {
    show();
    fireEvent.click(screen.getByRole('radio', { name: 'market' }));
    expect(screen.queryByRole('checkbox', { name: /cross after/i })).toBeNull();
    fireEvent.click(screen.getByRole('radio', { name: 'bid' }));
    expect(screen.queryByRole('checkbox', { name: /cross after/i })).toBeNull();
  });

  it('sends the wait once it is ticked', async () => {
    show();
    fireEvent.click(screen.getByRole('checkbox', { name: /cross after/i }));
    await waitFor(() =>
      expect(previewOrder.mock.calls.at(-1)![0]).toMatchObject({ convertToMarketAfterSec: 30 }),
    );
    expect(screen.getByText(/then takes the bid and pays the spread/i)).toBeInTheDocument();
  });

  it('takes a different wait', async () => {
    show();
    fireEvent.click(screen.getByRole('checkbox', { name: /cross after/i }));
    fireEvent.change(screen.getByLabelText('seconds before crossing'), { target: { value: '5' } });
    await waitFor(() =>
      expect(previewOrder.mock.calls.at(-1)![0]).toMatchObject({ convertToMarketAfterSec: 5 }),
    );
  });

  it('treats a price set below the bid as crossing, so nothing to convert', () => {
    show();
    fireEvent.click(screen.getByRole('radio', { name: 'set' }));
    fireEvent.change(screen.getByLabelText('limit price'), { target: { value: '5' } });
    expect(screen.queryByRole('checkbox', { name: /cross after/i })).toBeNull();
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
    const button = screen.getByRole('button', { name: /cannot sell/i });
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(placeOrder).not.toHaveBeenCalled();
  });

  it('sends nothing while the gates are still being checked', () => {
    previewOrder.mockReturnValue(new Promise(() => {}));   // never settles
    show();
    fireEvent.click(screen.getByRole('button', { name: /sell/i }));
    expect(placeOrder).not.toHaveBeenCalled();
  });

  it('places the order and reports the fill once the gates pass', async () => {
    show();
    await waitFor(() => expect(screen.getByRole('button', { name: /Sell · \$0\.009/ })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: /Sell · \$0\.009/ }));
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
    await waitFor(() => expect(screen.getByRole('button', { name: /Sell/ })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: /Sell/ }));
    await waitFor(() => expect(screen.getByText('Nothing was sent')).toBeInTheDocument());
    expect(screen.getByText('Needs $300, have $120.')).toBeInTheDocument();
  });
});

describe('paper mode', () => {
  it('says so after the order, so a paper fill is never mistaken for a real one', async () => {
    show();
    await waitFor(() => expect(screen.getByRole('button', { name: /Sell/ })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: /Sell/ }));
    await waitFor(() => expect(screen.getByText(/Nothing reached the exchange/)).toBeInTheDocument());
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
