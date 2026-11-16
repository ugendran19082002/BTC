import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CapSwap } from '@/components/strategy/CapSwap';

/** Swap at full cap on the strategies card (16 Nov 2026): on or off, the % kept and the most a minute, this account's. */
describe('swap at full cap', () => {
  it('[critical] the pill says off, or on with its % and its most a minute', () => {
    const { rerender } = render(<CapSwap swap={{ on: false, pct: 70, perMin: 20 }} onSave={async () => true} />);
    expect(screen.getByRole('button', { name: /Swap at full cap/ })).toHaveTextContent('Swap at full capoff');
    rerender(<CapSwap swap={{ on: true, pct: 70, perMin: 20 }} onSave={async () => true} />);
    expect(screen.getByRole('button', { name: /Swap at full cap/ })).toHaveTextContent('on · 70% kept · max 20/min');
  });

  it('[critical] switched on at a tested level with one tap, and saved', async () => {
    const onSave = vi.fn(async () => true);
    render(<CapSwap swap={{ on: false, pct: 70, perMin: 20 }} onSave={onSave} />);
    fireEvent.click(screen.getByRole('button', { name: /Swap at full cap/ }));
    const save = screen.getByRole('button', { name: 'Save' });
    expect(save).toBeDisabled();
    fireEvent.click(screen.getByRole('checkbox', { name: 'On' }));
    fireEvent.click(screen.getByRole('button', { name: '75%' }));
    expect(screen.getByRole('button', { name: '75%' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByLabelText('Premium kept, per cent')).toHaveValue('75');
    expect(screen.getByLabelText('Example')).toHaveTextContent('sold at 20 → swapped once it can be bought back at 5 or less');
    fireEvent.click(save);
    await waitFor(() => expect(onSave).toHaveBeenCalledWith({ on: true, pct: 75, perMin: 20 }));
  });

  it('[critical] a % or a per-minute number out of range is refused before it is sent', () => {
    const onSave = vi.fn(async () => true);
    render(<CapSwap swap={{ on: true, pct: 70, perMin: 20 }} onSave={onSave} />);
    fireEvent.click(screen.getByRole('button', { name: /Swap at full cap/ }));
    fireEvent.change(screen.getByLabelText('Premium kept, per cent'), { target: { value: '40' } });
    expect(screen.getByRole('alert')).toHaveTextContent('A whole % from 50 to 95.');
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Premium kept, per cent'), { target: { value: '70' } });
    fireEvent.change(screen.getByLabelText('Swaps a minute'), { target: { value: '0' } });
    expect(screen.getByRole('alert')).toHaveTextContent('Swaps a minute: 1 to 120.');
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    expect(onSave).not.toHaveBeenCalled();
  });

  it('"Defaults (off)" puts it back off (null)', async () => {
    const onSave = vi.fn(async () => true);
    render(<CapSwap swap={{ on: true, pct: 70, perMin: 20 }} onSave={onSave} />);
    fireEvent.click(screen.getByRole('button', { name: /Swap at full cap/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Defaults (off)' }));
    await waitFor(() => expect(onSave).toHaveBeenCalledWith(null));
  });
});
