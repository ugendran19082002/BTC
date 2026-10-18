import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { BacktestTsl } from '@/components/report/BacktestTsl';
import type { Tsl } from '@/types/signal-backtest';

/** The trailing SL's editor (18 Oct 2026): off to begin with; on, presets, both numbers in pts or %, worked through. */
function Harness({ start = null, stopPct = 1.5 }: { start?: Tsl | null; stopPct?: number }) {
  const [t, setT] = useState<Tsl | null>(start);
  return (
    <>
      <BacktestTsl value={t} stopPct={stopPct} onChange={setT} />
      <output aria-label="tsl">{JSON.stringify(t)}</output>
    </>
  );
}
const value = () => JSON.parse(screen.getByLabelText('tsl').textContent!) as Tsl | null;

describe('the trailing SL editor', () => {
  it('[critical] off says the stop stays; on, the rule in numbers and worked through on a premium', () => {
    render(<Harness />);
    const box = screen.getByRole('region', { name: 'Trailing SL' });
    expect(box).toHaveTextContent('Off · the option SL stays where it is set.');
    fireEvent.click(screen.getByRole('switch', { name: 'Trailing SL, on or off' }));
    expect(value()).toEqual({ move: 5, moveUnit: 'pts', by: 5, byUnit: 'pts' });
    // sold at 40 with the stop at +150%: 100
    expect(screen.getByLabelText('Trailing SL example')).toHaveTextContent('Sold at $40, SL $100: at $35 → SL $95 · at $30 → SL $90 · at $25 → SL $85.');
    fireEvent.click(within(screen.getByRole('group', { name: 'Trailing SL presets' })).getByRole('button', { name: '20% → 10%' }));
    expect(value()).toEqual({ move: 20, moveUnit: 'pct', by: 10, byUnit: 'pct' });
    expect(screen.getByLabelText('Trailing SL example')).toHaveTextContent('at $32 → SL $96');
    fireEvent.click(screen.getByRole('switch', { name: 'Trailing SL, on or off' }));
    expect(value()).toBeNull();
  });

  it('[critical] each number in pts or %, and what is wrong is said where it is typed', () => {
    render(<Harness start={{ move: 5, moveUnit: 'pts', by: 5, byUnit: 'pts' }} />);
    fireEvent.click(within(screen.getByRole('radiogroup', { name: 'Trailing SL: SL move in' })).getByRole('radio', { name: 'per cent of the price sold' }));
    expect(value()).toEqual({ move: 5, moveUnit: 'pts', by: 5, byUnit: 'pct' });
    fireEvent.click(within(screen.getByRole('radiogroup', { name: 'Trailing SL: SL move in' })).getByRole('radio', { name: 'premium points' }));
    fireEvent.change(screen.getByLabelText('Trailing SL: SL move'), { target: { value: '8' } });
    expect(screen.getByRole('alert')).toHaveTextContent('The SL cannot move further than the price did');
    expect(screen.queryByLabelText('Trailing SL example')).toBeNull();
  });

  it('with no option stop there is nothing to trail, and it says so', () => {
    render(<Harness start={{ move: 5, moveUnit: 'pts', by: 5, byUnit: 'pts' }} stopPct={0} />);
    expect(screen.getByRole('alert')).toHaveTextContent('A trailing SL needs an option stop to move: set the option stop.');
  });
});
