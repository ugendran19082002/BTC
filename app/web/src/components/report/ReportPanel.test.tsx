import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ReportPanel } from '@/components/report/ReportPanel';
import type { DaysReport, MtmReport } from '@/types/report';

const getDays = vi.fn();
const getMtm = vi.fn();
vi.mock('@/api/report', () => ({
  getDays: (...a: unknown[]) => getDays(...a),
  getMtm: (...a: unknown[]) => getMtm(...a),
  daysCsvUrl: (from: string, to: string) => `/api/report/days.csv?from=${from}&to=${to}`,
}));

/**
 * The P&L screen: a calendar, a running line, and today's line.
 *
 * What must not happen: a day drawn in the wrong colour, the charges toggle
 * changing the picture but not the numbers (or the other way round), or the
 * day's line claiming a drawdown that is only its minimum.
 */
const days = (over: Partial<DaysReport> = {}): DaysReport => ({
  mode: 'live', from: '2026-09-01', to: '2026-09-14',
  days: [
    { day: '2026-09-11', realisedUsd: 14, chargesUsd: 0.5, netUsd: 13.5, trades: 2, cumulativeUsd: 13.5 },
    { day: '2026-09-12', realisedUsd: -20, chargesUsd: 0.4, netUsd: -20.4, trades: 1, cumulativeUsd: -6.9 },
    { day: '2026-09-14', realisedUsd: 0.3, chargesUsd: 0.6, netUsd: -0.3, trades: 3, cumulativeUsd: -7.2 },
  ],
  totals: {
    realisedUsd: -5.7, chargesUsd: 1.5, netUsd: -7.2, tradingDays: 3, winDays: 1, lossDays: 2,
    best: { day: '2026-09-11', netUsd: 13.5 }, worst: { day: '2026-09-12', netUsd: -20.4 },
  },
  ...over,
});

const T = Date.UTC(2026, 8, 14, 0, 30);   // 06:00 IST
const mtm = (over: Partial<MtmReport> = {}): MtmReport => ({
  mode: 'live', day: '2026-09-14',
  samples: [-8, -3, 6, 2, 4].map((netUsd, i) => ({ at: T + i * 60_000, day: '2026-09-14', realisedUsd: 0, unrealisedUsd: netUsd, chargesUsd: 0, netUsd })),
  stats: { nowUsd: 4, min: { at: T, netUsd: -8 }, max: { at: T + 120_000, netUsd: 6 }, maxDrawdown: { usd: 4, at: T + 180_000 } },
  days: ['2026-09-14', '2026-09-12'],
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  try { localStorage.clear(); } catch { /* no storage */ }
  getDays.mockResolvedValue(days());
  getMtm.mockResolvedValue(mtm());
});

describe('the calendar', () => {
  it('[critical] colours a day by its sign and says its number on the square', async () => {
    render(<ReportPanel />);
    const up = await screen.findByRole('gridcell', { name: /2026-09-11: \+₹1,148/ });
    expect(up).toHaveClass('up');
    const down = screen.getByRole('gridcell', { name: /2026-09-12: −₹1,734/ });
    expect(down).toHaveClass('down', 'l3');
    expect(screen.getByRole('gridcell', { name: /2026-09-05: no trades/ })).toHaveClass('none');
  });

  it('[critical] the totals name the best and worst day', async () => {
    render(<ReportPanel />);
    const totals = within(await screen.findByLabelText('totals'));
    expect(totals.getByText('Best day').nextSibling).toHaveTextContent('+₹1,148');
    expect(totals.getByText('Worst day').nextSibling).toHaveTextContent('−₹1,734');
    expect(totals.getByText('Days').nextSibling).toHaveTextContent('3');
    expect(totals.getByText('Net').nextSibling).toHaveTextContent('−₹612');
  });

  it('[critical] turning charges off changes the squares and the totals together', async () => {
    render(<ReportPanel />);
    await screen.findByLabelText('totals');
    fireEvent.click(screen.getByRole('switch', { name: /Include charges/ }));
    // 14 Sep: +0.30 before charges, −0.30 after -- the square flips colour
    expect(screen.getByRole('gridcell', { name: /2026-09-14: \+₹25\.50/ })).toHaveClass('up');
    const totals = within(screen.getByLabelText('totals'));
    expect(totals.getByText('Gross').nextSibling).toHaveTextContent('−₹485');
  });

  it('tapping a day asks for that day\'s line', async () => {
    render(<ReportPanel />);
    fireEvent.click(await screen.findByRole('gridcell', { name: /2026-09-12/ }));
    await waitFor(() => expect(getMtm).toHaveBeenLastCalledWith('2026-09-12'));
  });

  it('offers the spreadsheet for the range that is showing', async () => {
    render(<ReportPanel />);
    await screen.findByLabelText('totals');
    const link = screen.getByRole('link', { name: /CSV/ });
    expect(link.getAttribute('href')).toMatch(/^\/api\/report\/days\.csv\?from=\d{4}-\d{2}-\d{2}&to=\d{4}-\d{2}-\d{2}$/);
  });

  it('refuses a range that ends before it starts, and asks nothing', async () => {
    render(<ReportPanel />);
    await screen.findByLabelText('totals');
    getDays.mockClear();
    fireEvent.change(screen.getByLabelText('from date'), { target: { value: '2027-01-01' } });
    expect(screen.getByText(/must not be after the end date/)).toBeInTheDocument();
    expect(getDays).not.toHaveBeenCalled();
  });
});

describe('the day, minute by minute', () => {
  it('[critical] shows the four figures, with the low and the fall told apart', async () => {
    render(<ReportPanel />);
    expect(await screen.findByText('Low')).toBeInTheDocument();
    expect(screen.getByText('Low').nextSibling).toHaveTextContent('−₹680');
    expect(screen.getByText('High').nextSibling).toHaveTextContent('+₹510');
    // the worst fall is 6 -> 2, not the −8 it opened at
    expect(screen.getByText('Worst fall').nextSibling).toHaveTextContent('−₹340');
    expect(screen.getByText(/bottomed 06:03/)).toBeInTheDocument();
  });

  it('draws the line and the drawdown shading', async () => {
    const { container } = render(<ReportPanel />);
    await screen.findByText('Low');
    expect(container.querySelector('.mtm-line')).toBeInTheDocument();
    expect(container.querySelector('.mtm-drawdown')).toBeInTheDocument();
  });

  it('says so, in words, when a day has no readings', async () => {
    getMtm.mockResolvedValue(mtm({ samples: [], stats: { nowUsd: null, min: null, max: null, maxDrawdown: null } }));
    render(<ReportPanel />);
    expect(await screen.findByText(/No readings for 2026-09-14/)).toBeInTheDocument();
  });
});
