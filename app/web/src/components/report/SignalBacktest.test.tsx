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
  params: { rule: 'delta', value: 0.1, lots: 10, targetPct: 0.9, stopPct: 3, window: 'desk' },
  signals: 1_400, skipped: { 'outside-window': 300, 'no-board': 0, 'no-strike': 95, 'no-exit-price': 5 },
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
  byMethod: [],
  byPattern: [row('REVERSAL_ZIGZAG', '#16 Reversal', { days: 1, n: 400, wins: 140, losses: 260, net: -160, won: 180, lost: 340 })],
  byFamily: [
    row('range', 'Range', { days: 1, n: 600, wins: 300, losses: 300, net: 40, won: 300, lost: 260 }),
    row('turn', 'Turn / event', { days: 1, n: 400, wins: 140, losses: 260, net: -160, won: 180, lost: 340 }),
  ],
  choices: { timeframes: [{ key: '5m', name: '5m' }, { key: '4h', name: '4h' }, { key: 'chain', name: 'With timeframe chain' }], methods: [{ key: 'gamma', name: '#50 Gamma wall reaction' }, { key: 'pulled', name: '#55 Pulled wall (spoof / pull)' }] },
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
      from: '2026-10-01', to: '2026-10-13', tfs: [], methods: [],
      params: { rule: 'delta', value: 0.1, lots: 10, targetPct: 0.9, stopPct: 3, window: 'desk' },
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
    await waitFor(() => expect(lastQuery().params).toEqual({ rule: 'delta', value: 0.1, lots: 16, targetPct: 0.9, stopPct: 1.5, window: 'all' }));
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
