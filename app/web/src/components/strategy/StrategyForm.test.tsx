import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { StrategyForm } from '@/components/strategy/StrategyForm';
import { DEFAULT_CONFIG, type Strategy } from '@/types/strategy';

const saveStrategy = vi.fn();
vi.mock('@/api/strategy', () => ({ saveStrategy: (...a: unknown[]) => saveStrategy(...a) }));

/**
 * The add-to-the-other-leg setting on the form.
 *
 * Asked for with the numbers "dynamic": the $3 and the 2x are the person's to
 * set, and the form reads them back -- in the sentence and on example prices --
 * as they are typed, then sends exactly those numbers to the server.
 */

const editing = (over: Partial<Strategy['config']> = {}): Strategy => ({
  id: 's', name: 'CE+PE', enabled: false, createdAt: 0, updatedAt: 0,
  lastRunDate: null, ranToday: false, nextEntryAt: null, status: 'off',
  config: { ...DEFAULT_CONFIG, ...over },
});

const show = (s: Strategy | null = editing()) =>
  render(<StrategyForm editing={s} open onOpenChange={() => {}} onSaved={() => {}} balanceUsd={228} spot={77_000} />);

beforeEach(() => {
  vi.clearAllMocks();
  saveStrategy.mockResolvedValue({ ok: true });
});

describe('adding to the other leg', () => {
  it('is off by default, with nothing to fill in', () => {
    show();
    expect(screen.getByRole('button', { name: /^Off\s*a target closes its leg/ })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.queryByLabelText('add minimum price')).toBeNull();
  });

  it('[critical] turning it on starts at $3 and 2x, and shows the rule tried on prices', () => {
    show();
    fireEvent.click(screen.getByRole('button', { name: /^On\s*CE target buys back 425/ }));
    expect(screen.getByLabelText('add minimum price')).toHaveValue('3');
    expect(screen.getByLabelText('add maximum multiple')).toHaveValue('2');
    const examples = within(screen.getByLabelText('add examples'));
    expect(examples.getAllByText('adds — sells 425 more')).toHaveLength(2); // 7.00, and exactly 3.00
    expect(examples.getByText('no — below $3')).toBeInTheDocument();
    expect(examples.getByText('no — 2x its $15 sale or more')).toBeInTheDocument();
  });

  it('[critical] the minimum is dynamic: typing $5 redraws the examples and the sentence', () => {
    show(editing({ addToOpposite: { minPriceUsd: 3, maxMultiple: 2 } }));
    fireEvent.change(screen.getByLabelText('add minimum price'), { target: { value: '5' } });
    const examples = within(screen.getByLabelText('add examples'));
    expect(examples.getByText('$4.00')).toBeInTheDocument();
    expect(examples.getByText('no — below $5')).toBeInTheDocument();
    expect(screen.getByText(/bid is \$5 or more/)).toBeInTheDocument();
  });

  it('[critical] saves exactly the numbers typed', async () => {
    show(editing({ addToOpposite: { minPriceUsd: 3, maxMultiple: 2 } }));
    fireEvent.change(screen.getByLabelText('add minimum price'), { target: { value: '4.5' } });
    fireEvent.change(screen.getByLabelText('add maximum multiple'), { target: { value: '1.5' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(saveStrategy).toHaveBeenCalled());
    expect(saveStrategy.mock.calls[0]![0].config.addToOpposite).toEqual({ minPriceUsd: 4.5, maxMultiple: 1.5 });
  });

  it('turning it off saves it as off', async () => {
    show(editing({ addToOpposite: { minPriceUsd: 3, maxMultiple: 2 } }));
    fireEvent.click(screen.getByRole('button', { name: /^Off\s*a target closes its leg/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(saveStrategy).toHaveBeenCalled());
    expect(saveStrategy.mock.calls[0]![0].config.addToOpposite).toBeNull();
  });

  it('shows the server\'s objection when it refuses the setting', async () => {
    saveStrategy.mockRejectedValue(new Error('Adding to the other leg needs both legs selected.'));
    show(editing({ legs: 'CE', doubleWhenOneSided: false, addToOpposite: { minPriceUsd: 3, maxMultiple: 2 } }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Adding to the other leg needs both legs selected.')).toBeInTheDocument();
  });
});
