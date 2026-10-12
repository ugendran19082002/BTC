import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { SideMax } from '@/components/strategy/SideMax';
import { sideCaps, sideMaxProblem } from '@/lib/side-max';

/**
 * Each side's own limit under "at most open" (owner, 12 Oct 2026: "CE max 80% and PE max 80%, each on its own -- not
 * a split that adds up to 100"; "default 80%"). The runner holds each side to it (server: signal-strategy.test.ts);
 * here, the same sum and the two controls that set it.
 */
describe('the limits, worked out', () => {
  it('[critical] each side its own per cent of the limit -- independent, never a share of the other; nothing without a limit', () => {
    expect(sideCaps(60, { CE: 80, PE: 80 })).toEqual({ CE: 48, PE: 48 });   // the default: 48 and 48 of 60, not 30 and 30
    expect(sideCaps(60, { CE: 50, PE: 100 })).toEqual({ CE: 30, PE: 60 });
    expect(sideCaps(40, { CE: 80, PE: 80 })).toEqual({ CE: 32, PE: 32 });
    expect(sideCaps(3, { CE: 10, PE: 0 })).toEqual({ CE: 1, PE: 0 });       // above nothing: at least one; nothing: none
    expect(sideCaps(0, { CE: 80, PE: 80 })).toBeNull();
    // One side's figure never moves the other's.
    for (let p = 0; p <= 100; p += 5) expect(sideCaps(60, { CE: p, PE: 80 })!.PE).toBe(48);
    expect(sideMaxProblem(101)).toMatch(/whole number of per cent of "at most open", from 0 to 100/);
    expect(sideMaxProblem(80)).toBeNull();
  });
});

describe('SideMax', () => {
  const show = (over: Partial<Parameters<typeof SideMax>[0]> = {}) => {
    const onSave = vi.fn().mockResolvedValue(true);
    const onInvalid = vi.fn();
    render(<SideMax pct={{ CE: 80, PE: 80 }} cap={60} open={{ CE: 8, PE: 48 }} onSave={onSave} onInvalid={onInvalid} {...over} />);
    const box = within(screen.getByRole('group', { name: 'CE and PE limits, of at most open' }));
    return { onSave, onInvalid, ce: within(box.getByRole('group', { name: 'CE limit' })), pe: within(box.getByRole('group', { name: 'PE limit' })) };
  };

  it('[critical] the default, 80 and 80: each side\'s trades of its own limit, the full one said so -- the owner\'s table', () => {
    const { ce, pe } = show();
    expect(ce.getByLabelText('CE max')).toHaveValue('80');
    expect(pe.getByLabelText('PE max')).toHaveValue('80');
    expect(ce.getByLabelText('CE open now, of its limit')).toHaveTextContent('8 of 48');
    expect(pe.getByLabelText('PE open now, of its limit')).toHaveTextContent('48 of 48 · full');
    expect(ce.getAllByRole('option').map((o) => o.textContent)).toEqual(['50%', '60%', '70%', '80% · default', '90%', '100% · no limit', 'Custom…']);
  });

  it('[critical] each is set on its own: the side and its per cent, the other not sent', async () => {
    const { onSave, ce, pe } = show();
    fireEvent.change(ce.getByLabelText('CE max'), { target: { value: '60' } });
    await waitFor(() => expect(onSave).toHaveBeenCalledWith('CE', 60));
    fireEvent.change(pe.getByLabelText('PE max'), { target: { value: '100' } });
    await waitFor(() => expect(onSave).toHaveBeenCalledWith('PE', 100));
    expect(onSave).toHaveBeenCalledTimes(2);
  });

  it('[critical] custom: any whole per cent; a bad one said and put back, never sent', async () => {
    const { onSave, onInvalid, ce } = show({ pct: { CE: 65, PE: 80 } });
    const field = ce.getByLabelText('CE max, per cent');
    expect(field).toHaveValue('65');
    expect(ce.getByLabelText('CE open now, of its limit')).toHaveTextContent('8 of 39');
    fireEvent.change(field, { target: { value: '75' } });
    fireEvent.blur(field);
    await waitFor(() => expect(onSave).toHaveBeenCalledWith('CE', 75));
    fireEvent.change(field, { target: { value: '250' } });
    fireEvent.blur(field);
    expect(onInvalid).toHaveBeenCalledWith('A side\'s limit must be a whole number of per cent of "at most open", from 0 to 100.');
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(field).toHaveValue('65');
  });

  it('"Custom…" opens the field without sending; with no limit set there is nothing to take a per cent of, and it says so', () => {
    const { onSave, ce, pe } = show({ cap: 0 });
    expect(pe.getByLabelText('PE open now, of its limit')).toHaveTextContent('48 open · no limit set');
    fireEvent.change(ce.getByLabelText('CE max'), { target: { value: 'custom' } });
    expect(ce.getByLabelText('CE max, per cent')).toBeInTheDocument();
    expect(onSave).not.toHaveBeenCalled();
  });
});
