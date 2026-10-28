import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ZoneFresh, freshWords } from '@/components/strategy/ZoneFresh';
import { ZONE_FRESH_DEFAULT_S } from '@/types/strategy';

/** The fill window on the strategies card (28 Oct 2026): seconds by time frame, this account's, saved and read back. */
describe('the fill window', () => {
  it('[critical] says "default" until one is set; opened, each time frame with its own default beside it', () => {
    render(<ZoneFresh seconds={{ ...ZONE_FRESH_DEFAULT_S }} onSave={async () => true} />);
    const pill = screen.getByRole('button', { name: /Fill window/ });
    expect(pill).toHaveTextContent('Fill windowdefault');
    fireEvent.click(pill);
    expect(screen.getByLabelText('5m fill window, seconds')).toHaveValue('90');
    expect(screen.getByLabelText('4h fill window, seconds')).toHaveValue('600');
    expect(screen.getByText('2.5 min · default 2.5 min')).toBeInTheDocument();
  });

  it('[critical] a figure changed is saved alone -- the others are left at their defaults; out of range is refused before it is sent', async () => {
    const onSave = vi.fn(async () => true);
    render(<ZoneFresh seconds={{ ...ZONE_FRESH_DEFAULT_S }} onSave={onSave} />);
    fireEvent.click(screen.getByRole('button', { name: /Fill window/ }));
    const save = screen.getByRole('button', { name: 'Save' });
    expect(save).toBeDisabled();
    fireEvent.change(screen.getByLabelText('5m fill window, seconds'), { target: { value: '5' } });
    expect(screen.getByRole('alert')).toHaveTextContent('5m: whole seconds from 10 to 1800.');
    expect(save).toBeDisabled();
    fireEvent.change(screen.getByLabelText('5m fill window, seconds'), { target: { value: '120' } });
    expect(save).toBeEnabled();
    fireEvent.click(save);
    await waitFor(() => expect(onSave).toHaveBeenCalledWith({ '5m': 120 }));
  });

  it('with some set, the pill says how many; "Defaults" puts them all back (null)', async () => {
    const onSave = vi.fn(async () => true);
    render(<ZoneFresh seconds={{ ...ZONE_FRESH_DEFAULT_S, '5m': 120, '1h': 400 }} onSave={onSave} />);
    const pill = screen.getByRole('button', { name: /Fill window/ });
    expect(pill).toHaveTextContent('2 set');
    fireEvent.click(pill);
    fireEvent.click(screen.getByRole('button', { name: 'Defaults' }));
    await waitFor(() => expect(onSave).toHaveBeenCalledWith(null));
    expect(freshWords(90)).toBe('90 s');
    expect(freshWords(450)).toBe('7.5 min');
    expect(freshWords(600)).toBe('10 min');
  });
});
