import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { StrategyPanel } from '@/components/strategy/StrategyPanel';
import { DEFAULT_CONFIG, type StrategyStatus } from '@/types/strategy';

const getStrategies = vi.fn();
vi.mock('@/api/strategy', () => ({
  getStrategies: (...a: unknown[]) => getStrategies(...a),
  saveStrategy: vi.fn(), setScheduler: vi.fn(), setStrategyEnabled: vi.fn(), deleteStrategy: vi.fn(),
  getRebalanceSettings: () => Promise.resolve({
    defaults: {
      enabled: true, lotsPerStep: 30, steps: 3, upStartPct: 30, downStartPct: 20, incrementPct: 10,
      confirmTicks: 2, endTime: '13:30', lockDirection: true, maxLotsPerSide: 200, allowPartial: true, maxSpreadPct: 0.15,
    },
    limits: {
      maxSteps: 20, maxLotsPerStep: 10_000, maxUpPct: 500, maxDownPct: 99,
      maxIncrementPct: 500, maxConfirmTicks: 10, maxLotsPerSide: 100_000,
    },
    ceilings: {
      maxSteps: 100, maxLotsPerStep: 100_000, maxUpPct: 10_000, maxDownPct: 99,
      maxIncrementPct: 10_000, maxConfirmTicks: 60, maxLotsPerSide: 1_000_000,
    },
  }),
  setRebalanceSettings: vi.fn(),
}));

/** The journal of adds: what was added, and -- the one people check -- why something was not. */
const status = (adds: StrategyStatus['adds'], config: Partial<StrategyStatus['strategies'][number]['config']> = {}): StrategyStatus => ({
  today: '2026-09-11', schedulerOn: true, runnerInstalled: true, mode: 'live', balanceUsd: 228, spot: 77_000,
  strategies: [{
    id: 's', name: 'CE+PE add', enabled: true, createdAt: 0, updatedAt: 0, lastRunDate: '2026-09-11', ranToday: true,
    nextEntryAt: null, status: 'already ran today',
    config: { ...DEFAULT_CONFIG, addToOpposite: { minPriceUsd: 3, maxMultiple: 2, addUntil: '16:59' }, ...config },
  }],
  runs: [],
  adds,
});

const row = (over: Partial<NonNullable<StrategyStatus['adds']>[number]>) => ({
  id: 1, strategyId: 's', runDate: '2026-09-11', sourceTradeId: 'CE-1', sourceSide: 'CE' as const,
  symbol: 'P-BTC-74000-110926', contracts: 425, status: 'placed' as const,
  detail: 'CE target bought back 425 — adding 425 to the PE 74000 at bid 7.00+, target 0.70',
  addedToTradeId: 'PE-1', at: Date.UTC(2026, 8, 11, 3, 38), ...over,
});

describe('the add journal on the strategy screen', () => {
  it('lists every decision, with its reason, including the ones that added nothing', async () => {
    getStrategies.mockResolvedValue(status([
      row({ id: 2, status: 'skipped', contracts: 200, detail: 'CE target bought back 200 — PE bid 2.00 is below $3.00' }),
      row({ id: 1 }),
    ]));
    render(<StrategyPanel />);
    const list = within(await screen.findByLabelText('adds'));
    expect(list.getByText('not added')).toBeInTheDocument();
    expect(list.getByText('CE target bought back 200 — PE bid 2.00 is below $3.00')).toBeInTheDocument();
    expect(list.getByText('added')).toBeInTheDocument();
  });

  it('[critical] dates every add, not just the clock time', async () => {
    /*
     * "13:54" alone reads as today's. The journal keeps a week of them, so an
     * add from Friday and one from ten minutes ago were indistinguishable —
     * and the runs log next to it has carried its run date all along, which is
     * what made the missing one look like a formatting quirk rather than a
     * gap.
     */
    getStrategies.mockResolvedValue(status([row({ id: 1 })]));
    render(<StrategyPanel />);
    const list = within(await screen.findByLabelText('adds'));
    expect(list.getByText(/11 Sep/)).toBeInTheDocument();
    expect(list.getByText(/09:08/)).toBeInTheDocument();
  });

  it('summarises the setting on the strategy row with its own numbers', async () => {
    getStrategies.mockResolvedValue(status([]));
    render(<StrategyPanel />);
    expect(await screen.findByText(/add to other leg if bid ≥ \$3, under 2x/)).toBeInTheDocument();
    expect(screen.queryByLabelText('adds')).toBeNull();
  });

  it('[critical] the row names the rule that picks the strike, not always the premium one', async () => {
    /*
     * A strategy selling at the open-interest wall described itself as
     * "at least $15" on the list -- the premium rule, read out loud whatever
     * `strikeRule` said. The one line somebody checks a strategy by was
     * describing a rule it was not running.
     */
    getStrategies.mockResolvedValue(status([], { strikeRule: 'oiWall' }));
    render(<StrategyPanel />);
    expect(await screen.findByText(/at the open-interest wall/)).toBeInTheDocument();
    expect(screen.queryByText(/at least \$15/)).toBeNull();
  });

  it('a premium strategy still reads as its premium rule', async () => {
    getStrategies.mockResolvedValue(status([], { strikeRule: 'premium' }));
    render(<StrategyPanel />);
    expect(await screen.findByText(/at least \$15/)).toBeInTheDocument();
  });

  it('says doubling covers a refusal, not only a skipped leg', async () => {
    getStrategies.mockResolvedValue(status([], { doubleWhenOneSided: true }));
    render(<StrategyPanel />);
    expect(await screen.findByText(/double if one side is refused/)).toBeInTheDocument();
  });
});
