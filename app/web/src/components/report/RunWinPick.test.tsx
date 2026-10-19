import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { RunWinPick, WIN_PICK_DEFAULT, winPickWords, type WinPick } from '@/components/report/RunWinPick';

/** Methods by win % for a run together (19 Oct 2026): picked on the days before by default; the run's own, said for what it is. */
function Harness() {
  const [w, setW] = useState<WinPick>(WIN_PICK_DEFAULT);
  return (<><RunWinPick value={w} onChange={setW} /><output aria-label="pick">{JSON.stringify(w)}</output></>);
}
const value = () => JSON.parse(screen.getByLabelText('pick').textContent!) as WinPick;

describe('Methods by win %, for the run', () => {
  it('[critical] a rate, least trades, and the days picked on -- the days before by default, the run\'s own warned of', () => {
    render(<Harness />);
    expect(value()).toEqual({ pct: 75, minTrades: 3, on: 'before', days: 7 });
    expect(screen.getByText(/picked on the 7 finished days before the run, then run on days that took no part/)).toBeInTheDocument();
    fireEvent.click(within(screen.getByRole('group', { name: 'Methods by win %, won at least' })).getByRole('button', { name: '60%' }));
    fireEvent.click(within(screen.getByRole('group', { name: 'Methods by win %, days before' })).getByRole('button', { name: '14 days' }));
    expect(value()).toMatchObject({ pct: 60, days: 14 });
    fireEvent.click(within(screen.getByRole('group', { name: 'Methods by win %, least trades' })).getByRole('button', { name: '1' }));
    expect(screen.getByText(/One or two trades is luck/)).toBeInTheDocument();
    fireEvent.click(within(screen.getByRole('radiogroup', { name: 'Methods by win %, picked on' })).getByRole('radio', { name: /run's own days/ }));
    expect(value().on).toBe('same');
    expect(screen.getByText(/the result looks better than it can be/)).toBeInTheDocument();
    expect(winPickWords(value())).toBe("methods won ≥60% of 1+ · the run's own days (in-sample)");
  });
});
