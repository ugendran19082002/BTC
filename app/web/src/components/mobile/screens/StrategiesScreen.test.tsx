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
const ONE = { today: '2026-10-10', schedulerOn: true, runs: [], signalRuns: [], strategies: [{ id: 's1', name: '30m time', enabled: true, config: { trigger: 'signal' }, status: 'taking signals' }] };
let activity: Record<string, unknown> = ONE;
vi.mock('@/api/phone', () => ({
  getActivity: () => Promise.resolve(activity),
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

beforeEach(() => { window.localStorage.clear(); getDaySignals.mockReset(); id = 0; activity = ONE; });

describe('StrategiesScreen: the day\'s signals in three tabs', () => {
  it('[critical] All, Taken and Not taken, each with its count; a tap shows only those, with the real orders and the reasons said', async () => {
    getDaySignals.mockResolvedValue({ trades: [sig('placed', { reasons: [] }), sig('would-place'), sig('would-place'), sig('skipped', { reasons: ['sl-min', 'tgt-min'] }), sig('skipped', { reasons: ['sl-min'] }), sig('refused', { reasons: ['premium'] }), sig('failed')] });
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
    expect(tabs().getByRole('button', { name: 'Not taken 4' })).toHaveAttribute('aria-pressed', 'true');
    // Not taken, by why (20 Oct 2026): each kind with its count, most first; a signal with two under both; one with none read is Other.
    const why = () => within(screen.getByRole('group', { name: 'Not taken, why' }));
    expect(why().getAllByRole('button').map((b) => b.textContent)).toEqual(['Any reason 4', 'Perp SL under min 2', 'Perp TGT under min 1', 'Premium too low 1', 'Other 1']);
    expect(screen.getByText(/A signal with two reasons is under both/)).toBeInTheDocument();
    fireEvent.click(why().getByRole('button', { name: 'Perp SL under min 2' }));
    expect(rows()).toHaveLength(2);
    expect(screen.getByText(/2 not taken for: Perp SL under min\./)).toBeInTheDocument();
    fireEvent.click(why().getByRole('button', { name: 'Perp TGT under min 1' }));
    expect(rows()).toHaveLength(1);
    // kept on the phone
    expect(window.localStorage.getItem(Object.keys(window.localStorage).find((k) => k.endsWith('m-strategies-why'))!)).toBe('"tgt-min"');
    fireEvent.click(why().getByRole('button', { name: 'Any reason 4' }));
    expect(rows()).toHaveLength(4);
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

describe('StrategiesScreen: each strategy, by group', () => {
  it('[critical] listed under its group, with how many are on and whose account; those in none last', async () => {
    getDaySignals.mockResolvedValue({ trades: [] });
    const s = (id: string, groupId: string | null, enabled: boolean) => ({ id, name: id.toUpperCase(), enabled, groupId, config: { trigger: 'signal' }, status: 'taking signals' });
    activity = { ...ONE, strategies: [s('a', 'group-1', true), s('b', 'group-1', false), s('c', null, false)],
      groups: [{ id: 'group-1', name: 'Main desk', accountId: 1, accountName: 'Acct 1', createdAt: 0, updatedAt: 0 }] };
    show();
    const main = await screen.findByRole('region', { name: 'group Main desk' });
    expect(within(main).getByText('A')).toBeInTheDocument();
    expect(within(main).getByText('B')).toBeInTheDocument();
    expect(within(main).getByText('1 of 2 on')).toBeInTheDocument();
    expect(within(main).getByText('Acct 1')).toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: 'not in a group' })).getByText('C')).toBeInTheDocument();
  });

  it('a server from before groups: the one list, no headings', async () => {
    getDaySignals.mockResolvedValue({ trades: [] });
    show();
    expect(await screen.findByText('30m time')).toBeInTheDocument();
    expect(screen.queryByText('Not in a group')).toBeNull();
  });
});

describe('StrategiesScreen: the limits on open trades, as bars', () => {
  const ACCOUNTS = [{ id: 1, name: 'Savings', active: true }, { id: 2, name: 'Expenses', active: true }, { id: 3, name: 'Old', active: false }];
  const at = (accountParam: number | null) => render(
    <PhoneContext.Provider value={{ now: NOW, accountParam, accounts: ACCOUNTS, openTrade: vi.fn(), go: vi.fn() } as unknown as PhoneData}>
      <StrategiesScreen />
    </PhoneContext.Provider>,
  );
  const LIMITS = { signalMaxOpen: 60, openNow: 56, signalSideMaxPct: { CE: 80, PE: 80 }, openBySide: { CE: 8, PE: 48 } };

  it('[critical] an account chosen: the cap and each side\'s own limit as bars with the count in words; a side at its limit says what follows', async () => {
    getDaySignals.mockResolvedValue({ trades: [] });
    activity = { ...ONE, ...LIMITS };
    at(1);
    const box = within(await screen.findByRole('region', { name: 'open limits' }));
    expect(box.getByRole('progressbar', { name: 'open trades, of at most open' })).toHaveAttribute('aria-valuenow', '56');
    expect(box.getByRole('progressbar', { name: 'open trades, of at most open' })).toHaveAttribute('aria-valuemax', '60');
    expect(box.getByRole('progressbar', { name: 'CE open, of its limit' })).toHaveAttribute('aria-valuemax', '48');
    expect(box.getByRole('progressbar', { name: 'PE open, of its limit' })).toHaveAttribute('aria-valuenow', '48');
    expect(box.getByText('56 of 60')).toBeInTheDocument();
    expect(box.getByText('8 of 48')).toBeInTheDocument();
    expect(box.getByText('48 of 48 · full')).toBeInTheDocument();
    expect(box.getAllByText('max 80%')).toHaveLength(2);
    expect(box.getByText(/PE at its limit: the next signal that way is skipped until one closes\./)).toBeInTheDocument();
  });

  it('[critical] "All accounts": one block for each account that is switched on, by name', async () => {
    getDaySignals.mockResolvedValue({ trades: [] });
    activity = { ...ONE, ...LIMITS, openBySide: { CE: 8, PE: 20 }, openNow: 28 };
    at(null);
    expect(await screen.findByRole('region', { name: 'open limits of Savings' })).toBeInTheDocument();
    const exp = within(screen.getByRole('region', { name: 'open limits of Expenses' }));
    expect(exp.getByRole('progressbar', { name: 'Expenses: PE open, of its limit' })).toHaveAttribute('aria-valuenow', '20');
    expect(screen.queryByRole('region', { name: 'open limits of Old' })).toBeNull();
    expect(screen.queryByText(/at its limit/)).toBeNull();
  });

  it('no limit set: said in words, no bars; a server from before the limits: no panel', async () => {
    getDaySignals.mockResolvedValue({ trades: [] });
    activity = { ...ONE, ...LIMITS, signalMaxOpen: 0 };
    const none = at(1);
    const box = within(await screen.findByRole('region', { name: 'open limits' }));
    expect(box.getByText(/No “at most open” limit is set, so neither side has one/)).toBeInTheDocument();
    expect(box.queryByRole('progressbar')).toBeNull();
    none.unmount();
    activity = { ...ONE, signalMaxOpen: 60 };
    at(1);
    expect(await screen.findByText('30m time')).toBeInTheDocument();
    expect(screen.queryByText('Open limits')).toBeNull();
  });
});
