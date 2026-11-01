import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Reentry } from '@/components/strategy/Reentry';
import { REENTRY_DEFAULT } from '@/types/strategy';

/** Re-entry on the strategies card (1 Nov 2026): after an SL and after a target, each with its time range, this account's. */
describe('re-entry', () => {
  const SL = { on: true, from: '07:00', to: '17:29', max: 2 };
  const TGT = { on: true, from: '07:00', to: '10:00', max: 1 };

  it('[critical] off to begin with; on, the pill says which and when', () => {
    const { rerender } = render(<Reentry reentry={REENTRY_DEFAULT} onSave={async () => true} />);
    expect(screen.getByRole('button', { name: /Re-entry/ })).toHaveTextContent('Re-entryoff');
    rerender(<Reentry reentry={{ sl: SL, tgt: REENTRY_DEFAULT.tgt }} onSave={async () => true} />);
    expect(screen.getByRole('button', { name: /Re-entry/ })).toHaveTextContent('SL→opp 7–17:29');
    rerender(<Reentry reentry={{ sl: SL, tgt: TGT }} onSave={async () => true} />);
    expect(screen.getByRole('button', { name: /Re-entry/ })).toHaveTextContent('SL→opp 7–17:29 · TGT→same 7–10');
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

  it('[critical] numbers or a range that cannot be saved are said, per rule, and Save waits', async () => {
    const onSave = vi.fn(async () => true);
    render(<Reentry reentry={{ sl: SL, tgt: TGT }} onSave={onSave} />);
    fireEvent.click(screen.getByRole('button', { name: /Re-entry/ }));
    const save = screen.getByRole('button', { name: 'Save' });
    fireEvent.change(screen.getByLabelText('After SL: max in a row'), { target: { value: '6' } });
    expect(screen.getByRole('alert')).toHaveTextContent('After SL: in a row: a whole number from 1 to 5.');
    expect(save).toBeDisabled();
    fireEvent.change(screen.getByLabelText('After SL: max in a row'), { target: { value: '2' } });
    fireEvent.change(screen.getByLabelText('After target: to'), { target: { value: '07:00' } });
    expect(screen.getByRole('alert')).toHaveTextContent('After target: the time range must not start and end at the same minute.');
    fireEvent.change(screen.getByLabelText('After target: to'), { target: { value: '11:00' } });
    fireEvent.change(screen.getByLabelText('After target: max in a row'), { target: { value: '2' } });
    expect(screen.queryByLabelText('After target: size')).toBeNull();
    fireEvent.click(save);
    await waitFor(() => expect(onSave).toHaveBeenCalledWith({ sl: SL, tgt: { ...TGT, to: '11:00', max: 2 } }));
  });

  it('"Defaults" puts both back off (null)', async () => {
    const onSave = vi.fn(async () => true);
    render(<Reentry reentry={{ sl: SL, tgt: TGT }} onSave={onSave} />);
    fireEvent.click(screen.getByRole('button', { name: /Re-entry/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Defaults' }));
    await waitFor(() => expect(onSave).toHaveBeenCalledWith(null));
  });
});
