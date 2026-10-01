import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MethodReport, reportCsv, sortRows } from '@/components/report/MethodReport';
import type { EntryTf, MethodReportResponse, MethodReportRow, MethodReportSection } from '@/types/entry';

const getMethodReport = vi.fn();
vi.mock('@/api/entry', () => ({ getMethodReport: (...a: unknown[]) => getMethodReport(...a) }));

const row = (n: number, name: string, o: Partial<MethodReportRow> = {}): MethodReportRow => ({
  n, method: name.toLowerCase(), name, signals: 0, trades: 0, wins: 0, losses: 0, winPct: null,
  profitPts: 0, lossPts: 0, netPts: 0, profitR: 0, lossR: 0, netR: 0, ...o,
});
const rows = [
  row(1, 'Breakout', { signals: 4, trades: 3, wins: 1, losses: 2, winPct: 100 / 3, profitPts: 150, lossPts: 120, netPts: 30, profitR: 1.5, lossR: 1.2, netR: 0.3 }),
  row(2, 'Retest', { signals: 5, trades: 2, wins: 2, losses: 0, winPct: 100, profitPts: 200, netPts: 200, profitR: 3, netR: 3 }),
  row(3, 'Momentum'),
];
const total = row(0, 'All 3 methods', { n: null, signals: 9, trades: 5, wins: 3, losses: 2, winPct: 60, profitPts: 350, lossPts: 120, netPts: 230, profitR: 4.5, lossR: 1.2, netR: 3.3 });
const sec = (mode: 'mtf' | 'single', r = rows, t = total, gatesOffSignals = 0): MethodReportSection =>
  ({ mode, label: mode === 'mtf' ? 'With the timeframe chain' : 'Without the timeframe chain', rows: r, total: t, gatesOffSignals });

/** 15m holds the trades; every other timeframe is quiet. */
const fifteen = [row(1, 'Breakout', { signals: 2, trades: 2, wins: 1, losses: 1, winPct: 50, netPts: 40, netR: 0.5 }), row(2, 'Retest'), row(3, 'Momentum')];
const quiet = [row(1, 'Breakout'), row(2, 'Retest'), row(3, 'Momentum')];
const report = (): MethodReportResponse => ({
  tf: null,
  sections: [sec('mtf', rows, total, 4), sec('single')],
  singleByTf: Object.fromEntries((['3m', '5m', '15m', '30m', '1h', '4h'] as EntryTf[]).map((tf) => [tf,
    tf === '15m'
      ? sec('single', fifteen, row(0, 'All 3 methods', { n: null, signals: 2, trades: 2, wins: 1, losses: 1, winPct: 50, netPts: 40, netR: 0.5 }))
      : sec('single', quiet, row(0, 'All 3 methods', { n: null }))])),
});

beforeEach(() => { localStorage.clear(); getMethodReport.mockReset(); getMethodReport.mockResolvedValue(report()); });

const chainSection = () => screen.findByRole('region', { name: 'With the timeframe chain' });
const aloneSection = () => screen.getByRole('region', { name: 'Without the timeframe chain' });

describe('the Methods report', () => {
  it('[critical] two sections, every method a line, and the totals', async () => {
    render(<MethodReport />);
    const chain = await chainSection();
    const methods = within(chain).getByRole('table', { name: 'With the timeframe chain' });
    expect(within(methods).getAllByRole('row')).toHaveLength(1 + rows.length + 1); // header, methods, total
    const breakout = within(methods).getByText('Breakout').closest('tr')!;
    expect(breakout).toHaveTextContent('33.3%');
    expect(breakout).toHaveTextContent('+30');
    expect(breakout).toHaveTextContent('+0.30R');
    expect(within(chain).queryByRole('tablist')).toBeNull(); // with the chain the entry is always 5m: no tabs
  });

  it('[critical] without the chain: a tab for All and each timeframe, each with its trade count', async () => {
    render(<MethodReport />);
    await chainSection();
    const tabs = within(aloneSection()).getAllByRole('tab');
    expect(tabs.map((t) => t.textContent)).toEqual(['All5', '3m0', '5m0', '15m2', '30m0', '1h0', '4h0']);
    expect(within(aloneSection()).getByRole('tab', { name: /All/ })).toHaveAttribute('aria-selected', 'true');
  });

  it('[critical] a timeframe tab shows that timeframe alone -- and asks the server for nothing', async () => {
    render(<MethodReport />);
    await chainSection();
    const calls = getMethodReport.mock.calls.length;
    fireEvent.click(within(aloneSection()).getByRole('tab', { name: /15m/ }));
    const panel = within(aloneSection()).getByRole('tabpanel');
    expect(panel).toHaveAttribute('aria-labelledby', 'mr-tab-15m');
    expect(within(panel).getByText('Breakout').closest('tr')).toHaveTextContent('50.0%');
    expect(within(panel).queryByRole('table', { name: 'By timeframe' })).toBeNull();
    expect(getMethodReport.mock.calls.length).toBe(calls);
  });

  it('[critical] All compares the timeframes, and a row opens its tab', async () => {
    render(<MethodReport />);
    await chainSection();
    const by = within(aloneSection()).getByRole('table', { name: 'By timeframe' });
    expect(within(by).getAllByRole('row')).toHaveLength(1 + 6 + 1);
    expect(within(by).getByText('15m').closest('tr')).toHaveTextContent('best net R');
    fireEvent.click(within(by).getByRole('button', { name: '15m' }));
    expect(within(aloneSection()).getByRole('tab', { name: /15m/ })).toHaveAttribute('aria-selected', 'true');
  });

  it('the arrow keys move between tabs, and only the chosen one is in the Tab order', async () => {
    render(<MethodReport />);
    await chainSection();
    const all = within(aloneSection()).getByRole('tab', { name: /All/ });
    expect(all).toHaveAttribute('tabindex', '0');
    fireEvent.keyDown(all, { key: 'ArrowRight' });
    const three = within(aloneSection()).getByRole('tab', { name: /3m/ });
    expect(three).toHaveAttribute('aria-selected', 'true');
    expect(all).toHaveAttribute('tabindex', '-1');
    fireEvent.keyDown(three, { key: 'End' });
    expect(within(aloneSection()).getByRole('tab', { name: /4h/ })).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(within(aloneSection()).getByRole('tab', { name: /4h/ }), { key: 'ArrowRight' });
    expect(within(aloneSection()).getByRole('tab', { name: /All/ })).toHaveAttribute('aria-selected', 'true');
  });

  it('the chosen tab is remembered', async () => {
    const { unmount } = render(<MethodReport />);
    await chainSection();
    fireEvent.click(within(aloneSection()).getByRole('tab', { name: /1h/ }));
    unmount();
    render(<MethodReport />);
    await chainSection();
    expect(within(aloneSection()).getByRole('tab', { name: /1h/ })).toHaveAttribute('aria-selected', 'true');
  });

  it('[critical] a method with no trade shows no win rate rather than 0%', async () => {
    render(<MethodReport />);
    const chain = await chainSection();
    expect(within(chain).getByText('Momentum').closest('tr')).toHaveTextContent('—');
  });

  it('hiding methods with no trades keeps the totals', async () => {
    render(<MethodReport />);
    await chainSection();
    fireEvent.click(screen.getByRole('switch', { name: /Hide methods with no trades/ }));
    const chain = screen.getByRole('region', { name: 'With the timeframe chain' });
    expect(within(chain).queryByText('Momentum')).toBeNull();
    expect(within(chain).getByText('All 3 methods')).toBeInTheDocument();
  });

  it('[critical] every signal counts by default -- gate-off ones too -- and says how many were', async () => {
    render(<MethodReport />);
    const chain = await chainSection();
    expect(getMethodReport).toHaveBeenLastCalledWith(null, false);
    expect(within(chain).getByText(/4 signals taken with a gate off/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('switch', { name: /Only signals with every gate on/ }));
    await waitFor(() => expect(getMethodReport).toHaveBeenLastCalledWith(null, true));
  });

  it('[critical] nothing recorded says so, rather than a table of zeros', async () => {
    const empty = report();
    for (const s of empty.sections) { s.rows = s.rows.map((r) => ({ ...r, signals: 0, trades: 0 })); s.total = { ...s.total, signals: 0, trades: 0 }; }
    getMethodReport.mockResolvedValue(empty);
    render(<MethodReport />);
    expect(await screen.findByRole('status')).toHaveTextContent('No TRADE signals recorded yet');
  });

  it('sorting puts methods without a trade last, whichever way', () => {
    expect(sortRows(rows, 'netR', false).map((r) => r.name)).toEqual(['Retest', 'Breakout', 'Momentum']);
    expect(sortRows(rows, 'netR', true).map((r) => r.name)).toEqual(['Breakout', 'Retest', 'Momentum']);
    expect(sortRows(rows, 'n', true).map((r) => r.n)).toEqual([1, 2, 3]);
  });

  it('the CSV holds both sections and every timeframe, each line marked with its timeframe', () => {
    const lines = reportCsv(report()).split('\r\n');
    expect(lines[0]).toBe('section,timeframe,no,method,signals,trades,wins,losses,win_pct,profit_pts,loss_pts,net_pts,profit_r,loss_r,net_r');
    expect(lines).toHaveLength(1 + 8 * (rows.length + 1)); // with the chain, All, six timeframes
    expect(lines.filter((l) => l.includes(',15m,1,Breakout,'))[0]).toContain(',2,2,1,1,50,');
  });

  it('[critical] no timeframe is called best when none made money', async () => {
    const losing = report();
    const t15 = losing.singleByTf['15m']!;
    losing.singleByTf['15m'] = { ...t15, total: { ...t15.total, netPts: -40, netR: -0.5 } };
    getMethodReport.mockResolvedValue(losing);
    render(<MethodReport />);
    await chainSection();
    expect(within(aloneSection()).queryByText('best net R')).toBeNull();
  });
});
