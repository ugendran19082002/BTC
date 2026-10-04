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
vi.mock('@/api/desk', () => ({
  getSettings: (...a: unknown[]) => getSettings(...a),
  setWallWithinEm: (...a: unknown[]) => setWallWithinEm(...a),
}));

/**
 * The numbers the desk works to, in one screen: read from the server and
 * written back, never read from a constant in the browser.
 */
beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  getBestTradeSettings.mockResolvedValue({ minPremiumUsd: 5 });
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
