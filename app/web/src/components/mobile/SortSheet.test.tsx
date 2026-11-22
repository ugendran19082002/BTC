import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { SortSheet } from '@/components/mobile/SortSheet';

/** The sort sheet (22 Nov 2026): a face with the order in force, a sheet of grouped choices, a tick on the one in force. */
describe('SortSheet', () => {
  const choices = [
    { key: 'a', label: 'Riskiest first', hint: 'Least room to the stop', group: 'Risk' },
    { key: 'b', label: 'Newest first', hint: 'Latest entry on top', group: 'Time' },
    { key: 'c', label: 'Oldest first', group: 'Time' },
  ] as const;

  it('[critical] the face says the order; the sheet groups the choices with their lines, ticks the one in force, and a tap sorts and closes', () => {
    const onChange = vi.fn();
    render(<SortSheet value="a" choices={choices} onChange={onChange} name="Sort positions by" />);
    fireEvent.click(screen.getByRole('button', { name: 'Sort positions by: Riskiest first' }));
    const sheet = within(screen.getByRole('dialog', { name: 'Sort positions by' }));
    expect(sheet.getByText('Risk')).toBeInTheDocument();
    expect(sheet.getByText('Time')).toBeInTheDocument();
    expect(sheet.getByRole('radio', { name: /^Riskiest first/ })).toHaveAttribute('aria-checked', 'true');
    expect(sheet.getByRole('radio', { name: /^Newest first/ })).toHaveTextContent('Latest entry on top');
    fireEvent.click(sheet.getByRole('radio', { name: /^Newest first/ }));
    expect(onChange).toHaveBeenCalledWith('b');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('Esc and the ✕ close it without a change', () => {
    const onChange = vi.fn();
    render(<SortSheet value="b" choices={choices} onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: /^Sort by/ }));
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /^Sort by/ }));
    fireEvent.click(within(screen.getByRole('dialog')).getAllByRole('button', { name: 'Close' }).at(-1)!);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
  });
});
