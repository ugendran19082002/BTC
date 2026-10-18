import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { BacktestPerpWiden } from '@/components/report/BacktestPerpWiden';

/** The perp's SL and TGT widened with volatility (18 Oct 2026): the signal's own the least, worked through on an example. */
function Harness() {
  const [v, setV] = useState<{ widenSlAtr: number; widenTgtAtr: number; widenMode: 'widest' | 'calm' }>({ widenSlAtr: 0, widenTgtAtr: 0, widenMode: 'widest' });
  return (
    <>
      <BacktestPerpWiden sl={v.widenSlAtr} tgt={v.widenTgtAtr} mode={v.widenMode} onChange={setV} />
      <output aria-label="widen">{JSON.stringify(v)}</output>
    </>
  );
}
const value = () => JSON.parse(screen.getByLabelText('widen').textContent!);
const NAME = 'Perp SL & TGT by volatility';

describe('the perp widening editor', () => {
  it('[critical] off: the signal\'s own; on, the least distance in ATRs, worked through quiet and busy -- kept at the widest', () => {
    render(<Harness />);
    expect(screen.getByRole('region', { name: NAME })).toHaveTextContent("Off · the perp SL and TGT stay the signal's own.");
    fireEvent.click(within(screen.getByRole('group', { name: `${NAME}: SL` })).getByRole('button', { name: '10× ATR' }));
    expect(value()).toEqual({ widenSlAtr: 10, widenTgtAtr: 0, widenMode: 'widest' });
    // quiet, ATR 20: 10× is 200, under the signal's 300 -- its own stands; busy, ATR 45: 450 -- widened
    expect(screen.getByLabelText(`${NAME} example`)).toHaveTextContent('Quiet, 1m ATR 20: SL 83,700, TGT 84,500. Busy, ATR 45: SL 83,550, TGT 84,500 -- and there they stay when it calms.');
    // back to the signal's own when calm: said in the example too
    fireEvent.click(within(screen.getByRole('radiogroup', { name: `${NAME}: when volatility falls again` })).getByRole('radio', { name: /Back to the signal's own/ }));
    expect(value()).toEqual({ widenSlAtr: 10, widenTgtAtr: 0, widenMode: 'calm' });
    expect(screen.getByLabelText(`${NAME} example`)).toHaveTextContent('once the ATR is back to 20, its level at the fill, SL 83,700 and TGT 84,500 again.');
    fireEvent.change(screen.getByLabelText(`${NAME}: TGT, ATRs`), { target: { value: '150' } });
    expect(screen.getByRole('alert')).toHaveTextContent('Widening with volatility is from 0 (off) to 100 ATRs.');
  });
});
