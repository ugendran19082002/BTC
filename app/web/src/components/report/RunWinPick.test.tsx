import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { RunWinPick, WIN_PICK_DEFAULT, winPickFor, winPickProblem, winPickWords, type WinPick } from '@/components/report/RunWinPick';

/** Methods by win % for a run together (19 Oct 2026): picked on the days before by default; the run's own, said for what it is. */
function Harness({ run, start = WIN_PICK_DEFAULT }: { run?: { from: string; to: string }; start?: WinPick }) {
  const [w, setW] = useState<WinPick>(start);
  return (<><RunWinPick value={w} run={run} onChange={setW} /><output aria-label="pick">{JSON.stringify(w)}</output></>);
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

  /*
   * 19 Oct 2026, owner: "portfolio not working". A run from 1 Oct -- the record's first day -- with "the 14 days
   * before": every run refused, and the last result left on the screen. Said here before the run, with the fix a tap away.
   */
  it('[critical] the days before a run that starts on the record\'s first day: said, and the run\'s first days a tap away', () => {
    render(<Harness run={{ from: '2026-10-01', to: '2026-10-19' }} start={{ pct: 60, minTrades: 3, on: 'before', days: 14 }} />);
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('There are no finished days before Thu 1 Oct to pick from: the record starts Thu 1 Oct.');
    fireEvent.click(within(alert).getByRole('button', { name: "Pick on the run's first 14 days instead" }));
    expect(value()).toEqual({ pct: 60, minTrades: 3, on: 'first', days: 14 });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByText(/picked on the run's first 14 days \(Thu 1 Oct – Wed 14 Oct\), then run on the days after them \(Thu 15 Oct – Mon 19 Oct\)/)).toBeInTheDocument();
    expect(winPickWords(value())).toBe("methods won ≥60% of 3+ · the run's first 14 days, run on the rest");
  });

  it('[critical] the first days leaving none to run on: said, with fewer days a tap away', () => {
    render(<Harness run={{ from: '2026-10-10', to: '2026-10-16' }} start={{ pct: 75, minTrades: 3, on: 'first', days: 7 }} />);
    expect(screen.getByRole('alert')).toHaveTextContent('The run is 7 days: picking on its first 7 days leaves none to run on.');
    fireEvent.click(screen.getByRole('button', { name: "Pick on the run's first 3 days instead" }));
    expect(value().days).toBe(3);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('the days before, as far as the record goes: fewer than asked is said; a run later has them all', () => {
    expect(winPickProblem({ ...WIN_PICK_DEFAULT, days: 7 }, { from: '2026-10-05', to: '2026-10-19' })).toEqual({
      problem: null, fix: null, note: 'Only 4 days of the 7 before the run are in the record (from Thu 1 Oct): picked on those.',
    });
    // 19 Oct 2026, a run from 2 Oct with 14 days asked: 1 Oct alone -- six of seven found nothing. Said, with the fix.
    expect(winPickProblem({ ...WIN_PICK_DEFAULT, days: 14 }, { from: '2026-10-02', to: '2026-10-20' })).toEqual({
      problem: null, fix: { on: 'first' },
      note: 'Only 1 day of the 14 before the run is in the record (from Thu 1 Oct): too few to pick on -- a day or two is a handful of trades, not a record.',
    });
    expect(winPickProblem({ ...WIN_PICK_DEFAULT, days: 7 }, { from: '2026-10-12', to: '2026-10-19' })).toEqual({ problem: null, fix: null, note: null });
    // A one-day run on the first day: nothing before, nothing after -- the run's own days.
    expect(winPickProblem(WIN_PICK_DEFAULT, { from: '2026-10-01', to: '2026-10-01' }).fix).toEqual({ on: 'same' });
  });

  it('[critical] switched on, it starts from a pick the run\'s days allow', () => {
    expect(winPickFor({ from: '2026-10-01', to: '2026-10-19' })).toEqual({ ...WIN_PICK_DEFAULT, on: 'first' });
    expect(winPickFor({ from: '2026-10-12', to: '2026-10-19' })).toEqual(WIN_PICK_DEFAULT);
    expect(winPickFor()).toEqual(WIN_PICK_DEFAULT);
  });
});
