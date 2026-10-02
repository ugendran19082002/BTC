import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { SignalStrategiesCard } from '@/components/strategy/SignalStrategiesCard';
import { DEFAULT_CONFIG, type Strategy, type StrategyStatus } from '@/types/strategy';

const getStrategies = vi.fn();
const saveStrategy = vi.fn();
const setStrategyEnabled = vi.fn();
vi.mock('@/api/strategy', () => ({
  getStrategies: (...a: unknown[]) => getStrategies(...a),
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

  it('[critical] the last signals its strategies took, and what each did', async () => {
    getStrategies.mockResolvedValue(status([strat('sig', SIG), strat('clock')], {
      signalRuns: [
        { id: 1, strategyId: 'sig', signalKey: 'k', method: 'bos', mode: 'single', tf: '15m', dir: -1, status: 'would-place', detail: 'would sell CE 86000 x1 @ 18 · perp SL 85400 · TGT 84500', tradeId: null, at: Date.now() },
      ],
    }));
    render(<SignalStrategiesCard />);
    const table = await screen.findByRole('table', { name: 'signals taken' });
    expect(within(table).getByText(/SELL → CE · 15m/)).toBeInTheDocument();
    expect(table).toHaveTextContent(/would sell/);
    expect(table).toHaveTextContent(/perp SL 85400 · TGT 84500/);
  });
});
