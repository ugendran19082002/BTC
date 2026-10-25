import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { MethodUpdate } from '@/types/strategy';

const getMethodUpdates = vi.fn();
const getMethodPicks = vi.fn();
const runMethodPicks = vi.fn();
vi.mock('@/api/strategy', () => ({
  getMethodUpdates: (...a: unknown[]) => getMethodUpdates(...a),
  getMethodPicks: (...a: unknown[]) => getMethodPicks(...a),
  runMethodPicks: (...a: unknown[]) => runMethodPicks(...a),
}));
vi.mock('@/api/entry', () => ({
  getEntryMethods: async () => ({ methods: [{ id: 'breakout', n: 1, name: 'Breakout' }, { id: 'bos', n: 6, name: 'BOS' }, { id: 'trap', n: 9, name: 'Trap' }] }),
}));
vi.mock('@/api/accounts', () => ({ getAccounts: async () => ({ accounts: [{ id: 1, name: 'Savings' }, { id: 2, name: 'Expenses' }] }) }));

const { MethodUpdatesLog, rangeKeyOf, rangeOf, ruleWords, sortMethods, stepRange, summarize } = await import('@/components/strategy/MethodUpdatesLog');

const NOW = Date.parse('2026-10-16T22:00:00+05:30');
const AT = Date.parse('2026-10-16T21:00:00+05:30');
const u = (o: Partial<MethodUpdate>): MethodUpdate => ({
  id: 1, at: AT, strategyId: '15m', strategyName: '15m time', accountId: 1, source: 'daily', tf: '15m', rule: { winPct: 75, minTrades: 3, days: 7 },
  from: '2026-10-10', to: '2026-10-16', before: ['breakout', 'bos'], after: ['breakout', 'trap'], added: ['trap'], dropped: ['bos'],
  records: [{ method: 'trap', trades: 5, wins: 4, net: 0.3 }, { method: 'bos', trades: 6, wins: 2, net: -0.2 }, { method: 'breakout', trades: 4, wins: 3, net: 0.1 }],
  note: null, ...o,
});
const THREE = [
  u({}),
  u({ id: 2, at: AT - 3_600_000, strategyId: '1h', strategyName: '1h time', accountId: 2, source: 'manual', tf: '1h', rule: null, from: null, to: null, before: ['bos'], after: ['bos', 'breakout'], added: ['breakout'], dropped: [], records: [] }),
  u({ id: 3, at: AT - 86_400_000, strategyId: '3m', strategyName: '3m time', tf: '3m', before: ['trap'], after: ['trap'], added: [], dropped: [], records: [], note: 'No method won 75% of 3 trades or more: the list was kept.' }),
];

beforeEach(() => {
  window.localStorage.clear(); getMethodUpdates.mockReset(); runMethodPicks.mockReset();
  getMethodPicks.mockReset().mockResolvedValue({ last: null, strategies: 3 });
});

describe('the method updates log (16 Oct 2026)', () => {
  it('[critical] the dates: today, yesterday, the last 7 days, this month, or two picked -- IST, both ends included', () => {
    const c = { from: '2026-10-12', to: '2026-10-03' };
    expect(rangeOf('today', NOW, c)).toEqual({ from: '2026-10-16', to: '2026-10-16' });
    expect(rangeOf('yesterday', NOW, c)).toEqual({ from: '2026-10-15', to: '2026-10-15' });
    expect(rangeOf('7d', NOW, c)).toEqual({ from: '2026-10-10', to: '2026-10-16' });
    expect(rangeOf('month', NOW, c)).toEqual({ from: '2026-10-01', to: '2026-10-16' });
    expect(rangeOf('custom', NOW, c)).toEqual({ from: '2026-10-03', to: '2026-10-12' }); // the wrong way round, put right
    // 1 AM IST on the 17th is the 17th, though it is still the 16th in UTC
    expect(rangeOf('today', Date.parse('2026-10-17T01:00:00+05:30'), c)).toEqual({ from: '2026-10-17', to: '2026-10-17' });
  });

  it('[critical] the summary: changes and kept days, methods in and out by day, each method\'s comings and goings and where it is now', () => {
    const s = summarize(THREE, { from: '2026-10-14', to: '2026-10-16' });
    expect([s.changes, s.kept, s.daily, s.manual, s.strategies, s.in, s.out]).toEqual([2, 1, 2, 1, 2, 2, 1]);
    expect(s.days).toEqual([{ day: '2026-10-14', in: 0, out: 0 }, { day: '2026-10-15', in: 0, out: 0 }, { day: '2026-10-16', in: 2, out: 1 }]);
    const m = new Map(s.methods.map((x) => [x.method, x]));
    expect([m.get('trap')!.in, m.get('trap')!.out, m.get('trap')!.nowIn]).toEqual([1, 0, 2]);           // in 15m's list, and 3m kept it
    expect([m.get('bos')!.out, m.get('bos')!.nowIn]).toEqual([1, 1]);                                 // out of 15m, still in 1h's
    expect([m.get('breakout')!.in, m.get('breakout')!.nowIn]).toEqual([1, 2]);
    expect(m.get('trap')!.record).toEqual({ method: 'trap', trades: 5, wins: 4, net: 0.3 });
    expect(sortMethods(s.methods, 'out')[0]!.method).toBe('bos');
    expect(sortMethods(s.methods, 'win')[0]!.method).toBe('trap');
    expect(s.byStrategy.map((x) => [x.name, x.changes, x.first, x.now])).toEqual([['15m time', 1, 2, 2], ['1h time', 1, 1, 2], ['3m time', 0, 1, 1]]);
  });

  it('[critical] the screen: last 7 days to begin with, the totals, a bar a day, the methods table -- a method a tap from its changes', async () => {
    getMethodUpdates.mockResolvedValue({ updates: THREE });
    render(<MethodUpdatesLog now={NOW} />);
    await waitFor(() => expect(getMethodUpdates).toHaveBeenCalledWith({ source: null, from: '2026-10-10', to: '2026-10-16', limit: 1_000 }));
    fireEvent.click(await screen.findByRole('tab', { name: 'Summary' }));
    const totals = await screen.findByLabelText('Totals');
    expect(totals).toHaveTextContent('Changes2');
    expect(totals).toHaveTextContent('2 daily · 1 by hand · 1 kept');
    expect(totals).toHaveTextContent('Methods in+2');
    expect(screen.getByRole('img')).toHaveAttribute('aria-label', expect.stringContaining('Fri 16 Oct: 2 in, 1 out'));
    const table = screen.getByRole('table', { name: 'Methods in and out' });
    expect(within(table).getAllByRole('row')).toHaveLength(4);
    expect(within(screen.getByRole('table', { name: 'Strategies changed' })).getByText('Expenses')).toBeInTheDocument();
    // a method tapped: the timeline, only its changes
    fireEvent.click(within(table).getByRole('button', { name: '#6 BOS' }));
    expect(screen.getByRole('tab', { name: 'Timeline' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('status')).toHaveTextContent('The changes of #6 BOS: 1 change.');
    const day = screen.getByRole('list', { name: 'Changes on Fri 16 Oct' });
    expect(within(day).getAllByRole('listitem').filter((li) => li.getAttribute('aria-label'))).toHaveLength(1);
    // another range: asked of the server
    fireEvent.click(within(screen.getByRole('group', { name: 'Dates' })).getByRole('button', { name: 'Yesterday' }));
    await waitFor(() => expect(getMethodUpdates).toHaveBeenLastCalledWith({ source: null, from: '2026-10-15', to: '2026-10-15', limit: 1_000 }));
    // back a day at a time from a day (25 Oct 2026: the calendar's arrows) -- a stepped range is Custom's from then on
    fireEvent.click(screen.getByRole('button', { name: 'Earlier' }));
    await waitFor(() => expect(getMethodUpdates).toHaveBeenLastCalledWith(expect.objectContaining({ from: '2026-10-14', to: '2026-10-14' })));
    expect(within(screen.getByRole('group', { name: 'Dates' })).getByRole('button', { name: 'Custom' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Later' }));
    await waitFor(() => expect(getMethodUpdates).toHaveBeenLastCalledWith(expect.objectContaining({ from: '2026-10-15', to: '2026-10-15' })));
    expect(within(screen.getByRole('group', { name: 'Dates' })).getByRole('button', { name: 'Yesterday' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('[critical] the timeline: each change by day, daily or by hand, before → after, the rule, a kept day with why -- its methods and records on a tap', async () => {
    getMethodUpdates.mockResolvedValue({ updates: THREE });
    render(<MethodUpdatesLog now={NOW} />);
    fireEvent.click(await screen.findByRole('tab', { name: 'Timeline' }));
    const today = await screen.findByRole('list', { name: 'Changes on Fri 16 Oct' });
    const [daily, manual] = within(today).getAllByRole('listitem').filter((li) => li.getAttribute('aria-label')) as [HTMLElement, HTMLElement];
    expect(daily).toHaveTextContent('9:00 pm15m timeSavingsDaily update');
    expect(daily).toHaveTextContent('2 → 2 methods · +1 new · −1 dropped');
    expect(daily).toHaveTextContent('Win ≥75% · 3+ trades · Sat 10 Oct – Fri 16 Oct');
    expect(manual).toHaveTextContent('1h timeExpensesSaved by hand');
    const before = screen.getByRole('list', { name: 'Changes on Thu 15 Oct' });
    expect(before).toHaveTextContent('Kept the 1 method');
    expect(before).toHaveTextContent('the list was kept');
    fireEvent.click(within(daily).getByRole('button', { name: 'Show the methods' }));
    expect(within(daily).getByRole('list', { name: 'New methods' })).toHaveTextContent(/#9 Trap4\/5 won \(80%\) · \+₹/);
    expect(within(daily).getByRole('list', { name: 'Dropped methods' })).toHaveTextContent(/#6 BOS2\/6 won \(33%\) · −₹/);
    expect(within(daily).getByRole('list', { name: 'Kept methods' })).toHaveTextContent('#1 Breakout');
  });

  it('nothing in the dates says how to start; a failed read says why; the rule line reads one day as one', async () => {
    getMethodUpdates.mockResolvedValue({ updates: [] });
    const { unmount } = render(<MethodUpdatesLog now={NOW} />);
    expect(await screen.findByText(/No method changes from Sat 10 Oct – Fri 16 Oct/)).toHaveTextContent('Switch on Auto-update methods');
    unmount();
    getMethodUpdates.mockRejectedValue(new Error('offline'));
    render(<MethodUpdatesLog compact now={NOW} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('The log could not be read: offline');
    expect(ruleWords({ rule: { winPct: 80, minTrades: 5, days: 1 }, from: '2026-10-16', to: '2026-10-16' })).toBe('Win ≥80% · 5+ trades · Fri 16 Oct');
    expect(ruleWords({ rule: null, from: null, to: null })).toBeNull();
  });
});

describe('the method updates log, account by account (18 Oct 2026)', () => {
  it('[critical] all accounts to begin with; one chosen, every view and the strategy list are its own -- and it is remembered', async () => {
    getMethodUpdates.mockResolvedValue({ updates: THREE });
    const { unmount } = render(<MethodUpdatesLog now={NOW} />);
    const accounts = await screen.findByRole('group', { name: 'Account' });
    expect(within(accounts).getAllByRole('button').map((b) => [b.textContent, b.getAttribute('aria-pressed')])).toEqual([
      ['All accounts', 'true'], ['Savings 2', 'false'], ['Expenses 1', 'false'],
    ]);
    fireEvent.click(within(accounts).getByRole('button', { name: /^Expenses/ }));
    fireEvent.click(screen.getByRole('tab', { name: 'Timeline' }));
    expect(screen.queryByText('15m time')).toBeNull();
    expect(screen.getAllByText('1h time').length).toBeGreaterThan(0);
    // one strategy left in it: no strategy list to choose from
    expect(screen.queryByRole('combobox', { name: 'Strategy' })).toBeNull();
    unmount();
    render(<MethodUpdatesLog now={NOW} />);
    expect(within(await screen.findByRole('group', { name: 'Account' })).getByRole('button', { name: /^Expenses/ })).toHaveAttribute('aria-pressed', 'true');
  });

  it('one account only: no account row', async () => {
    getMethodUpdates.mockResolvedValue({ updates: [THREE[0]!, THREE[2]!] });
    render(<MethodUpdatesLog now={NOW} />);
    await screen.findByRole('tab', { name: 'Summary' });
    expect(screen.queryByRole('group', { name: 'Account' })).toBeNull();
  });
});

describe('the calendar and Pick now (25 Oct 2026)', () => {
  it('[critical] a range from the calendar is its quick pick when it is one; the arrows move it by its own length, never past today', () => {
    expect(rangeKeyOf({ from: '2026-10-16', to: '2026-10-16' }, NOW)).toBe('today');
    expect(rangeKeyOf({ from: '2026-10-10', to: '2026-10-16' }, NOW)).toBe('7d');
    expect(rangeKeyOf({ from: '2026-10-11', to: '2026-10-12' }, NOW)).toBe('custom');
    expect(stepRange({ from: '2026-10-16', to: '2026-10-16' }, -1, '2026-10-16')).toEqual({ from: '2026-10-15', to: '2026-10-15' });
    expect(stepRange({ from: '2026-10-01', to: '2026-10-07' }, 1, '2026-10-16')).toEqual({ from: '2026-10-08', to: '2026-10-14' });
    expect(stepRange({ from: '2026-10-08', to: '2026-10-14' }, 1, '2026-10-16')).toEqual({ from: '2026-10-10', to: '2026-10-16' });
  });

  it('[critical] Pick now asks first, starts, says it is running, and when done shows today\'s changes', async () => {
    getMethodUpdates.mockResolvedValue({ updates: THREE });
    const started = { running: true, at: NOW, strategies: 3, updated: 0, doneAt: null, error: null };
    runMethodPicks.mockResolvedValue(started);
    window.localStorage.setItem('btc-desk:method-log:range', JSON.stringify('yesterday'));
    render(<MethodUpdatesLog now={NOW} />);
    expect(await screen.findByText('3 strategies with the daily update on.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Pick now' }));
    const ask = screen.getByRole('alertdialog', { name: 'Pick the methods now' });
    expect(ask).toHaveTextContent('Pick the methods now for 3 strategies?');
    expect(runMethodPicks).not.toHaveBeenCalled();
    getMethodPicks.mockResolvedValue({ last: started, strategies: 3 });
    fireEvent.click(within(ask).getByRole('button', { name: 'Pick now for 3 strategies' }));
    await waitFor(() => expect(runMethodPicks).toHaveBeenCalledWith(null));
    expect(await screen.findByText(/Picking for 3 strategies since/)).toBeInTheDocument();
    getMethodPicks.mockResolvedValue({ last: { ...started, running: false, updated: 3, doneAt: NOW + 30_000 }, strategies: 3 });
    await waitFor(() => expect(screen.getByText(/Last picked now at .*: 3 strategies of 3 saved\./)).toBeInTheDocument(), { timeout: 4_000 });
    // written today, read on yesterday: moved to today
    await waitFor(() => expect(getMethodUpdates).toHaveBeenLastCalledWith(expect.objectContaining({ from: '2026-10-16', to: '2026-10-16' })));
  });

  it('a pick refused is said; one strategy chosen is picked alone; the phone has no button', async () => {
    getMethodUpdates.mockResolvedValue({ updates: THREE });
    runMethodPicks.mockRejectedValue(new Error('A pick is already running: its changes come into the log when it is done.'));
    const { unmount } = render(<MethodUpdatesLog now={NOW} />);
    fireEvent.change(await screen.findByRole('combobox', { name: 'Strategy' }), { target: { value: '15m' } });
    fireEvent.click(screen.getByRole('button', { name: 'Pick now' }));
    fireEvent.click(screen.getByRole('button', { name: 'Pick now for 15m time' }));
    await waitFor(() => expect(runMethodPicks).toHaveBeenCalledWith('15m'));
    expect(await screen.findByRole('alert')).toHaveTextContent('Not picked: A pick is already running');
    unmount();
    render(<MethodUpdatesLog compact now={NOW} />);
    await screen.findByRole('tab', { name: 'Summary' });
    expect(screen.queryByRole('button', { name: 'Pick now' })).toBeNull();
  });
});
