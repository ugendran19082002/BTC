import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { SignalStrategiesCard } from '@/components/strategy/SignalStrategiesCard';
import { DEFAULT_CONFIG, type Strategy, type StrategyStatus } from '@/types/strategy';

const getStrategies = vi.fn();
const saveStrategy = vi.fn();
const setStrategyEnabled = vi.fn();
const getSignalTrades = vi.fn();
const cloneStrategy = vi.fn();
const setSignalMaxOpen = vi.fn();
vi.mock('@/api/strategy', () => ({
  setSignalMaxOpen: (...a: unknown[]) => setSignalMaxOpen(...a),
  cloneStrategy: (...a: unknown[]) => cloneStrategy(...a),
  getStrategies: (...a: unknown[]) => getStrategies(...a),
  getSignalTrades: (...a: unknown[]) => getSignalTrades(...a),
  saveStrategy: (...a: unknown[]) => saveStrategy(...a),
  setStrategyEnabled: (...a: unknown[]) => setStrategyEnabled(...a),
}));
vi.mock('@/api/entry', () => ({
  getEntryMethods: () => Promise.resolve({ methods: [] }),
  getMethodReport: () => Promise.resolve({ tf: null, sections: [], singleByTf: {} }),
  getEntryBoard: () => Promise.resolve({ reads: [], ltp: null }),
}));

/** The signal strategies on the Live screen: the same strategies as the Strategy tab, the signal ones. */

const strat = (id: string, over: Partial<Strategy['config']> = {}, enabled = true): Strategy => ({
  id, name: id.toUpperCase(), enabled, createdAt: 0, updatedAt: 0, lastRunDate: null, ranToday: false,
  nextEntryAt: null, status: 'taking signals until 5:29 PM', config: { ...DEFAULT_CONFIG, ...over },
});
const SIG = { trigger: 'signal' as const, lots: 1, liveOrders: false,
  signal: { mode: 'single' as const, tf: '15m' as const, methods: ['breakout', 'bos'], target: 'tp2' as const, maxOpen: 2 } };
const status = (strategies: Strategy[], over: Partial<StrategyStatus> = {}): StrategyStatus => ({
  today: '2026-10-02', schedulerOn: true, runnerInstalled: true, mode: 'paper', balanceUsd: 228, spot: 85_000,
  strategies, runs: [], signalRuns: [], ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  getSignalTrades.mockImplementation(async () => ({ from: null, to: null, trades: (await getStrategies()).signalTrades ?? [] }));
  saveStrategy.mockResolvedValue({ ok: true });
  setStrategyEnabled.mockResolvedValue({ ok: true });
});

describe('signal strategies on the Live screen', () => {
  it('[critical] lists only the signal strategies, each in one line', async () => {
    getStrategies.mockResolvedValue(status([strat('sig', SIG), strat('clock')]));
    render(<SignalStrategiesCard />);
    expect(await screen.findByText('SIG')).toBeInTheDocument();
    expect(screen.queryByText('CLOCK')).toBeNull();
    expect(screen.getByText(/2 methods on 15m · BUY → PE · SELL → CE · .* · 1 lot · perp SL \/ TGT2 \(else TGT1\) · max 2 open · 5:30 AM → 5:29 PM/)).toBeInTheDocument();
    expect(screen.getByText(/writes down what it would sell, sends nothing/)).toBeInTheDocument();
  });

  it('[critical] New opens the form already on signals, on its Signals tab, one lot', async () => {
    getStrategies.mockResolvedValue(status([]));
    render(<SignalStrategiesCard />);
    expect(await screen.findByText(/No signal strategy yet/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /New signal strategy/ }));
    expect(await screen.findByRole('tab', { name: /^Signals/ })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('radio', { name: 'With the timeframe chain' })).toBeInTheDocument();
    expect(screen.queryByRole('radiogroup', { name: 'legs' })).toBeNull();
    fireEvent.click(screen.getByRole('tab', { name: /^Strike & lots/ }));
    expect(screen.getByLabelText('lots')).toHaveValue('1');
    expect(screen.getByRole('switch', { name: /^Live orders/ })).toHaveAttribute('aria-checked', 'false');
  });

  it('[critical] live orders on needs a second tap; off is one tap', async () => {
    getStrategies.mockResolvedValue(status([strat('sig', SIG)]));
    render(<SignalStrategiesCard />);
    const sw = await screen.findByRole('switch', { name: 'Live orders for SIG' });
    fireEvent.click(sw);
    expect(saveStrategy).not.toHaveBeenCalled();
    expect(sw).toHaveTextContent('Tap again: real orders');
    fireEvent.click(sw);
    await waitFor(() => expect(saveStrategy).toHaveBeenCalledTimes(1));
    expect(saveStrategy.mock.calls[0]![0]).toMatchObject({ id: 'sig', name: 'SIG', config: { liveOrders: true, signal: SIG.signal } });
  });

  it('[critical] live orders off again is one tap', async () => {
    getStrategies.mockResolvedValue(status([strat('sig', { ...SIG, liveOrders: true })]));
    render(<SignalStrategiesCard />);
    const on = await screen.findByRole('switch', { name: 'Live orders for SIG' });
    expect(on).toHaveAttribute('aria-checked', 'true');
    expect(on).toHaveTextContent('Live orders ON');
    fireEvent.click(on);
    await waitFor(() => expect(saveStrategy).toHaveBeenCalledTimes(1));
    expect(saveStrategy.mock.calls[0]![0].config.liveOrders).toBe(false);
  });

  it('enable and disable from here', async () => {
    getStrategies.mockResolvedValue(status([strat('sig', SIG, false)]));
    render(<SignalStrategiesCard />);
    fireEvent.click(await screen.findByRole('button', { name: 'Enable' }));
    await waitFor(() => expect(setStrategyEnabled).toHaveBeenCalledWith('sig', true));
  });

  it('[critical] auto-trading off is said, with the way to the switch', async () => {
    getStrategies.mockResolvedValue(status([strat('sig', SIG)], { schedulerOn: false }));
    const go = vi.fn();
    render(<SignalStrategiesCard onOpenStrategyTab={go} />);
    expect(await screen.findByText(/Auto-trading is off, so no signal is taken/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Turn it on on the Strategy tab/ }));
    expect(go).toHaveBeenCalled();
  });

  it('[critical] the trade history is shown; the raw signals log is not', async () => {
    getStrategies.mockResolvedValue(status([strat('sig', SIG), strat('clock')], {
      signalRuns: [
        { id: 1, strategyId: 'sig', signalKey: 'k', method: 'bos', mode: 'single', tf: '15m', dir: -1, status: 'skipped', detail: 'already 7 of its trades open (at most 2)', tradeId: null, at: Date.now() },
      ],
      signalTrades: [{
        id: 2, strategyId: 'sig', at: Date.now(), method: 'bos', mode: 'single', tf: '15m', dir: -1, status: 'would-place',
        detail: '#6 BOS SELL | live orders off: would sell CE 86000 x1 @ 18', tradeId: null,
        levels: { entryLo: 85_000, entryHi: 85_050, stop: 85_400, tp1: 84_500, tp2: null, tp3: null },
        perp: { status: 'filled', fillPrice: 85_040, filledAt: Date.now(), exitPrice: null, exitAt: null }, option: null,
      }],
    }));
    render(<SignalStrategiesCard />);
    const table = await screen.findByRole('table', { name: 'signal trades' });
    // asked of the server for today, by IST day
    expect(getSignalTrades).toHaveBeenCalledWith({ from: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/), to: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) });
    expect(within(table).getByText('#6 BOS SELL')).toBeInTheDocument();
    expect(table).toHaveTextContent('in the trade');
    expect(screen.queryByRole('table', { name: 'signals taken' })).toBeNull();
    expect(screen.queryByText(/already 7 of its trades open/)).toBeNull();
  });
});

describe('copy', () => {
  it('[critical] Copy makes a copy and opens it, its name ready to change -- off, live orders off', async () => {
    getStrategies.mockResolvedValue(status([strat('sig', { ...SIG, liveOrders: true })]));
    cloneStrategy.mockResolvedValue({ ok: true, strategy: { ...strat('sig-copy', { ...SIG, liveOrders: false }, false), name: 'SIG copy' } });
    render(<SignalStrategiesCard />);
    fireEvent.click(await screen.findByRole('button', { name: 'Copy SIG' }));
    await waitFor(() => expect(cloneStrategy).toHaveBeenCalledWith('sig'));
    expect(await screen.findByRole('dialog', { name: 'Edit SIG copy' })).toBeInTheDocument();
    const name = screen.getByLabelText('strategy name');
    expect(name).toHaveValue('SIG copy');
    fireEvent.change(name, { target: { value: 'Breakout 15m only' } });
    expect(name).toHaveValue('Breakout 15m only');
    expect(screen.getByRole('switch', { name: /^Live orders/ })).toHaveAttribute('aria-checked', 'false');
  });
});

describe('at most open at once, across all strategies', () => {
  const field = () => screen.getByLabelText('At most open at once, all strategies');
  const type = (v: string) => { fireEvent.focus(field()); fireEvent.change(field(), { target: { value: v } }); fireEvent.blur(field()); };

  beforeEach(() => { setSignalMaxOpen.mockResolvedValue({ ok: true }); });

  it('[critical] sits left of "Auto-trading", shows the desk\'s number and how many are open against it', async () => {
    getStrategies.mockResolvedValue(status([strat('sig', SIG)], { signalMaxOpen: 6, openNow: 4 }));
    render(<SignalStrategiesCard />);
    await screen.findByText('SIG');
    expect(field()).toHaveValue('6');
    expect(screen.getByLabelText('open now, of the limit')).toHaveTextContent('4 of 6 open');
    const auto = screen.getByText(/^Auto-trading on$/);
    expect(Boolean(field().compareDocumentPosition(auto) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);
    // each strategy's own limit is still on its line
    expect(screen.getByText(/max 2 open/)).toBeInTheDocument();
  });

  it('[critical] 0 is no limit, and says so', async () => {
    getStrategies.mockResolvedValue(status([strat('sig', SIG)], { signalMaxOpen: 0, openNow: 3 }));
    render(<SignalStrategiesCard />);
    await screen.findByText('SIG');
    expect(field()).toHaveValue('0');
    expect(screen.getByLabelText('open now, of the limit')).toHaveTextContent('no limit · 3 open');
  });

  it('[critical] typed and left: saved to the server as the number, and the list is read again', async () => {
    getStrategies.mockResolvedValue(status([strat('sig', SIG)], { signalMaxOpen: 0, openNow: 3 }));
    render(<SignalStrategiesCard />);
    await screen.findByText('SIG');
    const before = getStrategies.mock.calls.length;
    type('6');
    await waitFor(() => expect(setSignalMaxOpen).toHaveBeenCalledWith(6));
    await waitFor(() => expect(getStrategies.mock.calls.length).toBeGreaterThan(before));
  });

  it('[critical] unchanged is not sent; blank or over 500 is said and put back, not sent', async () => {
    getStrategies.mockResolvedValue(status([strat('sig', SIG)], { signalMaxOpen: 6, openNow: 1 }));
    render(<SignalStrategiesCard />);
    await screen.findByText('SIG');
    type('6');
    type('');
    expect(screen.getByText('At most open at once, across all strategies, must be a whole number from 0 (no limit) to 500.')).toBeInTheDocument();
    expect(field()).toHaveValue('6');
    type('501');
    expect(field()).toHaveValue('6');
    expect(setSignalMaxOpen).not.toHaveBeenCalled();
    // letters cannot be typed at all
    fireEvent.focus(field());
    fireEvent.change(field(), { target: { value: '1x2' } });
    expect(field()).toHaveValue('12');
  });

  it('the server\'s refusal is shown', async () => {
    setSignalMaxOpen.mockRejectedValue(new Error('At most open at once, across all strategies, must be a whole number from 0 (no limit) to 500.'));
    getStrategies.mockResolvedValue(status([strat('sig', SIG)], { signalMaxOpen: 6, openNow: 1 }));
    render(<SignalStrategiesCard />);
    await screen.findByText('SIG');
    type('7');
    expect(await screen.findByText(/must be a whole number from 0 \(no limit\) to 500/)).toBeInTheDocument();
  });

  it('an older server that does not send it shows no field', async () => {
    getStrategies.mockResolvedValue(status([strat('sig', SIG)]));
    render(<SignalStrategiesCard />);
    await screen.findByText('SIG');
    expect(screen.queryByLabelText('At most open at once, all strategies')).toBeNull();
  });
});
