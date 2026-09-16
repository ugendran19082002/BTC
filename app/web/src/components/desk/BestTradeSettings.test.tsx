import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { BestTradeSettings } from '@/components/desk/BestTradeSettings';

const getBestTradeSettings = vi.fn();
const setBestTradeSettings = vi.fn();
vi.mock('@/api/trade', () => ({
  getBestTradeSettings: (...a: unknown[]) => getBestTradeSettings(...a),
  setBestTradeSettings: (...a: unknown[]) => setBestTradeSettings(...a),
}));

/**
 * The best-pick card's two controls: "tell me when the pick changes" and
 * "only strikes paying at least $X". What must hold: the switch says plainly
 * when it cannot reach the phone, the floor is not saved on every keystroke,
 * and a change asks the board to be read again.
 */
const settings = (over: Partial<{ alertOn: boolean; minPremiumUsd: number; telegram: { configured: boolean; on: boolean } }> = {}) => ({
  alertOn: false, minPremiumUsd: 5, telegram: { configured: true, on: true }, ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  getBestTradeSettings.mockResolvedValue(settings());
  setBestTradeSettings.mockImplementation(async (p: { alertOn?: boolean; minPremiumUsd?: number }) =>
    ({ ok: true, alertOn: p.alertOn ?? false, minPremiumUsd: p.minPremiumUsd ?? 5 }));
});

describe('the best pick settings', () => {
  it('[critical] the switch is off until asked for, and turning it on is saved on the server', async () => {
    const onChanged = vi.fn();
    render(<BestTradeSettings onChanged={onChanged} />);
    const sw = await screen.findByRole('switch', { name: /Tell me when the pick changes/ });
    expect(sw).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByText(/Off — nothing is sent about this card/)).toBeInTheDocument();
    fireEvent.click(sw);
    await waitFor(() => expect(setBestTradeSettings).toHaveBeenCalledWith({ alertOn: true }));
    await waitFor(() => expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'true'));
    expect(screen.getByText(/One message when a different strike becomes the pick/)).toBeInTheDocument();
    expect(screen.getByLabelText('alert state')).toHaveTextContent('watching');
    expect(onChanged).toHaveBeenCalled();
  });

  it('[critical] says plainly when it is on but cannot reach the phone', async () => {
    getBestTradeSettings.mockResolvedValue(settings({ alertOn: true, telegram: { configured: true, on: false } }));
    render(<BestTradeSettings />);
    expect(await screen.findByText(/phone alerts are switched off in the header/)).toBeInTheDocument();
    expect(screen.getByLabelText('alert state')).toHaveTextContent('not reaching the phone');
    getBestTradeSettings.mockResolvedValue(settings({ alertOn: true, telegram: { configured: false, on: true } }));
    render(<BestTradeSettings />);
    expect(await screen.findByText(/no Telegram bot on this server/)).toBeInTheDocument();
  });

  it('[critical] the floor opens on the server’s value and is saved on Enter, not per keystroke', async () => {
    const onChanged = vi.fn();
    render(<BestTradeSettings onChanged={onChanged} />);
    const box = await screen.findByLabelText('only strikes paying at least') as HTMLInputElement;
    expect(box.value).toBe('5');
    fireEvent.change(box, { target: { value: '8' } });
    expect(setBestTradeSettings).not.toHaveBeenCalled();
    expect(screen.getByText(/Press Enter or tap away to keep \$8/)).toBeInTheDocument();
    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() => expect(setBestTradeSettings).toHaveBeenCalledWith({ minPremiumUsd: 8 }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it('the floor is also saved on tapping away', async () => {
    render(<BestTradeSettings />);
    const box = await screen.findByLabelText('only strikes paying at least');
    fireEvent.change(box, { target: { value: '6' } });
    fireEvent.blur(box);
    await waitFor(() => expect(setBestTradeSettings).toHaveBeenCalledWith({ minPremiumUsd: 6 }));
  });

  it('a floor of nothing is refused before it is sent', async () => {
    render(<BestTradeSettings />);
    const box = await screen.findByLabelText('only strikes paying at least');
    fireEvent.change(box, { target: { value: '0' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(setBestTradeSettings).not.toHaveBeenCalled();
    expect(screen.getByText('A price above zero.')).toBeInTheDocument();
  });

  it('says why cheaper strikes are left out', async () => {
    render(<BestTradeSettings />);
    expect(await screen.findByText(/margin at risk does not shrink when the option is cheaper/)).toBeInTheDocument();
  });

  it('a refusal from the server is shown', async () => {
    setBestTradeSettings.mockRejectedValue(new Error('minPremiumUsd must be a price above zero'));
    render(<BestTradeSettings />);
    fireEvent.click(await screen.findByRole('switch'));
    expect(await screen.findByRole('alert')).toHaveTextContent('minPremiumUsd must be a price above zero');
  });
});
