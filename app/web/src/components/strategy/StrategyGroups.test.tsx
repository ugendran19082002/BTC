import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { SignalStrategiesCard } from '@/components/strategy/SignalStrategiesCard';
import { DEFAULT_CONFIG, type Strategy, type StrategyGroup, type StrategyStatus } from '@/types/strategy';
import { setAccountScope } from '@/lib/account-scope';
import { defaultGroupFor, groupNameProblem, groupSections, moveTargets, onCount } from '@/lib/strategy-groups';

const getStrategies = vi.fn();
const saveStrategy = vi.fn();
const createGroup = vi.fn();
const renameGroup = vi.fn();
const setGroupEnabled = vi.fn();
const cloneGroup = vi.fn();
const deleteGroup = vi.fn();
const moveToGroup = vi.fn();
const getAccounts = vi.fn();
vi.mock('@/api/strategy', () => ({
  getStrategies: (...a: unknown[]) => getStrategies(...a),
  getSignalTrades: () => Promise.resolve({ from: null, to: null, trades: [] }),
  saveStrategy: (...a: unknown[]) => saveStrategy(...a),
  setStrategyEnabled: vi.fn(), cloneStrategy: vi.fn(), deleteStrategy: vi.fn(), setScheduler: vi.fn(), setSignalMaxOpen: vi.fn(),
  createGroup: (...a: unknown[]) => createGroup(...a),
  renameGroup: (...a: unknown[]) => renameGroup(...a),
  setGroupEnabled: (...a: unknown[]) => setGroupEnabled(...a),
  cloneGroup: (...a: unknown[]) => cloneGroup(...a),
  deleteGroup: (...a: unknown[]) => deleteGroup(...a),
  moveToGroup: (...a: unknown[]) => moveToGroup(...a),
}));
vi.mock('@/api/accounts', () => ({ getAccounts: (...a: unknown[]) => getAccounts(...a) }));
vi.mock('@/api/entry', () => ({
  getEntryMethods: () => Promise.resolve({ methods: [] }),
  getMethodReport: () => Promise.resolve({ tf: null, sections: [], singleByTf: {} }),
  getEntryBoard: () => Promise.resolve({ reads: [], ltp: null }),
}));

/**
 * Groups of strategies (owner, 10 Oct 2026: "account 1's in one group, account 2's in another; clone and update").
 * The card lists them by group; the group's actions are the server's (strategy-groups.test.ts there), sent as said.
 */

const SIG = { trigger: 'signal' as const, lots: 1, liveOrders: false,
  signal: { mode: 'single' as const, tf: '15m' as const, methods: ['breakout'], target: 'tp2' as const, maxOpen: 2 } };
const strat = (id: string, accountId: number, groupId: string | null, enabled = false, live = false): Strategy => ({
  id, name: id.toUpperCase(), enabled, accountId, groupId, createdAt: 0, updatedAt: 0, lastRunDate: null, ranToday: false,
  nextEntryAt: null, status: 'taking signals', config: { ...DEFAULT_CONFIG, ...SIG, liveOrders: live },
});
const grp = (id: string, name: string, accountId: number, accountName = `Acct ${accountId}`): StrategyGroup =>
  ({ id, name, accountId, accountName, createdAt: 0, updatedAt: 0 });
const MAIN = grp('group-1', 'Main desk', 1);
const SCALPS = grp('g-scalps', 'Scalps', 1);
const OTHER = grp('group-2', 'Low win%', 2, 'Low win%');
const status = (strategies: Strategy[], groups?: StrategyGroup[]): StrategyStatus => ({
  today: '2026-10-10', schedulerOn: true, runnerInstalled: true, mode: 'paper', balanceUsd: 228, spot: 85_000,
  strategies, runs: [], signalRuns: [], signalMaxOpen: 0, openNow: 0, ...(groups ? { groups } : {}),
});

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  setAccountScope(1);
});
afterEach(() => setAccountScope(null));

describe('the groups, worked out', () => {
  const all = [strat('a', 1, 'group-1', true), strat('b', 1, 'g-scalps'), strat('c', 1, null), strat('d', 1, 'gone'), strat('e', 2, 'group-2')];
  it('[critical] each group with its own strategies, an empty one too; those in none -- or in a group not listed -- last, never dropped', () => {
    const s = groupSections(all, [MAIN, SCALPS, grp('g-empty', 'Empty', 1), OTHER]);
    expect(s.map((x) => [x.group?.id ?? null, x.strategies.map((y) => y.id)])).toEqual([
      ['group-1', ['a']], ['g-scalps', ['b']], ['g-empty', []], ['group-2', ['e']], [null, ['c', 'd']],
    ]);
    expect(groupSections(all, [])).toEqual([{ group: null, strategies: all }]);
    expect(groupSections([all[0]!], [MAIN])).toHaveLength(1);
  });
  it('a strategy moves only among its own account\'s groups; one made goes in the account\'s first', () => {
    expect(moveTargets(all[0]!, [MAIN, SCALPS, OTHER]).map((g) => g.id)).toEqual(['g-scalps']);
    expect(moveTargets(all[2]!, [MAIN, SCALPS, OTHER]).map((g) => g.id)).toEqual(['group-1', 'g-scalps']);
    expect(defaultGroupFor(2, [MAIN, SCALPS, OTHER])?.id).toBe('group-2');
    expect(defaultGroupFor(null, [MAIN])).toBeNull();
    expect(defaultGroupFor(3, [MAIN])).toBeNull();
    expect(onCount(all)).toEqual({ on: 1, of: 5 });
    expect(groupNameProblem(' ')).toBe('Give the group a name.');
    expect(groupNameProblem('x'.repeat(41))).toBe('A group name is at most 40 characters.');
  });
});

describe('the card, by group', () => {
  it('[critical] lists each group with its strategies and how many are on, then those in none; the cards inside as they were', async () => {
    getStrategies.mockResolvedValue(status([strat('a', 1, 'group-1', true), strat('b', 1, 'group-1'), strat('c', 1, null)], [MAIN, SCALPS]));
    render(<SignalStrategiesCard />);
    const main = await screen.findByRole('region', { name: 'group Main desk' });
    expect(within(main).getByText('A')).toBeInTheDocument();
    expect(within(main).getByText('B')).toBeInTheDocument();
    expect(within(main).getByLabelText('switched on in Main desk')).toHaveTextContent('1 of 2 on');
    expect(within(main).getByRole('switch', { name: 'Live orders for A' })).toBeInTheDocument();
    const scalps = screen.getByRole('region', { name: 'group Scalps' });
    expect(within(scalps).getByLabelText('switched on in Scalps')).toHaveTextContent('empty');
    expect(within(scalps).getByText(/No strategy in this group yet/)).toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: 'not in a group' })).getByText('C')).toBeInTheDocument();
    // An account's own tab: whose group it is goes unsaid.
    expect(within(main).queryByText('Acct 1')).toBeNull();
  });

  it('[critical] a folded group keeps its heading and its expand button; expanded again, its strategies are back', async () => {
    // The fold rule (styles.css) hides every child of a folded section but its `.fold-head`: the heading is that child,
    // or the whole group -- expand button and all -- folds away with no way back (owner, 10 Oct 2026: "no expand option").
    getStrategies.mockResolvedValue(status([strat('a', 1, 'group-1')], [MAIN]));
    render(<SignalStrategiesCard />);
    const main = await screen.findByRole('region', { name: 'group Main desk' });
    const fold = within(main).getByRole('button', { name: /^(Collapse|Expand) group Main desk$/ });
    expect(fold.closest('.fold-head')?.parentElement).toBe(main);
    fireEvent.click(fold);
    expect(main).toHaveAttribute('data-folded', 'true');
    expect(fold).toHaveAttribute('aria-expanded', 'false');
    expect(within(main).queryByText('A')).toBeNull();
    expect(within(main).getByText('Main desk')).toBeInTheDocument();
    expect([...main.children].filter((c) => !c.classList.contains('fold-head') && !c.classList.contains('fold-keep'))
      .every((c) => !c.contains(fold))).toBe(true);
    fireEvent.click(fold);
    expect(fold).toHaveAttribute('aria-expanded', 'true');
    expect(within(main).getByText('A')).toBeInTheDocument();
  });

  it('a server from before groups: the one list it always was', async () => {
    getStrategies.mockResolvedValue(status([strat('a', 1, null)]));
    render(<SignalStrategiesCard />);
    expect(await screen.findByText('A')).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: /group/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /New group/ })).toBeNull();
  });

  it('[critical] all on is two taps, saying how many and how many with live orders; what was left off is named', async () => {
    getStrategies.mockResolvedValue(status([strat('a', 1, 'group-1'), strat('b', 1, 'group-1', false, true), strat('c', 1, 'group-1', true)], [MAIN]));
    setGroupEnabled.mockResolvedValue({ ok: true, group: MAIN, changed: ['a'], leftOff: [{ id: 'b', name: 'B', problems: ['Lots must be a whole number, at least 1.'] }] });
    render(<SignalStrategiesCard />);
    const on = await screen.findByRole('button', { name: 'Turn all on in Main desk' });
    fireEvent.click(on);
    expect(on).toHaveTextContent('Tap again: 2 on, 1 with live orders');
    expect(setGroupEnabled).not.toHaveBeenCalled();
    fireEvent.click(on);
    await waitFor(() => expect(setGroupEnabled).toHaveBeenCalledWith('group-1', true));
    expect(await screen.findByText(/1 turned on\. Left off, its settings do not pass: B — Lots must be a whole number/)).toBeInTheDocument();
    // Off is one tap: the safe way.
    fireEvent.click(screen.getByRole('button', { name: 'Turn all off in Main desk' }));
    await waitFor(() => expect(setGroupEnabled).toHaveBeenCalledWith('group-1', false));
  });

  it('[critical] cloned to the other account: the account picked, every copy said to be off', async () => {
    getStrategies.mockResolvedValue(status([strat('a', 1, 'group-1')], [MAIN]));
    getAccounts.mockResolvedValue({ accounts: [{ id: 1, name: 'Acct 1', readable: true }, { id: 2, name: 'Low win%', readable: true }] });
    cloneGroup.mockResolvedValue({ ok: true, group: { ...MAIN, id: 'g-x', accountId: 2, accountName: 'Low win%' }, strategies: [strat('a2', 2, 'g-x')] });
    render(<SignalStrategiesCard />);
    fireEvent.click(await screen.findByRole('button', { name: 'Clone Main desk' }));
    const panel = screen.getByRole('group', { name: 'clone Main desk' });
    expect(within(panel).getByText(/switched off with live orders off, named with " copy"/)).toBeInTheDocument();
    await waitFor(() => expect(within(panel).getByRole('option', { name: 'Low win%' })).toBeInTheDocument());
    fireEvent.change(within(panel).getByLabelText('Clone to account'), { target: { value: '2' } });
    expect(within(panel).getByText(/names kept/)).toBeInTheDocument();
    fireEvent.click(within(panel).getByRole('button', { name: /Clone 1 strategy/ }));
    await waitFor(() => expect(cloneGroup).toHaveBeenCalledWith('group-1', { accountId: 2 }));
    expect(await screen.findByText('Cloned as "Main desk" on Low win%: 1 strategy, all switched off, live orders off.')).toBeInTheDocument();
  });

  it('[critical] a group made, renamed, removed (two taps, its strategies stay); a strategy moved among its account\'s groups only', async () => {
    getStrategies.mockResolvedValue(status([strat('a', 1, 'group-1')], [MAIN, SCALPS, OTHER]));
    createGroup.mockResolvedValue({ ok: true, group: grp('g-new', 'New one', 1) });
    renameGroup.mockResolvedValue({ ok: true, group: MAIN });
    deleteGroup.mockResolvedValue({ ok: true, ungrouped: 1 });
    moveToGroup.mockResolvedValue({ ok: true });
    render(<SignalStrategiesCard />);
    fireEvent.click(await screen.findByRole('button', { name: /New group/ }));
    fireEvent.change(screen.getByLabelText('Name of the new group'), { target: { value: '  New one ' } });
    fireEvent.click(screen.getByRole('button', { name: /Make group/ }));
    await waitFor(() => expect(createGroup).toHaveBeenCalledWith('New one', 1));

    fireEvent.click(screen.getByRole('button', { name: 'Rename Main desk' }));
    fireEvent.change(screen.getByLabelText('New name for Main desk'), { target: { value: 'Main' } });
    fireEvent.keyDown(screen.getByLabelText('New name for Main desk'), { key: 'Enter' });
    await waitFor(() => expect(renameGroup).toHaveBeenCalledWith('group-1', 'Main'));

    const del = screen.getByRole('button', { name: 'Delete group Main desk' });
    fireEvent.click(del);
    expect(del).toHaveTextContent('Tap again — its 1 stay');
    expect(deleteGroup).not.toHaveBeenCalled();
    fireEvent.click(del);
    await waitFor(() => expect(deleteGroup).toHaveBeenCalledWith('group-1'));

    const pick = screen.getByLabelText('Group of A');
    expect(within(pick).getAllByRole('option').map((o) => o.textContent)).toEqual(['Main desk', 'Scalps', 'No group']);
    fireEvent.change(pick, { target: { value: 'g-scalps' } });
    await waitFor(() => expect(moveToGroup).toHaveBeenCalledWith('a', 'g-scalps'));
  });

  it('on "All accounts": whose each group is, and nothing made there', async () => {
    setAccountScope(null, true);
    getStrategies.mockResolvedValue(status([strat('a', 1, 'group-1'), strat('e', 2, 'group-2')], [MAIN, OTHER]));
    render(<SignalStrategiesCard />);
    const other = await screen.findByRole('region', { name: 'group Low win%' });
    expect(within(other).getByText('Low win%', { selector: 'span' })).toBeInTheDocument();
    expect(within(other).getByRole('button', { name: /New strategy in Low win%/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: /New group/ })).toBeDisabled();
  });
});
