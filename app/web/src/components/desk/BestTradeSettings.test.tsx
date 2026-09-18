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
const settings = (over: Partial<{ alertOn: boolean; minPremiumUsd: number; repeat: number; telegram: { configured: boolean; on: boolean } }> = {}) => ({
  alertOn: false, minPremiumUsd: 5, repeat: 1, telegram: { configured: true, on: true }, ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  getBestTradeSettings.mockResolvedValue(settings());
  setBestTradeSettings.mockImplementation(async (p: { alertOn?: boolean; minPremiumUsd?: number; repeat?: number }) =>
    ({ ok: true, alertOn: p.alertOn ?? true, minPremiumUsd: p.minPremiumUsd ?? 5, repeat: p.repeat ?? 1 }));
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
    expect(screen.getByText(/One message when the pick changes\. The same strike is sent once at most/)).toBeInTheDocument();
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

  it('[critical] same strike defaults to once, and the stepper saves the new count', async () => {
    getBestTradeSettings.mockResolvedValue(settings({ alertOn: true }));
    render(<BestTradeSettings />);
    const group = await screen.findByRole('group', { name: 'times the same strike is sent' });
    expect(group).toHaveTextContent('1×');
    expect(screen.getByRole('button', { name: 'send the same strike fewer times' })).toBeDisabled();
    expect(screen.getByText(/from 5:31 PM to 5:30 PM the next day/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'send the same strike more times' }));
    await waitFor(() => expect(setBestTradeSettings).toHaveBeenCalledWith({ repeat: 2 }));
    await waitFor(() => expect(group).toHaveTextContent('2×'));
    expect(screen.getByText(/The same strike is sent 2 times at most/)).toBeInTheDocument();
  });

  it('the count cannot go past 10', async () => {
    getBestTradeSettings.mockResolvedValue(settings({ alertOn: true, repeat: 10 }));
    render(<BestTradeSettings />);
    expect(await screen.findByRole('button', { name: 'send the same strike more times' })).toBeDisabled();
  });

  it('the repeat control only appears once alerts are on', async () => {
    render(<BestTradeSettings />);
    await screen.findByRole('switch');
    expect(screen.queryByRole('group', { name: 'times the same strike is sent' })).toBeNull();
  });

  it('an older server with no repeat setting reads as once', async () => {
    const { repeat: _gone, ...old } = settings({ alertOn: true });
    getBestTradeSettings.mockResolvedValue(old);
    render(<BestTradeSettings />);
    expect(await screen.findByRole('group', { name: 'times the same strike is sent' })).toHaveTextContent('1×');
  });

  it('a refusal from the server is shown', async () => {
    setBestTradeSettings.mockRejectedValue(new Error('minPremiumUsd must be a price above zero'));
    render(<BestTradeSettings />);
    fireEvent.click(await screen.findByRole('switch'));
    expect(await screen.findByRole('alert')).toHaveTextContent('minPremiumUsd must be a price above zero');
  });
});
