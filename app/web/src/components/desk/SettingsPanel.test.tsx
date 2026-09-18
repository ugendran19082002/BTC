import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { SettingsPanel } from '@/components/desk/SettingsPanel';

const getAutoTrade = vi.fn();
const setAutoTrade = vi.fn();
const getRebalanceSettings = vi.fn();
const setRebalanceSettings = vi.fn();
vi.mock('@/api/trade', () => ({
  getAutoTrade: (...a: unknown[]) => getAutoTrade(...a),
  setAutoTrade: (...a: unknown[]) => setAutoTrade(...a),
}));
const getSettings = vi.fn();
const setWallWithinEm = vi.fn();
vi.mock('@/api/desk', () => ({
  getSettings: (...a: unknown[]) => getSettings(...a),
  setWallWithinEm: (...a: unknown[]) => setWallWithinEm(...a),
}));
vi.mock('@/api/strategy', () => ({
  getRebalanceSettings: (...a: unknown[]) => getRebalanceSettings(...a),
  setRebalanceSettings: (...a: unknown[]) => setRebalanceSettings(...a),
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
const rebalance = {
  defaults: {
    enabled: true, lotsPerStep: 30, steps: 3, upStartPct: 30, downStartPct: 20, incrementPct: 10,
    confirmTicks: 2, endTime: '13:30', lockDirection: true, maxLotsPerSide: 200, allowPartial: true, maxSpreadPct: 0.15,
  },
  limits: {
    maxSteps: 20, maxLotsPerStep: 10_000, maxUpPct: 500, maxDownPct: 99,
    maxIncrementPct: 500, maxConfirmTicks: 10, maxLotsPerSide: 100_000,
  },
  ceilings: {
    maxSteps: 100, maxLotsPerStep: 100_000, maxUpPct: 10_000, maxDownPct: 99,
    maxIncrementPct: 10_000, maxConfirmTicks: 60, maxLotsPerSide: 1_000_000,
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  getAutoTrade.mockResolvedValue(autoTrade);
  setAutoTrade.mockResolvedValue({ ok: true, settings: autoTrade.settings });
  getRebalanceSettings.mockResolvedValue(rebalance);
  getSettings.mockResolvedValue({ settings: { wall_within_em: '2' }, shortCap: { inForce: 1, ceiling: 1, chosen: null } });
  setWallWithinEm.mockResolvedValue({ ok: true, key: 'wall_within_em', value: '1.5' });
  setRebalanceSettings.mockImplementation(async (p: { defaults?: object; limits?: object }) => ({
    ok: true,
    defaults: { ...rebalance.defaults, ...(p.defaults ?? {}) },
    limits: { ...rebalance.limits, ...(p.limits ?? {}) },
  }));
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

  it('[critical] the rebalance defaults are settings: what a new rule starts as', async () => {
    render(<SettingsPanel />);
    const card = within(await screen.findByLabelText('rebalance settings'));
    expect(card.getByText(/3 stages from \+30% \/ −20%/)).toBeInTheDocument();
    const steps = card.getAllByLabelText('Stages')[0]!;
    fireEvent.change(steps, { target: { value: '5' } });
    fireEvent.blur(steps);
    await waitFor(() => expect(setRebalanceSettings).toHaveBeenCalledWith({ defaults: { steps: 5 } }));
  });

  it('[critical] the rule limits are separate from the defaults, and both are editable', async () => {
    render(<SettingsPanel />);
    const card = within(await screen.findByLabelText('rebalance settings'));
    const [defaultSteps, limitSteps] = card.getAllByLabelText('Stages');
    expect(defaultSteps).toHaveValue('3');
    expect(limitSteps).toHaveValue('20');
    fireEvent.change(limitSteps!, { target: { value: '40' } });
    fireEvent.blur(limitSteps!);
    await waitFor(() => expect(setRebalanceSettings).toHaveBeenCalledWith({ limits: { maxSteps: 40 } }));
  });

  it('says plainly that nothing here places an order', async () => {
    render(<SettingsPanel />);
    expect(await screen.findByText(/The switches that actually place orders are where the orders are/)).toBeInTheDocument();
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
