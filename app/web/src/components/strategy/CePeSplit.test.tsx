import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { CePeSplit } from '@/components/strategy/CePeSplit';
import { ceShareProblem, sideCaps } from '@/lib/ce-pe-split';

/**
 * "At most open" shared between calls and puts (owner, 12 Oct 2026: "60 as 40 and 20, or 30 and 30"). The runner
 * holds each side to its share (server: signal-strategy.test.ts); here, the same sum and the control that sets it.
 */
describe('the shares, worked out', () => {
  it('[critical] the calls\' share to the nearest trade, the puts the rest -- always adding up to the limit; nothing to share without one', () => {
    expect(sideCaps(60, 50)).toEqual({ CE: 30, PE: 30 });
    expect(sideCaps(60, 67)).toEqual({ CE: 40, PE: 20 }); // the owner's "40 and 20"
    expect(sideCaps(60, 33)).toEqual({ CE: 20, PE: 40 });
    expect(sideCaps(60, 40)).toEqual({ CE: 24, PE: 36 });
    expect(sideCaps(7, 50)).toEqual({ CE: 4, PE: 3 });
    expect(sideCaps(60, 0)).toEqual({ CE: 0, PE: 60 });
    expect(sideCaps(60, 100)).toEqual({ CE: 60, PE: 0 });
    for (const cap of [1, 7, 31, 60, 500]) for (let p = 0; p <= 100; p++) { const c = sideCaps(cap, p)!; expect(c.CE + c.PE).toBe(cap); }
    expect(sideCaps(0, 50)).toBeNull();
    expect(sideCaps(60, null)).toBeNull();
    expect(ceShareProblem(101)).toMatch(/whole number of per cent, from 0 to 100/);
    expect(ceShareProblem(40)).toBeNull();
  });
});

describe('CePeSplit', () => {
  const show = (over: Partial<Parameters<typeof CePeSplit>[0]> = {}) => {
    const onSave = vi.fn().mockResolvedValue(true);
    const onInvalid = vi.fn();
    render(<CePeSplit pct={null} cap={60} open={{ CE: 12, PE: 30 }} onSave={onSave} onInvalid={onInvalid} {...over} />);
    return { onSave, onInvalid, box: within(screen.getByRole('group', { name: 'CE / PE split of at most open' })) };
  };

  it('[critical] off until set: both sides counted, a split picked from the list and sent as the calls\' per cent', async () => {
    const { onSave, box } = show();
    expect(box.getByLabelText('CE / PE split')).toHaveValue('');
    expect(box.getByLabelText("open now, of each side's share")).toHaveTextContent('CE 12 · PE 30 open');
    expect(box.getAllByRole('option').map((o) => o.textContent)).toEqual(
      ['No split', 'CE 30% / PE 70%', 'CE 40% / PE 60%', 'CE 50% / PE 50%', 'CE 60% / PE 40%', 'CE 70% / PE 30%', 'Custom…']);
    fireEvent.change(box.getByLabelText('CE / PE split'), { target: { value: '40' } });
    await waitFor(() => expect(onSave).toHaveBeenCalledWith(40));
  });

  it('[critical] set: each side\'s trades of its share, a side at its share said "full"; taken off with "No split"', async () => {
    const { onSave, box } = show({ pct: 40, open: { CE: 24, PE: 30 } });
    expect(box.getByLabelText('CE / PE split')).toHaveValue('40');
    expect(box.getByLabelText("open now, of each side's share")).toHaveTextContent('CE 24 of 24 full · PE 30 of 36');
    fireEvent.change(box.getByLabelText('CE / PE split'), { target: { value: '' } });
    await waitFor(() => expect(onSave).toHaveBeenCalledWith(null));
  });

  it('[critical] custom: any whole per cent -- 67 is the owner\'s "40 and 20" of 60 -- a bad one said and put back, never sent', async () => {
    const { onSave, onInvalid, box } = show({ pct: 67 });
    expect(box.getByLabelText('CE / PE split')).toHaveValue('custom');
    expect(box.getByLabelText("open now, of each side's share")).toHaveTextContent('CE 12 of 40 · PE 30 of 20 full');
    const field = box.getByLabelText('CE share, per cent');
    expect(field).toHaveValue('67');
    fireEvent.change(field, { target: { value: '33' } });
    fireEvent.blur(field);
    await waitFor(() => expect(onSave).toHaveBeenCalledWith(33));
    fireEvent.change(field, { target: { value: '250' } });
    fireEvent.blur(field);
    expect(onInvalid).toHaveBeenCalledWith('The CE share must be a whole number of per cent, from 0 to 100 -- or none, for no split.');
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(field).toHaveValue('67');
  });

  it('with no limit set there is nothing to share, and it says so; "Custom…" opens the field without sending', () => {
    const { onSave, box } = show({ pct: 50, cap: 0 });
    expect(box.getByLabelText("open now, of each side's share")).toHaveTextContent('no limit set: nothing to share');
    fireEvent.change(box.getByLabelText('CE / PE split'), { target: { value: 'custom' } });
    expect(box.getByLabelText('CE share, per cent')).toBeInTheDocument();
    expect(onSave).not.toHaveBeenCalled();
  });
});
