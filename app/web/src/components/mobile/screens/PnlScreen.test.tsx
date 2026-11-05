import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { PhoneContext, type PhoneData } from '@/components/mobile/phone-context';
import type { Stats, StatsGroup } from '@/api/phone';
import type { DayTrade } from '@/api/ledger';
import { signedInr, usdToInr } from '@/lib/format';

/**
 * P&L's two filters (owner, 8 Oct 2026: "strategy select option, multiple select dropdown, mobile user friendly",
 * then "on the P&L screen both filters: the methods filter and the strategy filter"): tick strategies, or entry
 * methods, under the range and the closed trades' figures -- the numbers, the calendar, the pairs -- are asked for
 * again, for those alone.
 */

const getStats = vi.fn();
const getDaysFor = vi.fn();
vi.mock('@/api/phone', () => ({ getStats: (...a: unknown[]) => getStats(...a), getDaysFor: (...a: unknown[]) => getDaysFor(...a) }));
const getLedgerDay = vi.fn();
vi.mock('@/api/ledger', () => ({ getLedgerDay: (...a: unknown[]) => getLedgerDay(...a) }));
vi.mock('@/api/client', () => ({ json: vi.fn().mockResolvedValue({ day: '2026-10-06', samples: [], stats: { nowUsd: null, min: null, max: null, maxDrawdown: null }, days: [] }) }));

const { PnlScreen } = await import('@/components/mobile/screens/PnlScreen');

const group = (key: string, name: string, trades: number, wins: number, netUsd: number): StatsGroup => ({
  key, name, trades, wins, losses: trades - wins, winRate: trades ? wins / trades : null, grossProfitUsd: Math.max(0, netUsd), grossLossUsd: Math.max(0, -netUsd),
  profitFactor: null, avgWinUsd: null, avgLossUsd: null, netUsd, bestUsd: null, worstUsd: null,
});
const STRATEGIES = [{ key: 's15', name: '15m time', trades: 12, netUsd: 3.12 }, { key: 's1h', name: '1h time', trades: 4, netUsd: -3.68 }, { key: 'manual', name: 'By hand', trades: 1, netUsd: 0.14 }];
const TIMEFRAMES = [{ key: '15m', name: '15m', trades: 9, netUsd: 2.2 }, { key: '1h', name: '1h', trades: 5, netUsd: -0.9 }, { key: 'chain', name: 'With timeframe chain', trades: 2, netUsd: 0.4 }];
const METHODS = [{ key: 'pd', name: '#16 Previous day H/L rejection', trades: 8, netUsd: 2.4 }, { key: 'vwap', name: '#19 VWAP reclaim / loss', trades: 3, netUsd: -1.1 }];
type Filter = { strategies?: readonly string[]; methods?: readonly string[]; timeframes?: readonly string[] };
/** What the server answers: every figure of what was asked for, and the whole lists to choose from. */
const statsFor = (f: Filter = {}): Stats => {
  const asked = f.strategies ?? []; const askedMethods = f.methods ?? []; const askedTfs = f.timeframes ?? [];
  const kept = asked.length ? STRATEGIES.filter((s) => asked.includes(s.key)) : STRATEGIES;
  // Sample arithmetic only: a method choice counts its own trades, a strategy choice the strategies'.
  const trades = askedTfs.length ? TIMEFRAMES.filter((t) => askedTfs.includes(t.key)).reduce((n, t) => n + t.trades, 0)
    : askedMethods.length ? METHODS.filter((m) => askedMethods.includes(m.key)).reduce((n, m) => n + m.trades, 0) : kept.reduce((n, s) => n + s.trades, 0);
  return {
    mode: 'paper', from: '2026-10-06', to: '2026-10-06', overall: group('all', 'all', trades, trades - 1, kept.reduce((n, s) => n + s.netUsd, 0)),
    strategies: STRATEGIES, methods: METHODS, timeframes: TIMEFRAMES, byStrategy: [], byAccount: [], byOption: [], byAction: [],
    byPair: [{ ...group(`m|single|15m|${asked.join('+')}|${askedMethods.join('+')}|${askedTfs.join('+')}`, '#16 Previous day H/L rejection', trades, trades - 1, 1), tf: '15m' }],
  };
};
// Tue 6 Oct 2026, 14:00 IST
const NOW = Date.UTC(2026, 9, 6, 8, 30);
const show = () => render(
  <PhoneContext.Provider value={{ now: NOW, status: null, accountParam: null, shown: 'all', trading: [] } as unknown as PhoneData}><PnlScreen /></PhoneContext.Provider>,
);
const open = async () => fireEvent.click(await screen.findByRole('button', { name: /^Strategy filter:/ }));
const tick = (name: RegExp, list = 'Strategies') => fireEvent.click(within(screen.getByRole('listbox', { name: list })).getByRole('option', { name }).querySelector('button')!);
const only = (strategies: string[], methods: string[] = [], timeframes: string[] = []) => ({ strategies, methods, timeframes });
/** A day's trades as `/api/ledger/day` gives them: two won, two lost after charges (one of them up before its charges), one still open. */
const trade = (id: string, strike: number, netUsd: number, o: Partial<DayTrade> = {}): DayTrade => ({
  tradeId: id, symbol: `P-BTC-${strike}-061026`, strike, optionSide: 'PE', action: 'sell', contracts: 10, entryAt: NOW - 3_600_000, exitAt: NOW - 600_000,
  entryPrice: 40, exitPrice: 20, chargesUsd: 0.05, grossUsd: netUsd + 0.05, netUsd, exitBy: netUsd > 0 ? 'option-tgt' : 'option-sl',
  open: false, spans: false, strategy: '15m time', account: null, orderIds: [], ...o,
});
const TRADES = [
  trade('w1', 81_000, 2), trade('w2', 81_200, 0.5),
  trade('l1', 82_000, -1.5), trade('l2', 82_200, -0.01, { grossUsd: 0.04 }),
  trade('o1', 82_400, 0.3, { open: true, exitAt: null, exitPrice: null, exitBy: null }),
];
const DESK_DAY = { realisedUsd: 1.13, profitUsd: 2.68, lossUsd: 1.55, chargesUsd: 0.2, netUsd: 0.93, trades: 5, open: 1 };
const inr = (usd: number) => signedInr(usdToInr(usd));
const tile = (label: string) => screen.getByText(label, { selector: 'dt' }).nextSibling;

beforeEach(() => {
  window.localStorage.clear();
  getStats.mockReset(); getDaysFor.mockReset();
  getLedgerDay.mockReset().mockImplementation(async (day: string) => ({ day, account: null, desk: DESK_DAY, trades: TRADES }));
  getStats.mockImplementation(async (_from: string, _to: string, _account: number | null, f?: Filter) => statsFor(f));
  getDaysFor.mockResolvedValue({ mode: 'paper', from: '2026-09-30', to: '2026-10-06', days: [], totals: { realisedUsd: 0, chargesUsd: 0, netUsd: 0, tradingDays: 0, winDays: 0, lossDays: 0, best: null, worst: null } });
});

describe('PnlScreen: the strategy, method and timeframe filters', () => {
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
    expect(screen.getByText(/whole account's: open positions are not split by strategy, method or time frame.*are of 1h time\./)).toBeInTheDocument();
    tick(/By hand/);
    await waitFor(() => expect(getStats).toHaveBeenLastCalledWith('2026-10-06', '2026-10-06', null, only(['s1h', 'manual'])));
    await waitFor(() => expect(tile('Trades')).toHaveTextContent('5'));
    expect(screen.getByRole('heading', { name: 'Summary · 2 strategies' })).toBeInTheDocument();
    tick(/All strategies/);
    await waitFor(() => expect(tile('Trades')).toHaveTextContent('17'));
    expect(screen.queryByText(/open positions are not split by strategy, method or time frame/)).not.toBeInTheDocument();
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

  it('[critical] a timeframe filter of the same kind, the timeframe chain one of its choices: ticking asks for those trades alone', async () => {
    show();
    fireEvent.click(await screen.findByRole('button', { name: 'Time frame filter: All time frames' }));
    expect(within(screen.getByRole('listbox', { name: 'Time frames' })).getAllByRole('option').map((o) => o.textContent!.replace(/ · .*$/, ''))).toEqual([
      'All time frames3 in this list', '15m9 trades', '1h5 trades', 'With timeframe chain2 trades',
    ]);
    tick(/With timeframe chain/, 'Time frames');
    await waitFor(() => expect(getStats).toHaveBeenLastCalledWith('2026-10-06', '2026-10-06', null, only([], [], ['chain'])));
    await waitFor(() => expect(tile('Trades')).toHaveTextContent('2'));
    expect(screen.getByRole('heading', { name: 'Summary · With timeframe chain' })).toBeInTheDocument();
    tick(/^15m/, 'Time frames');
    await waitFor(() => expect(getStats).toHaveBeenLastCalledWith('2026-10-06', '2026-10-06', null, only([], [], ['chain', '15m'])));
    await waitFor(() => expect(tile('Trades')).toHaveTextContent('11'));
    expect(screen.getByRole('button', { name: 'Time frame filter: 2 of 3 time frames' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Summary · 2 time frames' })).toBeInTheDocument();
  });

  it('all three filters at once are all three, on the trades and on the calendar; a server that names no timeframes shows no timeframe filter', async () => {
    window.localStorage.setItem('btc-desk:m-pnl-strategies', JSON.stringify(['s15']));
    window.localStorage.setItem('btc-desk:m-pnl-methods', JSON.stringify(['pd']));
    window.localStorage.setItem('btc-desk:m-pnl-timeframes', JSON.stringify(['15m']));
    const { unmount } = show();
    fireEvent.click(await screen.findByRole('radio', { name: '7 days' }));
    await waitFor(() => expect(getDaysFor).toHaveBeenLastCalledWith('2026-09-30', '2026-10-06', null, only(['s15'], ['pd'], ['15m'])));
    expect(getStats).toHaveBeenLastCalledWith('2026-09-30', '2026-10-06', null, only(['s15'], ['pd'], ['15m']));
    expect(await screen.findByRole('heading', { name: 'Summary · 15m time · #16 Previous day H/L rejection · 15m' })).toBeInTheDocument();
    unmount();
    window.localStorage.clear();
    getStats.mockResolvedValue({ ...statsFor(), timeframes: undefined });
    show();
    await screen.findByRole('button', { name: /^Method filter:/ });
    expect(screen.queryByRole('button', { name: /^Time frame filter:/ })).not.toBeInTheDocument();
  });
});

describe('PnlScreen: booked, won and lost, a tap from their trades', () => {
  const sheetLines = () => within(screen.getByRole('list', { name: "The day's trades" })).getAllByRole('button');

  it('[critical] today: Won and Lost count each closed trade after its charges, and a tap opens the day\'s trades on that side, adding up to the same', async () => {
    show();
    const box = within(await screen.findByRole('region', { name: 'Won and lost' }));
    expect(getLedgerDay).toHaveBeenCalledWith('2026-10-06', null);
    const won = await box.findByRole('button', { name: `Won: 2 trades, ${inr(2.5)}. Show them` });
    // Up 0.04 before its charges, down 0.01 after: lost. The open one is in neither, and the line says so.
    const lost = box.getByRole('button', { name: `Lost: 2 trades, ${inr(-1.51)}. Show them` });
    expect(box.getByText(/1 still open, in neither/)).toBeInTheDocument();
    expect(won).toBeEnabled();

    fireEvent.click(lost);
    const sheet = within(await screen.findByRole('dialog', { name: /^.+ · trades lost$/ }));
    await waitFor(() => expect(sheetLines()).toHaveLength(2));
    expect(sheetLines().map((b) => b.getAttribute('aria-label'))).toEqual(['82000 PE: open the trade', '82200 PE: open the trade']);
    expect(sheet.getByText('2 trades, after charges').nextSibling).toHaveTextContent(inr(-1.51));
    expect(within(sheet.getByRole('group', { name: 'Won or lost' })).getByRole('button', { name: 'Lost' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(sheet.getAllByRole('button', { name: 'Close' }).at(-1)!);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('[critical] a tap on Booked opens every one of today\'s trades', async () => {
    show();
    fireEvent.click(await screen.findByRole('button', { name: /^Booked .*: show today's trades$/ }));
    await screen.findByRole('dialog', { name: /^.+ · trades$/ });
    await waitFor(() => expect(sheetLines()).toHaveLength(5));
  });

  it('[critical] over days, the day picked on the calendar has its own Won and Lost, opening that day\'s trades', async () => {
    const row = (day: string, netUsd: number, cumulativeUsd: number) => ({ day, realisedUsd: netUsd + 0.2, profitUsd: 2.68, lossUsd: 1.55, chargesUsd: 0.2, netUsd, trades: 5, cumulativeUsd });
    getDaysFor.mockResolvedValue({
      mode: 'paper', from: '2026-09-30', to: '2026-10-06', days: [row('2026-10-02', 0.93, 0.93), row('2026-10-05', -0.4, 0.53)],
      totals: { realisedUsd: 0.93, chargesUsd: 0.4, netUsd: 0.53, tradingDays: 2, winDays: 1, lossDays: 1, best: null, worst: null },
    });
    show();
    fireEvent.click(await screen.findByRole('radio', { name: '7 days' }));
    fireEvent.click(await screen.findByRole('button', { name: /^Fri, 2 Oct:/ }));
    const won = await screen.findByRole('button', { name: `Won: 2 trades, ${inr(2.5)}. Show them` });
    expect(getLedgerDay).toHaveBeenLastCalledWith('2026-10-02', null);
    fireEvent.click(won);
    await screen.findByRole('dialog', { name: /· trades won$/ });
    await waitFor(() => expect(sheetLines()).toHaveLength(2));
    expect(getLedgerDay).toHaveBeenLastCalledWith('2026-10-02', null);
  });
});

describe('PnlScreen: a range past what the server reads at once', () => {
  it('[critical] said in words, never shown as the whole range (4 Nov 2026)', async () => {
    getDaysFor.mockResolvedValue({ mode: 'paper', from: '2026-09-30', to: '2026-10-06', days: [], truncated: true,
      totals: { realisedUsd: 0, chargesUsd: 0, netUsd: 0, tradingDays: 0, winDays: 0, lossDays: 0, best: null, worst: null } });
    show();
    fireEvent.click(await screen.findByRole('radio', { name: '7 days' }));
    expect(await screen.findByText(/More than 100,000 trades in this range: these figures are of the newest/)).toBeInTheDocument();
  });

  it('a range read whole says nothing of it', async () => {
    show();
    fireEvent.click(await screen.findByRole('radio', { name: '7 days' }));
    await waitFor(() => expect(getDaysFor).toHaveBeenCalled());
    expect(screen.queryByText(/More than 100,000 trades/)).toBeNull();
  });
});
