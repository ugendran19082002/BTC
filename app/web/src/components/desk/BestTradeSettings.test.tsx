import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { BestTradeSettings } from '@/components/desk/BestTradeSettings';

const getBestTradeSettings = vi.fn();
const setBestTradeSettings = vi.fn();
vi.mock('@/api/trade', () => ({
  getBestTradeSettings: (...a: unknown[]) => getBestTradeSettings(...a),
  setBestTradeSettings: (...a: unknown[]) => setBestTradeSettings(...a),
}));

beforeEach(() => {
  vi.clearAllMocks();
  getBestTradeSettings.mockResolvedValue({ minPremiumUsd: 5 });
  setBestTradeSettings.mockResolvedValue({ ok: true, minPremiumUsd: 7.5 });
});

describe('the best pick\'s premium floor', () => {
  it('[critical] shows the floor the server holds, and saves a changed one on Enter', async () => {
    const onChanged = vi.fn();
    render(<BestTradeSettings onChanged={onChanged} />);
    const box = await screen.findByLabelText('only strikes paying at least');
    expect(box).toHaveValue('5');
    fireEvent.change(box, { target: { value: '7.5' } });
    expect(screen.getByText(/Press Enter or tap away to keep \$7.5/)).toBeInTheDocument();
    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() => expect(setBestTradeSettings).toHaveBeenCalledWith({ minPremiumUsd: 7.5 }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(box).toHaveValue('7.5');
  });

  it('a price that is not above zero is said and never sent', async () => {
    render(<BestTradeSettings />);
    const box = await screen.findByLabelText('only strikes paying at least');
    fireEvent.change(box, { target: { value: '0' } });
    fireEvent.blur(box);
    expect(screen.getByText('A price above zero.')).toBeInTheDocument();
    expect(setBestTradeSettings).not.toHaveBeenCalled();
  });

  it('[critical] there is no alert switch and no repeat stepper: the watcher behind them is gone', async () => {
    render(<BestTradeSettings />);
    await screen.findByLabelText('only strikes paying at least');
    expect(screen.queryByRole('switch')).not.toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'times the same strike is sent' })).not.toBeInTheDocument();
  });

  it('a save the server refuses says why', async () => {
    setBestTradeSettings.mockRejectedValue(new Error('minPremiumUsd must be a price above zero'));
    render(<BestTradeSettings />);
    const box = await screen.findByLabelText('only strikes paying at least');
    fireEvent.change(box, { target: { value: '9' } });
    fireEvent.blur(box);
    expect(await screen.findByRole('alert')).toHaveTextContent('minPremiumUsd must be a price above zero');
  });
});
