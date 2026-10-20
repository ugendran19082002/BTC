import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { BtTradeRow, WinSweepResult } from '@/types/signal-backtest';
import { WinSweep, pctsOf, tradesOf } from '@/components/report/WinSweep';
import { sweepQuery } from '@/api/signal-backtest';

/**
 * Methods by win % at several bars (owner, 20 Oct 2026: "an editable range -- the win %, the strategies and the least
 * trades -- in the backtest and the portfolio section"): a range typed or a tap away, the least trades as a list, the
 * saved backtests ticked, the days picked on as the run's own pick -- asked with a tap, and every bar side by side.
 */
const read = vi.fn();
const cell = (n: number, wins: number, net: number, methods = 10) => ({ methods, n, wins, net, charges: 1 });
const RESULT: WinSweepResult = {
  from: '2026-10-08', to: '2026-10-20', pick: { from: '2026-10-01', to: '2026-10-07' }, pcts: [50, 60, 70], minTrades: [1, 3], runs: 9,
  rows: [
    { id: 'a', name: '4h time', problem: null, saved: cell(40, 30, 4), all: cell(50, 35, 5), cells: [[cell(40, 32, 5.4), cell(35, 30, 5.6), cell(30, 27, 5.5)], [cell(20, 16, 4.2), null, null]] },
    { id: 'b', name: '5m time', problem: null, saved: cell(80, 50, -2), all: cell(90, 52, -2.5), cells: [[cell(80, 50, -0.2), cell(60, 42, 1.1), cell(40, 30, 1.6)], [cell(50, 35, 0.5), cell(30, 22, 0.8), null]] },
    { id: 'c', name: '1m time', problem: null, saved: cell(0, 0, 0, 0), all: cell(0, 0, 0, 0), cells: [[null, null, null], [null, null, null]] },
  ],
  total: {
    saved: cell(120, 80, 2), all: cell(140, 87, 2.5),
    cells: [[cell(120, 82, 5.2), cell(95, 72, 6.7), cell(70, 57, 7.1)], [cell(70, 51, 4.7), cell(30, 22, 0.8), null]],
  },
};
const MEMBERS = [{ id: 'a', name: '4h time' }, { id: 'b', name: '5m time' }, { id: 'c', name: '1m time' }];
const RUN = { from: '2026-10-08', to: '2026-10-20' };

beforeEach(() => { window.localStorage.clear(); read.mockReset().mockResolvedValue(RESULT); });

describe('pctsOf / tradesOf', () => {
  it('a range by its step, the last where the step lands; held to what the server takes', () => {
    expect(pctsOf('50', '75', '5')).toEqual([50, 55, 60, 65, 70, 75]);
    expect(pctsOf('50', '72', '10')).toEqual([50, 60, 70]);
    expect(pctsOf('60', '60', '5')).toEqual([60]);
    expect(pctsOf('75', '50', '5')).toMatch(/above the "to"/);
    expect(pctsOf('0', '50', '5')).toMatch(/1 to 100/);
    expect(pctsOf('', '50', '5')).toMatch(/1 to 100/);
    expect(pctsOf('50', '75', '0')).toMatch(/step/);
    expect(pctsOf('40', '100', '5')).toMatch(/13 win % values; at most 12/);
    expect(tradesOf('3, 1  3,5')).toEqual([1, 3, 5]);
    expect(tradesOf('')).toMatch(/one or more/);
    expect(tradesOf('1, 2.5')).toMatch(/whole number/);
    expect(tradesOf('1,2,3,4,5')).toMatch(/At most 4/);
  });

  it('asked as the server reads it: the days picked on as the run\'s own pick', () => {
    expect(sweepQuery({ pcts: [50, 60], minTrades: [1, 3], on: 'before', days: 7 })).toEqual([['w_pcts', '50,60'], ['w_trades', '1,3'], ['o_winon', 'before'], ['o_windays', '7']]);
    expect(sweepQuery({ pcts: [50], minTrades: [1], on: 'same', days: 7, split: true })).toEqual([['w_pcts', '50'], ['w_trades', '1'], ['o_winon', 'same'], ['w_split', 'tf']]);
    expect(sweepQuery({ pcts: [50], minTrades: [1], on: 'custom', days: 7, pickFrom: '2026-10-01', pickTo: '2026-10-05' }))
      .toEqual([['w_pcts', '50'], ['w_trades', '1'], ['o_winon', 'custom'], ['o_winfrom', '2026-10-01'], ['o_winto', '2026-10-05']]);
  });
});

describe('WinSweep', () => {
  it('[critical] asked with a tap, with the range, the least trades, the ticked saved backtests and the days picked on', async () => {
    render(<WinSweep scope="portfolio" askKey="q" read={read} run={RUN} members={MEMBERS} />);
    expect(read).not.toHaveBeenCalled();
    expect(screen.getByText('50% · 55% · 60% · 65% · 70% · 75%')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '50–90 by 10' }));
    fireEvent.change(screen.getByLabelText('Least trades, one or more'), { target: { value: '3, 1' } });
    fireEvent.click(within(screen.getByRole('group', { name: 'Saved backtests in the sweep' })).getByRole('button', { name: '1m time' }));
    // The days before the run, to begin with: an honest test.
    expect(screen.getByRole('radio', { name: /Picked on the days before the run/ })).toBeChecked();
    expect(screen.queryByRole('group', { name: 'Methods by win %, won at least' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Sweep' }));
    await waitFor(() => expect(read).toHaveBeenCalledTimes(1));
    expect(read).toHaveBeenCalledWith({ pcts: [50, 60, 70, 80, 90], minTrades: [1, 3], on: 'before', days: 7, pickFrom: undefined, pickTo: undefined, split: false }, ['a', 'b']);
    // kept in this browser
    expect(JSON.parse(window.localStorage.getItem(Object.keys(window.localStorage).find((k) => k.endsWith('winSweep.portfolio'))!)!)).toMatchObject({ from: '50', to: '90', step: '10', trades: '3, 1', skip: ['c'] });
  });

  it('[critical] every bar side by side: net, trades and won %, the row\'s best marked, the total, and none passed said as nothing traded', async () => {
    render(<WinSweep scope="portfolio" askKey="q" read={read} run={RUN} members={MEMBERS} />);
    fireEvent.click(screen.getByRole('button', { name: 'Sweep' }));
    const one = await screen.findByRole('region', { name: 'At least 1 trade' });
    expect(within(one).getAllByRole('columnheader').map((x) => x.textContent)).toEqual(['Strategy', 'As saved', 'All', '50%', '60%', '70%']);
    expect(within(one).getByLabelText(/^4h time, 60%: .*, 35 trades, won 86%, 10 methods, the row's best$/)).toBeInTheDocument();
    expect(within(one).getByLabelText(/^5m time, 70%: .*the row's best$/)).toBeInTheDocument();
    expect(within(one).getByLabelText(/^Total, 70%: .*the row's best$/)).toBeInTheDocument();
    // a row with no trades at all is left out, and named
    expect(within(one).queryByRole('rowheader', { name: '1m time' })).toBeNull();
    expect(screen.getByText(/No trades: 1m time\./)).toBeInTheDocument();
    const three = screen.getByRole('region', { name: 'At least 3 trades' });
    expect(within(three).getByLabelText('4h time, 60%: no method passed, nothing traded')).toBeInTheDocument();
    expect(screen.getByText((_, el) => el?.tagName === 'P' && /^Picked on .*, run on /.test(el.textContent ?? ''))).toHaveTextContent(/^Picked on (\w+ )?1 Oct – (\w+ )?7 Oct \(7 days\), run on (\w+ )?8 Oct – (\w+ )?20 Oct \(13 days\)\.$/);
    expect(within(one).getByText(/Best total: /, { selector: 'span' })).toHaveTextContent(/70% of 1\+/);
    expect(within(three).getByText(/Best total: /, { selector: 'span' })).toHaveTextContent(/50% of 3\+/);
  });

  it('[critical] the best bar taken over to the run\'s own methods by win %, with the days picked on here', async () => {
    const onUse = vi.fn();
    render(<WinSweep scope="portfolio" askKey="q" read={read} run={RUN} members={MEMBERS} onUse={onUse} />);
    fireEvent.click(screen.getByRole('button', { name: 'Sweep' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Use 70% of 1+ for the run' }));
    expect(onUse).toHaveBeenCalledWith(expect.objectContaining({ pct: 70, minTrades: 1, on: 'before', days: 7 }));
    fireEvent.click(screen.getByRole('button', { name: 'Use 50% of 3+ for the run' }));
    expect(onUse).toHaveBeenLastCalledWith(expect.objectContaining({ pct: 50, minTrades: 3 }));
  });

  it('[critical] a cell tapped opens its trades, one by one: asked with what the sweep was worked with, not what is typed since', async () => {
    const at = Date.parse('2026-10-09T05:00:00Z');
    const trade: BtTradeRow = {
      at, method: 'trap', name: '#7 Trap', tf: '4h', dir: 1, perpEntry: 82_782, perpSl: 82_295.5, perpTgt: 83_563.7, cp: 'P', strike: 81_400, lots: 1,
      entryAt: at, entry: 43, exitAt: at + 3_600_000, exit: 4.3, by: 'option-tgt', optTgt: 4.3, optStop: 111.8, perpPts: 120, netUsd: 0.38, chargesUsd: 0.01,
    };
    const readTrades = vi.fn().mockResolvedValue({ day: '2026-10-08..2026-10-20', total: 1, trades: [trade] });
    render(<WinSweep scope="portfolio" askKey="q" read={read} readTrades={readTrades} run={RUN} members={MEMBERS} />);
    fireEvent.click(screen.getByRole('button', { name: 'Sweep' }));
    const one = await screen.findByRole('region', { name: 'At least 1 trade' });
    // typed after the sweep: not what the trades are asked with
    fireEvent.change(screen.getByLabelText('Least trades, one or more'), { target: { value: '5' } });
    fireEvent.click(within(one).getByRole('button', { name: /^4h time, 60%: .*: its trades$/ }));
    await waitFor(() => expect(readTrades).toHaveBeenCalledTimes(1));
    expect(readTrades).toHaveBeenCalledWith(expect.objectContaining({ pcts: [50, 55, 60, 65, 70, 75], minTrades: [1, 3] }), 'a', { pct: 60, minTrades: 1 });
    expect(await screen.findByText('4h time · 60% of 1+')).toBeInTheDocument();
    fireEvent.click(within(one).getByRole('button', { name: /^5m time, as saved: .*: its trades$/, hidden: true }));
    await waitFor(() => expect(readTrades).toHaveBeenLastCalledWith(expect.anything(), 'b', 'saved'));
    // the total and "none passed" are not cells to open
    expect(within(one).queryByRole('button', { name: /^Total/, hidden: true })).toBeNull();
  });

  it('what cannot be swept is said, and Sweep waits for it to be put right', () => {
    render(<WinSweep scope="portfolio" askKey="q" read={read} run={{ from: '2026-10-01', to: '2026-10-20' }} members={MEMBERS} />);
    // from 1 Oct there are no days before: the run's first days instead, to begin with
    expect(screen.getByRole('radio', { name: /Picked on the run's first days/ })).toBeChecked();
    fireEvent.change(screen.getByLabelText('Win % from'), { target: { value: '40' } });
    fireEvent.change(screen.getByLabelText('Win % to'), { target: { value: '100' } });
    expect(screen.getByRole('alert')).toHaveTextContent(/13 win % values; at most 12/);
    expect(screen.getByRole('button', { name: 'Sweep' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Win % step'), { target: { value: '10' } });
    fireEvent.click(within(screen.getByRole('group', { name: 'Saved backtests in the sweep' })).getByRole('button', { name: 'All' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Tick one or more saved backtests.');
    fireEvent.click(within(screen.getByRole('group', { name: 'Saved backtests in the sweep' })).getByRole('button', { name: 'All' }));
    expect(screen.getByRole('button', { name: 'Sweep' })).toBeEnabled();
  });

  it('of the single backtest: no saved backtests to tick, each time frame a row when asked', async () => {
    read.mockResolvedValue({ ...RESULT, pick: { from: RUN.from, to: RUN.to } });
    render(<WinSweep scope="single" askKey="q" read={read} run={RUN} />);
    expect(screen.queryByRole('group', { name: 'Saved backtests in the sweep' })).toBeNull();
    fireEvent.click(screen.getByRole('switch', { name: /Each time frame on its own row/ }));
    fireEvent.click(screen.getByRole('radio', { name: /Picked on the run's own days/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Sweep' }));
    await waitFor(() => expect(read).toHaveBeenCalledWith(expect.objectContaining({ on: 'same', split: true }), null));
    expect(await screen.findByText(/the same days: in-sample/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /for the run/ })).toBeNull();
  });

  it('a sweep of other settings is said to be: the last one stays, greyed, until swept again', async () => {
    const { rerender } = render(<WinSweep scope="single" askKey="q1" read={read} run={RUN} />);
    fireEvent.click(screen.getByRole('button', { name: 'Sweep' }));
    await screen.findByRole('region', { name: 'At least 1 trade' });
    rerender(<WinSweep scope="single" askKey="q2" read={read} run={RUN} />);
    expect(screen.getByText(/changed since: below is the last sweep/)).toBeInTheDocument();
  });
});
