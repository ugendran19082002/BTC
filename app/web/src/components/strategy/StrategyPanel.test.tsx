import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { StrategyPanel } from '@/components/strategy/StrategyPanel';
import { DEFAULT_CONFIG, type StrategyStatus } from '@/types/strategy';

const getStrategies = vi.fn();
vi.mock('@/api/strategy', () => ({
  getStrategies: (...a: unknown[]) => getStrategies(...a),
  saveStrategy: vi.fn(), setScheduler: vi.fn(), setStrategyEnabled: vi.fn(), deleteStrategy: vi.fn(),
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
