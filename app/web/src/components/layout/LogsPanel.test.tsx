import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { LogsPanel } from '@/components/layout/LogsPanel';

const getDeskMetrics = vi.fn();
vi.mock('@/api/desk', () => ({ getDeskMetrics: (...a: unknown[]) => getDeskMetrics(...a) }));
vi.mock('@/api/errors', () => ({
  getErrors: vi.fn().mockResolvedValue({ errors: [], summary: { unresolved: 0, bySource: {} } }),
  resolveError: vi.fn(), resolveAll: vi.fn(),
}));
const getTelegramLog = vi.fn();
vi.mock('@/api/trade', () => ({ getTelegramLog: (...a: unknown[]) => getTelegramLog(...a) }));

const spread = (p50: number | null, p95: number | null, max: number | null) => ({ p50Ms: p50, p95Ms: p95, maxMs: max });
const metrics = {
  at: 0, countingForMs: 600_000,
  delta: {
    windowMs: 300_000, quotaUnits: 20_000, calls: 2_400, units: 7_300, usedPct: 36.5,
    byKind: [{ kind: 'order lookup', calls: 2_300, units: 6_900 }, { kind: 'place, edit or cancel', calls: 80, units: 400 }],
    response: spread(180, 420, 1_300), failed: 0, refused: 2, rateLimited: { inWindow: 0, sinceStart: 0, lastAt: null },
  },
  passes: { count: 250, everyMs: 1_000, ...spread(640, 1_800, 4_200), late: 31, tradesNow: 18 },
  signalRun: { count: 12, read: spread(90, 140, 200), calc: spread(310, 520, 700) },
  thread: { p50Ms: 1, p99Ms: 38, maxMs: 512 },
};

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  getDeskMetrics.mockResolvedValue(metrics);
  getTelegramLog.mockRejectedValue(new Error('not in this test'));
});
const tab = (name: string) => within(screen.getByRole('tablist', { name: 'Logs' })).getByRole('tab', { name });

describe('the Logs screen', () => {
  it('[critical] has the errors, the Telegram log and the speed gauges as tabs, opens on errors and remembers the tab', () => {
    const { unmount } = render(<LogsPanel />);
    expect(within(screen.getByRole('tablist', { name: 'Logs' })).getAllByRole('tab').map((t) => t.textContent?.trim())).toEqual(['Errors', 'Telegram', 'Speed']);
    expect(tab('Errors')).toHaveAttribute('aria-selected', 'true');
    fireEvent.click(tab('Telegram'));
    expect(tab('Telegram')).toHaveAttribute('aria-selected', 'true');
    expect(getTelegramLog).toHaveBeenCalled();
    unmount();
    render(<LogsPanel />);
    expect(tab('Telegram')).toHaveAttribute('aria-selected', 'true');
  });

  it('[critical] Speed shows what the desk counted: the quota used, 429s, Delta\'s answer time, the pass over the open trades and the signal run', async () => {
    render(<LogsPanel />);
    fireEvent.click(tab('Speed'));
    const card = within(await screen.findByLabelText('desk metrics'));
    expect(card.getByLabelText('quota used')).toHaveTextContent('7,300 of 20,000 units (36.5%) · 2,400 calls');
    expect(card.getByText('order lookup: 6,900 units · 2,300 calls')).toBeInTheDocument();
    expect(card.getByLabelText('rate limited')).toHaveTextContent('None since the server started');
    expect(card.getByLabelText('delta response time')).toHaveTextContent('180 ms median · 420 ms at worst 5% · 1.3 s longest');
    expect(card.getByLabelText('pass time')).toHaveTextContent('640 ms median · 1.8 s at worst 5% · 4.2 s longest');
    expect(card.getByLabelText('late passes')).toHaveTextContent('31 of 250 took over a second · 18 trades polled now');
    expect(card.getByLabelText('signal calculation time')).toHaveTextContent('every method on it: 310 ms median · 520 ms at worst 5% · 700 ms longest — the SL and TGT watch waits this long');
    expect(card.getByLabelText('thread held')).toHaveTextContent('held 38 ms at worst 1% · 512 ms longest');
  });

  it('a 429 is said in the warning colour, and a server without the gauges says so instead of showing zeros', async () => {
    getDeskMetrics.mockResolvedValue({ ...metrics, delta: { ...metrics.delta, usedPct: 72, rateLimited: { inWindow: 1, sinceStart: 3, lastAt: 1 } } });
    const { unmount } = render(<LogsPanel />);
    fireEvent.click(tab('Speed'));
    const limited = await screen.findByLabelText('rate limited');
    expect(limited).toHaveTextContent('1 in the last 5 minutes · 3 since the server started');
    expect(limited).toHaveClass('warn');
    expect(screen.getByLabelText('quota used')).toHaveClass('warn');
    unmount();
    getDeskMetrics.mockRejectedValue(new Error('404'));
    render(<LogsPanel />);
    expect(await screen.findByText('Not available on this server.')).toBeInTheDocument();
  });
});
