import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { VolStudyLine, VolStudyResult } from '@/types/signal-backtest';
import { VolStudy, VOL_DRAFTS, volAskOf, volDraftProblem } from '@/components/report/VolStudy';

/**
 * The SL, delta and lots by volatility, as research (owner, 17 Oct 2026: "SL, delta, lots -- Low, Normal and High for
 * all three; backtest and portfolio"): each rule a switch with its three levels, the study asked for with a tap,
 * both ways of reading volatility laid beside the settings as set, and nothing claimed that the numbers do not show.
 */
const read = vi.fn();
const levels = (o: Partial<Record<'low' | 'medium' | 'high' | 'unknown', [number, number, number]>>) => (['low', 'medium', 'high', 'unknown'] as const)
  .map((level) => { const [n, net, stopHits] = o[level] ?? [0, 0, 0]; return { level, n, wins: Math.round(n * 0.8), net, stopHits }; });
const line = (rule: VolStudyLine['rule'], o: Partial<VolStudyLine>): VolStudyLine => ({
  rule, n: 300, wins: 240, net: 0, charges: 3, lots: 300, stopHits: 20, worstDay: { day: '2026-10-09', net: -5 }, maxDrawdown: 6, halves: [0, 0], byLevel: [], ...o,
});
const RESULT: VolStudyResult = {
  from: '2026-10-01', to: '2026-10-16', days: 16, secondHalfFrom: '2026-10-09', fixed: { pct: 1.6, stepped: false, each: [1.6] },
  sl: { high: 1.5, medium: 2, low: 2.5 }, delta: null, lots: null, signals: 300, sameTrades: true,
  sources: [
    { by: 'atr', lines: [
      line('fixed', { net: 30, halves: [20, 10], byLevel: levels({ low: [100, 12, 5], medium: [100, 10, 7], high: [90, 6, 8], unknown: [10, 2, 0] }) }),
      line('by-vol', { net: 34, stopHits: 18, worstDay: { day: '2026-10-09', net: -3 }, maxDrawdown: 4, halves: [22, 12], byLevel: levels({ low: [100, 14, 3], medium: [100, 11, 5], high: [90, 7, 10], unknown: [10, 2, 0] }) }),
    ] },
    { by: 'iv', lines: [
      line('fixed', { net: 30, halves: [20, 10], byLevel: levels({ low: [100, 10, 6], medium: [100, 10, 7], high: [100, 10, 7] }) }),
      line('by-vol', { net: 28, stopHits: 25, halves: [24, 4], byLevel: levels({ low: [100, 9, 4], medium: [100, 10, 9], high: [100, 9, 12] }) }),
    ] },
  ],
};
const show = (askKey = 'q1') => render(<VolStudy askKey={askKey} read={read} />);

beforeEach(() => { window.localStorage.clear(); read.mockReset().mockResolvedValue(RESULT); });

describe('VolStudy', () => {
  it('[critical] three rules, each a switch with Low, Normal and High: the SL on at 250 / 200 / 150, delta and lots off until switched on', () => {
    show();
    expect(screen.getByRole('switch', { name: /SL by volatility/ })).toBeChecked();
    expect(screen.getByRole('switch', { name: /Delta by volatility/ })).not.toBeChecked();
    expect(screen.getByRole('switch', { name: /Lots by volatility/ })).not.toBeChecked();
    expect(screen.getByLabelText('Option SL in low volatility, per cent over the premium')).toHaveValue(250);
    expect(screen.getByLabelText('Option SL in normal volatility, per cent over the premium')).toHaveValue(200);
    expect(screen.getByLabelText('Option SL in high volatility, per cent over the premium')).toHaveValue(150);
    expect(screen.queryByLabelText('Strike delta in high volatility')).toBeNull();
    fireEvent.click(screen.getByRole('switch', { name: /Delta by volatility/ }));
    fireEvent.click(screen.getByRole('switch', { name: /Lots by volatility/ }));
    expect(screen.getByLabelText('Strike delta in low volatility')).toHaveValue(0.12);
    expect(screen.getByLabelText('Strike delta in normal volatility')).toHaveValue(0.1);
    expect(screen.getByLabelText('Strike delta in high volatility')).toHaveValue(0.08);
    expect(screen.getByLabelText('Lots in low volatility')).toHaveValue(2);
    expect(screen.getByLabelText('Lots in normal volatility')).toHaveValue(2);
    expect(screen.getByLabelText('Lots in high volatility')).toHaveValue(1);
    expect(screen.getByText(/SL Low \+250% · Normal \+200% · High \+150%; Delta Low Δ 0\.12 · Normal Δ 0\.10 · High Δ 0\.08; Lots Low 2 lots · Normal 2 lots · High 1 lot\./)).toBeInTheDocument();
    expect(read).not.toHaveBeenCalled();
  });

  it('[critical] Compare asks with what is switched on and typed -- what is off is not sent -- and the values are kept in this browser', async () => {
    show();
    fireEvent.change(screen.getByLabelText('Option SL in high volatility, per cent over the premium'), { target: { value: '120' } });
    fireEvent.click(screen.getByRole('switch', { name: /Lots by volatility/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Compare' }));
    await waitFor(() => expect(read).toHaveBeenCalledWith({ sl: { low: 250, medium: 200, high: 120 }, delta: null, lots: { low: 2, medium: 2, high: 1 } }));
    expect(JSON.parse(window.localStorage.getItem('btc-desk:signalBacktest.volStudy.rules')!).sl.high).toBe('120');
    fireEvent.click(screen.getByRole('button', { name: 'Back to the defaults' }));
    expect(screen.getByLabelText('Option SL in high volatility, per cent over the premium')).toHaveValue(150);
  });

  it('[critical] a value out of range, none switched on, or none typed is said in words and Compare waits', () => {
    expect(volDraftProblem(VOL_DRAFTS)).toBeNull();
    expect(volDraftProblem({ ...VOL_DRAFTS, sl: { ...VOL_DRAFTS.sl, on: false } })).toMatch(/Switch on the SL, the delta or the lots/);
    expect(volDraftProblem({ ...VOL_DRAFTS, delta: { ...VOL_DRAFTS.delta, on: true, high: '0.9' } })).toMatch(/high volatility delta is from 0\.02 to 0\.50/);
    expect(volDraftProblem({ ...VOL_DRAFTS, lots: { ...VOL_DRAFTS.lots, on: true, low: '1.5' } })).toMatch(/low volatility lots are a whole number/);
    expect(volDraftProblem({ ...VOL_DRAFTS, sl: { ...VOL_DRAFTS.sl, medium: '' } })).toMatch(/Type the normal volatility SL/);
    expect(volAskOf({ ...VOL_DRAFTS, delta: { ...VOL_DRAFTS.delta, on: true } })).toEqual({ sl: { low: 250, medium: 200, high: 150 }, delta: { low: 0.12, medium: 0.1, high: 0.08 }, lots: null });
    show();
    fireEvent.change(screen.getByLabelText('Option SL in low volatility, per cent over the premium'), { target: { value: '2000' } });
    expect(screen.getByRole('alert')).toHaveTextContent('The low volatility SL is from 10% to 1,000% of the premium.');
    expect(screen.getByRole('button', { name: 'Compare' })).toBeDisabled();
  });

  it('[critical] each way of reading volatility beside the settings as set: the better of each figure marked, and a verdict that needs both halves', async () => {
    show();
    fireEvent.click(screen.getByRole('button', { name: 'Compare' }));
    const atr = await screen.findByRole('region', { name: 'By ATR 2h' });
    expect(within(atr).getByRole('status')).toHaveTextContent(/By volatility made \+?₹[\d,.]+ more than as set, and was better in both halves of the days\./);
    const table = within(atr).getByRole('table', { name: /By ATR 2h: the settings as set against/ });
    expect(within(within(table).getByRole('row', { name: /^Net [+−]?₹/ })).getAllByRole('cell')[1]).toHaveTextContent('(better)');
    expect(within(within(table).getByRole('row', { name: /^Max drawdown/ })).getAllByRole('cell')[1]).toHaveTextContent('(better)');
    expect(within(table).queryByRole('row', { name: /^Lots traded/ })).toBeNull();
    expect(within(atr).getByText(/By level · 290 with a level, 10 unknown/)).toBeInTheDocument();
    expect(within(atr).getByText('kept as set')).toBeInTheDocument();
    expect(screen.getByText(/As set:/).parentElement).toHaveTextContent('As set: SL +160%. By volatility: Low SL +250% · Normal SL +200% · High SL +150%.');

    const iv = screen.getByRole('region', { name: 'By ATM IV' });
    expect(within(iv).getByRole('status')).toHaveTextContent(/made −?₹[\d,.]+ less than as set, but better in one half only -- not a rule yet\./);
    expect(screen.getByText(/16 expiry days are a short sample: a difference here can be luck\..*A rule goes to paper first, never straight to live\./)).toBeInTheDocument();
  });

  it('[critical] with the lots by level the money is of another size: lots traded and net per lot, and the verdict per lot', async () => {
    const sized: VolStudyResult = { ...RESULT, sl: null, lots: { low: 2, medium: 2, high: 1 }, sources: [RESULT.sources[0]!, {
      by: 'iv', lines: [line('fixed', { net: 30, lots: 300, halves: [15, 15], byLevel: levels({ low: [100, 10, 0], medium: [100, 10, 0], high: [100, 10, 0] }) }),
        line('by-vol', { net: 50, lots: 500, halves: [25, 25], byLevel: levels({ low: [100, 20, 0], medium: [100, 20, 0], high: [100, 10, 0] }) })],
    }] };
    read.mockResolvedValue(sized);
    show();
    fireEvent.click(screen.getByRole('button', { name: 'Compare' }));
    const iv = await screen.findByRole('region', { name: 'By ATM IV' });
    // ₹ 30 / 300 lots against ₹ 50 / 500: the same a lot -- more money only from more lots, and said so.
    expect(within(iv).getByRole('status')).toHaveTextContent(/made ₹0(\.00)? (more|less) a lot than as set, and was not better in either half\./);
    const table = within(iv).getByRole('table', { name: /By ATM IV: the settings as set/ });
    expect(within(table).getByRole('row', { name: /^Lots traded 300 500$/ })).toBeInTheDocument();
    expect(within(within(table).getByRole('row', { name: /^Net [+−]?₹/ })).getAllByRole('cell')[1]).not.toHaveTextContent('(better)');
  });

  it('[critical] over saved backtests run together: how many, and one that could not be worked, named with why', async () => {
    read.mockResolvedValue({ ...RESULT, fixed: { pct: 1.6, stepped: false, each: [1.6, 3] }, members: [{ id: 'a', name: '15m time', problem: null }, { id: 'b', name: 'Old', problem: 'The strategy it is worked by has been deleted.' }] });
    render(<VolStudy askKey="run" read={read} title="By volatility · SL, delta, lots · over the run" />);
    expect(screen.getByText('By volatility · SL, delta, lots · over the run')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Compare' }));
    expect(await screen.findByText(/Over 1 saved backtest, each on its own signals and settings, added up\. Old: The strategy it is worked by has been deleted\./)).toBeInTheDocument();
    expect(screen.getByText(/As set:/).parentElement).toHaveTextContent("As set: each one's own SL (+160%, +300%).");
  });

  it('[critical] the question changed after a comparison: the last one is kept, greyed and said to be of the settings before', async () => {
    const { rerender } = show('q1');
    fireEvent.click(screen.getByRole('button', { name: 'Compare' }));
    await screen.findByRole('region', { name: 'By ATR 2h' });
    rerender(<VolStudy askKey="q2" read={read} />);
    expect(screen.getByText(/The settings or the values changed since: below is the last comparison/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Compare again' })).toBeEnabled();
  });

  it('[critical] no level could be said for any trade: no comparison is made up', async () => {
    read.mockResolvedValue({ ...RESULT, sources: RESULT.sources.map((s) => ({ ...s, lines: s.lines.map((l) => ({ ...l, byLevel: levels({ unknown: [300, 30, 20] }) })) })) });
    show();
    fireEvent.click(screen.getByRole('button', { name: 'Compare' }));
    const iv = await screen.findByRole('region', { name: 'By ATM IV' });
    expect(within(iv).getByText(/No signal in these days has a level by the ATM IV: every trade kept the settings as set/)).toBeInTheDocument();
    expect(within(iv).queryByRole('table')).toBeNull();
  });

  it('a failed comparison is said, and can be asked again', async () => {
    read.mockRejectedValue(new Error('The backtest took too long and was stopped.'));
    show();
    fireEvent.click(screen.getByRole('button', { name: 'Compare' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not compare: The backtest took too long and was stopped.');
    expect(screen.getByRole('button', { name: 'Compare' })).toBeEnabled();
  });
});
