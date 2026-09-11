import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { StrategyPanel } from '@/components/strategy/StrategyPanel';
import { DEFAULT_CONFIG, type StrategyStatus } from '@/types/strategy';

const getStrategies = vi.fn();
vi.mock('@/api/strategy', () => ({
  getStrategies: (...a: unknown[]) => getStrategies(...a),
  saveStrategy: vi.fn(), setScheduler: vi.fn(), setStrategyEnabled: vi.fn(), deleteStrategy: vi.fn(),
}));

/** The journal of adds: what was added, and -- the one people check -- why something was not. */
const status = (adds: StrategyStatus['adds']): StrategyStatus => ({
  today: '2026-09-11', schedulerOn: true, runnerInstalled: true, mode: 'live', balanceUsd: 228, spot: 77_000,
  strategies: [{
    id: 's', name: 'CE+PE add', enabled: true, createdAt: 0, updatedAt: 0, lastRunDate: '2026-09-11', ranToday: true,
    nextEntryAt: null, status: 'already ran today',
    config: { ...DEFAULT_CONFIG, addToOpposite: { minPriceUsd: 3, maxMultiple: 2 } },
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

  it('summarises the setting on the strategy row with its own numbers', async () => {
    getStrategies.mockResolvedValue(status([]));
    render(<StrategyPanel />);
    expect(await screen.findByText(/add to other leg if bid ≥ \$3, under 2x/)).toBeInTheDocument();
    expect(screen.queryByLabelText('adds')).toBeNull();
  });
});
