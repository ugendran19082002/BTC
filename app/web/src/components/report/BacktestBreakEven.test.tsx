import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { BacktestBreakEven } from '@/components/report/BacktestBreakEven';
import type { BreakEven } from '@/types/signal-backtest';

/** The option's stop to the price sold once the premium has fallen so far (18 Oct 2026): pts or %, worked through. */
function Harness() {
  const [b, setB] = useState<BreakEven | null>(null);
  return (
    <>
      <BacktestBreakEven value={b} onChange={setB} />
      <output aria-label="be">{JSON.stringify(b)}</output>
    </>
  );
}
const value = () => JSON.parse(screen.getByLabelText('be').textContent!) as BreakEven | null;

describe('SL to entry', () => {
  it('[critical] off to begin with; on, a fall in pts or %, worked through on a premium; off again, gone', () => {
    render(<Harness />);
    expect(screen.getByRole('region', { name: 'SL to entry' })).toHaveTextContent('Off · the option SL is never moved to the entry.');
    fireEvent.click(screen.getByRole('switch', { name: 'SL to entry, on or off' }));
    expect(value()).toEqual({ move: 25, unit: 'pct' });
    expect(screen.getByLabelText('SL to entry example')).toHaveTextContent('Sold at $40: once offered at $30 or less, the SL is $40.');
    fireEvent.click(within(screen.getByRole('radiogroup', { name: 'SL to entry: premium fall in' })).getByRole('radio', { name: 'premium points' }));
    expect(value()).toEqual({ move: 25, unit: 'pts' });
    expect(screen.getByLabelText('SL to entry example')).toHaveTextContent('once offered at $15 or less');
    fireEvent.click(within(screen.getByRole('group', { name: 'SL to entry presets' })).getByRole('button', { name: '10 pts' }));
    expect(value()).toEqual({ move: 10, unit: 'pts' });
    fireEvent.change(screen.getByLabelText('SL to entry: premium fall'), { target: { value: '0' } });
    expect(screen.getByRole('alert')).toHaveTextContent('The move to break-even is more than 0');
    fireEvent.click(screen.getByRole('switch', { name: 'SL to entry, on or off' }));
    expect(value()).toBeNull();
  });
});
