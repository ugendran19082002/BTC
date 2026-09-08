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
vi.mock('@/api/trade', () => ({
  previewOrder: (...a: unknown[]) => previewOrder(...a),
  placeOrder: (...a: unknown[]) => placeOrder(...a),
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
  creditUsd: 9,
  worstCaseLossUsd: 13.5,
  stopPrice: 22.5,
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
  vi.clearAllMocks();
  previewOrder.mockResolvedValue(ok());
  placeOrder.mockResolvedValue({ mode: 'paper', ok: true, trade: { position: -1, entryAvgPrice: 9 } });
});

describe('the ticket opens ready to trade', () => {
  it('names the contract and defaults to the market', async () => {
    show();
    expect(screen.getByText('Sell 80,000 CE')).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'market' })).toHaveAttribute('data-state', 'on');
    await waitFor(() => expect(previewOrder).toHaveBeenCalled());
    // market means "take what the book gives", which is a null limit price
    expect(previewOrder.mock.calls.at(-1)![0]).toMatchObject({ limitPrice: null, lots: 1 });
  });

  it('shows the whole book, so a price is one tap away', () => {
    show();
    expect(screen.getByText('9.00')).toBeInTheDocument();
    expect(screen.getByText('10.00')).toBeInTheDocument();
    expect(screen.getByText('11.00')).toBeInTheDocument();
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

  it('will not step past the lots the account can carry', () => {
    show({ maxLots: 3 });
    const lots = screen.getByLabelText('lots') as HTMLInputElement;
    for (let i = 0; i < 6; i++) fireEvent.click(screen.getByLabelText('one more lot'));
    expect(lots.value).toBe('3');
  });

  it('clamps a typed size to the cap instead of trusting it', () => {
    show({ maxLots: 5 });
    const lots = screen.getByLabelText('lots') as HTMLInputElement;
    fireEvent.change(lots, { target: { value: '999' } });
    expect(lots.value).toBe('5');
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
    await waitFor(() => expect(screen.getByRole('button', { name: /Sell · \$9\.00/ })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: /Sell · \$9\.00/ }));
    await waitFor(() => expect(screen.getByText('Sold 1 at 9.00')).toBeInTheDocument());
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
    await waitFor(() => expect(screen.getByText('Not sent')).toBeInTheDocument());
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
