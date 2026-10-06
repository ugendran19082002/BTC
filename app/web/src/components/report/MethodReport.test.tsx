import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MethodReport, reportCsv, shows, sortRows } from '@/components/report/MethodReport';
import type { EntryTf, MethodReportResponse, MethodReportRow, MethodReportSection } from '@/types/entry';

const getMethodReport = vi.fn();
vi.mock('@/api/entry', () => ({ getMethodReport: (...a: unknown[]) => getMethodReport(...a) }));

const row = (n: number, name: string, o: Partial<MethodReportRow> = {}): MethodReportRow => ({
  n, method: name.toLowerCase(), name, signals: 0, trades: 0, wins: 0, losses: 0, winPct: null,
  profitPts: 0, lossPts: 0, netPts: 0, profitR: 0, lossR: 0, netR: 0, ...o,
});
const rows = [
  row(1, 'Breakout', { orderSide: 'BUY', signals: 4, trades: 3, wins: 1, losses: 2, winPct: 100 / 3, profitPts: 150, lossPts: 180, netPts: -30, profitR: 1.5, lossR: 1.8, netR: -0.3 }),
  row(2, 'Retest', { orderSide: 'SELL', signals: 5, trades: 2, wins: 2, losses: 0, winPct: 100, profitPts: 200, netPts: 200, profitR: 3, netR: 3 }),
  row(3, 'Momentum'),
];
const total = row(0, 'All 3 methods', { n: null, signals: 9, trades: 5, wins: 3, losses: 2, winPct: 60, profitPts: 350, lossPts: 180, netPts: 170, profitR: 4.5, lossR: 1.8, netR: 2.7 });
const sec = (mode: 'mtf' | 'single', r = rows, t = total, gatesOffSignals = 0): MethodReportSection =>
  ({ mode, label: mode === 'mtf' ? 'With the timeframe chain' : 'Without the timeframe chain', rows: r, total: t, gatesOffSignals });

/** Without the chain, 15m holds the trades; every other timeframe is quiet. */
const fifteen = [row(1, 'Breakout', { signals: 2, trades: 2, wins: 1, losses: 1, winPct: 50, profitPts: 100, lossPts: 60, netPts: 40, netR: 0.5 }), row(2, 'Retest'), row(3, 'Momentum')];
const quiet = [row(1, 'Breakout'), row(2, 'Retest'), row(3, 'Momentum')];
const report = (): MethodReportResponse => ({
  tf: null,
  sections: [sec('mtf', rows, total, 4), sec('single')],
  singleByTf: Object.fromEntries((['3m', '5m', '15m', '30m', '1h', '4h'] as EntryTf[]).map((tf) => [tf,
    tf === '15m'
      ? sec('single', fifteen, row(0, 'All 3 methods', { n: null, signals: 2, trades: 2, wins: 1, losses: 1, winPct: 50, profitPts: 100, lossPts: 60, netPts: 40, netR: 0.5 }))
      : sec('single', quiet, row(0, 'All 3 methods', { n: null }))])),
});

// "Today" is the IST day: the clock is pinned to 10:00 IST, 2 Oct 2026 (only Date is faked -- the polling still runs).
const TODAY = { from: '2026-10-02', to: '2026-10-02' };
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(Date.UTC(2026, 9, 2, 4, 30));
  localStorage.clear(); getMethodReport.mockReset(); getMethodReport.mockResolvedValue(report());
});
afterEach(() => vi.useRealTimers());

const ways = async () => within(await screen.findByRole('tablist', { name: 'Way' }));
const openWithout = async () => fireEvent.click((await ways()).getByRole('tab', { name: /Without timeframe chain/ }));
const shown = () => screen.getByRole('tabpanel', { name: /timeframe chain/ });

describe('the Methods report', () => {
  it('[critical] two tabs, one way each -- with the chain first, every method a line and the total', async () => {
    render(<MethodReport />);
    const tabs = (await ways()).getAllByRole('tab');
    expect(tabs[0]).toHaveAccessibleName('With timeframe chain, 5 trades');
    expect(tabs[1]).toHaveAccessibleName('Without timeframe chain, 5 trades');
    expect(tabs[0]).toHaveTextContent('With chain'); // the short label, for a phone
    expect(tabs[0]).toHaveAttribute('aria-selected', 'true');
    const table = await screen.findByRole('table', { name: 'With the timeframe chain' });
    expect(within(table).getAllByRole('row')).toHaveLength(1 + rows.length + 1); // header, methods, total
    expect(screen.queryByRole('region', { name: 'Without the timeframe chain' })).toBeNull(); // one way at a time
    const breakout = within(table).getByText('Breakout').closest('tr')!;
    expect(breakout).toHaveTextContent('33.3%');
    expect(breakout).toHaveTextContent('−30');
    // Each method's order side, in its own column; a row without one says so, and the total has none.
    expect(within(table).getByRole('columnheader', { name: 'Order side' })).toBeInTheDocument();
    expect(within(breakout).getAllByRole('cell')[2]).toHaveTextContent('BUY');
    expect(within(within(table).getByText('Retest').closest('tr')!).getAllByRole('cell')[2]).toHaveTextContent('SELL');
    expect(within(within(table).getByText('Momentum').closest('tr')!).getAllByRole('cell')[2]).toHaveTextContent('—');
    expect(within(within(table).getByText('All 3 methods').closest('tr')!).getAllByRole('cell')[2]).toBeEmptyDOMElement();
  });

  it('[critical] no net R anywhere on the screen -- points only', async () => {
    render(<MethodReport />);
    await screen.findByRole('table', { name: 'With the timeframe chain' });
    expect(screen.queryByText(/Net R/i)).toBeNull();
    expect(screen.queryByText(/[+−]\d+(\.\d+)?R\b/)).toBeNull();
    await openWithout();
    expect(screen.queryByText(/Net R/i)).toBeNull();
  });

  it('[critical] the second tab is the way without the chain, with a tab per timeframe', async () => {
    render(<MethodReport />);
    await openWithout();
    expect(shown()).toHaveAttribute('aria-labelledby', 'mrw-tab-single');
    const tfs = within(screen.getByRole('tablist', { name: 'Timeframe' })).getAllByRole('tab');
    expect(tfs.map((t) => t.textContent)).toEqual(['All5', '3m0', '5m0', '15m2', '30m0', '1h0', '2h0', '4h0']);
  });

  it('[critical] Profit and Loss list the methods whose net points are up or down -- and the totals follow', async () => {
    render(<MethodReport />);
    const table = await screen.findByRole('table', { name: 'With the timeframe chain' });
    const filter = within(screen.getByRole('group', { name: 'Show methods' }));
    expect(filter.getAllByRole('button').map((b) => b.textContent)).toEqual(['All 3', 'Profit 1', 'Loss 1', 'No trades 1']);
    fireEvent.click(filter.getByRole('button', { name: /Profit/ }));
    expect(within(table).queryByText('Breakout')).toBeNull();
    expect(within(table).getByText('Retest')).toBeInTheDocument();
    // The totals follow the filter -- top and bottom: Retest alone, +200, not the way's +170.
    expect(within(table).getByText('Profit · 1 method').closest('tr')).toHaveTextContent('+200');
    expect(within(table).queryByText('All 3 methods')).toBeNull();
    const kpis = within(screen.getByRole('region', { name: 'With the timeframe chain' }));
    expect(kpis.getByText('Net points').nextElementSibling).toHaveTextContent('+200');
    expect(kpis.getByText('Win rate').nextElementSibling).toHaveTextContent('100.0%');
    expect(screen.getByText(/1 of 3 methods/)).toBeInTheDocument();
    fireEvent.click(filter.getByRole('button', { name: /Loss/ }));
    expect(within(table).getByText('Breakout')).toBeInTheDocument();
    expect(within(table).queryByText('Retest')).toBeNull();
    fireEvent.click(filter.getByRole('button', { name: /No trades/ }));
    expect(within(table).getByText('Momentum')).toBeInTheDocument();
    expect(within(table).queryByText('Breakout')).toBeNull();
  });

  it('the filter counts follow the tab it is on', async () => {
    render(<MethodReport />);
    await openWithout();
    fireEvent.click(within(screen.getByRole('tablist', { name: 'Timeframe' })).getByRole('tab', { name: /15m/ }));
    const filter = within(screen.getByRole('group', { name: 'Show methods' }));
    expect(filter.getAllByRole('button').map((b) => b.textContent)).toEqual(['All 3', 'Profit 1', 'Loss 0', 'No trades 2']);
    fireEvent.click(filter.getByRole('button', { name: /Loss/ }));
    expect(screen.getByText('No method is in loss here.')).toBeInTheDocument();
  });

  it('[critical] a timeframe tab shows that timeframe alone -- and asks the server for nothing', async () => {
    render(<MethodReport />);
    await openWithout();
    const calls = getMethodReport.mock.calls.length;
    fireEvent.click(within(screen.getByRole('tablist', { name: 'Timeframe' })).getByRole('tab', { name: /15m/ }));
    const panel = screen.getByRole('tabpanel', { name: /15m/ });
    expect(within(panel).getByText('Breakout').closest('tr')).toHaveTextContent('50.0%');
    expect(within(panel).queryByRole('table', { name: 'By timeframe' })).toBeNull();
    expect(getMethodReport.mock.calls.length).toBe(calls);
  });

  it('[critical] All compares the timeframes in points, the best one named only when it made money', async () => {
    render(<MethodReport />);
    await openWithout();
    const by = screen.getByRole('table', { name: 'By timeframe' });
    expect(within(by).getAllByRole('row')).toHaveLength(1 + 6 + 1);
    expect(within(by).getByText('15m').closest('tr')).toHaveTextContent('best');
    fireEvent.click(within(by).getByRole('button', { name: '15m' }));
    expect(within(screen.getByRole('tablist', { name: 'Timeframe' })).getByRole('tab', { name: /15m/ })).toHaveAttribute('aria-selected', 'true');
  });

  it('no timeframe is called best when none made money', async () => {
    const losing = report();
    const t15 = losing.singleByTf['15m']!;
    losing.singleByTf['15m'] = { ...t15, total: { ...t15.total, netPts: -40 } };
    getMethodReport.mockResolvedValue(losing);
    render(<MethodReport />);
    await openWithout();
    expect(within(screen.getByRole('table', { name: 'By timeframe' })).queryByText('best')).toBeNull();
  });

  it('the arrow keys move between tabs, and only the chosen one is in the Tab order', async () => {
    render(<MethodReport />);
    const w = await ways();
    const withChain = w.getByRole('tab', { name: /With timeframe chain/ });
    fireEvent.keyDown(withChain, { key: 'ArrowRight' });
    expect(w.getByRole('tab', { name: /Without timeframe chain/ })).toHaveAttribute('aria-selected', 'true');
    expect(withChain).toHaveAttribute('tabindex', '-1');
    const tf = within(screen.getByRole('tablist', { name: 'Timeframe' }));
    fireEvent.keyDown(tf.getByRole('tab', { name: /All/ }), { key: 'End' });
    expect(tf.getByRole('tab', { name: /4h/ })).toHaveAttribute('aria-selected', 'true');
  });

  it('the way, the timeframe and the filter are remembered', async () => {
    const { unmount } = render(<MethodReport />);
    await openWithout();
    fireEvent.click(within(screen.getByRole('tablist', { name: 'Timeframe' })).getByRole('tab', { name: /1h/ }));
    fireEvent.click(within(screen.getByRole('group', { name: 'Show methods' })).getByRole('button', { name: /Profit/ }));
    unmount();
    render(<MethodReport />);
    expect((await ways()).getByRole('tab', { name: /Without timeframe chain/ })).toHaveAttribute('aria-selected', 'true');
    expect(within(screen.getByRole('tablist', { name: 'Timeframe' })).getByRole('tab', { name: /1h/ })).toHaveAttribute('aria-selected', 'true');
    expect(within(screen.getByRole('group', { name: 'Show methods' })).getByRole('button', { name: /Profit/ })).toHaveAttribute('aria-pressed', 'true');
  });

  it('a sort by net R remembered from the last build falls back to the method number', async () => {
    localStorage.setItem('btc-desk:methodReport.sort', JSON.stringify({ key: 'netR', asc: false }));
    render(<MethodReport />);
    const table = await screen.findByRole('table', { name: 'With the timeframe chain' });
    expect(within(table).getAllByRole('row')[1]).toHaveTextContent('Breakout');
  });

  it('[critical] every signal counts by default -- gate-off ones too -- and says how many were', async () => {
    render(<MethodReport />);
    await screen.findByRole('table', { name: 'With the timeframe chain' });
    expect(getMethodReport).toHaveBeenLastCalledWith(null, false, TODAY);
    expect(screen.getByText(/4 signals taken with a gate off/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('switch', { name: /Only signals with every gate on/ }));
    await waitFor(() => expect(getMethodReport).toHaveBeenLastCalledWith(null, true, TODAY));
  });

  it('[critical] nothing recorded says so, rather than a table of zeros', async () => {
    const empty = report();
    for (const s of empty.sections) { s.rows = s.rows.map((r) => ({ ...r, signals: 0, trades: 0 })); s.total = { ...s.total, signals: 0, trades: 0 }; }
    getMethodReport.mockResolvedValue(empty);
    render(<MethodReport />);
    expect(await screen.findByRole('status')).toHaveTextContent('No TRADE signals on today');
  });

  it('the pieces: the filter rule and the sort', () => {
    expect(rows.filter((r) => shows(r, 'profit')).map((r) => r.name)).toEqual(['Retest']);
    expect(rows.filter((r) => shows(r, 'loss')).map((r) => r.name)).toEqual(['Breakout']);
    expect(rows.filter((r) => shows(r, 'none')).map((r) => r.name)).toEqual(['Momentum']);
    expect(sortRows(rows, 'netPts', false).map((r) => r.name)).toEqual(['Retest', 'Breakout', 'Momentum']);
    expect(sortRows(rows, 'netPts', true).map((r) => r.name)).toEqual(['Breakout', 'Retest', 'Momentum']);
  });

  it('the CSV still holds every way and timeframe -- R kept there for the R&D', () => {
    const lines = reportCsv(report()).split('\r\n');
    expect(lines[0]).toBe('section,timeframe,no,method,order_side,signals,trades,wins,losses,win_pct,profit_pts,loss_pts,net_pts,profit_r,loss_r,net_r');
    expect(lines).toHaveLength(1 + 8 * (rows.length + 1));
  });

  it('[critical] the dates start at today, and once chosen are kept across a refresh', async () => {
    const { unmount } = render(<MethodReport />);
    await screen.findByRole('table', { name: 'With the timeframe chain' });
    expect(getMethodReport).toHaveBeenLastCalledWith(null, false, TODAY);
    expect(screen.getByRole('button', { name: /today/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /today/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'last 7 days' }));
    await waitFor(() => expect(getMethodReport).toHaveBeenLastCalledWith(null, false, { from: '2026-09-26', to: '2026-10-02' }));
    unmount();
    render(<MethodReport />);
    await screen.findByRole('table', { name: 'With the timeframe chain' });
    // remembered (owner, 2 Oct 2026: "set once, a refresh must not change it")
    expect(getMethodReport).toHaveBeenLastCalledWith(null, false, { from: '2026-09-26', to: '2026-10-02' });
  });

  it('[critical] "all time" asks for every signal, and the sections say which days they count', async () => {
    render(<MethodReport />);
    await screen.findByRole('table', { name: 'With the timeframe chain' });
    expect(screen.getByText(/today · 3 methods/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /today/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'all time' }));
    await waitFor(() => expect(getMethodReport).toHaveBeenLastCalledWith(null, false, null));
    expect(await screen.findByText(/all time · 3 methods/)).toBeInTheDocument();
  });

  it('[critical] a From time narrows the day to the minute: the server is asked for IST minutes', async () => {
    render(<MethodReport />);
    await screen.findByRole('table', { name: 'With the timeframe chain' });
    fireEvent.click(screen.getByRole('button', { name: /From time: 12:00 AM/ }));
    fireEvent.click(await screen.findByRole('button', { name: '9:00 AM' }));
    fireEvent.click(screen.getByRole('button', { name: 'Set 9:00 AM' }));
    await waitFor(() => expect(getMethodReport).toHaveBeenLastCalledWith(null, false, { from: '2026-10-02T09:00', to: '2026-10-02' }));
    expect(await screen.findByText(/today, 9:00 AM – 11:59 PM · 3 methods/)).toBeInTheDocument();
  });

  it('"all time" has no times to pick', async () => {
    render(<MethodReport />);
    await screen.findByRole('table', { name: 'With the timeframe chain' });
    expect(screen.getByRole('button', { name: /From time/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /today/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'all time' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: /From time/ })).toBeNull());
  });
});

describe('the date filter is remembered', () => {
  it('[critical] the days and times chosen survive a refresh', () => {
    localStorage.setItem('btc-desk:methodReport.range', JSON.stringify({ from: '2026-09-28', to: '2026-10-01' }));
    localStorage.setItem('btc-desk:methodReport.fromTime', JSON.stringify('09:15'));
    localStorage.setItem('btc-desk:methodReport.toTime', JSON.stringify('15:30'));
    render(<MethodReport />);
    // asked of the server with the remembered range, not today
    expect(getMethodReport).toHaveBeenCalledWith(null, false, { from: '2026-09-28T09:15', to: '2026-10-01T15:30' });
  });
});

describe('the Methods report on a phone (6 Oct 2026)', () => {
  const phone = (matches: boolean) => vi.stubGlobal('matchMedia', (q: string) => ({
    matches: matches && q.includes('max-width'), media: q, addEventListener: () => {}, removeEventListener: () => {},
  }));
  afterEach(() => vi.unstubAllGlobals());

  it('[critical] a line per method instead of eleven columns: an idle one quiet, one with signals saying them', async () => {
    phone(true);
    render(<MethodReport />);
    const list = await screen.findByRole('list', { name: 'With the timeframe chain' });
    expect(screen.queryByRole('table', { name: 'With the timeframe chain' })).toBeNull();
    const items = within(list).getAllByRole('listitem');
    expect(items).toHaveLength(rows.length + 1); // the methods, then the total
    const breakout = items.find((li) => li.textContent?.includes('Breakout'))!;
    expect(breakout).toHaveTextContent('4 signals');
    expect(breakout).toHaveTextContent('3 trades');
    expect(breakout).toHaveTextContent('33.3%');
    expect(breakout).toHaveTextContent('−30 pts');
    expect(items.find((li) => li.textContent?.includes('Momentum'))).toHaveTextContent('no signal');
    expect(items.at(-1)).toHaveTextContent('All 3 methods');
  });

  it('sorts from a picker, since there are no column heads to tap', async () => {
    phone(true);
    render(<MethodReport />);
    const list = await screen.findByRole('list', { name: 'With the timeframe chain' });
    fireEvent.change(screen.getAllByRole('combobox', { name: /Sort/ })[0]!, { target: { value: 'netPts' } });
    await waitFor(() => expect(within(list).getAllByRole('listitem')[0]).toHaveTextContent('Retest'));
  });
});
