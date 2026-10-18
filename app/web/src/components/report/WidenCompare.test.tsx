import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { WidenCompare, type WidenVariant } from '@/components/report/WidenCompare';
import type { BtTot } from '@/types/signal-backtest';

/** The perp levels three ways on the same trades (18 Oct 2026): the signal's own, kept widest, back when calm. */
const tot = (net: number, o: Partial<BtTot> = {}): BtTot => ({ n: 10, wins: 6, losses: 4, net, won: 20, lost: 8, perpPts: 0, charges: 1, exits: { 'perp-sl': { n: 3, wins: 0, net: -6 } }, ...o });

describe('Perp SL & TGT: the three ways', () => {
  it('[critical] asked on a tap: the same run with the signal\'s own, kept widest and back when calm -- side by side, the best marked', async () => {
    const ask = vi.fn(async (v: WidenVariant) => ({
      total: v === null ? tot(-5) : v.mode === 'widest' ? tot(12, { wins: 7 }) : tot(4),
      days: [{ day: '2026-10-12', net: -3 }, { day: '2026-10-13', net: 1 }],
    }));
    render(<WidenCompare sl={10} tgt={20} ask={ask} askKey="k" />);
    expect(ask).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Compare the three' }));
    const table = await screen.findByRole('table', { name: 'Perp SL and TGT, the three ways' });
    expect(ask.mock.calls.map((c) => c[0])).toEqual([null, { slAtr: 10, tgtAtr: 20, mode: 'widest' }, { slAtr: 10, tgtAtr: 20, mode: 'calm' }]);
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows.map((r) => r.querySelector('th')!.textContent)).toEqual(["Signal's own", 'Keep widest ★', 'Back when calm']);
    expect(rows[1]).toHaveTextContent('7 · 3');
    expect(rows[0]).toHaveTextContent(/3 −₹/);
  });

  it('a refusal is said', async () => {
    render(<WidenCompare sl={10} tgt={0} ask={async () => { throw new Error('busy'); }} askKey="k" />);
    fireEvent.click(screen.getByRole('button', { name: 'Compare the three' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('busy');
  });
});
