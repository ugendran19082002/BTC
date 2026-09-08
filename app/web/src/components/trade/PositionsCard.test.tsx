import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { PositionsCard } from '@/components/trade/PositionsCard';
import { AlarmBanner } from '@/components/trade/ModeBanner';
import { ModeSwitch } from '@/components/trade/ModeSwitch';
import type { Trade, TradeStatus } from '@/types/trade';

const closeTrade = vi.fn();
const setTradeMode = vi.fn();
vi.mock('@/api/trade', () => ({
  closeTrade: (...a: unknown[]) => closeTrade(...a),
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
  ...over,
});

beforeEach(() => { vi.clearAllMocks(); closeTrade.mockResolvedValue({ ok: true }); });

describe('a protected position', () => {
  it('names the contract, the size and where the stop is', () => {
    render(<PositionsCard trades={[trade()]} />);
    expect(screen.getByText('80,000 CE')).toBeInTheDocument();
    expect(screen.getByText(/short 100 at 10.50/)).toBeInTheDocument();
    expect(screen.getByText('26.00')).toBeInTheDocument();
  });
});

describe('a position with no stop behind it', () => {
  const naked = trade({ phase: 'unprotected', protection: { takeProfit: null, stopLoss: null }, alarm: 'POSITION UNPROTECTED: API down' });

  it('says NO STOP in words rather than leaving a blank', () => {
    render(<PositionsCard trades={[naked]} />);
    expect(screen.getByText('NO STOP')).toBeInTheDocument();
    expect(screen.getByText('none')).toBeInTheDocument();
    expect(screen.getByText('POSITION UNPROTECTED: API down')).toBeInTheDocument();
  });

  it('is still detected when the phase looks fine but the stop is gone', () => {
    // the phase can lag a reconcile by one poll; the missing stop cannot
    render(<PositionsCard trades={[trade({ protection: { takeProfit: 'tp', stopLoss: null } })]} />);
    expect(screen.getByText('none')).toBeInTheDocument();
  });

  it('interrupts the page from the banner, naming the contract', () => {
    render(<AlarmBanner status={{ open: [naked] } as TradeStatus} />);
    expect(screen.getByText('A position has no stop behind it')).toBeInTheDocument();
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

  it('offers nothing to close on a position that is already flat', () => {
    render(<PositionsCard trades={[trade({ position: 0, phase: 'flat' })]} />);
    expect(screen.getByRole('button', { name: /close now/i })).toBeDisabled();
  });
});

describe('an empty desk', () => {
  it('says so rather than showing an empty box', () => {
    render(<PositionsCard trades={[]} />);
    expect(screen.getByText('Nothing on.')).toBeInTheDocument();
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

  it('calls paper paper, and real money real money', () => {
    const { rerender } = render(<ModeSwitch status={status()} />);
    expect(screen.getByText('paper')).toBeInTheDocument();
    rerender(<ModeSwitch status={status({ mode: 'live', live: true })} />);
    expect(screen.getByText('live · real money')).toBeInTheDocument();
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
    await waitFor(() => expect(screen.getByText('Trade for real?')).toBeInTheDocument());
    expect(setTradeMode).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: /go live/i }));
    await waitFor(() => expect(setTradeMode).toHaveBeenCalledWith('live'));
  });

  it('goes back to paper on one tap, because leaving live is never the risky direction', async () => {
    setTradeMode.mockResolvedValue({ ok: true, mode: 'paper' });
    render(<ModeSwitch status={status({ mode: 'live', live: true })} />);
    fireEvent.click(screen.getByRole('button', { name: /live/i }));
    await waitFor(() => expect(setTradeMode).toHaveBeenCalledWith('paper'));
    expect(screen.queryByText('Trade for real?')).toBeNull();
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
