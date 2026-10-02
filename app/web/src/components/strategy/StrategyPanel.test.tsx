import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { StrategyPanel } from '@/components/strategy/StrategyPanel';
import { DEFAULT_CONFIG, type StrategyStatus } from '@/types/strategy';

const getStrategies = vi.fn();
const cloned = vi.fn();
vi.mock('@/api/strategy', () => ({
  getStrategies: (...a: unknown[]) => getStrategies(...a),
  saveStrategy: vi.fn(), setScheduler: vi.fn(), setStrategyEnabled: vi.fn(), deleteStrategy: vi.fn(),
  cloneStrategy: (...a: unknown[]) => cloned(...a),
}));

/** One strategy on the screen, with whatever config a test needs. */
const status = (config: Partial<StrategyStatus['strategies'][number]['config']> = {}): StrategyStatus => ({
  today: '2026-09-22', schedulerOn: true, runnerInstalled: true, mode: 'live', balanceUsd: 228, spot: 77_000,
  strategies: [{
    id: 's', name: 'UG-CE', enabled: false, createdAt: 0, updatedAt: 0, lastRunDate: null, ranToday: false,
    nextEntryAt: null, status: 'off', config: { ...DEFAULT_CONFIG, ...config },
  }],
  runs: [],
});

describe('the strategy row, the one line a strategy is checked by', () => {
  it('[critical] names the rule that picks the strike, not always the premium one', async () => {
    /*
     * A strategy selling at the open-interest wall described itself as
     * "at least $15" on the list -- the premium rule, read out loud whatever
     * `strikeRule` said.
     */
    getStrategies.mockResolvedValue(status({ strikeRule: 'oiWall' }));
    render(<StrategyPanel />);
    expect(await screen.findByText(/at the open-interest wall/)).toBeInTheDocument();
    expect(screen.queryByText(/at least \$15/)).toBeNull();
  });

  it('a premium strategy still reads as its premium rule', async () => {
    getStrategies.mockResolvedValue(status({ strikeRule: 'premium' }));
    render(<StrategyPanel />);
    expect(await screen.findByText(/at least \$15/)).toBeInTheDocument();
  });

  it('[critical] says the exits in their own mode, with the timetable', async () => {
    getStrategies.mockResolvedValue(status({
      takeProfitPct: 0.8,
      targetSteps: [{ at: '07:30', value: 0.85 }, { at: '09:30', value: 0.9 }],
      stopMode: 'points', stopLossPoints: 70,
    }));
    render(<StrategyPanel />);
    expect(await screen.findByText(/target 80% → 85% → 90% · stop 70 pts/)).toBeInTheDocument();
  });

  it('[critical] the retired extras are not mentioned', async () => {
    getStrategies.mockResolvedValue(status());
    render(<StrategyPanel />);
    await screen.findByText(/at least \$15/);
    expect(screen.queryByText(/double if one side|add to other leg|min safety/)).toBeNull();
    expect(screen.queryByText(/Adds to the other leg/)).toBeNull();
  });
});

describe('two strategies on one strike', () => {
  it('[critical] warns above the list when two would sell the same leg at the same minute', async () => {
    const one = status({ legs: 'PE', lots: 100 });
    getStrategies.mockResolvedValue({
      ...one,
      strategies: [
        { ...one.strategies[0]!, id: 'ug-ce', name: 'UG-CE' },
        { ...one.strategies[0]!, id: 'ug-pe', name: 'UG-PE' },
      ],
    });
    render(<StrategyPanel />);
    expect(await screen.findByRole('alert')).toHaveTextContent('UG-CE and UG-PE both sell PE at 5:30 AM');
  });
});

describe('the entry countdown on the list', () => {
  it('[critical] an enabled strategy counts down to its entry; a disabled one does not', async () => {
    const one = status({ entryTime: '22:35' });
    const soon = Date.now() + 10 * 60_000;
    getStrategies.mockResolvedValue({
      ...one,
      strategies: [
        { ...one.strategies[0]!, id: 'on', name: 'ON', enabled: true, nextEntryAt: soon },
        { ...one.strategies[0]!, id: 'off', name: 'OFF', enabled: false, nextEntryAt: soon },
      ],
    });
    render(<StrategyPanel />);
    expect(await screen.findAllByRole('timer')).toHaveLength(1);
    expect(screen.getByRole('timer')).toHaveTextContent(/^Entry in (9m|10m) \d\ds/);
  });
});

describe('copying a strategy', () => {
  it('[critical] copies the settings and opens the copy, which is never armed', async () => {
    /*
     * The way a second rule is actually made: take the one that works, change
     * a field. Building it by hand from the first is how a field gets missed
     * -- and a copy that stayed armed would double the scheduler's position at
     * the moment nobody is expecting it.
     */
    getStrategies.mockResolvedValue(status());
    cloned.mockResolvedValue({
      ok: true,
      strategy: { id: 's-copy', name: 'UG-CE copy', enabled: false, createdAt: 0, updatedAt: 0,
        lastRunDate: null, ranToday: false, nextEntryAt: null, status: 'off', config: DEFAULT_CONFIG },
    });
    render(<StrategyPanel />);
    fireEvent.click(await screen.findByRole('button', { name: 'Copy UG-CE' }));

    await waitFor(() => expect(cloned).toHaveBeenCalledWith('s'));
    // the form opens on the copy, because nobody clones a rule to keep it identical
    expect(await screen.findByDisplayValue('UG-CE copy')).toBeInTheDocument();
  });
});

describe('the scheduler switch says what it stops', () => {
  it('[critical] off, it warns that the exit times are off too, and that the target and stop still work', async () => {
    // "Auto-trading off" reads as "nothing new", not as "nothing closed at its exit time".
    getStrategies.mockResolvedValue({ ...status(), schedulerOn: false });
    render(<StrategyPanel />);
    const note = await screen.findByRole('note');
    expect(note).toHaveTextContent(/Exit times are off too/);
    expect(note).toHaveTextContent(/target and stop at Delta still work/);
  });

  it('on, it says turning it off stops the exit times too', async () => {
    getStrategies.mockResolvedValue(status());
    render(<StrategyPanel />);
    expect(await screen.findByText(/Turning it off stops the exit times too/)).toBeInTheDocument();
    expect(screen.queryByRole('note')).toBeNull();
  });

  it('not installed, it promises nothing about exits either', async () => {
    getStrategies.mockResolvedValue({ ...status(), runnerInstalled: false });
    render(<StrategyPanel />);
    await screen.findByText(/Not installed on this server/);
    expect(screen.queryByText(/exit times/)).toBeNull();
  });
});

describe('a signal strategy on the list', () => {
  const sig = { trigger: 'signal' as const, signal: { mode: 'mtf' as const, tf: '5m' as const, methods: ['breakout', 'bos'], target: 'tp1' as const, maxOpen: 2 }, lots: 1 };

  it('[critical] says it enters on signals, BUY → PE and SELL → CE, its perp exits -- and that live orders are off', async () => {
    getStrategies.mockResolvedValue(status({ ...sig, liveOrders: false }));
    render(<StrategyPanel />);
    expect(await screen.findByText(/on signal: 2 methods with the chain, BUY → PE · SELL → CE · .* · perp SL \/ TGT1 from the signal · max 2 open/)).toBeInTheDocument();
    expect(screen.getByText('paper: writes down')).toBeInTheDocument();
  });

  it('[critical] live orders on is said in red, on the row', async () => {
    getStrategies.mockResolvedValue(status({ ...sig, liveOrders: true }));
    render(<StrategyPanel />);
    expect(await screen.findByText('LIVE ORDERS')).toBeInTheDocument();
  });

  it('[critical] each signal it saw, and what it did with it', async () => {
    getStrategies.mockResolvedValue({
      ...status({ ...sig }),
      signalRuns: [
        { id: 2, strategyId: 's', signalKey: 'k2', method: 'bos', mode: 'mtf', tf: '5m', dir: -1, status: 'skipped', detail: 'already 2 of its trades open (at most 2)', tradeId: null, at: Date.now() },
        { id: 1, strategyId: 's', signalKey: 'k1', method: 'breakout', mode: 'mtf', tf: '5m', dir: 1, status: 'would-place', detail: '#1 Breakout BUY | live orders off: would sell PE 84000 x1 @ 18 · perp SL 84600 · TGT 85500', tradeId: null, at: Date.now() },
      ],
    });
    render(<StrategyPanel />);
    const table = await screen.findByRole('table', { name: 'signals taken' });
    expect(table).toHaveTextContent(/SELL → CE · chain/);
    expect(table).toHaveTextContent(/skipped/);
    expect(table).toHaveTextContent(/would sell/);
    expect(table).toHaveTextContent(/perp SL 84600 · TGT 85500/);
  });
});

describe('what "on" means with a signal strategy', () => {
  it('[critical] one with live orders off is not counted as placing orders', async () => {
    getStrategies.mockResolvedValue(status({ trigger: 'signal', liveOrders: false, signal: { mode: 'mtf', tf: '5m', methods: ['breakout'], target: 'tp1', maxOpen: 1 } }));
    const st = await getStrategies();
    st.strategies[0].enabled = true;
    getStrategies.mockResolvedValue(st);
    render(<StrategyPanel />);
    expect(await screen.findByText('On — 0 strategies will place orders automatically; 1 signal strategy writes down what it would sell.')).toBeInTheDocument();
    expect(screen.getByText(/a signal strategy, once per signal/)).toBeInTheDocument();
  });
});

describe('Edit opens the form the strategy is', () => {
  it('[critical] a signal strategy opens on the signal form; a clock one on the clock form', async () => {
    getStrategies.mockResolvedValue({
      ...status(),
      strategies: [
        { ...status().strategies[0]!, id: 'sig', name: 'SIG', config: { ...DEFAULT_CONFIG, trigger: 'signal', signal: { mode: 'mtf', tf: '5m', methods: ['breakout'], target: 'tp1', maxOpen: 1 } } },
        { ...status().strategies[0]!, id: 'clk', name: 'CLK' },
      ],
    });
    render(<StrategyPanel />);
    await screen.findByText('SIG');
    fireEvent.click(screen.getAllByRole('button', { name: /Edit/ })[0]!);
    expect(await screen.findByRole('dialog', { name: 'Edit SIG' })).toBeInTheDocument();
    expect(screen.getAllByRole('tab').map((t) => t.textContent?.replace('has a problem', ''))).toEqual(['Signals', 'Strike & lots', 'Entry & exit', 'When']);
  });
});
