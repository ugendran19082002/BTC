import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { PhoneContext, type PhoneData } from '@/components/mobile/phone-context';
import type { Stats, StatsGroup } from '@/api/phone';

/**
 * P&L's two filters (owner, 8 Oct 2026: "strategy select option, multiple select dropdown, mobile user friendly",
 * then "on the P&L screen both filters: the methods filter and the strategy filter"): tick strategies, or entry
 * methods, under the range and the closed trades' figures -- the numbers, the calendar, the pairs -- are asked for
 * again, for those alone.
 */

const getStats = vi.fn();
const getDaysFor = vi.fn();
vi.mock('@/api/phone', () => ({ getStats: (...a: unknown[]) => getStats(...a), getDaysFor: (...a: unknown[]) => getDaysFor(...a) }));
vi.mock('@/api/client', () => ({ json: vi.fn().mockResolvedValue({ day: '2026-10-06', samples: [], stats: { nowUsd: null, min: null, max: null, maxDrawdown: null }, days: [] }) }));

const { PnlScreen } = await import('@/components/mobile/screens/PnlScreen');

const group = (key: string, name: string, trades: number, wins: number, netUsd: number): StatsGroup => ({
  key, name, trades, wins, losses: trades - wins, winRate: trades ? wins / trades : null, grossProfitUsd: Math.max(0, netUsd), grossLossUsd: Math.max(0, -netUsd),
  profitFactor: null, avgWinUsd: null, avgLossUsd: null, netUsd, bestUsd: null, worstUsd: null,
});
const STRATEGIES = [{ key: 's15', name: '15m time', trades: 12, netUsd: 3.12 }, { key: 's1h', name: '1h time', trades: 4, netUsd: -3.68 }, { key: 'manual', name: 'By hand', trades: 1, netUsd: 0.14 }];
const METHODS = [{ key: 'pd', name: '#16 Previous day H/L rejection', trades: 8, netUsd: 2.4 }, { key: 'vwap', name: '#19 VWAP reclaim / loss', trades: 3, netUsd: -1.1 }];
type Filter = { strategies?: readonly string[]; methods?: readonly string[] };
/** What the server answers: every figure of what was asked for, and the whole lists to choose from. */
const statsFor = (f: Filter = {}): Stats => {
  const asked = f.strategies ?? []; const askedMethods = f.methods ?? [];
  const kept = asked.length ? STRATEGIES.filter((s) => asked.includes(s.key)) : STRATEGIES;
  // Sample arithmetic only: a method choice counts its own trades, a strategy choice the strategies'.
  const trades = askedMethods.length ? METHODS.filter((m) => askedMethods.includes(m.key)).reduce((n, m) => n + m.trades, 0) : kept.reduce((n, s) => n + s.trades, 0);
  return {
    mode: 'paper', from: '2026-10-06', to: '2026-10-06', overall: group('all', 'all', trades, trades - 1, kept.reduce((n, s) => n + s.netUsd, 0)),
    strategies: STRATEGIES, methods: METHODS, byStrategy: [], byAccount: [], byOption: [], byAction: [],
    byPair: [{ ...group(`m|single|15m|${asked.join('+')}|${askedMethods.join('+')}`, '#16 Previous day H/L rejection', trades, trades - 1, 1), tf: '15m' }],
  };
};
// Tue 6 Oct 2026, 14:00 IST
const NOW = Date.UTC(2026, 9, 6, 8, 30);
const show = () => render(
  <PhoneContext.Provider value={{ now: NOW, status: null, accountParam: null, shown: 'all', trading: [] } as unknown as PhoneData}><PnlScreen /></PhoneContext.Provider>,
);
const open = async () => fireEvent.click(await screen.findByRole('button', { name: /^Strategy filter:/ }));
const tick = (name: RegExp, list = 'Strategies') => fireEvent.click(within(screen.getByRole('listbox', { name: list })).getByRole('option', { name }).querySelector('button')!);
const only = (strategies: string[], methods: string[] = []) => ({ strategies, methods });
const tile = (label: string) => screen.getByText(label, { selector: 'dt' }).nextSibling;

beforeEach(() => {
  window.localStorage.clear();
  getStats.mockReset(); getDaysFor.mockReset();
  getStats.mockImplementation(async (_from: string, _to: string, _account: number | null, f?: Filter) => statsFor(f));
  getDaysFor.mockResolvedValue({ mode: 'paper', from: '2026-09-30', to: '2026-10-06', days: [], totals: { realisedUsd: 0, chargesUsd: 0, netUsd: 0, tradingDays: 0, winDays: 0, lossDays: 0, best: null, worst: null } });
});

describe('PnlScreen: the strategy and method filters', () => {
  it('[critical] every strategy to begin with; the list says each one\'s trades and what it made', async () => {
    show();
    await open();
    expect(getStats).toHaveBeenLastCalledWith('2026-10-06', '2026-10-06', null, only([]));
    const rows = within(screen.getByRole('listbox', { name: 'Strategies' })).getAllByRole('option').map((o) => o.textContent);
    expect(rows).toHaveLength(4);
    expect(rows[0]).toBe('All strategies3 in this list');
    expect(rows[1]).toMatch(/^15m time12 trades · \+₹265/);
    expect(rows[2]).toMatch(/^1h time4 trades · [−-]₹313/);
    expect(rows[3]).toMatch(/^By hand1 trade · \+₹11/);
    expect(tile('Trades')).toHaveTextContent('17');
  });

  it('[critical] ticking strategies asks the server for their trades alone, and the screen says whose figures these are', async () => {
    show();
    await open();
    tick(/1h time/);
    await waitFor(() => expect(getStats).toHaveBeenLastCalledWith('2026-10-06', '2026-10-06', null, only(['s1h'])));
    await waitFor(() => expect(tile('Trades')).toHaveTextContent('4'));
    expect(screen.getByRole('button', { name: 'Strategy filter: 1h time' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Summary · 1h time' })).toBeInTheDocument();
    // Today's live figure cannot be split by strategy, and says so.
    expect(screen.getByText(/whole account's: open positions are not split by strategy or method.*are of 1h time\./)).toBeInTheDocument();
    tick(/By hand/);
    await waitFor(() => expect(getStats).toHaveBeenLastCalledWith('2026-10-06', '2026-10-06', null, only(['s1h', 'manual'])));
    await waitFor(() => expect(tile('Trades')).toHaveTextContent('5'));
    expect(screen.getByRole('heading', { name: 'Summary · 2 strategies' })).toBeInTheDocument();
    tick(/All strategies/);
    await waitFor(() => expect(tile('Trades')).toHaveTextContent('17'));
    expect(screen.queryByText(/open positions are not split by strategy or method/)).not.toBeInTheDocument();
  });

  it('[critical] over days the calendar and the totals are asked for the same strategies', async () => {
    show();
    fireEvent.click(await screen.findByRole('radio', { name: '7 days' }));
    await open();
    tick(/15m time/);
    await waitFor(() => expect(getDaysFor).toHaveBeenLastCalledWith('2026-09-30', '2026-10-06', null, only(['s15'])));
    expect(getStats).toHaveBeenLastCalledWith('2026-09-30', '2026-10-06', null, only(['s15']));
    expect(await screen.findByText(/Net P&L, .* · 15m time/)).toBeInTheDocument();
  });

  it('the choice is remembered; and with a server that names no strategies there is no filter', async () => {
    window.localStorage.setItem('btc-desk:m-pnl-strategies', JSON.stringify(['s15']));
    const { unmount } = show();
    expect(await screen.findByRole('button', { name: 'Strategy filter: 15m time' })).toBeInTheDocument();
    expect(getStats).toHaveBeenLastCalledWith('2026-10-06', '2026-10-06', null, only(['s15']));
    unmount();
    window.localStorage.clear();
    getStats.mockResolvedValue({ ...statsFor(), strategies: undefined });
    show();
    await waitFor(() => expect(tile('Trades')).toHaveTextContent('17'));
    expect(screen.queryByRole('button', { name: /^Strategy filter:/ })).not.toBeInTheDocument();
  });

  it('[critical] a method filter beside it, the same control: ticking methods asks for their trades alone, and both together is both', async () => {
    show();
    fireEvent.click(await screen.findByRole('button', { name: 'Method filter: All methods' }));
    expect(within(screen.getByRole('listbox', { name: 'Methods' })).getAllByRole('option').map((o) => o.textContent!.replace(/₹[\d.,]+$/, '₹'))).toEqual([
      'All methods2 in this list', '#16 Previous day H/L rejection8 trades · +₹', '#19 VWAP reclaim / loss3 trades · −₹',
    ]);
    tick(/#19/, 'Methods');
    await waitFor(() => expect(getStats).toHaveBeenLastCalledWith('2026-10-06', '2026-10-06', null, only([], ['vwap'])));
    await waitFor(() => expect(tile('Trades')).toHaveTextContent('3'));
    expect(screen.getByRole('heading', { name: 'Summary · #19 VWAP reclaim / loss' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    await open();
    tick(/15m time/);
    await waitFor(() => expect(getStats).toHaveBeenLastCalledWith('2026-10-06', '2026-10-06', null, only(['s15'], ['vwap'])));
    expect(await screen.findByRole('heading', { name: 'Summary · 15m time · #19 VWAP reclaim / loss' })).toBeInTheDocument();
    expect(screen.getByText(/are of 15m time, #19 VWAP reclaim \/ loss\./)).toBeInTheDocument();
  });

  it('over days the calendar is asked for the methods too, and the choice is remembered', async () => {
    window.localStorage.setItem('btc-desk:m-pnl-methods', JSON.stringify(['pd']));
    show();
    fireEvent.click(await screen.findByRole('radio', { name: '7 days' }));
    await waitFor(() => expect(getDaysFor).toHaveBeenLastCalledWith('2026-09-30', '2026-10-06', null, only([], ['pd'])));
    expect(await screen.findByRole('button', { name: 'Method filter: #16 Previous day H/L rejection' })).toBeInTheDocument();
  });
});
