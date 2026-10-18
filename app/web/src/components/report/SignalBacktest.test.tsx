import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { BtRow, BtTot, SignalBacktestResponse } from '@/types/signal-backtest';
import { PhoneContext, type PhoneData } from '@/components/mobile/phone-context';

/**
 * The backtest (owner, 13 Oct 2026): the signal history sold as options on the prices the contracts really had,
 * the perp's TGT and SL kept -- and the question it was asked for answered in a panel of its own: when the perp's
 * SL was hit, how often was the option a profit all the same.
 */

const getSignalBacktest = vi.fn();
/** The live check under a result, with nothing on either side: its own behaviour is LiveCheck.test.tsx's. */
const NO_CHECK = {
  from: '2026-10-01', to: '2026-10-13', liveFrom: null, liveTo: null, until: 0, against: { kind: 'strategies' }, strategies: [], liveOnly: [],
  total: { placed: 0, refused: 0, skipped: 0, backtest: 0, backtestSkipped: 0, same: 0, backtestOnly: 0, liveOnly: 0 },
  liveWhy: { refused: [], skipped: [] }, money: { real: null, backtest: { n: 0, wins: 0, net: 0 } }, days: [],
  notCompared: { backtest: 0, desk: 0 }, notComparedWhy: { backtest: [], desk: [] },
  fate: { live: { taken: 0, waiting: 0, notTaken: 0, skipped: 0, refused: 0, rejected: 0, expired: 0, cancelled: 0 }, backtest: { taken: 0, waiting: 0, notTaken: 0, skipped: 0, refused: 0, rejected: 0, expired: 0, cancelled: 0 } },
};
const getLiveCheck = vi.fn();
const getBacktestTrades = vi.fn();
const getVolStudy = vi.fn();
vi.mock('@/api/signal-backtest', () => ({ getSignalBacktest: (...a: unknown[]) => getSignalBacktest(...a), getLiveCheck: (...a: unknown[]) => getLiveCheck(...a), getBacktestTrades: (...a: unknown[]) => getBacktestTrades(...a), getVolStudy: (...a: unknown[]) => getVolStudy(...a) }));

const saves = { getBacktestSaves: vi.fn(), saveBacktest: vi.fn(), deleteBacktestSave: vi.fn(), savePortfolio: vi.fn(), deletePortfolio: vi.fn(), getBacktestPortfolio: vi.fn(), getPortfolioLiveCheck: vi.fn(), getPortfolioTrades: vi.fn() };
vi.mock('@/api/backtest-saves', async () => ({
  ...Object.fromEntries(Object.keys(saves).map((k) => [k, (...a: unknown[]) => (saves as Record<string, (...x: unknown[]) => unknown>)[k]!(...a)])),
  AS_SAVED: { window: 'saved' },
  // The real one: it is how a run's settings become a query, and the run is keyed by what it gives.
  overQuery: (await vi.importActual<typeof import('@/api/backtest-saves')>('@/api/backtest-saves')).overQuery,
}));

const { SignalBacktest } = await import('@/components/report/SignalBacktest');
const { BacktestScreen } = await import('@/components/mobile/screens/BacktestScreen');

const tot = (o: Partial<BtTot> = {}): BtTot => ({ n: 0, wins: 0, losses: 0, net: 0, won: 0, lost: 0, perpPts: 0, charges: 0, exits: {}, ...o });
const row = (key: string, name: string, o: Partial<BtRow>): BtRow => ({ ...tot(o), key, name, ...o });

const TOTAL = tot({
  n: 1_000, wins: 440, losses: 560, net: -120, won: 480, lost: 600, perpPts: 13_600, charges: 40,
  exits: {
    'perp-tgt': { n: 350, wins: 250, net: 30 }, 'perp-sl': { n: 500, wins: 60, net: -550 },
    'option-tgt': { n: 130, wins: 130, net: 440 }, 'option-sl': { n: 5, wins: 0, net: -62 }, 'window-end': { n: 15, wins: 12, net: 22 },
  },
});
const RESULT: SignalBacktestResponse = {
  from: '2026-10-01', to: '2026-10-13',
  params: { rule: 'delta', value: 0.1, lots: 10, targetPct: 0.9, stopPct: 3, window: 'desk', deskMax: 0, cePct: 100, pePct: 100 },
  deskLimits: [{ account: 'Savings', max: 58, ce: 80, pe: 80 }, { account: 'Expenses', max: 35, ce: 80, pe: 80 }],
  margin: { peakUsd: 300, peakDay: '2026-10-13', peakAt: Date.parse('2026-10-13T04:29:00+05:30'), peakOpen: 58, peakLots: 580, avgDailyPeakUsd: 200, avgTradeUsd: 5.2 },
  signals: 1_400, skipped: { 'outside-window': 300, 'no-entry-window': 0, distance: 0, volatility: 0, 'at-limit': 0, 'desk-limit': 0, 'side-limit': 0, 'no-board': 0, 'no-strike': 95, 'no-exit-price': 5 },
  strategy: null,
  strategies: [
    { id: '1h-time', name: '1h time', enabled: true, account: 'Savings', methods: ['gamma'], tfs: ['4h'], target: { pct: 0.7, steps: [{ at: '23:30', pct: 0.75 }, { at: '03:30', pct: 0.85 }] } },
    { id: '4h-old', name: '4h old', enabled: false, account: 'Expenses', methods: ['pulled', 'gamma'], tfs: ['chain'] },
  ],
  total: TOTAL,
  days: [
    { ...tot({ n: 600, wins: 300, losses: 300, net: 40, won: 300, lost: 260 }), day: '2026-10-12', pattern: 'FALSE_BREAKOUT_RANGE', live: false },
    { ...tot({ n: 400, wins: 140, losses: 260, net: -160, won: 180, lost: 340 }), day: '2026-10-13', pattern: 'REVERSAL_ZIGZAG', live: true },
  ],
  pairs: [
    row('gamma|single|30m', '#50 Gamma wall reaction', { tf: '30m', n: 145, wins: 101, losses: 44, net: 12.4, won: 20, lost: 7.6, perpPts: 13_981 }),
    row('pulled|single|5m', '#55 Pulled wall (spoof / pull)', { tf: '5m', n: 2_421, wins: 700, losses: 1_721, net: -105.6, won: 60, lost: 165.6, perpPts: 4_210 }),
  ],
  byTf: [
    row('5m', '5m', { n: 700, wins: 238, losses: 462, net: -230, won: 200, lost: 430, perpPts: 2_300 }),
    row('4h', '4h', { n: 100, wins: 79, losses: 21, net: 10.3, won: 20, lost: 9.7, perpPts: -171 }),
    row('chain', 'With timeframe chain', { n: 200, wins: 70, losses: 130, net: -30, won: 20, lost: 50, perpPts: 900 }),
  ],
  byMethod: [
    row('gamma', '#50 Gamma wall reaction', { n: 458, wins: 311, losses: 147, net: 35, won: 60, lost: 25, perpPts: 42_585 }),
    row('pulled', '#55 Pulled wall (spoof / pull)', { n: 2_421, wins: 700, losses: 1_721, net: -105.6, won: 60, lost: 165.6, perpPts: 4_210 }),
  ],
  byPattern: [row('REVERSAL_ZIGZAG', '#16 Reversal', { days: 1, n: 400, wins: 140, losses: 260, net: -160, won: 180, lost: 340 })],
  byFamily: [
    row('range', 'Range', { days: 1, n: 600, wins: 300, losses: 300, net: 40, won: 300, lost: 260 }),
    row('turn', 'Turn / event', { days: 1, n: 400, wins: 140, losses: 260, net: -160, won: 180, lost: 340 }),
  ],
  choices: { timeframes: [{ key: '5m', name: '5m' }, { key: '4h', name: '4h' }, { key: 'chain', name: 'With timeframe chain' }], methods: [{ key: 'gamma', name: '#50 Gamma wall reaction', n: 458, wins: 311, net: 35 }, { key: 'pulled', name: '#55 Pulled wall (spoof / pull)', n: 2_421, wins: 700, net: -105.6 }] },
};

// Tue 13 Oct 2026, 11:00 IST
const NOW = Date.parse('2026-10-13T11:00:00+05:30');
const show = (wide = false) => render(<SignalBacktest now={NOW} wide={wide} />);
const lastQuery = () => getSignalBacktest.mock.calls.at(-1)![0];
const rowsOf = (name: string) => within(screen.getByRole('table', { name })).getAllByRole('row').slice(1).map((r) => r.textContent!.replace(/[+−]?₹[\d,.]+/g, '₹'));

beforeEach(() => {
  window.localStorage.clear();
  getSignalBacktest.mockReset();
  getSignalBacktest.mockResolvedValue(RESULT);
  for (const f of Object.values(saves)) f.mockReset();
  saves.getBacktestSaves.mockResolvedValue({ saves: [], portfolios: [] });
  getLiveCheck.mockReset().mockResolvedValue(NO_CHECK);
  saves.getPortfolioLiveCheck.mockResolvedValue(NO_CHECK);
});

describe('SignalBacktest', () => {
  it('[critical] asks with the desk\'s own rules to begin with: since 1 Oct, 9:30 PM to 3:59 PM, delta 0.10, 10 lots, 90% target, +300% stop', async () => {
    show();
    await screen.findByText('Backtest result');
    expect(lastQuery()).toEqual({
      from: '2026-10-01', to: '2026-10-13', tfs: [], methods: [], strategy: null,
      params: { rule: 'delta', value: 0.1, lots: 10, targetPct: 0.9, stopPct: 3, window: 'desk', deskMax: 0, cePct: 100, pePct: 100 },
    });
    expect(screen.getByText(/Thu 1 Oct → Tue 13 Oct · delta ≤ 0\.10 · 10 lots a signal · option target 90%, stop \+300%/)).toBeInTheDocument();
    // the live check under the result is asked with the same question: it is the check of what is on the screen
    await waitFor(() => expect(getLiveCheck).toHaveBeenLastCalledWith(lastQuery()));
    expect(await screen.findByText('Live check · the desk beside this backtest')).toBeInTheDocument();
    // and it is in the result, not a section of its own
    expect(screen.getAllByRole('radio').filter((x) => /Single|Portfolio|Live/.test(x.textContent ?? '')).map((x) => x.textContent)).toEqual(['Single backtest', 'Portfolio']);
  });

  it('[critical] the result: the net and what one trade made, how many were traded -- and why the rest were not', async () => {
    show();
    const panel = within((await screen.findByText('Backtest result')).closest('section, div')!.parentElement!);
    expect(panel.getByText(/a trade$/).parentElement!.textContent).toMatch(/^−₹[\d,.]+ −₹[\d,.]+ a trade$/);
    expect(panel.getByText('Trades').parentElement!.textContent).toBe('Trades1,000');
    expect(panel.getByText('Won').parentElement!.textContent).toBe('Won44%');
    expect(panel.getByText('Profit factor').parentElement!.textContent).toBe('Profit factor0.80');
    expect(panel.getByText('+13,600 pts')).toBeInTheDocument();
    expect(panel.getByText(/1,400 signals went in the trade; 1,000 were traded here\. Not traded: 300 outside the hours chosen, 95 with no strike inside the rule worth \$10, 5 with no price to exit at\./)).toBeInTheDocument();
  });

  it('[critical] the question it was built for: when the perp\'s SL was hit, how often the option was still a profit', async () => {
    show();
    const panel = (await screen.findByText("When the perp's SL was hit")).closest('section, div')!.parentElement!;
    const text = panel.textContent!.replace(/[+−]?₹[\d,.]+/g, '₹');
    expect(text).toContain("The perp reached the signal's stop on 500 trades. The option was still a profit on 60 of them (12%) and a loss on 440. Together: ₹ ₹ a trade.");
    expect(text).toContain('the perp reached the target on 350 trades: the option was a profit on 71% of them');
  });

  it('[critical] by exit and by time frame: trades, how many in profit, the net with one trade\'s under it, and the perp beside', async () => {
    show();
    await screen.findByText('Backtest result');
    expect(rowsOf('Backtest: which exit closed the trades')).toEqual(['Perp TGT35071%₹₹', 'Perp SL50012%₹₹', 'Option TGT130100%₹₹', 'Option SL50%₹₹', 'Window end1580%₹₹']);
    expect(rowsOf('Backtest by time frame')).toEqual(['5mperp +2,300 pts70034%₹₹charges ₹', '4hperp −171 pts10079%₹₹charges ₹', 'TF chainperp +900 pts20035%₹₹charges ₹']);
    // each day's count a button (14 Oct 2026): it opens that day's trades, asked as the backtest on the screen is
    expect(rowsOf('Backtest by expiry day')).toEqual(['Tue 13 Oct · so far400 ›35%₹₹charges ₹', 'Mon 12 Oct600 ›50%₹₹charges ₹']);
    getBacktestTrades.mockResolvedValue({ day: '2026-10-12', total: 0, trades: [] });
    fireEvent.click(screen.getByRole('button', { name: 'See the 600 trades of Mon 12 Oct' }));
    await waitFor(() => expect(getBacktestTrades).toHaveBeenCalledWith(expect.objectContaining({ from: '2026-10-01' }), { day: '2026-10-12' }));
    expect(await screen.findByRole('dialog', { name: /Mon 12 Oct · trade by trade/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'close' }));
    // by family to begin with, by market type on a tap
    expect(rowsOf('Backtest by kind of day')).toEqual(['Range1 day60050%₹₹charges ₹', 'Turn / event1 day40035%₹₹charges ₹']);
    fireEvent.click(screen.getByRole('radio', { name: 'By each market type' }));
    expect(rowsOf('Backtest by kind of day')).toEqual(['#16 Reversal1 day40035%₹₹charges ₹']);
  });

  it('[critical] the best and worst pairs as options, each with what the same trades made on the perp', async () => {
    show();
    const best = within(await screen.findByRole('list', { name: 'Best pairs as options' }));
    expect(best.getByText('#50 Gamma wall reaction')).toBeInTheDocument();
    expect(best.getByText(/145 trades · 70% won · PF 2\.63 · perp \+13,981 pts/)).toBeInTheDocument();
    const worst = within(screen.getByRole('list', { name: 'Worst pairs as options' }));
    expect(worst.getByText('#55 Pulled wall (spoof / pull)')).toBeInTheDocument();
    expect(worst.getByText(/2421 trades · 29% won · PF 0\.36 · perp \+4,210 pts/)).toBeInTheDocument();
  });

  it('[critical] every setting is a tap, asks again, and is remembered', async () => {
    show();
    await screen.findByText('Backtest result');
    fireEvent.click(screen.getByRole('radio', { name: 'Pick the strike by premium' }));
    await waitFor(() => expect(lastQuery().params).toMatchObject({ rule: 'premium', value: 50 }));
    fireEvent.click(within(screen.getByRole('group', { name: 'Sell the dearest strike priced at most' })).getByRole('button', { name: '$75' }));
    await waitFor(() => expect(lastQuery().params.value).toBe(75));
    fireEvent.click(within(screen.getByRole('group', { name: "The option's own stop, over the premium sold" })).getByRole('button', { name: '+150%' }));
    await waitFor(() => expect(lastQuery().params.stopPct).toBe(1.5));
    fireEvent.click(within(screen.getByRole('group', { name: 'Lots a signal' })).getByRole('button', { name: '16' }));
    await waitFor(() => expect(lastQuery().params.lots).toBe(16));
    fireEvent.click(screen.getByRole('radio', { name: 'Signals of the whole expiry day' }));
    await waitFor(() => expect(lastQuery().params.window).toBe('all'));
    fireEvent.click(within(screen.getByRole('group', { name: 'Time frame' })).getByRole('button', { name: '4h' }));
    await waitFor(() => expect(lastQuery().tfs).toEqual(['4h']));
    fireEvent.click(screen.getByRole('radio', { name: 'The last 7 expiry days' }));
    await waitFor(() => expect(lastQuery()).toMatchObject({ from: '2026-10-07', to: '2026-10-13' }));
    // back to delta: its own usual limit, not the premium's number
    fireEvent.click(screen.getByRole('radio', { name: 'Pick the strike by delta' }));
    await waitFor(() => expect(lastQuery().params).toEqual({ rule: 'delta', value: 0.1, lots: 16, targetPct: 0.9, stopPct: 1.5, window: 'all', deskMax: 0, cePct: 100, pePct: 100 }));
    const kept = Object.keys(window.localStorage).find((k) => k.endsWith('signalBacktest.params'))!;
    expect(JSON.parse(window.localStorage.getItem(kept)!)).toMatchObject({ lots: 16, stopPct: 1.5 });
  });

  it('[critical] a custom range of expiry days, picked in the same sheet as the market report\'s', async () => {
    show();
    await screen.findByText('Backtest result');
    fireEvent.click(screen.getByRole('radio', { name: 'A range of expiry days of your own' }));
    const sheet = within(screen.getByRole('dialog', { name: 'Custom range' }));
    fireEvent.change(sheet.getByLabelText('From'), { target: { value: '2026-10-09' } });
    fireEvent.change(sheet.getByLabelText('To'), { target: { value: '2026-10-11' } });
    fireEvent.click(sheet.getByRole('button', { name: 'Show' }));
    await waitFor(() => expect(lastQuery()).toMatchObject({ from: '2026-10-09', to: '2026-10-11' }));
    expect(screen.getByText('Fri 9 Oct → Sun 11 Oct')).toBeInTheDocument();
  });

  it('[critical] the methods\' profit and loss as options: in the method list, and in a table of those in profit and those in loss', async () => {
    show();
    await screen.findByText('Backtest result');
    expect(rowsOf('Backtest: methods in profit')).toEqual(['#50 Gamma wall reactionperp +42,585 pts45868%₹₹charges ₹']);
    expect(rowsOf('Backtest: methods in loss')).toEqual(['#55 Pulled wall (spoof / pull)perp +4,210 pts2,42129%₹₹charges ₹']);
    fireEvent.click(screen.getByRole('button', { name: 'Method filter: All methods' }));
    const list = within(screen.getByRole('listbox'));
    expect(list.getByText(/^458 trades · 68% won · \+₹/)).toBeInTheDocument();
    expect(list.getByText(/^2,421 trades · 29% won · −₹/)).toBeInTheDocument();
  });

  it('[critical] backtest by a saved strategy: chosen from the list, its own rules said, its real orders beside -- and back to the settings', async () => {
    show();
    await screen.findByText('Backtest result');
    const by = screen.getByRole('combobox', { name: 'Backtest by' });
    expect([...by.querySelectorAll('option')].map((o) => o.textContent)).toEqual(['These settings (every signal)', '1h time · Savings', '4h old · Expenses · off']);
    getSignalBacktest.mockResolvedValue({
      ...RESULT, skipped: { ...RESULT.skipped, 'outside-window': 40, 'no-entry-window': 12, distance: 30, 'at-limit': 200 },
      strategy: { id: '1h-time', name: '1h time', accountId: 1, caveats: ['Its timed target and stop steps are not replayed: the starting target and stop are used all day.'], real: { n: 46, wins: 8, open: 22, net: -37.4 } },
    });
    fireEvent.change(by, { target: { value: '1h-time' } });
    await waitFor(() => expect(lastQuery().strategy).toBe('1h-time'));
    expect(await screen.findByText(/By .*'s own rules/)).toHaveTextContent("By 1h time's own rules");
    expect(screen.getByText(/timed target and stop steps are not replayed/)).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Lots a signal' })).not.toBeInTheDocument();
    expect(screen.queryByRole('radio', { name: 'Pick the strike by delta' })).not.toBeInTheDocument();
    const vs = (await screen.findByText('Backtest against its real orders')).closest('section, div')!.parentElement!;
    expect(vs.textContent).toMatch(/Real orders46 closed · 17% won · 22 open · −₹/);
    expect(screen.getByText(/40 outside its days and hours, 12 inside its no-entry window, 30 with the SL or TGT outside its distances, 200 while it already had its most open/)).toBeInTheDocument();
    fireEvent.change(screen.getByRole('combobox', { name: 'Backtest by' }), { target: { value: '' } });
    await waitFor(() => expect(lastQuery().strategy).toBeNull());
    expect(screen.getByRole('group', { name: 'Lots a signal' })).toBeInTheDocument();
  });

  it('a strategy remembered from before and deleted since falls back to the settings', async () => {
    window.localStorage.setItem(Object.keys(window.localStorage)[0] ?? 'x', '0');
    getSignalBacktest.mockImplementation((q: { strategy?: string | null }) => (q.strategy ? Promise.reject(new Error('No such signal strategy to backtest: it may have been deleted')) : Promise.resolve(RESULT)));
    show();
    fireEvent.change(await screen.findByRole('combobox', { name: 'Backtest by' }), { target: { value: '1h-time' } });
    await waitFor(() => expect(lastQuery().strategy).toBeNull());
    expect(await screen.findByText('Backtest result')).toBeInTheDocument();
  });

  it('[critical] custom numbers: typed in the row\'s own unit, checked, applied on Use or Enter -- and said on the chip after', async () => {
    show();
    await screen.findByText('Backtest result');
    const row = (name: string) => within(screen.getByRole('group', { name }));
    // a delta of 0.12
    fireEvent.click(row('Sell the nearest strike with a delta of at most').getByRole('button', { name: 'Custom' }));
    const delta = screen.getByRole('spinbutton', { name: 'Delta limit, your own' });
    fireEvent.change(delta, { target: { value: '0.9' } });
    expect(screen.getByRole('alert')).toHaveTextContent('From 0.02 to 0.5.');
    expect(row('Sell the nearest strike with a delta of at most').getByRole('button', { name: 'Use' })).toBeDisabled();
    fireEvent.change(delta, { target: { value: '0.12' } });
    fireEvent.click(row('Sell the nearest strike with a delta of at most').getByRole('button', { name: 'Use' }));
    await waitFor(() => expect(lastQuery().params.value).toBe(0.12));
    expect(row('Sell the nearest strike with a delta of at most').getByRole('button', { name: 'Custom · 0.12' })).toHaveAttribute('aria-pressed', 'true');
    // a stop of +200%, typed as a percentage, sent as a share; Enter applies
    fireEvent.click(row("The option's own stop, over the premium sold").getByRole('button', { name: 'Custom' }));
    const stop = screen.getByRole('spinbutton', { name: 'Option stop, your own' });
    fireEvent.change(stop, { target: { value: '200' } });
    fireEvent.keyDown(stop, { key: 'Enter' });
    await waitFor(() => expect(lastQuery().params.stopPct).toBe(2));
    expect(row("The option's own stop, over the premium sold").getByRole('button', { name: 'Custom · +200%' })).toBeInTheDocument();
    // a target of 75% kept
    fireEvent.click(row("The option's own target, of the premium kept").getByRole('button', { name: 'Custom' }));
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Option target, your own' }), { target: { value: '75' } });
    fireEvent.click(row("The option's own target, of the premium kept").getByRole('button', { name: 'Use' }));
    await waitFor(() => expect(lastQuery().params.targetPct).toBe(0.75));
    // lots: whole numbers only
    fireEvent.click(row('Lots a signal').getByRole('button', { name: 'Custom' }));
    const lots = screen.getByRole('spinbutton', { name: 'Lots, your own' });
    fireEvent.change(lots, { target: { value: '2.5' } });
    expect(screen.getByRole('alert')).toHaveTextContent('A whole number.');
    fireEvent.change(lots, { target: { value: '25' } });
    fireEvent.keyDown(lots, { key: 'Enter' });
    await waitFor(() => expect(lastQuery().params).toMatchObject({ rule: 'delta', value: 0.12, stopPct: 2, targetPct: 0.75, lots: 25 }));
    expect(await screen.findByText(/option target 75%, stop \+200%/)).toBeInTheDocument();
    // a preset is one tap back
    fireEvent.click(row('Lots a signal').getByRole('button', { name: '10' }));
    await waitFor(() => expect(lastQuery().params.lots).toBe(10));
    expect(row('Lots a signal').getByRole('button', { name: 'Custom' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('[critical] the Strategy filter beside Method: choosing strategies ticks their methods and time frames, by the settings', async () => {
    show();
    await screen.findByText('Backtest result');
    fireEvent.click(screen.getByRole('button', { name: 'Strategy filter: All strategies' }));
    const list = within(screen.getByRole('listbox'));
    expect(list.getByText('Savings · 1 method on 4h')).toBeInTheDocument();
    expect(list.getByText('Expenses · 2 methods on TF chain · off')).toBeInTheDocument();
    fireEvent.click(list.getByText('1h time'));
    fireEvent.click(list.getByText('4h old'));
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(lastQuery()).toMatchObject({ methods: ['gamma', 'pulled'], tfs: ['4h', 'chain'], strategy: null }));
    expect(screen.getByText(/The methods and time frames of 1h time, 4h old: 2 methods on 4h, TF chain, by the settings above\./)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Method filter: 2 of 2 methods' })).toBeInTheDocument();
    // a time frame changed by hand ends the shortcut: the line goes, the methods stay as they are
    fireEvent.click(within(screen.getByRole('group', { name: 'Time frame' })).getByRole('button', { name: '5m' }));
    await waitFor(() => expect(lastQuery().tfs).toEqual(['4h', 'chain', '5m']));
    expect(screen.queryByText(/The methods and time frames of/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Strategy filter: All strategies' })).toBeInTheDocument();
    // clear all: every method and time frame again
    fireEvent.click(screen.getByRole('button', { name: 'Clear all' }));
    await waitFor(() => expect(lastQuery()).toMatchObject({ methods: [], tfs: [] }));
  });

  it('[critical] the desk\'s limits: an account\'s own in one tap, or each set -- the side limits said as counts, and what they skipped', async () => {
    show();
    await screen.findByText('Backtest result');
    const limits = within(screen.getByRole('region', { name: "The desk's limits" }));
    expect(limits.queryByRole('group', { name: /^CE max/ })).not.toBeInTheDocument();
    fireEvent.click(limits.getByRole('button', { name: 'Expenses · 35 · CE 80% · PE 80%' }));
    await waitFor(() => expect(lastQuery().params).toMatchObject({ deskMax: 35, cePct: 80, pePct: 80 }));
    expect(limits.getByRole('group', { name: 'CE max: at most 28 CE open at once' })).toBeInTheDocument();
    expect(limits.getByRole('button', { name: 'Expenses · 35 · CE 80% · PE 80%' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(within(limits.getByRole('group', { name: 'PE max: at most 28 PE open at once' })).getByRole('button', { name: '50%' }));
    await waitFor(() => expect(lastQuery().params.pePct).toBe(50));
    expect(limits.getByRole('group', { name: 'PE max: at most 18 PE open at once' })).toBeInTheDocument();
    fireEvent.click(within(limits.getByRole('group', { name: 'At most open, every trade together' })).getByRole('button', { name: 'Custom' }));
    const max = screen.getByRole('spinbutton', { name: 'At most open, your own' });
    fireEvent.change(max, { target: { value: '45' } });
    fireEvent.keyDown(max, { key: 'Enter' });
    await waitFor(() => expect(lastQuery().params.deskMax).toBe(45));
    getSignalBacktest.mockResolvedValue({ ...RESULT, params: { ...RESULT.params, deskMax: 45, cePct: 80, pePct: 50 }, skipped: { ...RESULT.skipped, 'desk-limit': 120, 'side-limit': 40 } });
    fireEvent.click(within(limits.getByRole('group', { name: 'CE max: at most 36 CE open at once' })).getByRole('button', { name: '100% · no limit' }));
    expect(await screen.findByText(/120 while 45 were open \(at most open\), 40 while that side was at its CE \/ PE max/)).toBeInTheDocument();
    fireEvent.click(within(limits.getByRole('group', { name: 'At most open, every trade together' })).getByRole('button', { name: 'No limit' }));
    await waitFor(() => expect(lastQuery().params.deskMax).toBe(0));
    expect(limits.queryByRole('group', { name: /^PE max/ })).not.toBeInTheDocument();
  });

  it('[critical] custom hours: a From and a To time, past midnight too, said after and changeable', async () => {
    show();
    await screen.findByText('Backtest result');
    fireEvent.click(screen.getByRole('radio', { name: 'Signals in hours of your own' }));
    const from = screen.getByLabelText('From (IST)'), to = screen.getByLabelText('To (IST)');
    expect(lastQuery().params.window).toBe('desk');                 // nothing asked until the hours are used
    fireEvent.change(from, { target: { value: '22:00' } });
    fireEvent.change(to, { target: { value: '22:00' } });
    expect(screen.getByRole('alert')).toHaveTextContent('The From and To times must differ.');
    expect(screen.getByRole('button', { name: 'Use these hours' })).toBeDisabled();
    fireEvent.change(to, { target: { value: '02:00' } });
    expect(screen.getByText(/Signals filled from 10:00 PM to 2:00 AM, past midnight/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Use these hours' }));
    await waitFor(() => expect(lastQuery().params).toMatchObject({ window: 'custom', hoursFrom: '22:00', hoursTo: '02:00' }));
    expect(screen.getByRole('radio', { name: 'Signals in hours of your own' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByText('10:00 PM → 2:00 AM')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Change hours' }));
    expect(screen.getByLabelText('From (IST)')).toHaveValue('22:00');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    fireEvent.click(screen.getByRole('radio', { name: 'Signals of the whole expiry day' }));
    await waitFor(() => expect(lastQuery().params.window).toBe('all'));
  });

  it('[critical] a filter changed: "working" at once, the old result greyed and said to be the previous settings\' -- until the new one comes', async () => {
    show();
    expect(await screen.findByText('Backtest result')).toBeInTheDocument();
    expect(screen.queryByText(/Working out/)).not.toBeInTheDocument();
    let answer!: (v: unknown) => void;
    getSignalBacktest.mockImplementation(() => new Promise((r) => { answer = r; }));
    fireEvent.click(within(screen.getByRole('group', { name: 'Lots a signal' })).getByRole('button', { name: '16' }));
    const bar = await screen.findByText(/Working out the backtest for the settings you chose/);
    expect(bar.closest('[aria-busy]')).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByText(/Below: the previous settings' result/)).toBeInTheDocument();
    expect(screen.getByText('Backtest result').closest('.opacity-40')).not.toBeNull();
    answer({ ...RESULT, params: { ...RESULT.params, lots: 16 } });
    await waitFor(() => expect(screen.queryByText(/Working out the backtest/)).not.toBeInTheDocument());
    expect(screen.getByText('Backtest result').closest('.opacity-40')).toBeNull();
  });

  it('[critical] the charges: before them, them, and after them -- a trade\'s share, and under each row of the tables', async () => {
    show();
    const panel = within((await screen.findByText('Backtest result')).closest('section, div')!.parentElement!);
    const tile = (label: string) => panel.getByText(label).parentElement!.textContent!.replace(label, '');
    // −$120 after $40 of charges: −$80 before them
    expect(tile('Before charges')).toMatch(/^−₹6,800/);
    expect(tile('Charges')).toMatch(/^−₹3,400/);
    expect(tile('After charges')).toMatch(/^−₹10,200/);
    expect(panel.getByText(/Delta's fee on each fill .* −₹3\.40 a trade, 50% of the result before them/)).toBeInTheDocument();
    expect(within(screen.getByRole('table', { name: 'Backtest by time frame' })).getAllByText(/^charges /).length).toBe(3);
  });

  it('[critical] "traded here" counts every reason a signal was not traded -- the limits on open trades too', async () => {
    getSignalBacktest.mockResolvedValue({ ...RESULT, signals: 6_681, total: { ...TOTAL, n: 2_846 },
      skipped: { ...RESULT.skipped, 'outside-window': 1_540, 'desk-limit': 1_447, 'side-limit': 397, 'no-strike': 451, 'no-exit-price': 0 },
      params: { ...RESULT.params, deskMax: 58, cePct: 80, pePct: 80 } });
    show();
    expect(await screen.findByText(/6,681 signals went in the trade; 2,846 were traded here\./)).toBeInTheDocument();
  });

  it('[critical] the SL and TGT range: four fields as in the strategy form, checked, applied on leaving a field -- and said in the result', async () => {
    show();
    await screen.findByText('Backtest result');
    const range = within(screen.getByRole('region', { name: 'SL and TGT range' }));
    expect(range.getByText('Off: every signal, whatever its SL and TGT.')).toBeInTheDocument();
    const slMin = range.getByLabelText('SL at least, points'), slMax = range.getByLabelText('SL at most, points');
    const tgMin = range.getByLabelText('TGT at least, points');
    fireEvent.change(slMin, { target: { value: '500' } });
    fireEvent.change(slMax, { target: { value: '200' } });
    fireEvent.blur(slMax);
    expect(range.getByRole('alert')).toHaveTextContent('The SL maximum must not be under its minimum.');
    expect(lastQuery().params.slMin ?? 0).toBe(0);                     // nothing sent while it is wrong
    fireEvent.change(slMin, { target: { value: '150' } });
    fireEvent.change(slMax, { target: { value: '0' } });
    fireEvent.change(tgMin, { target: { value: '150' } });
    fireEvent.blur(tgMin);
    await waitFor(() => expect(lastQuery().params).toMatchObject({ slMin: 150, slMax: 0, tgtMin: 150, tgtMax: 0 }));
    expect(range.getByText('Taken: SL ≥ 150 pts · TGT ≥ 150 pts')).toBeInTheDocument();
    getSignalBacktest.mockResolvedValue({ ...RESULT, params: { ...RESULT.params, slMin: 150, tgtMin: 150 }, skipped: { ...RESULT.skipped, distance: 77 } });
    fireEvent.change(range.getByLabelText('TGT at most, points'), { target: { value: '900' } });
    fireEvent.keyDown(range.getByLabelText('TGT at most, points'), { key: 'Enter' });
    await waitFor(() => expect(lastQuery().params.tgtMax).toBe(900));
    expect(await screen.findByText(/77 with the SL or TGT outside the range set/)).toBeInTheDocument();
    expect(screen.getAllByText(/· SL ≥ 150, TGT ≥ 150 ≤ 900 pts/).length).toBe(2);       // on the result, and on the settings' own line
    fireEvent.click(range.getByRole('button', { name: 'Turn the range off' }));
    await waitFor(() => expect(lastQuery().params).toMatchObject({ slMin: 0, slMax: 0, tgtMin: 0, tgtMax: 0 }));
  });

  it('[critical] a saved backtest put on the screen: the SL / TGT fields show its range, not the last one\'s (15 Oct 2026)', async () => {
    window.localStorage.setItem('btc-desk:savedBacktests.listOpen.phone', 'true');
    const saved = (id: string, name: string, params: object) => ({ id, name, query: { params: { ...RESULT.params, slMax: 0, tgtMax: 0, vol: 'off', minPremium: 10, ...params }, tfs: [], methods: [], strategy: null }, createdAt: 1, updatedAt: 1 });
    saves.getBacktestSaves.mockResolvedValue({ saves: [saved('a', 'Wide', { slMin: 250, tgtMin: 100 }), saved('b', 'Near', { slMin: 200, tgtMin: 200 })], portfolios: [] });
    show();
    await screen.findByText('Backtest result');
    const range = () => within(screen.getByRole('region', { name: 'SL and TGT range' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Run Wide' }));
    await waitFor(() => expect(range().getByLabelText('SL at least, points')).toHaveValue(250));
    expect(range().getByLabelText('TGT at least, points')).toHaveValue(100);
    fireEvent.click(screen.getByRole('button', { name: 'Run Near' }));
    await waitFor(() => expect(range().getByLabelText('SL at least, points')).toHaveValue(200));
    expect(range().getByLabelText('TGT at least, points')).toHaveValue(200);
    // and leaving a field puts back nothing stale
    fireEvent.blur(range().getByLabelText('SL at least, points'));
    expect(lastQuery().params).toMatchObject({ slMin: 200, tgtMin: 200 });
  });

  it('[critical] the no-entry window: the strategy form\'s own, in the settings -- sent, said in the result, kept with a saved backtest (15 Oct 2026)', async () => {
    show();
    await screen.findByText('Backtest result');
    const taken = within(screen.getByRole('region', { name: 'Which signals are taken' }));
    const sw = taken.getByRole('switch', { name: /No-entry window/ });
    expect(sw).not.toBeChecked();
    expect(lastQuery().params.noEntry?.on ?? false).toBe(false);
    fireEvent.click(sw);
    // on: one window to begin with, inside the desk's hours, and asked for
    await waitFor(() => expect(lastQuery().params.noEntry?.on).toBe(true));
    const w = lastQuery().params.noEntry!.windows;
    expect(w).toHaveLength(1);
    expect(taken.getByText(/^No new entry .* IST\. From the until time, signals are taken again\.$/)).toBeInTheDocument();
    expect(screen.getAllByText(/· no entry \d{1,2}:\d{2} [AP]M – \d{1,2}:\d{2} [AP]M/).length).toBeGreaterThan(0);
    // another window, then the first taken away: what is asked follows
    fireEvent.click(taken.getByRole('button', { name: '+ Add another window' }));
    await waitFor(() => expect(lastQuery().params.noEntry!.windows).toHaveLength(2));
    fireEvent.click(taken.getByRole('button', { name: 'Remove no-entry window 1' }));
    await waitFor(() => expect(lastQuery().params.noEntry!.windows).toHaveLength(1));
    // switched off: the times kept for switching back on, none applied
    fireEvent.click(taken.getByRole('switch', { name: /No-entry window/ }));
    await waitFor(() => expect(lastQuery().params.noEntry?.on).toBe(false));
    expect(lastQuery().params.noEntry!.windows).toHaveLength(1);
  });

  it('[critical] the margin: the most at once, the result on it, an average day\'s most -- and when, with how many open', async () => {
    show();
    const panel = within((await screen.findByText('Backtest result')).closest('section, div')!.parentElement!);
    const tile = (label: string) => panel.getByText(label).parentElement!.textContent!.replace(label, '');
    expect(tile('Margin at most')).toMatch(/^₹25,500/);                 // $300 at ₹85
    expect(tile('On that margin')).toBe('−40.0%');                      // −$120 on $300
    expect(tile("A day's most, average")).toMatch(/^₹17,000/);
    // and its working, to be multiplied out by whoever reads it: 58 trades of ten lots, $300 over 580 lots
    expect(panel.getByText(/The working:/).parentElement!.textContent).toContain('The working: 58 trades of 580 lots together × ₹43.97 a lot (BTC ÷ 200 × 0.001, at 200x) = ₹25,500.');
    expect(panel.getByText(/the most at once was 58 trades open at 4:29 AM on the Tue 13 Oct expiry; a trade held ₹442/)).toBeInTheDocument();
  });

  it('[critical] the settings in sections, folded to one line on a phone and open in a column of their own on the desk; the filters always open', async () => {
    const phone = show();
    await screen.findByText('Backtest result');
    const settings = within(screen.getByRole('complementary', { name: 'Backtest settings' }));
    for (const name of ['What to backtest', 'Strike and exits', 'Which signals are taken', 'Filters']) expect(settings.getByRole('region', { name })).toBeInTheDocument();
    // folded on a phone to begin with: what the result is of, in a line, and Change
    const toggle = settings.getByRole('button', { name: 'Change' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(settings.getByText('delta ≤ 0.10 · 10 lots · TGT 90% · SL +300% · 9:30 PM → 3:59 PM · no open limit')).toBeInTheDocument();
    expect(settings.getByRole('region', { name: 'What to backtest' }).parentElement).toHaveClass('hidden');
    expect(settings.getByRole('region', { name: 'Filters' }).parentElement).not.toHaveClass('hidden');
    fireEvent.click(toggle);
    expect(settings.getByRole('button', { name: 'Hide' })).toHaveAttribute('aria-expanded', 'true');
    expect(settings.getByRole('region', { name: 'What to backtest' }).parentElement).not.toHaveClass('hidden');
    // the line follows the settings
    fireEvent.click(within(settings.getByRole('group', { name: 'Lots a signal' })).getByRole('button', { name: '16' }));
    fireEvent.click(settings.getByRole('button', { name: 'Savings · 58 · CE 80% · PE 80%' }));
    expect(settings.getByText('delta ≤ 0.10 · 16 lots · TGT 90% · SL +300% · 9:30 PM → 3:59 PM · at most 58 open · CE 80% · PE 80%')).toBeInTheDocument();
    phone.unmount();
    // the desk: open to begin with, and remembered apart from the phone's
    show(true);
    await screen.findByText('Backtest result');
    expect(screen.getByRole('button', { name: 'Hide' })).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('complementary', { name: 'Backtest settings' })).toHaveClass('xl:sticky');
  });

  it('[critical] each section of the settings folds to a line of what it is set to; all fold and open in one tap, and are remembered (16 Oct 2026)', async () => {
    show(true);
    await screen.findByText('Backtest result');
    const settings = within(screen.getByRole('complementary', { name: 'Backtest settings' }));
    const strike = () => within(settings.getByRole('region', { name: 'Strike and exits' }));
    fireEvent.click(strike().getByRole('button', { name: 'Strike and exits', expanded: true }));
    expect(strike().queryByRole('group', { name: 'Lots a signal' })).toBeNull();
    expect(strike().getByLabelText('Strike and exits: as set')).toHaveTextContent(/^delta ≤ 0\.10 · TGT 90% · SL \+300% · 10 lots · min \$10$/);
    fireEvent.click(settings.getByRole('button', { name: 'Fold all' }));
    expect(settings.getByLabelText('Filters: as set')).toHaveTextContent('every time frame · every method');
    expect(settings.getByLabelText('Which signals are taken: as set')).toBeInTheDocument();
    expect(Object.entries(window.localStorage).some(([k, v]) => k.endsWith('signalBacktest.sectionsShut') && v.includes('Filters'))).toBe(true);
    fireEvent.click(settings.getByRole('button', { name: 'Open all' }));
    expect(strike().getByRole('group', { name: 'Lots a signal' })).toBeInTheDocument();
  });

  it('[critical] the target: fixed or dynamic first -- dynamic takes a strategy\'s own steps at once, another\'s on a tap, or yours typed', async () => {
    getSignalBacktest.mockResolvedValue({ ...RESULT, strategies: [
      ...RESULT.strategies,
      { id: '4h-time', name: '4h time', enabled: true, account: 'Savings', methods: ['gamma'], tfs: ['4h'], target: { pct: 0.7, steps: [{ at: '23:30', pct: 0.73 }, { at: '01:30', pct: 0.76 }, { at: '15:30', pct: 0.97 }] } },
    ] });
    show();
    await screen.findByText('Backtest result');
    // fixed to begin with: the chips
    expect(screen.getByRole('radio', { name: 'One target all day' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('group', { name: "The option's own target, of the premium kept" })).toBeInTheDocument();
    // dynamic: the first switched-on strategy's steps, in use at once -- nothing made up, nothing to fill in
    fireEvent.click(screen.getByRole('radio', { name: 'A target that moves by the clock' }));
    await waitFor(() => expect(lastQuery().params).toMatchObject({ targetPct: 0.7, targetSteps: [{ at: '23:30', pct: 0.75 }, { at: '03:30', pct: 0.85 }] }));
    expect(screen.queryByRole('group', { name: "The option's own target, of the premium kept" })).not.toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Ready schedules' })).not.toBeInTheDocument();
    const whose = screen.getByLabelText('Whose target steps');
    expect([...whose.querySelectorAll('option')].map((o) => o.textContent)).toEqual(['1h time · Savings · 70% → 85%, 2 steps', '4h time · Savings · 70% → 97%, 3 steps']);
    expect(whose).toHaveValue('0');
    expect(screen.getByLabelText('Step 2 time, IST')).toHaveValue('03:30');
    expect(screen.getByText(/^In use\./)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Use these steps' })).not.toBeInTheDocument();
    expect(screen.getAllByText(/70% → 85% by time \(2 steps\)/).length).toBeGreaterThan(0);
    // another strategy's, on a tap
    fireEvent.change(whose, { target: { value: '1' } });
    await waitFor(() => expect(lastQuery().params.targetSteps?.length).toBe(3));
    expect(screen.getByLabelText('Step 3 per cent')).toHaveValue(97);
    // your own: typed, checked, and used with a tap; a time out of order is put in the day's order
    fireEvent.change(screen.getByLabelText('Step 3 per cent'), { target: { value: '150' } });
    expect(screen.getByRole('alert')).toHaveTextContent('Each step keeps from 1% to 99% of the premium.');
    expect(screen.getByRole('button', { name: 'Use these steps' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Step 3 per cent'), { target: { value: '90' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add a step' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Give every step a time.');
    fireEvent.change(screen.getByLabelText('Step 4 time, IST'), { target: { value: '21:30' } });
    fireEvent.change(screen.getByLabelText('Step 4 per cent'), { target: { value: '72' } });
    expect(screen.getByText('Changed: not in use yet.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Use these steps' }));
    await waitFor(() => expect(lastQuery().params.targetSteps).toEqual([{ at: '21:30', pct: 0.72 }, { at: '23:30', pct: 0.73 }, { at: '01:30', pct: 0.76 }, { at: '15:30', pct: 0.9 }]));
    expect(screen.getByLabelText('Whose target steps')).toHaveValue('');
    // back to fixed: the steps go
    fireEvent.click(screen.getByRole('radio', { name: 'One target all day' }));
    await waitFor(() => expect(lastQuery().params.targetSteps).toBeUndefined());
    expect(screen.getByRole('group', { name: "The option's own target, of the premium kept" })).toBeInTheDocument();
  });

  it('with no strategy that has target steps, dynamic opens empty with a ready schedule to start from -- and nothing is backtested until one is used', async () => {
    getSignalBacktest.mockResolvedValue({ ...RESULT, strategies: RESULT.strategies.map((x) => ({ ...x, target: { pct: 0.9, steps: [] } })) });
    show();
    await screen.findByText('Backtest result');
    fireEvent.click(screen.getByRole('radio', { name: 'A target that moves by the clock' }));
    expect(lastQuery().params.targetSteps).toBeUndefined();
    expect(screen.getByRole('alert')).toHaveTextContent('Add at least one step, or choose Fixed.');
    fireEvent.click(within(screen.getByRole('group', { name: 'Ready schedules' })).getByRole('button', { name: '70% → 97%' }));
    expect(screen.getByLabelText('Step 1 per cent')).toHaveValue(73);
    expect(screen.getByLabelText('Step 9 per cent')).toHaveValue(97);
    fireEvent.click(screen.getByRole('button', { name: 'Use these steps' }));
    await waitFor(() => expect(lastQuery().params).toMatchObject({ targetPct: 0.7, targetSteps: expect.arrayContaining([{ at: '15:30', pct: 0.97 }]) }));
  });

  it('[critical] the volatility filter: off to begin with, one tap asks for a level, and the result says what it left out and shows each level', async () => {
    show();
    await screen.findByText('Backtest result');
    const group = screen.getByRole('radiogroup', { name: 'Volatility when the signal fills' });
    expect(within(group).getByRole('radio', { name: 'Volatility filter off: every signal' })).toBeChecked();
    expect(lastQuery().params.vol).toBeUndefined();
    expect(screen.queryByText('By volatility when the signal filled')).toBeNull();

    getSignalBacktest.mockResolvedValue({ ...RESULT, params: { ...RESULT.params, vol: 'high' }, signals: 1_400, total: { ...TOTAL, n: 200 },
      skipped: { ...RESULT.skipped, 'outside-window': 300, volatility: 800, 'no-strike': 95, 'no-exit-price': 5 },
      byVol: [row('high', 'High volatility', { n: 200, wins: 90, losses: 110, net: -20, won: 30, lost: 50, perpPts: 900 })] });
    fireEvent.click(within(group).getByRole('radio', { name: 'Only signals in high volatility' }));
    await waitFor(() => expect(lastQuery().params.vol).toBe('high'));
    expect(await screen.findByText(/1,400 signals went in the trade; 200 were traded here\. Not traded: 300 outside the hours chosen, 800 not in high volatility, 95 with no strike/)).toBeInTheDocument();
    expect(rowsOf('Backtest by volatility')).toEqual(['High volatility20045%₹₹charges ₹']);

    fireEvent.click(within(group).getByRole('radio', { name: 'Volatility filter off: every signal' }));
    await waitFor(() => expect(lastQuery().params.vol).toBe('off'));
  });

  it('[critical] a strike rule by time of day, as the strategy form\'s: the rule above is block 1, blocks after it sent with the backtest -- only while right for the hours', async () => {
    show();
    await screen.findByText('Backtest result');
    const blocks = () => screen.getByRole('region', { name: 'strike rule over the window' });
    expect(blocks().textContent).toMatch(/The strike rule above: delta ≤ 0\.10, from the start of the hours/);
    expect(lastQuery().params.strikeBlocks).toBeUndefined();
    fireEvent.click(within(blocks()).getByRole('checkbox', { name: 'Different strike rule by time of day' }));
    // The desk's hours, 9:30 PM to 3:59 PM, cut every 4 hours: 5 blocks, the first the rule above.
    await waitFor(() => expect(lastQuery().params.strikeBlocks?.length).toBe(4));
    expect(lastQuery().params.strikeBlocks!.map((b: { at: string }) => b.at)).toEqual(['01:30', '05:30', '09:30', '13:30']);
    expect(within(blocks()).getByText(/5 blocks from 9:30 PM to 3:59 PM/)).toBeInTheDocument();
    // Block 2 by premium: sent as the block's own rule.
    fireEvent.click(within(within(blocks()).getByRole('listitem', { name: 'block 2' })).getByRole('radio', { name: /By premium/ }));
    await waitFor(() => expect(lastQuery().params.strikeBlocks![0]!.strikeRule).toBe('premium'));
    // "Apply to all" from block 1 copies the rule above to every block.
    fireEvent.click(within(blocks()).getByRole('button', { name: 'apply block 1 to all 5 blocks' }));
    await waitFor(() => expect(lastQuery().params.strikeBlocks!.every((b: { strikeRule: string; delta?: { max: number } | null }) => b.strikeRule === 'delta' && b.delta?.max === 0.1)).toBe(true));
    // One rule all day again: no blocks sent.
    fireEvent.click(within(blocks()).getByRole('checkbox', { name: 'Same strike rule all the time' }));
    await waitFor(() => expect(lastQuery().params.strikeBlocks).toBeUndefined());
  });

  it('[critical] volatility by ATR 2h to begin with; ATM IV is one tap, sent with the backtest and said in its words -- and the SL study is asked for, never run on its own', async () => {
    show();
    await screen.findByText('Backtest result');
    const by = screen.getByRole('radiogroup', { name: 'Volatility is read by' });
    expect(within(by).getByRole('radio', { name: /two hours of 15-minute ATR/ })).toBeChecked();
    expect(lastQuery().params.volBy).toBeUndefined();
    expect(screen.getByText(/low is under 0\.8×, high over 1\.3×/)).toBeInTheDocument();
    fireEvent.click(within(by).getByRole('radio', { name: /at-the-money implied volatility/ }));
    await waitFor(() => expect(lastQuery().params.volBy).toBe('iv'));
    expect(screen.getByText(/same hour of the five expiry days before.*unknown, never low/)).toBeInTheDocument();
    fireEvent.click(within(by).getByRole('radio', { name: /two hours of 15-minute ATR/ }));
    await waitFor(() => expect(lastQuery().params.volBy).toBeUndefined());
    // The study's panel is there, with a chip to it, and nothing is asked of the server until Compare.
    expect(screen.getByRole('button', { name: 'By volatility' })).toBeInTheDocument();
    expect(screen.getByText('By volatility · SL, delta, lots · research')).toBeInTheDocument();
    expect(getVolStudy).not.toHaveBeenCalled();
  });

  it('[critical] every part of the result folds by its heading; Collapse all and Expand all; kept in this browser', async () => {
    const first = show();
    await screen.findByText('Backtest result');
    const heading = (name: RegExp) => screen.getByRole('button', { name });
    expect(heading(/^Backtest result$/)).toHaveAttribute('aria-expanded', 'true');
    expect(heading(/^Closed by which exit$/)).toHaveAttribute('aria-expanded', 'true');
    // One part shut: its body goes, its heading stays to open it again.
    fireEvent.click(heading(/^Closed by which exit$/));
    expect(heading(/^Closed by which exit$/)).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('table', { name: 'Backtest: which exit closed the trades' })).toBeNull();
    expect(heading(/^Backtest result$/)).toHaveAttribute('aria-expanded', 'true');
    // Every part at once, the research panel and the live check too.
    fireEvent.click(screen.getByRole('button', { name: 'Collapse all' }));
    for (const n of [/^Backtest result$/, /^By time frame$/, /^By volatility · SL, delta, lots · research$/, /^Live check · /]) expect(heading(n)).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByRole('button', { name: 'Collapse all' })).toBeDisabled();
    fireEvent.click(heading(/^By time frame$/));
    expect(heading(/^By time frame$/)).toHaveAttribute('aria-expanded', 'true');
    // Kept: the screen opens again as it was left.
    first.unmount();
    show();
    await screen.findByText('Backtest result');
    expect(heading(/^Backtest result$/)).toHaveAttribute('aria-expanded', 'false');
    expect(heading(/^By time frame$/)).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Expand all' }));
    expect(heading(/^Backtest result$/)).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('table', { name: 'Backtest: which exit closed the trades' })).toBeInTheDocument();
    // The settings column is not part of the result: its own folds, untouched.
    expect(screen.queryByRole('button', { name: /^Settings$/, expanded: false })).toBeNull();
  });

  it('[critical] says what the options were priced on -- the desk\'s 1-minute record, Delta\'s 1-minute mark, or 5-minute prices -- and each expiry day with it', async () => {
    getSignalBacktest.mockResolvedValue({ ...RESULT, priced: { 'own-1m': 1, 'mark-1m': 10, '5m': 2 }, days: RESULT.days.map((d, i) => ({ ...d, grain: i ? '5m' : 'mark-1m' })) });
    const first = show();
    expect(await screen.findByText("Option prices a minute at a time on 11 of 13 days: 1 day on the desk's own 1-minute record, 10 days on Delta's 1-minute mark with the desk's recorded spread (an estimate). The other 2 days on 5-minute prices -- a day still running, or one whose 1-minute prices are still being fetched from Delta.")).toBeInTheDocument();
    expect(rowsOf('Backtest by expiry day').map((x) => x.split(/\d{3}/)[0])).toEqual(['Tue 13 Oct · so far · 5m prices', 'Mon 12 Oct · 1m est.']);
    first.unmount();

    getSignalBacktest.mockResolvedValue({ ...RESULT, priced: { 'own-1m': 13, 'mark-1m': 0, '5m': 0 } });
    const second = show();
    expect(await screen.findByText("Option prices a minute at a time: 13 days on the desk's own 1-minute record.")).toBeInTheDocument();
    second.unmount();

    // an older server says nothing about it: nothing is claimed
    getSignalBacktest.mockResolvedValue(RESULT);
    show();
    await screen.findByText('Backtest result');
    expect(screen.queryByText(/Option prices/)).toBeNull();
  });

  it('[critical] a table row folds to two lines under 640px -- the name with the net beside it, trades and share won beneath -- so no table is wider than a phone', async () => {
    show();
    await screen.findByText('Backtest result');
    for (const name of ['Backtest: methods in profit', 'Backtest: methods in loss', 'Backtest by time frame', 'Backtest by expiry day', 'Backtest: which exit closed the trades']) {
      const table = screen.queryByRole('table', { name });
      if (!table) continue;
      const row = within(table).getAllByRole('row')[1]!;
      expect(row.className).toContain('max-sm:grid');
      const head = within(row).getByRole('rowheader');
      // the page's own header cells never wrap: a row's name must
      expect(head.className).toContain('whitespace-normal');
      expect(head.className).toContain('max-sm:col-span-2');
      const cells = within(row).getAllByRole('cell');
      expect(cells.map((c) => /max-sm:row-start-(\d)/.exec(c.className)?.[1])).toEqual(['2', '2', '1']);
      expect(cells[2]!.className).toContain('max-sm:row-span-2');
    }
    expect(screen.getByRole('table', { name: 'Backtest: methods in loss' }).className).toContain('max-sm:block');
  });

  it('nothing traded says so; a backtest that cannot be read says why; a first read says it takes a moment', async () => {
    getSignalBacktest.mockResolvedValue({ ...RESULT, total: tot(), signals: 300, skipped: { ...RESULT.skipped, 'no-strike': 0, 'no-exit-price': 0 }, pairs: [], byTf: [], days: [], byFamily: [], byPattern: [] });
    const { unmount } = show();
    expect(await screen.findByText('No signal could be traded with these settings in this range.')).toBeInTheDocument();
    expect(screen.queryByText("When the perp's SL was hit")).not.toBeInTheDocument();
    unmount();
    getSignalBacktest.mockReturnValue(new Promise(() => {}));
    const waiting = show();
    expect(screen.getByText('Reading the backtest (a first read of a range takes a few seconds)…')).toBeInTheDocument();
    waiting.unmount();
    getSignalBacktest.mockRejectedValue(new Error('the desk is restarting'));
    show();
    expect(await screen.findByText(/Could not read the backtest .*: the desk is restarting/)).toBeInTheDocument();
  });

  it('[critical] on the phone under More, and on the desk it says where it begins', async () => {
    const phone = render(<PhoneContext.Provider value={{ now: NOW, accountParam: 2 } as PhoneData}><BacktestScreen /></PhoneContext.Provider>);
    await screen.findByText('Backtest result');
    expect(lastQuery()).toMatchObject({ from: '2026-10-01', to: '2026-10-13' });
    expect(screen.queryByRole('heading', { level: 2, name: /^Backtest ·/ })).not.toBeInTheDocument();
    phone.unmount();
    show(true);
    expect(await screen.findByRole('heading', { level: 2, name: /^Backtest ·/ })).toBeInTheDocument();
  });

  it('[critical] the minimum premium: $10 to begin with, another floor on a tap or typed, 0 or Off for none -- asked for, and said', async () => {
    show();
    await screen.findByText('Backtest result');
    const row = screen.getByRole('group', { name: 'Minimum premium: sell only for at least' });
    expect(within(row).getByRole('button', { name: '$10' })).toHaveAttribute('aria-pressed', 'true');
    expect(lastQuery().params.minPremium).toBeUndefined();
    expect(screen.getByText('A strike bid under $10 when the signal fills is not sold: the signal is counted as "no strike".')).toBeInTheDocument();

    fireEvent.click(within(row).getByRole('button', { name: '$20' }));
    await waitFor(() => expect(lastQuery().params.minPremium).toBe(20));
    expect(screen.getByText(/95 with no strike inside the rule worth \$20/)).toBeInTheDocument();

    // off: no floor at all, and the line that counts the signals says no worth
    fireEvent.click(within(row).getByRole('button', { name: 'Off' }));
    await waitFor(() => expect(lastQuery().params.minPremium).toBe(0));
    expect(screen.getByText('Off: any strike with a bid is sold, however little it pays. Type 0 for off, a number for a floor.')).toBeInTheDocument();
    expect(screen.getByText(/95 with no strike inside the rule, 5 with no price/)).toBeInTheDocument();

    // typed: 12.5 dollars
    fireEvent.click(within(row).getByRole('button', { name: /^Custom/ }));
    fireEvent.change(screen.getByRole('spinbutton', { name: /Minimum premium/ }), { target: { value: '12.5' } });
    fireEvent.click(screen.getByRole('button', { name: 'Use' }));
    await waitFor(() => expect(lastQuery().params.minPremium).toBe(12.5));
  });

  it('[critical] a day on average: over the expiry days that traded, and the days in profit and the days in loss each on their own', async () => {
    show();
    const panel = within((await screen.findByText('Backtest result')).closest('section, div')!.parentElement!);
    // 12 Oct +$40, 13 Oct -$160: -$120 over two days
    const tile = (label: string) => panel.getByText(label).parentElement!.textContent!.replace(label, '');
    expect(tile('A day, on average · 2 days')).toBe('−₹5,100');           // -$60 at ₹85
    expect(tile('A day in profit · 1 day')).toBe('+₹3,400');
    expect(tile('A day in loss · 1 day')).toBe('−₹13,600');
  });

  it('[critical] saved backtests: the settings on the screen kept by name, put back on a tap, and two run together with their total above the result', async () => {
    window.localStorage.setItem('btc-desk:savedBacktests.listOpen.phone', 'true');   // the list open, as a phone keeps it once opened
    const saved = (id: string, name: string, params: object, tfs: string[] = []) => ({ id, name, query: { params: { ...RESULT.params, slMin: 0, slMax: 0, tgtMin: 0, tgtMax: 0, vol: 'off', minPremium: 10, ...params }, tfs, methods: [], strategy: null }, createdAt: 1, updatedAt: 1 });
    const A = saved('a1', 'Desk rules', {});
    saves.getBacktestSaves.mockResolvedValue({ saves: [], portfolios: [] });
    saves.saveBacktest.mockImplementation(async () => { saves.getBacktestSaves.mockResolvedValue({ saves: [A], portfolios: [] }); return { ok: true, save: A }; });
    show();
    await screen.findByText('Backtest result');
    const panel = () => within(screen.getByText('Saved backtests').closest('section, div')!.parentElement!);
    expect(await panel().findByText(/Nothing saved yet\./)).toBeInTheDocument();

    // kept by name: what is asked to be saved is what is on the screen
    fireEvent.change(panel().getByLabelText('Name for the saved backtest'), { target: { value: 'Desk rules' } });
    fireEvent.click(panel().getByRole('button', { name: 'Save' }));
    expect(await panel().findByText('Saved as "Desk rules".')).toBeInTheDocument();
    expect(saves.saveBacktest.mock.calls[0]![0]).toMatchObject({ name: 'Desk rules', query: { params: { rule: 'delta', value: 0.1, lots: 10 }, tfs: [], methods: [], strategy: null } });
    expect(await panel().findByText(/The settings on the screen are saved as/)).toHaveTextContent('saved as Desk rules.');
    expect(panel().getByRole('button', { name: 'Run Desk rules' })).toHaveTextContent('Desk rules · on the screendelta ≤ 0.10 · 10 lots · TGT 90% · SL +300% · 9:30 PM → 3:59 PM · no open limit');
  });

  it('[critical] a saved backtest tapped puts its settings on the screen; two ticked are run together, and the set kept as a portfolio', async () => {
    window.localStorage.setItem('btc-desk:savedBacktests.listOpen.phone', 'true');   // the list open, as a phone keeps it once opened
    const saved = (id: string, name: string, params: object, tfs: string[] = []) => ({ id, name, query: { params: { ...RESULT.params, slMin: 0, slMax: 0, tgtMin: 0, tgtMax: 0, vol: 'off', minPremium: 10, ...params }, tfs, methods: [], strategy: null }, createdAt: 1, updatedAt: 1 });
    const A = saved('a1', 'Desk rules', {}), B = saved('b2', '16 lots on 4h', { lots: 16 }, ['4h']);
    saves.getBacktestSaves.mockResolvedValue({ saves: [B, A], portfolios: [] });
    const member = (m: typeof A, n: number, net: number) => ({ id: m.id, name: m.name, problem: null, signals: n + 10, total: tot({ n, wins: Math.round(n / 2), losses: n - Math.round(n / 2), net, won: Math.max(net, 0) + 10, lost: 10 - Math.min(net, 0), charges: 4 }), marginPeakUsd: 100, priced: null });
    saves.getBacktestPortfolio.mockResolvedValue({
      from: '2026-10-01', to: '2026-10-13', members: [member(B, 100, 30), member(A, 1_000, -120)],
      total: tot({ n: 1_100, wins: 550, losses: 550, net: -90, won: 40, lost: 130, charges: 8 }),
      days: [{ day: '2026-10-12', live: false, n: 700, wins: 350, net: 60, charges: 5, byMember: [20, 40] }, { day: '2026-10-13', live: true, n: 400, wins: 200, net: -150, charges: 3, byMember: [10, -160] }],
      margin: { peakUsd: 150, peakDay: '2026-10-13', peakAt: Date.parse('2026-10-13T04:29:00+05:30'), peakOpen: 61, avgDailyPeakUsd: 120, sumOfPeaksUsd: 200 },
      // The single backtest's breakdowns, of both together (17 Oct 2026).
      breakdown: { pairs: RESULT.pairs, byTf: RESULT.byTf, byMethod: RESULT.byMethod, byPattern: RESULT.byPattern, byFamily: RESULT.byFamily, byVol: [] },
      signals: 1_300, skipped: { ...RESULT.skipped, 'outside-window': 150, 'desk-limit': 50, 'no-strike': 0, 'no-exit-price': 0 },
    });
    show();
    await screen.findByText('Backtest result');
    const panel = () => within(screen.getByText('Saved backtests').closest('section, div')!.parentElement!);
    expect(await panel().findByRole('button', { name: 'Run 16 lots on 4h' })).toHaveTextContent('16 lots on 4hdelta ≤ 0.10 · 16 lots · TGT 90% · SL +300% · 9:30 PM → 3:59 PM · no open limit · on 4h');

    // tapped: its settings and its filter are the screen's, and the backtest is asked for them
    fireEvent.click(panel().getByRole('button', { name: 'Run 16 lots on 4h' }));
    await waitFor(() => expect([lastQuery().params.lots, lastQuery().tfs]).toEqual([16, ['4h']]));
    expect(panel().getByRole('button', { name: 'Run 16 lots on 4h' })).toHaveAttribute('aria-current', 'true');
    // changed after: it can be updated in place, or saved as another
    fireEvent.click(within(screen.getByRole('group', { name: 'Lots a signal' })).getByRole('button', { name: '1' }));
    expect(await panel().findByRole('button', { name: 'Or update “16 lots on 4h” to these settings' })).toBeInTheDocument();

    // the other section: one open at a time -- the single backtest's settings and result give way to the portfolios
    expect(panel().queryByRole('checkbox')).toBeNull();                                      // no ticks in the single backtest's list
    fireEvent.click(screen.getByRole('radio', { name: 'Saved backtests run together, and their total' }));
    expect(screen.queryByText('Backtest result')).toBeNull();
    expect(screen.queryByRole('complementary', { name: 'Backtest settings' })).toBeNull();
    expect(screen.getByText(/^Run a portfolio, or tick two or more saved backtests and run them together/)).toBeInTheDocument();
    const folio = () => within(screen.getByRole('complementary', { name: 'Portfolio' }));
    // two ticked: run together, over the days on the screen
    expect(await folio().findByText('Tick two or more to run them together and see what they come to as one.')).toBeInTheDocument();
    fireEvent.click(folio().getByRole('checkbox', { name: 'Run 16 lots on 4h together with others' }));
    fireEvent.click(folio().getByRole('checkbox', { name: 'Run Desk rules together with others' }));
    fireEvent.click(folio().getByRole('button', { name: 'Run these 2 together' }));
    // the panel is there at once, saying it is being worked out; then the result
    await screen.findByRole('table', { name: 'Run together: each saved backtest' });
    const run = within(screen.getByText('Run together · 16 lots on 4h + Desk rules').closest('section, div')!.parentElement!);
    // no saved backtest carries a limit here: the account's own -- Savings, 58 open, CE and PE 80% -- is the one shown and asked for
    expect(saves.getBacktestPortfolio).toHaveBeenLastCalledWith(['b2', 'a1'], { from: '2026-10-01', to: '2026-10-13' }, 'shared', { max: 58, ce: 80, pe: 80 }, { window: 'saved' }, {});
    // the days are chosen in this section too
    expect(folio().getByRole('radiogroup', { name: 'Expiry days' })).toBeInTheDocument();
    expect(run.getByText(/a trade$/).parentElement!.textContent).toMatch(/^−₹7,650 −₹[\d.]+ a trade$/);                 // -$90 together
    expect(rowsOf('Run together: each saved backtest')).toEqual(['16 lots on 4h10050%₹₹charges ₹', 'Desk rules1,00050%₹₹charges ₹']);
    expect(rowsOf('Run together: by expiry day').map((x) => x.split('%')[0])).toEqual(['Tue 13 Oct · so far400 ›50', 'Mon 12 Oct700 ›50']);
    // a day's count opens its trades, asked exactly as the run is
    saves.getPortfolioTrades.mockResolvedValue({ day: '2026-10-12', total: 0, trades: [] });
    // the expiry days are a panel of their own now, as in one backtest's result
    fireEvent.click(within(screen.getByRole('table', { name: 'Run together: by expiry day' })).getByRole('button', { name: 'See the 700 trades of Mon 12 Oct' }));
    await waitFor(() => expect(saves.getPortfolioTrades).toHaveBeenLastCalledWith({ day: '2026-10-12' }, ['b2', 'a1'], { from: '2026-10-01', to: '2026-10-13' }, 'shared', { max: 58, ce: 80, pe: 80 }, { window: 'saved' }, {}));
    fireEvent.click(await screen.findByRole('button', { name: 'close' }));
    const tile = (label: string) => run.getByText(label).parentElement!.textContent!.replace(label, '');
    expect([tile('Margin at most, together'), tile("Each one's most, added")]).toEqual(['₹12,750', '₹17,000']);
    expect(run.getByText(/the most held at once was 61 trades at 4:29 AM on the Tue 13 Oct expiry/)).toBeInTheDocument();
    // laid out as one backtest's result: the same summary lines, the jump bar, and the same breakdowns, each its own panel
    expect(run.getByText('Winners made')).toBeInTheDocument();
    expect(run.getByText(/1,300 signals went in the trade over all of them; 1,100 were traded here\. Not traded: 150 outside their hours, 50 while the account was full \(at most open\)\./)).toBeInTheDocument();
    const jump = screen.getAllByRole('navigation', { name: 'Jump to a part of the result' }).at(-1)!;
    expect(within(jump).getAllByRole('button').map((x) => x.textContent)).toEqual(['Summary', 'Exits & time frames', 'Pairs', 'Methods', 'Days', 'By volatility', 'Live check']);
    for (const name of ['Backtest: which exit closed the trades', 'Backtest by time frame', 'Backtest: methods in profit', 'Backtest by kind of day']) {
      expect(screen.getAllByRole('table', { name }).length, name).toBeGreaterThan(0);
    }

    // kept as a portfolio, and run again from its own row
    saves.savePortfolio.mockImplementation(async () => { saves.getBacktestSaves.mockResolvedValue({ saves: [B, A], portfolios: [{ id: 'p1', name: 'Both', saveIds: ['b2', 'a1'], createdAt: 1, updatedAt: 1 }] }); return { ok: true, portfolio: { id: 'p1', name: 'Both', saveIds: ['b2', 'a1'] } }; });
    fireEvent.change(folio().getByLabelText('Name for the portfolio'), { target: { value: 'Both' } });
    fireEvent.click(folio().getByRole('button', { name: 'Keep' }));
    expect(await folio().findByText('Kept as the portfolio "Both".')).toBeInTheDocument();
    expect(saves.savePortfolio).toHaveBeenCalledWith({ name: 'Both', saveIds: ['b2', 'a1'] });
    fireEvent.click(await folio().findByRole('button', { name: 'Run the portfolio Both' }));
    expect(await screen.findByText('Run together · Both')).toBeInTheDocument();
    expect(folio().getByText('Both · running')).toBeInTheDocument();
    // a day on average, as the single backtest says it: +$60 and -$150 over two days
    const dayTile = (label: string) => screen.getByText(label).parentElement!.textContent!.replace(label, '');
    expect([dayTile('A day, on average · 2 days'), dayTile('A day in profit · 1 day'), dayTile('A day in loss · 1 day')]).toEqual(['−₹3,825', '+₹5,100', '−₹12,750']);

    // back to the single backtest: its settings are as they were left, and a saved one is deleted there -- asked once more
    fireEvent.click(screen.getByRole('radio', { name: 'One backtest: its settings, filters and result' }));
    expect(await screen.findByText('Backtest result')).toBeInTheDocument();
    expect(screen.queryByText('Run together · Both')).toBeNull();                              // one section at a time
    saves.deleteBacktestSave.mockImplementation(async () => { saves.getBacktestSaves.mockResolvedValue({ saves: [A], portfolios: [] }); return { ok: true, portfoliosDeleted: ['Both'] }; });
    fireEvent.click(await panel().findByRole('button', { name: 'Delete 16 lots on 4h' }));
    expect(saves.deleteBacktestSave).not.toHaveBeenCalled();
    fireEvent.click(panel().getByRole('button', { name: 'Delete' }));
    expect(await panel().findByText('Deleted "16 lots on 4h". The portfolio "Both" had fewer than two left and went with it.')).toBeInTheDocument();
    // and the run of what it was in is closed with it
    fireEvent.click(screen.getByRole('radio', { name: 'Saved backtests run together, and their total' }));
    expect(screen.queryByText('Run together · Both')).toBeNull();
    expect(await folio().findByText(/A portfolio is two saved backtests or more, run together\. Save them under Single backtest first -- there is one so far\./)).toBeInTheDocument();
  });

  it('[critical] a saved backtest edited: its settings go on the screen to be changed there, its name is changed beside them, and nothing is kept until Save changes', async () => {
    window.localStorage.setItem('btc-desk:savedBacktests.listOpen.phone', 'true');   // the list open, as a phone keeps it once opened
    const saved = (id: string, name: string, params: object, tfs: string[] = []) => ({ id, name, query: { params: { ...RESULT.params, slMin: 0, slMax: 0, tgtMin: 0, tgtMax: 0, vol: 'off', minPremium: 10, ...params }, tfs, methods: [], strategy: null }, createdAt: 1, updatedAt: 1 });
    const A = saved('a1', 'Desk rules', {}), B = saved('b2', '16 lots on 4h', { lots: 16 }, ['4h']);
    saves.getBacktestSaves.mockResolvedValue({ saves: [B, A], portfolios: [] });
    show();
    await screen.findByText('Backtest result');
    const panel = () => within(screen.getByText('Saved backtests').closest('section, div')!.parentElement!);

    fireEvent.click(await panel().findByRole('button', { name: 'Edit 16 lots on 4h' }));
    // its settings are the screen's now, and the backtest is asked for them
    await waitFor(() => expect([lastQuery().params.lots, lastQuery().tfs]).toEqual([16, ['4h']]));
    const form = () => within(panel().getByRole('form', { name: 'Edit 16 lots on 4h' }));
    expect(form().getByLabelText('Name of the saved backtest')).toHaveValue('16 lots on 4h');
    expect(form().getByText('Settings unchanged so far.')).toBeInTheDocument();
    expect(form().getByRole('button', { name: 'Save changes' })).toBeDisabled();           // nothing changed yet
    expect(panel().queryByLabelText('Name for the saved backtest')).toBeNull();            // not a new one: this one

    // one lot instead of sixteen, and another name
    fireEvent.click(within(screen.getByRole('group', { name: 'Lots a signal' })).getByRole('button', { name: '1' }));
    expect(await form().findByText(/^It will be: delta ≤ 0\.10 · 1 lot · TGT 90% · SL \+300% · 9:30 PM → 3:59 PM · no open limit · on 4h$/)).toBeInTheDocument();
    fireEvent.change(form().getByLabelText('Name of the saved backtest'), { target: { value: 'One lot on 4h' } });
    expect(saves.saveBacktest).not.toHaveBeenCalled();
    const after = { ...B, name: 'One lot on 4h', query: { ...B.query, params: { ...B.query.params, lots: 1 } } };
    saves.saveBacktest.mockImplementation(async () => { saves.getBacktestSaves.mockResolvedValue({ saves: [A, after], portfolios: [] }); return { ok: true, save: after }; });
    fireEvent.click(form().getByRole('button', { name: 'Save changes' }));
    expect(await panel().findByText('Saved the changes to "One lot on 4h" (it was "16 lots on 4h").')).toBeInTheDocument();
    expect(saves.saveBacktest.mock.calls[0]![0]).toMatchObject({ id: 'b2', name: 'One lot on 4h', query: { params: { lots: 1 }, tfs: ['4h'] } });
    expect(panel().queryByRole('form')).toBeNull();
    expect(panel().getByRole('button', { name: 'Run One lot on 4h' })).toHaveAttribute('aria-current', 'true');

    // Cancel keeps it as it was
    fireEvent.click(panel().getByRole('button', { name: 'Edit Desk rules' }));
    fireEvent.change(within(panel().getByRole('form', { name: 'Edit Desk rules' })).getByLabelText('Name of the saved backtest'), { target: { value: 'Something else' } });
    fireEvent.click(within(panel().getByRole('form', { name: 'Edit Desk rules' })).getByRole('button', { name: 'Cancel' }));
    expect(panel().queryByRole('form')).toBeNull();
    expect(saves.saveBacktest).toHaveBeenCalledTimes(1);

    // a name the desk will not take is said, and the edit stays open to put right
    saves.saveBacktest.mockRejectedValue(new Error('There is a saved backtest called "One lot on 4h" already: give this one another name, or update that one.'));
    fireEvent.click(panel().getByRole('button', { name: 'Edit Desk rules' }));
    fireEvent.change(within(panel().getByRole('form', { name: 'Edit Desk rules' })).getByLabelText('Name of the saved backtest'), { target: { value: 'One lot on 4h' } });
    fireEvent.click(within(panel().getByRole('form', { name: 'Edit Desk rules' })).getByRole('button', { name: 'Save changes' }));
    expect(await panel().findByRole('alert')).toHaveTextContent('There is a saved backtest called "One lot on 4h" already');
    expect(panel().getByRole('form', { name: 'Edit Desk rules' })).toBeInTheDocument();
  });

  it('[critical] a portfolio edited: its members are the ticks in the list, its name beside them -- two or more, kept on Save changes', async () => {
    const saved = (id: string, name: string) => ({ id, name, query: { params: { ...RESULT.params, slMin: 0, slMax: 0, tgtMin: 0, tgtMax: 0, vol: 'off', minPremium: 10, lots: id.length + 20 }, tfs: [], methods: [], strategy: null }, createdAt: 1, updatedAt: 1 });
    const all = [saved('a1', 'Alpha'), saved('b22', 'Beta'), saved('c333', 'Gamma')];
    const BOTH = { id: 'p1', name: 'Both', saveIds: ['a1', 'b22'], createdAt: 1, updatedAt: 1 };
    saves.getBacktestSaves.mockResolvedValue({ saves: all, portfolios: [BOTH] });
    saves.getBacktestPortfolio.mockResolvedValue({ from: '2026-10-01', to: '2026-10-13', members: [], total: tot(), days: [], margin: { peakUsd: 0, peakDay: null, peakAt: null, peakOpen: 0, avgDailyPeakUsd: 0, sumOfPeaksUsd: 0 } });
    show();
    await screen.findByText('Backtest result');
    fireEvent.click(screen.getByRole('radio', { name: 'Saved backtests run together, and their total' }));
    const panel = () => within(screen.getByRole('complementary', { name: 'Portfolio' }));
    const tick = (name: string) => panel().getByRole('checkbox', { name: `Run ${name} together with others` });

    // it is on the screen as a run, to see that the run follows the edit
    fireEvent.click(await panel().findByRole('button', { name: 'Run the portfolio Both' }));
    await screen.findByText('Run together · Both');

    fireEvent.click(panel().getByRole('button', { name: 'Edit the portfolio Both' }));
    const form = () => within(panel().getByRole('form', { name: 'Edit the portfolio Both' }));
    expect([tick('Alpha'), tick('Beta'), tick('Gamma')].map((c) => (c as HTMLInputElement).checked)).toEqual([true, true, false]);
    expect(form().getByLabelText('Name of the portfolio')).toHaveValue('Both');
    expect(form().getByText('In it: Alpha + Beta.')).toBeInTheDocument();
    expect(panel().queryByRole('button', { name: /^Run these/ })).toBeNull();               // editing, not starting another

    // one alone is not a portfolio
    fireEvent.click(tick('Beta'));
    expect(form().getByRole('alert')).toHaveTextContent('A portfolio is two saved backtests or more: tick another.');
    expect(form().getByRole('button', { name: 'Save changes' })).toBeDisabled();
    // Gamma in Beta's place, and another name
    fireEvent.click(tick('Gamma'));
    expect(form().getByText('In it: Alpha + Gamma.')).toBeInTheDocument();
    fireEvent.change(form().getByLabelText('Name of the portfolio'), { target: { value: 'Alpha and Gamma' } });
    const after = { ...BOTH, name: 'Alpha and Gamma', saveIds: ['a1', 'c333'] };
    saves.savePortfolio.mockImplementation(async () => { saves.getBacktestSaves.mockResolvedValue({ saves: all, portfolios: [after] }); return { ok: true, portfolio: after }; });
    fireEvent.click(form().getByRole('button', { name: 'Save changes' }));
    expect(await panel().findByText('Saved the changes to the portfolio "Alpha and Gamma" (it was "Both"): 2 saved backtests.')).toBeInTheDocument();
    expect(saves.savePortfolio).toHaveBeenCalledWith({ id: 'p1', name: 'Alpha and Gamma', saveIds: ['a1', 'c333'] });
    expect(panel().queryByRole('form')).toBeNull();
    // the run on the screen is of what the portfolio is now
    expect(await screen.findByText('Run together · Alpha and Gamma')).toBeInTheDocument();
    await waitFor(() => expect(saves.getBacktestPortfolio).toHaveBeenLastCalledWith(['a1', 'c333'], { from: '2026-10-01', to: '2026-10-13' }, 'shared', { max: 58, ce: 80, pe: 80 }, { window: 'saved' }, {}));

    // Cancel: as it was, and the ticks cleared
    fireEvent.click(panel().getByRole('button', { name: 'Edit the portfolio Alpha and Gamma' }));
    fireEvent.click(within(panel().getByRole('form', { name: 'Edit the portfolio Alpha and Gamma' })).getByRole('button', { name: 'Cancel' }));
    expect(panel().queryByRole('form')).toBeNull();
    expect([tick('Alpha'), tick('Gamma')].map((c) => (c as HTMLInputElement).checked)).toEqual([false, false]);
    expect(saves.savePortfolio).toHaveBeenCalledTimes(1);
  });

  it('[critical] a run together is held to one account\'s limit to begin with -- said, with how many it turned away -- or to each one\'s own on a tap', async () => {
    const saved = (id: string, name: string) => ({ id, name, query: { params: { ...RESULT.params, slMin: 0, slMax: 0, tgtMin: 0, tgtMax: 0, vol: 'off', minPremium: 10, deskMax: 120, cePct: 80, pePct: 80, lots: id.length }, tfs: [], methods: [], strategy: null }, createdAt: 1, updatedAt: 1 });
    const all = [saved('a1', 'Alpha'), saved('b22', 'Beta')];
    saves.getBacktestSaves.mockResolvedValue({ saves: all, portfolios: [{ id: 'p1', name: 'Both', saveIds: ['a1', 'b22'], createdAt: 1, updatedAt: 1 }] });
    const member = (id: string, name: string, n: number) => ({ id, name, problem: null, signals: n + 40, total: tot({ n, wins: n / 2, losses: n / 2, net: 10, won: 30, lost: 20, charges: 2 }), marginPeakUsd: 80, priced: null });
    const answer = (shared: object | null, open: number) => ({
      from: '2026-10-01', to: '2026-10-13', shared, members: [member('a1', 'Alpha', 200), member('b22', 'Beta', 100)],
      total: tot({ n: 300, wins: 150, losses: 150, net: 20, won: 60, lost: 40, charges: 4 }),
      days: [{ day: '2026-10-12', live: false, n: 300, wins: 150, net: 20, charges: 4, byMember: [10, 10] }],
      margin: { peakUsd: open, peakDay: '2026-10-12', peakAt: Date.parse('2026-10-12T09:15:00+05:30'), peakOpen: open, peakLots: open * 2, avgDailyPeakUsd: open, sumOfPeaksUsd: 160 },
    });
    saves.getBacktestPortfolio.mockImplementation(async (_ids: string[], _range: object, limit: string) => (limit === 'own' ? answer(null, 152) : answer({ max: 120, ce: 96, pe: 96, cePct: 80, pePct: 80, turnedAway: 37 }, 120)));
    show();
    await screen.findByText('Backtest result');
    fireEvent.click(screen.getByRole('radio', { name: 'Saved backtests run together, and their total' }));
    const folio = () => within(screen.getByRole('complementary', { name: 'Portfolio' }));
    expect(folio().getByRole('radio', { name: 'One account: one limit on open trades across all of them' })).toBeChecked();
    fireEvent.click(await folio().findByRole('button', { name: 'Run the portfolio Both' }));
    await screen.findByRole('table', { name: 'Run together: each saved backtest' });
    const run = () => within(screen.getByText('Run together · Both').closest('section, div')!.parentElement!);
    // the limit is on the screen, with the value it opens on: the ACCOUNT's own as it stands on the desk (Savings: 58 open,
    // CE and PE 80%) -- not the 120 typed into the saved backtests, which is offered beside it
    expect(saves.getBacktestPortfolio).toHaveBeenLastCalledWith(['a1', 'b22'], { from: '2026-10-01', to: '2026-10-13' }, 'shared', { max: 58, ce: 80, pe: 80 }, { window: 'saved' }, {});
    const capOf = () => within(folio().getByRole('group', { name: "One account's limit" }));
    expect([capOf().getByLabelText('At most open, together'), capOf().getByLabelText('CE max'), capOf().getByLabelText('PE max')].map((x) => (x as HTMLInputElement).value)).toEqual(['58', '80', '80']);
    expect(capOf().getByRole('status')).toHaveTextContent('The default: 58 open · CE 80% · PE 80% -- the account\'s own limit as it stands on the desk (the saved backtests\' own, where no account has one). Type another to try it.');
    const picks = () => within(capOf().getByRole('group', { name: 'Limits to take' }));
    expect(picks().getAllByRole('button').map((b) => [b.textContent, b.getAttribute('aria-pressed')])).toEqual([
      ['Savings · 58 · CE 80% · PE 80%', 'true'], ['Expenses · 35 · CE 80% · PE 80%', 'false'], ['Saved backtests · 120 · CE 80% · PE 80%', 'false'],
    ]);
    // one tap takes another: the saved backtests' own 120
    fireEvent.click(picks().getByRole('button', { name: 'Saved backtests · 120 · CE 80% · PE 80%' }));
    await waitFor(() => expect(saves.getBacktestPortfolio).toHaveBeenLastCalledWith(['a1', 'b22'], { from: '2026-10-01', to: '2026-10-13' }, 'shared', { max: 120, ce: 80, pe: 80 }, { window: 'saved' }, {}));
    expect((capOf().getByLabelText('At most open, together') as HTMLInputElement).value).toBe('120');
    // the working of the margin is said, to be multiplied out: 120 trades of 240 lots at $0.50 a lot
    expect(run().getByText(/The working:/).parentElement!.textContent).toContain('The working: 120 trades of 240 lots together × ₹42.50 a lot (BTC ÷ 200 × 0.001, at 200x) = ₹10,200.');

    // typed: 60 open, calls half of it -- asked for on leaving the field, and said as one's own, with the way back
    fireEvent.change(capOf().getByLabelText('At most open, together'), { target: { value: '60' } });
    fireEvent.change(capOf().getByLabelText('CE max'), { target: { value: '50' } });
    expect(saves.getBacktestPortfolio).toHaveBeenLastCalledWith(['a1', 'b22'], { from: '2026-10-01', to: '2026-10-13' }, 'shared', { max: 120, ce: 80, pe: 80 }, { window: 'saved' }, {});   // not yet
    fireEvent.blur(capOf().getByLabelText('CE max'));
    await waitFor(() => expect(saves.getBacktestPortfolio).toHaveBeenLastCalledWith(['a1', 'b22'], { from: '2026-10-01', to: '2026-10-13' }, 'shared', { max: 60, ce: 50, pe: 80 }, { window: 'saved' }, {}));
    expect(capOf().getByRole('status')).toHaveTextContent('Your own: 60 open · CE 50% · PE 80%. The default is 58 open · CE 80% · PE 80%. Default');
    // one that cannot be meant is said, and not asked for
    fireEvent.change(capOf().getByLabelText('At most open, together'), { target: { value: '0' } });
    fireEvent.blur(capOf().getByLabelText('At most open, together'));
    expect(capOf().getByRole('alert')).toHaveTextContent('At most open is a whole number from 1 to 500.');
    expect(saves.getBacktestPortfolio).toHaveBeenLastCalledWith(['a1', 'b22'], { from: '2026-10-01', to: '2026-10-13' }, 'shared', { max: 60, ce: 50, pe: 80 }, { window: 'saved' }, {});
    fireEvent.change(capOf().getByLabelText('At most open, together'), { target: { value: '60' } });
    // Default: back to the account's own
    fireEvent.click(capOf().getByRole('button', { name: 'Default' }));
    await waitFor(() => expect(saves.getBacktestPortfolio).toHaveBeenLastCalledWith(['a1', 'b22'], { from: '2026-10-01', to: '2026-10-13' }, 'shared', { max: 58, ce: 80, pe: 80 }, { window: 'saved' }, {}));
    expect((capOf().getByLabelText('At most open, together') as HTMLInputElement).value).toBe('58');
    expect(run().getByText(/2 saved backtests,/).textContent).toBe('Thu 1 Oct → Tue 13 Oct · 2 saved backtests, traded as one account: at most 120 open together (CE 96 · PE 96), the longer time frame first, as the desk takes them.');
    expect(run().getByText('37 signals found the account, or their side of it, full and were not traded.')).toBeInTheDocument();
    expect(run().getByText(/the most held at once was 120 trades at 9:15 AM on the Mon 12 Oct expiry -- never more than the account's 120 --/)).toBeInTheDocument();

    // each its own: asked again, and said -- with the warning that it may be more than one account holds
    fireEvent.click(folio().getByRole('radio', { name: 'Each saved backtest keeps its own limit' }));
    await waitFor(() => expect(saves.getBacktestPortfolio).toHaveBeenLastCalledWith(['a1', 'b22'], { from: '2026-10-01', to: '2026-10-13' }, 'own', null, { window: 'saved' }, {}));
    expect(folio().queryByRole('group', { name: "One account's limit" })).toBeNull();          // each its own: no shared limit to set
    expect(await screen.findByText(/2 saved backtests, each worked as it is alone and added up\./)).toBeInTheDocument();
    expect(run().getByText(/the most held at once was 152 trades .* Each kept its own limit here, so more may be open together than one account would hold: choose One account to hold them to one limit\./)).toBeInTheDocument();
    expect(run().queryByText(/found the account/)).toBeNull();
  });

  it('[critical] the hours of a run together: each as saved to begin with, or one choice for the run -- said over the result, with who kept their own', async () => {
    const saved = (id: string, name: string, strategy: string | null = null) => ({ id, name, query: { params: { ...RESULT.params, slMin: 0, slMax: 0, tgtMin: 0, tgtMax: 0, vol: 'off', minPremium: 10 }, tfs: [], methods: [], strategy }, createdAt: 1, updatedAt: 1 });
    saves.getBacktestSaves.mockResolvedValue({ saves: [saved('a1', 'Alpha'), saved('b22', 'Beta', 's1')], portfolios: [{ id: 'p1', name: 'Both', saveIds: ['a1', 'b22'], createdAt: 1, updatedAt: 1 }] });
    const member = (id: string, name: string) => ({ id, name, problem: null, signals: 50, total: tot({ n: 10, wins: 5, losses: 5, net: 1, won: 3, lost: 2, charges: 1 }), marginPeakUsd: 8, priced: null });
    saves.getBacktestPortfolio.mockImplementation(async (_i: string[], _r: object, _l: string, _c: object | null, hours: { window: string; hoursFrom?: string; hoursTo?: string }) => ({
      from: '2026-10-01', to: '2026-10-13', shared: null, members: [member('a1', 'Alpha'), member('b22', 'Beta')],
      hours: hours.window === 'saved' ? null : { ...hours, own: ['b22'] },
      total: tot({ n: 20, wins: 10, losses: 10, net: 2, won: 6, lost: 4, charges: 2 }), days: [],
      margin: { peakUsd: 0, peakDay: null, peakAt: null, peakOpen: 0, peakLots: 0, avgDailyPeakUsd: 0, sumOfPeaksUsd: 0 },
    }));
    show();
    await screen.findByText('Backtest result');
    fireEvent.click(screen.getByRole('radio', { name: 'Saved backtests run together, and their total' }));
    const folio = () => within(screen.getByRole('complementary', { name: 'Portfolio' }));
    const hours = () => within(folio().getByRole('radiogroup', { name: 'Which signals, for the run' }));
    // the same three choices as the single backtest, after the one it opens on
    expect(hours().getAllByRole('radio').map((r) => [r.textContent, (r as HTMLInputElement).checked ?? r.getAttribute('aria-checked')])).toHaveLength(4);
    expect(hours().getByRole('radio', { name: 'Each saved backtest keeps its own hours' })).toBeChecked();
    expect(folio().getByText('Each saved backtest keeps the hours saved in it.')).toBeInTheDocument();
    fireEvent.click(await folio().findByRole('button', { name: 'Run the portfolio Both' }));
    await screen.findByRole('table', { name: 'Run together: each saved backtest' });
    const last = () => saves.getBacktestPortfolio.mock.calls.at(-1)![4];
    expect(last()).toEqual({ window: 'saved' });
    expect(screen.queryByRole('note', { name: 'What this run was held to' })).toBeNull();
    // as saved is said as well: the result always names what it is of
    expect(screen.getByText(/Each saved backtest ran with its own hours and settings, as saved\./)).toBeInTheDocument();

    // the whole day, for the run: asked again, and said -- with the one a strategy works keeping its own
    fireEvent.click(hours().getByRole('radio', { name: 'Signals of the whole expiry day' }));
    await waitFor(() => expect(last()).toEqual({ window: 'all' }));
    expect(await screen.findByRole('note', { name: 'What this run was held to' })).toHaveTextContent(
      'Signals of the whole expiry day (IST) for this run, in place of each saved backtest\'s own hours.Everything else is each saved backtest\'s own. Nothing saved is changed. Beta is worked by a strategy and kept its strategy\'s own rules.');
    expect(folio().getByText(/These hours are put over every saved backtest in the run, for the run only/)).toBeInTheDocument();

    // custom: nothing is asked until both times are given
    const asks = saves.getBacktestPortfolio.mock.calls.length;
    fireEvent.click(hours().getByRole('radio', { name: 'Signals in hours of your own' }));
    fireEvent.change(folio().getByLabelText('From (IST)'), { target: { value: '22:00' } });
    fireEvent.change(folio().getByLabelText('To (IST)'), { target: { value: '02:00' } });
    expect(saves.getBacktestPortfolio.mock.calls.length).toBe(asks);
    fireEvent.click(folio().getByRole('button', { name: 'Use these hours' }));
    await waitFor(() => expect(last()).toEqual({ window: 'custom', hoursFrom: '22:00', hoursTo: '02:00' }));
    expect(await screen.findByRole('note', { name: 'What this run was held to' })).toHaveTextContent('Signals of 10:00 PM → 2:00 AM (IST) for this run');
    expect(folio().getByText('10:00 PM → 2:00 AM')).toBeInTheDocument();
    // kept in this browser, like the limit
    expect(JSON.parse(window.localStorage.getItem(Object.keys(window.localStorage).find((k) => k.endsWith('signalBacktest.together.hours'))!)!)).toEqual({ window: 'custom', hoursFrom: '22:00', hoursTo: '02:00' });

    // and back to each one's own
    fireEvent.click(hours().getByRole('radio', { name: 'Each saved backtest keeps its own hours' }));
    await waitFor(() => expect(last()).toEqual({ window: 'saved' }));
    await waitFor(() => expect(screen.queryByRole('note', { name: 'What this run was held to' })).toBeNull());
  });

  it('[critical] the settings of a run together: each a switch -- off, every saved backtest\'s own; on, that one put over them all for the run', async () => {
    const saved = (id: string, name: string) => ({ id, name, query: { params: { ...RESULT.params, slMin: 0, slMax: 0, tgtMin: 0, tgtMax: 0, vol: 'off', minPremium: 10 }, tfs: [], methods: [], strategy: null }, createdAt: 1, updatedAt: 1 });
    saves.getBacktestSaves.mockResolvedValue({ saves: [saved('a1', 'Alpha'), saved('b22', 'Beta')], portfolios: [{ id: 'p1', name: 'Both', saveIds: ['a1', 'b22'], createdAt: 1, updatedAt: 1 }] });
    const member = (id: string, name: string) => ({ id, name, problem: null, signals: 50, total: tot({ n: 10, wins: 5, losses: 5, net: 1, won: 3, lost: 2, charges: 1 }), marginPeakUsd: 8, priced: null });
    type Over = Record<string, Record<string, unknown>>;
    // The server says back what it put over the run: the switched-on settings, flat.
    saves.getBacktestPortfolio.mockImplementation(async (_i: string[], _r: object, _l: string, _c: object | null, _h: object, over: Over) => ({
      from: '2026-10-01', to: '2026-10-13', shared: null, members: [member('a1', 'Alpha'), member('b22', 'Beta')], hours: null,
      over: Object.keys(over).length ? { settings: Object.assign({}, ...Object.values(over)), own: [] } : null,
      total: tot({ n: 20, wins: 10, losses: 10, net: 2, won: 6, lost: 4, charges: 2 }), days: [],
      margin: { peakUsd: 0, peakDay: null, peakAt: null, peakOpen: 0, peakLots: 0, avgDailyPeakUsd: 0, sumOfPeaksUsd: 0 },
    }));
    show();
    await screen.findByText('Backtest result');
    fireEvent.click(screen.getByRole('radio', { name: 'Saved backtests run together, and their total' }));
    const folio = () => within(screen.getByRole('complementary', { name: 'Portfolio' }));
    const set = () => within(folio().getByRole('region', { name: 'Settings for the run' }));
    const sw = (name: string) => set().getByRole('switch', { name: `${name}, for the run` });
    const NAMES = ['Strike', 'Strike by time of day', 'Option target', 'Option stop', 'Lots a signal', 'Minimum premium', 'SL and TGT range', 'Volatility filter', 'No-entry window'];
    // every one off to begin with, each saying whose settings run
    expect(set().getAllByRole('switch').map((x) => [x.getAttribute('aria-label'), x.getAttribute('aria-checked')])).toEqual(NAMES.map((n) => [`${n}, for the run`, 'false']));
    expect(set().getAllByText('Off · each saved backtest’s own')).toHaveLength(9);
    expect(set().getByText('· all off')).toBeInTheDocument();
    expect(set().queryByRole('button', { name: 'Switch all off' })).toBeNull();
    // folded on a phone to begin with: one line of what the run is held to, and Change
    const held = () => folio().getByLabelText('What the run is held to');
    expect(held()).toHaveTextContent('Thu 1 Oct → Tue 13 Oct · hours as saved · one account: 58 open · CE 80% · PE 80% · settings as saved');
    const fold = folio().getByRole('button', { name: 'Change' });
    expect(fold).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(fold);
    expect(folio().getByRole('button', { name: 'Hide' })).toHaveAttribute('aria-expanded', 'true');
    expect(JSON.parse(window.localStorage.getItem(Object.keys(window.localStorage).find((k) => k.endsWith('signalBacktest.runOpen.phone'))!)!)).toBe(true);
    fireEvent.click(await folio().findByRole('button', { name: 'Run the portfolio Both' }));
    await screen.findByRole('table', { name: 'Run together: each saved backtest' });
    const last = () => saves.getBacktestPortfolio.mock.calls.at(-1)![5];
    expect(last()).toEqual({});

    // lots: switched on, it starts from the Single backtest section's own and is asked for at once
    fireEvent.click(sw('Lots a signal'));
    await waitFor(() => expect(last()).toEqual({ lots: { lots: 10 } }));
    // the live check under the run is asked with the run's own question: its name, its members, and what is over it
    await waitFor(() => expect(saves.getPortfolioLiveCheck.mock.calls.at(-1)!.slice(0, 2)).toEqual(['Both', ['a1', 'b22']]));
    await waitFor(() => expect(saves.getPortfolioLiveCheck.mock.calls.at(-1)![6]).toEqual({ lots: { lots: 10 } }));
    expect(sw('Lots a signal')).toHaveAttribute('aria-checked', 'true');
    expect(set().getByText('For the run: 10 lots a signal')).toBeInTheDocument();
    fireEvent.click(within(set().getByRole('group', { name: 'Lots a signal' })).getByRole('button', { name: '16' }));
    await waitFor(() => expect(last()).toEqual({ lots: { lots: 16 } }));
    expect(await screen.findByRole('note', { name: 'What this run was held to' })).toHaveTextContent(
      'For this run, every one of them with: 16 lots a signal.Everything else is each saved backtest\'s own. Nothing saved is changed.');

    // the option's stop and its target beside it: each its own switch, the others untouched
    fireEvent.click(sw('Option stop'));
    fireEvent.click(within(set().getByRole('group', { name: 'The option\'s own stop, over the premium sold' })).getByRole('button', { name: '+150%' }));
    await waitFor(() => expect(last()).toEqual({ lots: { lots: 16 }, stop: { stopPct: 1.5 } }));
    fireEvent.click(sw('Option target'));
    fireEvent.click(within(set().getByRole('group', { name: 'The option\'s own target, of the premium kept' })).getByRole('button', { name: '70%' }));
    await waitFor(() => expect(last()).toEqual({ lots: { lots: 16 }, stop: { stopPct: 1.5 }, target: { targetPct: 0.7 } }));
    expect(set().getByRole('radio', { name: 'One target all day, for the run' })).toBeChecked();

    // the strike: its rule and its limit together
    fireEvent.click(sw('Strike'));
    await waitFor(() => expect(last().strike).toEqual({ rule: 'delta', value: 0.1 }));
    fireEvent.click(set().getByRole('radio', { name: 'Pick the strike by premium' }));
    await waitFor(() => expect(last().strike).toEqual({ rule: 'premium', value: 50 }));
    expect(set().getByText('For the run: strike premium ≤ $50')).toBeInTheDocument();

    // the premium floor off for all of them is a setting of its own; and the range, its four together
    fireEvent.click(sw('Minimum premium'));
    fireEvent.click(within(set().getByRole('group', { name: 'Minimum premium: sell only for at least' })).getByRole('button', { name: 'Off' }));
    await waitFor(() => expect(last().minPremium).toEqual({ minPremium: 0 }));
    expect(set().getByText('For the run: no premium floor')).toBeInTheDocument();
    fireEvent.click(sw('SL and TGT range'));
    await waitFor(() => expect(last().range).toEqual({ slMin: 0, slMax: 0, tgtMin: 0, tgtMax: 0 }));
    expect(set().getByText('For the run: no SL / TGT range')).toBeInTheDocument();
    expect(set().getByText('· 6 on')).toBeInTheDocument();
    expect(held()).toHaveTextContent('hours as saved · one account: 58 open · CE 80% · PE 80% · strike premium ≤ $50 · target 70% · stop +150% · 16 lots a signal · no premium floor · no SL / TGT range');
    expect(await screen.findByRole('note', { name: 'What this run was held to' })).toHaveTextContent(
      'For this run, every one of them with: strike premium ≤ $50 · target 70% · stop +150% · 16 lots a signal · no premium floor · no SL / TGT range.');
    // kept in this browser, like the hours and the limit
    expect(Object.keys(JSON.parse(window.localStorage.getItem(Object.keys(window.localStorage).find((k) => k.endsWith('signalBacktest.together.over'))!)!)).sort())
      .toEqual(['lots', 'minPremium', 'range', 'stop', 'strike', 'target']);

    // one off again: that one is each saved backtest's own once more; then all of them
    fireEvent.click(sw('Lots a signal'));
    await waitFor(() => expect(Object.keys(last()).sort()).toEqual(['minPremium', 'range', 'stop', 'strike', 'target']));
    fireEvent.click(set().getByRole('button', { name: 'Switch all off' }));
    await waitFor(() => expect(last()).toEqual({}));

    // a strike rule by time of day over every one of them: the form's blocks, held to the whole day
    fireEvent.click(sw('Strike by time of day'));
    await waitFor(() => expect(last()).toEqual({ strikeBlocks: { blocks: [] } }));
    expect(set().getByText('For the run: one strike rule all day')).toBeInTheDocument();
    fireEvent.click(within(set().getByRole('region', { name: 'strike rule over the window' })).getByRole('checkbox', { name: 'Different strike rule by time of day' }));
    await waitFor(() => expect(last().strikeBlocks?.blocks.length).toBeGreaterThan(0));
    expect(set().getByText(/Each saved backtest's own strike rule/)).toBeInTheDocument();
    expect(set().getByRole('button', { name: /apply block 1 to all/ })).toBeDisabled();
    fireEvent.click(sw('Strike by time of day'));
    await waitFor(() => expect(last()).toEqual({}));

    // the volatility filter over every one of them: the level and what it is read by, together
    fireEvent.click(sw('Volatility filter'));
    await waitFor(() => expect(last()).toEqual({ vol: { vol: 'off', volBy: 'atr' } }));
    fireEvent.click(set().getByRole('radio', { name: 'For the run, only signals in high volatility' }));
    fireEvent.click(set().getByRole('radio', { name: /For the run, volatility by the at-the-money/ }));
    await waitFor(() => expect(last().vol).toEqual({ vol: 'high', volBy: 'iv' }));
    expect(set().getByText('For the run: high volatility only (ATM IV)')).toBeInTheDocument();
    fireEvent.click(sw('Volatility filter'));
    await waitFor(() => expect(last()).toEqual({}));
    await waitFor(() => expect(screen.queryByRole('note', { name: 'What this run was held to' })).toBeNull());
    expect(set().getAllByText('Off · each saved backtest’s own')).toHaveLength(9);
  });

  it('a run\'s settings as the route reads them: the single backtest\'s own names under o_, and nothing for a switch that is off', async () => {
    const { overQuery } = await vi.importActual<typeof import('@/api/backtest-saves')>('@/api/backtest-saves');
    expect(overQuery({})).toEqual({});
    expect(overQuery({ lots: { lots: 2 }, stop: { stopPct: 1.6 } })).toEqual({ o_lots: '2', o_sl: '1.6' });
    expect(overQuery({ strike: { rule: 'delta', value: 0.1 }, minPremium: { minPremium: 0 } })).toEqual({ o_rule: 'delta', o_value: '0.1', o_minprem: '0' });
    expect(overQuery({ target: { targetPct: 0.7 } })).toEqual({ o_tp: '0.7' });
    expect(overQuery({ target: { targetPct: 0.7, targetSteps: [{ at: '23:30', pct: 0.73 }, { at: '01:30', pct: 0.76 }] } })).toEqual({ o_tp: '0.7', o_tsteps: '23:30:73,01:30:76' });
    // the range goes whole, zeros too: "no range for any of them" is asked for, not left out
    expect(overQuery({ range: { slMin: 250, slMax: 0, tgtMin: 250, tgtMax: 0 } })).toEqual({ o_slmin: '250', o_slmax: '0', o_tgtmin: '250', o_tgtmax: '0' });
    expect(overQuery({ vol: { vol: 'low', volBy: 'atr' } })).toEqual({ o_vol: 'low', o_volby: 'atr' });
  });
});

describe('saved backtests on a phone (14 Oct 2026)', () => {
  it('[critical] the list folds to one line until opened, and says which one is on the screen; a wide desk always shows it', async () => {
    const { SavedBacktests } = await import('@/components/report/SavedBacktests');
    const saved = (id: string, name: string, params: object, tfs: string[] = []) => ({ id, name, query: { params: { ...RESULT.params, slMin: 0, slMax: 0, tgtMin: 0, tgtMax: 0, vol: 'off', minPremium: 10, ...params }, tfs, methods: [], strategy: null }, createdAt: 1, updatedAt: 1 });
    const A = saved('a1', 'Desk rules', {});
    saves.getBacktestSaves.mockResolvedValue({ saves: [A, saved('b2', '16 lots on 4h', { lots: 16 }, ['4h'])], portfolios: [] });
    const props = {
      current: A.query, wordsOf: () => 'words', onLoad: () => {}, run: null, onRun: () => {},
    } as unknown as Parameters<typeof SavedBacktests>[0];
    const { unmount } = render(<SavedBacktests {...props} />);
    const open = await screen.findByRole('button', { name: 'Show the 2 saved · Desk rules is on the screen' });
    expect(screen.queryByRole('list', { name: 'Saved backtests' })).toBeNull();
    fireEvent.click(open);
    expect(screen.getByRole('list', { name: 'Saved backtests' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Hide the saved list' })).toHaveAttribute('aria-expanded', 'true');
    unmount();
    window.localStorage.clear();
    render(<SavedBacktests {...props} wide />);
    expect(await screen.findByRole('list', { name: 'Saved backtests' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Show the \d+ saved/ })).toBeNull();
  });
});
