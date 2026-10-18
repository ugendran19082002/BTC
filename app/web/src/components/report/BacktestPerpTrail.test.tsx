import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { BacktestPerpTrail } from '@/components/report/BacktestPerpTrail';

/** The perp's SL and TGT trailed by the 1m ATR (18 Oct 2026): off to begin with; a multiplier a tap, or typed. */
function Harness() {
  const [v, setV] = useState({ trailSlAtr: 0, trailTgtAtr: 0 });
  return (
    <>
      <BacktestPerpTrail sl={v.trailSlAtr} tgt={v.trailTgtAtr} onChange={setV} />
      <output aria-label="trail">{JSON.stringify(v)}</output>
    </>
  );
}
const value = () => JSON.parse(screen.getByLabelText('trail').textContent!);

describe('the perp trail editor', () => {
  it('[critical] off says the signal\'s own levels stand; each level its own multiplier; a moving target alone is warned of', () => {
    render(<Harness />);
    expect(screen.getByRole('region', { name: 'Perp trail' })).toHaveTextContent("Off · the perp SL and TGT stay the signal's own.");
    fireEvent.click(within(screen.getByRole('group', { name: 'Perp trail: TGT' })).getByRole('button', { name: '3× ATR' }));
    expect(value()).toEqual({ trailSlAtr: 0, trailTgtAtr: 3 });
    expect(screen.getByText(/A target that keeps moving with no trailing SL can give a whole run back/)).toBeInTheDocument();
    fireEvent.click(within(screen.getByRole('group', { name: 'Perp trail: SL' })).getByRole('button', { name: '2× ATR' }));
    expect(value()).toEqual({ trailSlAtr: 2, trailTgtAtr: 3 });
    expect(screen.queryByText(/give a whole run back/)).toBeNull();
    expect(screen.getByRole('region', { name: 'Perp trail' })).toHaveTextContent('it does not wait for the close');
    fireEvent.change(screen.getByLabelText('Perp trail: SL, ATRs'), { target: { value: '25' } });
    expect(screen.getByRole('alert')).toHaveTextContent('A perp trail is from 0 (off) to 20 ATRs.');
  });
});
