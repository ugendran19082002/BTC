import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { MethodReportResponse, MethodReportRow, MethodReportSection } from '@/types/entry';
import { PhoneContext, type PhoneData } from '@/components/mobile/phone-context';

/**
 * Signal history pairs, under More (owner, 6 Oct 2026): the best and worst method + timeframe from the signal
 * history, with the timeframe chain or without it, over the days P&L's own filter picks.
 */

const getMethodReport = vi.fn();
vi.mock('@/api/entry', () => ({ getMethodReport: (...a: unknown[]) => getMethodReport(...a) }));

const { SignalPairsScreen } = await import('@/components/mobile/screens/SignalPairsScreen');

const row = (n: number, name: string, o: Partial<MethodReportRow> = {}): MethodReportRow => ({
  n, method: name.toLowerCase().replace(/\W+/g, '-'), name, signals: 12, trades: 5, wins: 4, losses: 1, winPct: 80,
  profitPts: 1600, lossPts: 360, netPts: 1240, profitR: 6, lossR: 1.2, netR: 4.8, ...o,
});
const lost = { wins: 1, losses: 4, winPct: 20, profitPts: 200, lossPts: 1100, netPts: -900, profitR: 0.5, lossR: 3.6, netR: -3.1 };
const section = (mode: 'mtf' | 'single', rows: MethodReportRow[]): MethodReportSection => ({ mode, label: mode, rows, total: row(0, 'All'), gatesOffSignals: 0 });
const REPORT: MethodReportResponse = {
  tf: null,
  sections: [section('mtf', [row(31, 'Expected-move edge reaction', { netPts: 410, netR: 1.6 }), row(36, 'Trendline break & retest', lost)]), section('single', [])],
  singleByTf: {
    '15m': section('single', [row(63, 'Initial balance failed break'), row(71, 'Call / put OI divergence', lost)]),
    '30m': section('single', [row(19, 'VWAP reclaim / loss', { netPts: 300, netR: 1.1 }), row(6, 'BOS', { signals: 3, trades: 0, wins: 0, losses: 0, winPct: null, profitPts: 0, lossPts: 0, netPts: 0, netR: 0 })]),
  },
};
// Tue 6 Oct 2026, 14:00 IST
const NOW = Date.UTC(2026, 9, 6, 8, 30);
const show = () => render(
  <PhoneContext.Provider value={{ now: NOW } as PhoneData}><SignalPairsScreen /></PhoneContext.Provider>,
);

beforeEach(() => {
  window.localStorage.clear();
  getMethodReport.mockReset();
  getMethodReport.mockResolvedValue(REPORT);
});

describe('SignalPairsScreen', () => {
  it('[critical] without the timeframe chain to begin with, today: each timeframe\'s pairs, in points and R, best and worst', async () => {
    show();
    const best = within(await screen.findByRole('list', { name: 'Best pairs' }));
    expect(getMethodReport).toHaveBeenCalledWith(null, false, { from: '2026-10-06', to: '2026-10-06' });
    const rows = best.getAllByRole('listitem');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent('#63 Initial balance failed break');
    expect(rows[0]).toHaveTextContent('15m');
    expect(rows[0]).toHaveTextContent('+1,240 pts');
    expect(rows[0]).toHaveTextContent('5 trades · 80% won · PF 4.44 · +4.8R');
    // what its winners made and its losers gave back, under the bar
    expect(within(rows[0]!).getByLabelText('won +1,600 pts')).toBeInTheDocument();
    expect(within(rows[0]!).getByLabelText('lost −360 pts')).toBeInTheDocument();
    expect(rows[1]).toHaveTextContent('#19 VWAP reclaim / loss');
    expect(rows[1]).toHaveTextContent('30m');
    const worst = within(screen.getByRole('list', { name: 'Worst pairs' })).getByRole('listitem');
    expect(worst).toHaveTextContent('#71 Call / put OI divergence');
    expect(worst).toHaveTextContent('−900 pts');
    expect(worst).toHaveTextContent('−3.1R');
    // the whole: 1240 + 300 − 900 points over 15 trades, 9 won; the method with no trade still counts its signals
    expect(screen.getByText('+640 pts')).toBeInTheDocument();
    expect(screen.getByText('Signals').parentElement!).toHaveTextContent('39');
    expect(screen.getByText('Trades').parentElement!).toHaveTextContent('15');
    expect(screen.getByText('Win rate').parentElement!).toHaveTextContent('60%');
    // 1,600 + 1,600 + 200 won, 360 + 360 + 1,100 lost
    expect(screen.getByText('Won pts').parentElement!).toHaveTextContent('+3,400');
    expect(screen.getByText('Loss pts').parentElement!).toHaveTextContent('−1,820');
    expect(screen.getByText('Profit factor').parentElement!).toHaveTextContent('1.87');
    expect(screen.getByText(/whether or not an order was placed/)).toBeInTheDocument();
  });

  it('with the timeframe chain: the chain\'s pairs, and the choice is remembered', async () => {
    const first = show();
    await screen.findByRole('list', { name: 'Best pairs' });
    fireEvent.click(screen.getByRole('radio', { name: 'With the timeframe chain' }));
    const best = within(screen.getByRole('list', { name: 'Best pairs' })).getByRole('listitem');
    expect(best).toHaveTextContent('#31 Expected-move edge reaction');
    expect(best).toHaveTextContent('5m + TF chain');
    expect(best).toHaveTextContent('+410 pts');
    expect(within(screen.getByRole('list', { name: 'Worst pairs' })).getByRole('listitem')).toHaveTextContent('#36 Trendline break & retest');
    first.unmount();
    show();
    await screen.findByRole('list', { name: 'Best pairs' });
    expect(screen.getByRole('radio', { name: 'With the timeframe chain' })).toBeChecked();
  });

  it('the date filter is P&L\'s: 7 days asks for the last seven, and keeps its own memory apart from P&L\'s', async () => {
    window.localStorage.setItem('m-pnl-range', JSON.stringify('90'));
    show();
    await screen.findByRole('list', { name: 'Best pairs' });
    expect(screen.getByRole('radio', { name: 'Today' })).toBeChecked();
    fireEvent.click(screen.getByRole('radio', { name: '7 days' }));
    await waitFor(() => expect(getMethodReport).toHaveBeenLastCalledWith(null, false, { from: '2026-09-30', to: '2026-10-06' }));
    expect(screen.getByRole('radio', { name: 'Custom' })).toBeInTheDocument();
  });

  it('[critical] without the chain, a row of timeframes under it: one at a time by default, and All to clear', async () => {
    show();
    await screen.findByRole('list', { name: 'Best pairs' });
    const tfs = within(screen.getByRole('group', { name: 'Time frame' }));
    expect(tfs.getAllByRole('button').map((b) => b.textContent)).toEqual(['All', '15m', '30m']);
    expect(tfs.getByRole('button', { name: 'All' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(tfs.getByRole('button', { name: '30m' }));
    // only 30m: #19 in profit, nothing in loss; its 12 + 3 signals, its 5 trades
    expect(within(screen.getByRole('list', { name: 'Best pairs' })).getAllByRole('listitem')).toHaveLength(1);
    expect(screen.getByText('No method and time frame is in loss today.')).toBeInTheDocument();
    expect(screen.getByText('+300 pts', { selector: 'div' })).toBeInTheDocument();
    expect(screen.getByText('Signals').parentElement!).toHaveTextContent('15');
    expect(screen.getByText(/without the timeframe chain on 30m/)).toBeInTheDocument();
    // one at a time: 15m takes 30m's place
    fireEvent.click(tfs.getByRole('button', { name: '15m' }));
    expect(tfs.getByRole('button', { name: '30m' })).toHaveAttribute('aria-pressed', 'false');
    expect(within(screen.getByRole('list', { name: 'Best pairs' })).getByRole('listitem')).toHaveTextContent('#63');
    fireEvent.click(tfs.getByRole('button', { name: 'All' }));
    expect(within(screen.getByRole('list', { name: 'Best pairs' })).getAllByRole('listitem')).toHaveLength(2);
  });

  it('many: each tap adds a timeframe or takes it away; back to one keeps the first; the pick is remembered', async () => {
    const first = show();
    await screen.findByRole('list', { name: 'Best pairs' });
    const tfs = () => within(screen.getByRole('group', { name: 'Time frame' }));
    fireEvent.click(screen.getByRole('button', { name: 'Many' }));
    fireEvent.click(tfs().getByRole('button', { name: '30m' }));
    fireEvent.click(tfs().getByRole('button', { name: '15m' }));
    expect(tfs().getByRole('button', { name: '15m' })).toHaveAttribute('aria-pressed', 'true');
    expect(tfs().getByRole('button', { name: '30m' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText('15m, 30m')).toBeInTheDocument();
    fireEvent.click(tfs().getByRole('button', { name: '15m' }));
    expect(tfs().getByRole('button', { name: '15m' })).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(tfs().getByRole('button', { name: '15m' }));
    first.unmount();
    show();
    await screen.findByRole('list', { name: 'Best pairs' });
    expect(screen.getByRole('button', { name: 'Many' })).toHaveAttribute('aria-pressed', 'true');
    expect(tfs().getByRole('button', { name: '30m' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'One' }));
    expect(tfs().getByRole('button', { name: '15m' })).toHaveAttribute('aria-pressed', 'true');
    expect(tfs().getByRole('button', { name: '30m' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('with the chain there is no timeframe to pick: the row is gone, and a pick made before does not narrow it', async () => {
    window.localStorage.setItem('m-sigpairs-tfs', JSON.stringify(['30m']));
    show();
    await screen.findByRole('list', { name: 'Best pairs' });
    fireEvent.click(screen.getByRole('radio', { name: 'With the timeframe chain' }));
    expect(screen.queryByRole('group', { name: 'Time frame' })).toBeNull();
    expect(within(screen.getByRole('list', { name: 'Best pairs' })).getByRole('listitem')).toHaveTextContent('#31');
  });

  it('no trade in the range: says so, and draws no list', async () => {
    getMethodReport.mockResolvedValue({ tf: null, sections: [], singleByTf: {} });
    show();
    expect(await screen.findByText('No signal became a trade today, without the timeframe chain.')).toBeInTheDocument();
    expect(screen.queryByRole('list')).toBeNull();
    // the net, and nothing won or lost
    expect(screen.getByText('0 pts')).toBeInTheDocument();
    expect(screen.getByText('Won pts').parentElement!).toHaveTextContent('0');
    expect(screen.getByText('Profit factor').parentElement!).toHaveTextContent('—');
  });
});
