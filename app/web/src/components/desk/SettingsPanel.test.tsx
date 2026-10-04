import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { SettingsPanel } from '@/components/desk/SettingsPanel';

const getBestTradeSettings = vi.fn();
const setBestTradeSettings = vi.fn();
vi.mock('@/api/trade', () => ({
  getBestTradeSettings: (...a: unknown[]) => getBestTradeSettings(...a),
  setBestTradeSettings: (...a: unknown[]) => setBestTradeSettings(...a),
}));
const getSettings = vi.fn();
const setWallWithinEm = vi.fn();
const getDeskMetrics = vi.fn();
vi.mock('@/api/desk', () => ({
  getSettings: (...a: unknown[]) => getSettings(...a),
  setWallWithinEm: (...a: unknown[]) => setWallWithinEm(...a),
  getDeskMetrics: (...a: unknown[]) => getDeskMetrics(...a),
}));
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

/**
 * The numbers the desk works to, in one screen: read from the server and
 * written back, never read from a constant in the browser.
 */
beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  getBestTradeSettings.mockResolvedValue({ minPremiumUsd: 5 });
  getDeskMetrics.mockResolvedValue(metrics);
  setBestTradeSettings.mockResolvedValue({ ok: true, minPremiumUsd: 8 });
  getSettings.mockResolvedValue({ settings: { wall_within_em: '2' }, shortCap: { inForce: 1, ceiling: 1, chosen: null } });
  setWallWithinEm.mockResolvedValue({ ok: true, key: 'wall_within_em', value: '1.5' });
});

describe('the settings screen', () => {
  it('[critical] has no switch that places an order: the best pick\'s automatic trade and its limits are gone, and it says so', async () => {
    render(<SettingsPanel />);
    expect(await screen.findByText(/Nothing on this screen places an order/)).toBeInTheDocument();
    expect(screen.queryByLabelText('auto-trade limits')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('best pick switches')).not.toBeInTheDocument();
    expect(screen.queryByRole('switch')).not.toBeInTheDocument();
  });

  it('[critical] the best pick keeps its premium floor, read from the server and saved back', async () => {
    render(<SettingsPanel />);
    const card = within(await screen.findByLabelText('best pick settings card'));
    const box = await card.findByLabelText('only strikes paying at least');
    expect(box).toHaveValue('5');
    fireEvent.change(box, { target: { value: '8' } });
    fireEvent.blur(box);
    await waitFor(() => expect(setBestTradeSettings).toHaveBeenCalledWith({ minPremiumUsd: 8 }));
  });

  it('[critical] the level band is a setting, and a fraction is allowed', async () => {
    render(<SettingsPanel />);
    const box = await screen.findByLabelText('level band in expected moves');
    expect(box).toHaveValue('2');
    fireEvent.change(box, { target: { value: '1.5' } });
    fireEvent.blur(box);
    await waitFor(() => expect(setWallWithinEm).toHaveBeenCalledWith(1.5));
    fireEvent.change(box, { target: { value: '0.1' } });
    fireEvent.blur(box);
    expect(setWallWithinEm).toHaveBeenCalledTimes(1);
  });
});

describe('speed and Delta quota', () => {
  it('[critical] shows what the desk counted: the quota used, 429s, Delta\'s answer time, the pass over the open trades and the signal run', async () => {
    render(<SettingsPanel />);
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
    const { unmount } = render(<SettingsPanel />);
    const limited = await screen.findByLabelText('rate limited');
    expect(limited).toHaveTextContent('1 in the last 5 minutes · 3 since the server started');
    expect(limited).toHaveClass('warn');
    expect(screen.getByLabelText('quota used')).toHaveClass('warn');
    unmount();
    getDeskMetrics.mockRejectedValue(new Error('404'));
    render(<SettingsPanel />);
    expect(await screen.findByText('Not available on this server.')).toBeInTheDocument();
  });
});
