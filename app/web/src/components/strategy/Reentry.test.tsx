import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { Reentry } from '@/components/strategy/Reentry';
import { REENTRY_DEFAULT } from '@/types/strategy';

/**
 * Re-entry on the strategies card (1 Nov 2026): after an SL and after a target, each with its time range, this account's
 * -- and how many trades an exit opens at once, 1 to 4, with no most in a row (2 Nov 2026).
 */
describe('re-entry', () => {
  const SL = { on: true, from: '07:00', to: '17:29', entries: 1 };
  const TGT = { on: true, from: '07:00', to: '10:00', entries: 1 };

  it('[critical] off to begin with; on, the pill says which, how many at once when more than one, and when', () => {
    const { rerender } = render(<Reentry reentry={REENTRY_DEFAULT} onSave={async () => true} />);
    expect(screen.getByRole('button', { name: /Re-entry/ })).toHaveTextContent('Re-entryoff');
    rerender(<Reentry reentry={{ sl: SL, tgt: REENTRY_DEFAULT.tgt }} onSave={async () => true} />);
    expect(screen.getByRole('button', { name: /Re-entry/ })).toHaveTextContent('SL→opp 7–17:29');
    rerender(<Reentry reentry={{ sl: { ...SL, entries: 2 }, tgt: TGT }} onSave={async () => true} />);
    expect(screen.getByRole('button', { name: /Re-entry/ })).toHaveTextContent('SL→opp ×2 7–17:29 · TGT→same 7–10');
  });

  it('[critical] the defaults are filled in: ticking one and saving sends both rules, the other as it was', async () => {
    const onSave = vi.fn(async () => true);
    render(<Reentry reentry={REENTRY_DEFAULT} today={{ sl: 1, tgt: 3 }} onSave={onSave} />);
    fireEvent.click(screen.getByRole('button', { name: /Re-entry/ }));
    expect(screen.getByLabelText('Today')).toHaveTextContent('Today: 4 re-entries · 1 after SL · 3 after target');
    expect(screen.getByLabelText('After target: from')).toHaveValue('07:00');
    expect(screen.getByLabelText('After target: to')).toHaveValue('10:00');
    const save = screen.getByRole('button', { name: 'Save' });
    expect(save).toBeDisabled();
    fireEvent.click(screen.getByRole('checkbox', { name: 'After SL: on' }));
    fireEvent.click(save);
    await waitFor(() => expect(onSave).toHaveBeenCalledWith({ sl: { ...REENTRY_DEFAULT.sl, on: true }, tgt: REENTRY_DEFAULT.tgt }));
  });

  it('[critical] trades at once is a tap from 1 to 4 on each rule, and is saved; there is no most in a row', async () => {
    const onSave = vi.fn(async () => true);
    render(<Reentry reentry={{ sl: SL, tgt: TGT }} onSave={onSave} />);
    fireEvent.click(screen.getByRole('button', { name: /Re-entry/ }));
    const sl = within(screen.getByRole('radiogroup', { name: 'After SL: trades at once' }));
    expect(sl.getAllByRole('radio').map((r) => r.textContent)).toEqual(['1', '2', '3', '4']);
    expect(sl.getByRole('radio', { name: '1' })).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(sl.getByRole('radio', { name: '3' }));
    expect(sl.getByRole('radio', { name: '3' })).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(within(screen.getByRole('radiogroup', { name: 'After target: trades at once' })).getByRole('radio', { name: '2' }));
    expect(screen.queryByLabelText(/max in a row/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(onSave).toHaveBeenCalledWith({ sl: { ...SL, entries: 3 }, tgt: { ...TGT, entries: 2 } }));
  });

  it('[critical] a range that cannot be saved is said, per rule, and Save waits', async () => {
    const onSave = vi.fn(async () => true);
    render(<Reentry reentry={{ sl: SL, tgt: TGT }} onSave={onSave} />);
    fireEvent.click(screen.getByRole('button', { name: /Re-entry/ }));
    const save = screen.getByRole('button', { name: 'Save' });
    fireEvent.change(screen.getByLabelText('After target: to'), { target: { value: '07:00' } });
    expect(screen.getByRole('alert')).toHaveTextContent('After target: the time range must not start and end at the same minute.');
    expect(save).toBeDisabled();
    fireEvent.change(screen.getByLabelText('After target: to'), { target: { value: '11:00' } });
    expect(screen.queryByRole('alert')).toBeNull();
    fireEvent.click(save);
    await waitFor(() => expect(onSave).toHaveBeenCalledWith({ sl: SL, tgt: { ...TGT, to: '11:00' } }));
  });

  it('a server from before 2 Nov -- no trades at once, a max in a row -- reads as one at once, and the max goes no further', async () => {
    const onSave = vi.fn(async () => true);
    const old = { sl: { on: true, from: '07:00', to: '17:29', max: 2 }, tgt: { on: false, from: '07:00', to: '10:00', max: 1 } } as never;
    render(<Reentry reentry={old} onSave={onSave} />);
    fireEvent.click(screen.getByRole('button', { name: /Re-entry/ }));
    expect(within(screen.getByRole('radiogroup', { name: 'After SL: trades at once' })).getByRole('radio', { name: '1' })).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(within(screen.getByRole('radiogroup', { name: 'After SL: trades at once' })).getByRole('radio', { name: '2' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(onSave).toHaveBeenCalledWith({ sl: { ...SL, entries: 2 }, tgt: { ...TGT, on: false } }));
  });

  it('"Defaults" puts both back off (null)', async () => {
    const onSave = vi.fn(async () => true);
    render(<Reentry reentry={{ sl: SL, tgt: TGT }} onSave={onSave} />);
    fireEvent.click(screen.getByRole('button', { name: /Re-entry/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Defaults' }));
    await waitFor(() => expect(onSave).toHaveBeenCalledWith(null));
  });
});
