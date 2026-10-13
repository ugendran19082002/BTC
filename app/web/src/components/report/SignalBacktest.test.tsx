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
vi.mock('@/api/signal-backtest', () => ({ getSignalBacktest: (...a: unknown[]) => getSignalBacktest(...a) }));

const { SignalBacktest } = await import('@/components/report/SignalBacktest');
const { BacktestScreen } = await import('@/components/mobile/screens/BacktestScreen');

const tot = (o: Partial<BtTot> = {}): BtTot => ({ n: 0, wins: 0, losses: 0, net: 0, won: 0, lost: 0, perpPts: 0, exits: {}, ...o });
const row = (key: string, name: string, o: Partial<BtRow>): BtRow => ({ ...tot(o), key, name, ...o });

const TOTAL = tot({
  n: 1_000, wins: 440, losses: 560, net: -120, won: 480, lost: 600, perpPts: 13_600,
  exits: {
    'perp-tgt': { n: 350, wins: 250, net: 30 }, 'perp-sl': { n: 500, wins: 60, net: -550 },
    'option-tgt': { n: 130, wins: 130, net: 440 }, 'option-sl': { n: 5, wins: 0, net: -62 }, 'window-end': { n: 15, wins: 12, net: 22 },
  },
});
const RESULT: SignalBacktestResponse = {
  from: '2026-10-01', to: '2026-10-13',
  params: { rule: 'delta', value: 0.1, lots: 10, targetPct: 0.9, stopPct: 3, window: 'desk', deskMax: 0, cePct: 100, pePct: 100 },
  deskLimits: [{ account: 'Savings', max: 58, ce: 80, pe: 80 }, { account: 'Expenses', max: 35, ce: 80, pe: 80 }],
  signals: 1_400, skipped: { 'outside-window': 300, 'no-entry-window': 0, distance: 0, 'at-limit': 0, 'desk-limit': 0, 'side-limit': 0, 'no-board': 0, 'no-strike': 95, 'no-exit-price': 5 },
  strategy: null,
  strategies: [
    { id: '1h-time', name: '1h time', enabled: true, account: 'Savings', methods: ['gamma'], tfs: ['4h'] },
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
    expect(rowsOf('Backtest by time frame')).toEqual(['5mperp +2,300 pts70034%₹₹', '4hperp −171 pts10079%₹₹', 'TF chainperp +900 pts20035%₹₹']);
    expect(rowsOf('Backtest by expiry day')).toEqual(['Tue 13 Oct · so far40035%₹₹', 'Mon 12 Oct60050%₹₹']);
    // by family to begin with, by market type on a tap
    expect(rowsOf('Backtest by kind of day')).toEqual(['Range1 day60050%₹₹', 'Turn / event1 day40035%₹₹']);
    fireEvent.click(screen.getByRole('radio', { name: 'By each market type' }));
    expect(rowsOf('Backtest by kind of day')).toEqual(['#16 Reversal1 day40035%₹₹']);
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
    expect(rowsOf('Backtest: methods in profit')).toEqual(['#50 Gamma wall reactionperp +42,585 pts45868%₹₹']);
    expect(rowsOf('Backtest: methods in loss')).toEqual(['#55 Pulled wall (spoof / pull)perp +4,210 pts2,42129%₹₹']);
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
});
