import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Reentry } from '@/components/strategy/Reentry';

/** Re-entry after an option SL on the strategies card (1 Nov 2026): on or off, how many in a row and the size, this account's. */
describe('re-entry after SL', () => {
  it('[critical] off to begin with; on, the pill says the opposite side, how many in a row and the size', () => {
    const { rerender } = render(<Reentry reentry={{ on: false, max: 2, size: 1 }} onSave={async () => true} />);
    expect(screen.getByRole('button', { name: /Re-entry after SL/ })).toHaveTextContent('Re-entry after SLoff');
    rerender(<Reentry reentry={{ on: true, max: 2, size: 3 }} onSave={async () => true} />);
    expect(screen.getByRole('button', { name: /Re-entry after SL/ })).toHaveTextContent('opposite · max 2 · x3');
  });

  it('[critical] switched on and saved with its numbers; numbers out of range are refused before they are sent', async () => {
    const onSave = vi.fn(async () => true);
    render(<Reentry reentry={{ on: false, max: 2, size: 1 }} onSave={onSave} />);
    fireEvent.click(screen.getByRole('button', { name: /Re-entry after SL/ }));
    const save = screen.getByRole('button', { name: 'Save' });
    expect(save).toBeDisabled();
    fireEvent.click(screen.getByRole('checkbox', { name: 'On' }));
    fireEvent.change(screen.getByLabelText('Re-entries in a row'), { target: { value: '6' } });
    expect(screen.getByRole('alert')).toHaveTextContent('In a row: a whole number from 1 to 5.');
    expect(save).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Re-entries in a row'), { target: { value: '3' } });
    fireEvent.change(screen.getByLabelText('Times the lots'), { target: { value: '8' } });
    expect(screen.getByRole('alert')).toHaveTextContent('Size: a whole number from 1 to 7.');
    fireEvent.change(screen.getByLabelText('Times the lots'), { target: { value: '2' } });
    fireEvent.click(save);
    await waitFor(() => expect(onSave).toHaveBeenCalledWith({ on: true, max: 3, size: 2 }));
  });

  it('"Defaults" puts it back off (null)', async () => {
    const onSave = vi.fn(async () => true);
    render(<Reentry reentry={{ on: true, max: 2, size: 2 }} onSave={onSave} />);
    fireEvent.click(screen.getByRole('button', { name: /Re-entry after SL/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Defaults' }));
    await waitFor(() => expect(onSave).toHaveBeenCalledWith(null));
  });
});
