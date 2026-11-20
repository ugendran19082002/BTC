import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { SignalSwap } from '@/components/strategy/CapSwap';

/** Swap on every signal on the strategies card (20 Nov 2026): this account's, off by default, 80-95% one tap away. */
describe('swap on every signal', () => {
  it('[critical] the pill says off, or on with its % and its most a minute', () => {
    const { rerender } = render(<SignalSwap swap={{ on: false, pct: 90, perMin: 20 }} onSave={async () => true} />);
    expect(screen.getByRole('button', { name: /Swap on every signal/ })).toHaveTextContent('Swap on every signaloff');
    rerender(<SignalSwap swap={{ on: true, pct: 85, perMin: 10 }} onSave={async () => true} />);
    expect(screen.getByRole('button', { name: /Swap on every signal/ })).toHaveTextContent('on · 85% kept · max 10/min');
  });

  it('[critical] says what it does: before each new signal, one out one in; none that far, sold as usual', () => {
    render(<SignalSwap swap={{ on: false, pct: 90, perMin: 20 }} onSave={async () => true} />);
    fireEvent.click(screen.getByRole('button', { name: /Swap on every signal/ }));
    const box = screen.getByRole('dialog', { name: 'Swap on every signal' });
    expect(box).toHaveTextContent('Before a new signal is sold');
    expect(box).toHaveTextContent('If none has, the new signal is sold as usual');
    expect(box).toHaveTextContent('off by default');
    for (const q of ['80%', '85%', '90%', '95%']) expect(screen.getByRole('button', { name: q })).toBeInTheDocument();
  });

  it('[critical] switched on at 80% with one tap, and saved', async () => {
    const onSave = vi.fn(async () => true);
    render(<SignalSwap swap={{ on: false, pct: 90, perMin: 20 }} onSave={onSave} />);
    fireEvent.click(screen.getByRole('button', { name: /Swap on every signal/ }));
    const save = screen.getByRole('button', { name: 'Save' });
    expect(save).toBeDisabled();
    fireEvent.click(screen.getByRole('checkbox', { name: 'On' }));
    fireEvent.click(screen.getByRole('button', { name: '80%' }));
    expect(screen.getByLabelText('Example')).toHaveTextContent('sold at 20 → swapped once it can be bought back at 4 or less');
    fireEvent.click(save);
    await waitFor(() => expect(onSave).toHaveBeenCalledWith({ on: true, pct: 80, perMin: 20 }));
  });

  it('[critical] its own range: 99% can be set (above Swap at full cap\'s 95), 49% cannot', () => {
    const onSave = vi.fn(async () => true);
    render(<SignalSwap swap={{ on: true, pct: 90, perMin: 20 }} onSave={onSave} />);
    fireEvent.click(screen.getByRole('button', { name: /Swap on every signal/ }));
    const box = screen.getByLabelText('Premium kept, per cent');
    fireEvent.change(box, { target: { value: '99' } });
    expect(screen.queryByRole('alert')).toBeNull();
    fireEvent.change(box, { target: { value: '49' } });
    expect(screen.getByRole('alert')).toHaveTextContent('A whole % from 50 to 99.');
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it('defaults (off) is offered only when something differs from them', () => {
    const onSave = vi.fn(async () => true);
    const { unmount } = render(<SignalSwap swap={{ on: false, pct: 90, perMin: 20 }} onSave={onSave} />);
    fireEvent.click(screen.getByRole('button', { name: /Swap on every signal/ }));
    expect(screen.getByRole('button', { name: 'Defaults (off)' })).toBeDisabled();
    unmount();
    render(<SignalSwap swap={{ on: true, pct: 85, perMin: 20 }} onSave={onSave} />);
    fireEvent.click(screen.getByRole('button', { name: /Swap on every signal/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Defaults (off)' }));
    expect(onSave).toHaveBeenCalledWith(null);
  });
});
