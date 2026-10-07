import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { PressureStrip } from '@/components/mobile/PressureStrip';
import type { Pressure } from '@/components/mobile/usePressure';

/** Home's row of three over today's P&L (owner, 7 Oct 2026): CE flow, PE flow, and the big-move band with its percent and lean. */

const side = (pressure: string | null) => ({ pressure });
const read = (o: { ce?: string | null; pe?: string | null; band?: string; pressure?: number | null; lean?: -1 | 0 | 1; perpRead?: boolean; flow?: boolean; warning?: boolean } = {}): Pressure => ({
  chain: null, chainError: null, perpRead: o.perpRead ?? true, perpError: null, leg: null, shock: null,
  flow: o.flow === false ? null : { ce: side(o.ce === undefined ? 'SELL PRESSURE' : o.ce), pe: side(o.pe === undefined ? 'BALANCED' : o.pe) },
  warning: o.warning === false ? null : { band: o.band ?? 'watch', pressure: o.pressure === undefined ? 56 : o.pressure, lean: o.lean ?? -1, triggers: [], score: null, action: '' },
}) as unknown as Pressure;
const cell = (label: string) => screen.getByText(label).parentElement!;

describe('PressureStrip', () => {
  it('[critical] three tiles in one row: each side\'s word, and the band with its percent and which way it leans', () => {
    const onOpen = vi.fn();
    render(<PressureStrip pressure={read()} onOpen={onOpen} />);
    expect(cell('CE flow')).toHaveTextContent('SELLpressure');
    expect(cell('PE flow')).toHaveTextContent('BALANCEDboth sides');
    expect(cell('Big move')).toHaveTextContent('WATCH56%down ↓');
    const row = screen.getByRole('button', { name: 'Pressure: CE flow sell pressure; PE flow balanced; big move watch, 56 percent, pressure down. Open' });
    expect(row.className).toContain('grid-cols-3');
    fireEvent.click(row);
    expect(onOpen).toHaveBeenCalledOnce();
  });

  it('buy pressure, a calm band leaning up, and a band with no lean', () => {
    const { rerender } = render(<PressureStrip pressure={read({ ce: 'BUY PRESSURE', pe: 'SELL PRESSURE', band: 'calm', pressure: 22, lean: 1 })} onOpen={() => {}} />);
    expect(cell('CE flow')).toHaveTextContent('BUYpressure');
    expect(cell('PE flow')).toHaveTextContent('SELLpressure');
    expect(cell('Big move')).toHaveTextContent('CALM22%up ↑');
    rerender(<PressureStrip pressure={read({ band: 'sudden', pressure: 91, lean: 0 })} onOpen={() => {}} />);
    expect(cell('Big move')).toHaveTextContent('SUDDEN91%');
    expect(cell('Big move')).not.toHaveTextContent('↑');
    expect(cell('Big move')).not.toHaveTextContent('↓');
  });

  it('not read yet is not "no prints": dots while reading, a dash where the tape has nothing', () => {
    const { rerender } = render(<PressureStrip pressure={read({ perpRead: false, flow: false, warning: false })} onOpen={() => {}} />);
    expect(cell('CE flow')).toHaveTextContent('…reading');
    expect(cell('Big move')).toHaveTextContent('…reading');
    rerender(<PressureStrip pressure={read({ flow: false, pressure: null })} onOpen={() => {}} />);
    expect(cell('CE flow')).toHaveTextContent('—no prints');
    expect(cell('PE flow')).toHaveTextContent('—no prints');
    expect(cell('Big move')).toHaveTextContent('WATCH—');
  });
});
