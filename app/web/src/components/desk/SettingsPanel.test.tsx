import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { SettingsPanel } from '@/components/desk/SettingsPanel';

const getAutoTrade = vi.fn();
const setAutoTrade = vi.fn();
const getBestTradeSettings = vi.fn();
vi.mock('@/api/trade', () => ({
  getAutoTrade: (...a: unknown[]) => getAutoTrade(...a),
  setAutoTrade: (...a: unknown[]) => setAutoTrade(...a),
  clearAutoTrade: vi.fn(),
  getBestTradeSettings: (...a: unknown[]) => getBestTradeSettings(...a),
  setBestTradeSettings: vi.fn(),
}));
const getSettings = vi.fn();
const setWallWithinEm = vi.fn();
vi.mock('@/api/desk', () => ({
  getSettings: (...a: unknown[]) => getSettings(...a),
  setWallWithinEm: (...a: unknown[]) => setWallWithinEm(...a),
}));

/**
 * Every number the desk works to, in one screen.
 *
 * The property worth pinning: these are read from the server and written back,
 * never read from a constant in the browser — and the hard ceiling each box
 * cannot pass is shown, so raising a limit is a decision with a visible edge.
 */

const autoTrade = {
  settings: { on: false, lots: 5, targetPct: 95, stopPct: 0, chaseSeconds: 5, maxPerContract: 1 },
  defaults: { on: false, lots: 5, targetPct: 95, stopPct: 0, chaseSeconds: 5, maxPerContract: 1 },
  limits: { maxLots: 1_000, minTargetPct: 1, maxTargetPct: 99, maxStopPct: 500, maxChaseSec: 600, maxPerContract: 10 },
  ceilings: { maxLots: 100_000, maxTargetPct: 99, maxStopPct: 10_000, maxChaseSec: 600, maxPerContract: 100 },
  mode: 'paper', done: {},
};

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  getAutoTrade.mockResolvedValue(autoTrade);
  getBestTradeSettings.mockResolvedValue({ alertOn: false, minPremiumUsd: 5, repeat: 1, telegram: { configured: true, on: true } });
  setAutoTrade.mockResolvedValue({ ok: true, settings: autoTrade.settings });
  getSettings.mockResolvedValue({ settings: { wall_within_em: '2' }, shortCap: { inForce: 1, ceiling: 1, chosen: null } });
  setWallWithinEm.mockResolvedValue({ ok: true, key: 'wall_within_em', value: '1.5' });
});

describe('the settings screen', () => {
  it('[critical] shows the limits in force, from the server, with their hard ceiling', async () => {
    render(<SettingsPanel />);
    const card = within(await screen.findByLabelText('auto-trade limits'));
    expect(card.getByLabelText('Most lots per order')).toHaveValue('1000');
    expect(card.getByText('up to 100,000')).toBeInTheDocument();
  });

  it('[critical] a changed limit is saved as a limit, not as a setting', async () => {
    render(<SettingsPanel />);
    const box = await screen.findByLabelText('Most lots per order');
    fireEvent.change(box, { target: { value: '50' } });
    fireEvent.blur(box);
    await waitFor(() => expect(setAutoTrade).toHaveBeenCalledWith({ limits: { maxLots: 50 } }));
  });

  it('a number past the hard ceiling is refused before it is sent', async () => {
    render(<SettingsPanel />);
    const box = await screen.findByLabelText('Most lots per order');
    fireEvent.change(box, { target: { value: '999999' } });
    fireEvent.blur(box);
    expect(setAutoTrade).not.toHaveBeenCalled();
    expect(screen.getByText('1 to 100,000')).toBeInTheDocument();
  });

  it('says plainly which switches here place orders, and that the limits do not', async () => {
    render(<SettingsPanel />);
    expect(await screen.findByText(/The only switches here that place orders are the best pick's, above/)).toBeInTheDocument();
  });

  it('a server it cannot reach says so rather than showing invented numbers', async () => {
    getAutoTrade.mockRejectedValue(new Error('offline'));
    render(<SettingsPanel />);
    expect(await screen.findByText('offline')).toBeInTheDocument();
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

describe('the best pick\'s own switches', () => {
  it('[critical] are on this screen -- the server runs them from saved settings, so they must be visible somewhere', async () => {
    render(<SettingsPanel />);
    expect(await screen.findByText('Best pick — alerts and automatic trade')).toBeInTheDocument();
    await waitFor(() => expect(getBestTradeSettings).toHaveBeenCalled());
  });
});
