import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { PhoneContext, type PhoneData } from '@/components/mobile/phone-context';
import type { SignalTrade } from '@/types/strategy';

/**
 * Strategies on the phone (owner, 10 Oct 2026: "all count, taken count, not taken count, in tabs, user friendly"):
 * the day's signals in three tabs, each with its count -- over the whole IST day, not the latest sixty -- the
 * real orders and the reasons said, and a long list shown forty at a time rather than cut off.
 */
const getDaySignals = vi.fn();
vi.mock('@/api/phone', () => ({
  getActivity: () => Promise.resolve({ today: '2026-10-10', schedulerOn: true, runs: [], signalRuns: [], strategies: [{ id: 's1', name: '30m time', enabled: true, config: { trigger: 'signal' }, status: 'taking signals' }] }),
  getStats: () => Promise.resolve({ byMethod: [] }),
  methodNames: () => Promise.resolve(new Map([['breakout', { id: 'breakout', n: 1, name: 'Breakout' }]])),
  getDaySignals: (...a: unknown[]) => getDaySignals(...a),
}));
const { StrategiesScreen } = await import('@/components/mobile/screens/StrategiesScreen');

const NOW = Date.parse('2026-10-10T12:00:00+05:30');
let id = 0;
const sig = (status: SignalTrade['status'], over: Partial<SignalTrade> = {}): SignalTrade => ({
  id: ++id, strategyId: 's1', at: NOW - id * 60_000, method: 'breakout', mode: 'single', tf: '30m', dir: 1,
  status, detail: `${status} detail`, tradeId: status === 'placed' ? `t${id}` : null, levels: null, perp: null, option: null, ...over,
} as SignalTrade);
const show = () => render(
  <PhoneContext.Provider value={{ now: NOW, accountParam: null, openTrade: vi.fn(), go: vi.fn() } as unknown as PhoneData}>
    <StrategiesScreen />
  </PhoneContext.Provider>,
);
const tabs = () => within(screen.getByRole('group', { name: 'Which signals' }));
const rows = () => within(screen.getByRole('list', { name: 'Signals' })).getAllByRole('listitem');

beforeEach(() => { window.localStorage.clear(); getDaySignals.mockReset(); id = 0; });

describe('StrategiesScreen: the day\'s signals in three tabs', () => {
  it('[critical] All, Taken and Not taken, each with its count; a tap shows only those, with the real orders and the reasons said', async () => {
    getDaySignals.mockResolvedValue({ trades: [sig('placed'), sig('would-place'), sig('would-place'), sig('skipped'), sig('skipped'), sig('refused'), sig('failed')] });
    show();
    await waitFor(() => expect(tabs().getByRole('button', { name: 'All 7' })).toBeInTheDocument());
    expect(getDaySignals).toHaveBeenCalledWith('2026-10-10', null);
    expect(tabs().getByRole('button', { name: 'Taken 3' })).toBeInTheDocument();
    expect(tabs().getByRole('button', { name: 'Not taken 4' })).toBeInTheDocument();
    expect(rows()).toHaveLength(7);

    fireEvent.click(tabs().getByRole('button', { name: 'Taken 3' }));
    expect(rows()).toHaveLength(3);
    expect(screen.getByText('1 real order · 2 paper (live orders off)')).toBeInTheDocument();

    fireEvent.click(tabs().getByRole('button', { name: 'Not taken 4' }));
    expect(rows()).toHaveLength(4);
    expect(screen.getByText(/2 skipped · 1 refused · 1 failed/)).toBeInTheDocument();
    expect(tabs().getByRole('button', { name: 'Not taken 4' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('[critical] the tab is remembered on the phone; an empty one says so in words', async () => {
    getDaySignals.mockResolvedValue({ trades: [sig('placed')] });
    const { unmount } = show();
    await waitFor(() => expect(tabs().getByRole('button', { name: 'Not taken 0' })).toBeInTheDocument());
    fireEvent.click(tabs().getByRole('button', { name: 'Not taken 0' }));
    expect(screen.getByText('Every signal today was taken.')).toBeInTheDocument();
    unmount();
    show();
    await waitFor(() => expect(tabs().getByRole('button', { name: 'Not taken 0' })).toHaveAttribute('aria-pressed', 'true'));
  });

  it('a long day: forty at a time, the rest a tap away -- never cut off without a word', async () => {
    getDaySignals.mockResolvedValue({ trades: Array.from({ length: 95 }, () => sig('skipped')) });
    show();
    await waitFor(() => expect(tabs().getByRole('button', { name: 'All 95' })).toBeInTheDocument());
    expect(rows()).toHaveLength(40);
    fireEvent.click(screen.getByRole('button', { name: 'Show 40 more · 40 of 95' }));
    expect(rows()).toHaveLength(80);
    fireEvent.click(screen.getByRole('button', { name: 'Show 15 more · 80 of 95' }));
    expect(rows()).toHaveLength(95);
    expect(screen.queryByRole('button', { name: /Show \d+ more/ })).not.toBeInTheDocument();
  });
});
