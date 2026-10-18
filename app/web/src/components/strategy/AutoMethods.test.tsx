import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { AutoMethodsFields, autoWords } from '@/components/strategy/AutoMethods';
import { DEFAULT_AUTO_METHODS, autoMethodsProblems, type AutoMethods, type AutoMethodsRun } from '@/types/strategy';

const names: Record<string, string> = { breakout: '#1 Breakout', bos: '#6 BOS', trap: '#9 Trap' };
function Harness({ start = null, pickNow, onTake = () => {}, blocked = null }: {
  start?: AutoMethods | null; pickNow?: (a: AutoMethods) => Promise<AutoMethodsRun>; onTake?: (r: AutoMethodsRun) => void; blocked?: string | null;
}) {
  const [a, setA] = useState<AutoMethods | null>(start);
  return (
    <>
      <AutoMethodsFields value={a} onChange={setA} onTake={onTake} pickNow={pickNow} nameOf={(id) => names[id] ?? id} blocked={blocked} />
      <output aria-label="saved">{JSON.stringify(a)}</output>
    </>
  );
}
const saved = () => JSON.parse(screen.getByLabelText('saved').textContent!) as AutoMethods;

describe('the methods\' daily update in the signal strategy form (16 Oct 2026)', () => {
  it('[critical] off to begin with; switched on, it says the rule in one sentence, win 75% marked best', () => {
    render(<Harness />);
    const sw = screen.getByRole('switch', { name: 'Update the methods every day' });
    expect(sw).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByLabelText('Auto-update methods')).toHaveTextContent('Off · the list below is yours');
    fireEvent.click(sw);
    expect(saved()).toEqual({ ...DEFAULT_AUTO_METHODS, on: true });
    expect(screen.getByLabelText('Auto-update methods')).toHaveTextContent(
      'Every day at 9:00 PM IST, keep the methods that won 75% or more of at least 3 trades over the last 7 days. If none do, the list stays as it is.');
    expect(screen.getByRole('button', { name: 'Win 75%, best when tested' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('[critical] a preset or a number typed, for the win rate, the days and the trades; and the time', () => {
    render(<Harness start={{ ...DEFAULT_AUTO_METHODS, on: true }} />);
    fireEvent.click(within(screen.getByRole('group', { name: 'Win rate presets' })).getByRole('button', { name: 'Win 80%' }));
    fireEvent.click(within(screen.getByRole('group', { name: 'Look-back presets' })).getByRole('button', { name: 'Last 14 days' }));
    fireEvent.change(screen.getByLabelText('Daily update: least trades'), { target: { value: '4' } });
    fireEvent.change(screen.getByLabelText('Update time, IST'), { target: { value: '20:30' } });
    expect(saved()).toMatchObject({ winPct: 80, days: 14, minTrades: 4, at: '20:30' });
    expect(autoWords(saved())).toMatch(/^Every day at 8:30 PM IST, keep the methods that won 80% or more of at least 4 trades over the last 14 days/);
  });

  it('[critical] "Pick now": what it would pick, new and dropped, by name -- taken only on "Use this list"', async () => {
    const run: AutoMethodsRun = { at: Date.parse('2026-10-16T15:30:00Z'), from: '2026-10-10', to: '2026-10-16', picked: ['breakout', 'trap'], before: ['breakout', 'bos'], records: [{ method: 'breakout', trades: 4, wins: 3, net: 0.2 }] };
    const pickNow = vi.fn(async () => run);
    const onTake = vi.fn();
    render(<Harness start={{ ...DEFAULT_AUTO_METHODS, on: true, winPct: 70 }} pickNow={pickNow} onTake={onTake} />);
    fireEvent.click(screen.getByRole('button', { name: 'Pick now' }));
    const shown = await screen.findByRole('status', { name: 'What it would pick' });
    expect(pickNow).toHaveBeenCalledWith(expect.objectContaining({ winPct: 70 }));
    expect(shown).toHaveTextContent('2 methods (now 2)');
    expect(shown).toHaveTextContent('+1 new, −1 dropped');
    expect(within(screen.getByRole('list', { name: 'Methods it would pick' })).getAllByRole('listitem').map((li) => li.textContent)).toEqual([
      expect.stringMatching(/^#1 Breakout · 3\/4 won · \+₹/), '#9 Trap',
    ]);
    fireEvent.click(within(shown).getByRole('button', { name: 'Use this list' }));
    expect(onTake).toHaveBeenCalledWith(run);
    expect(screen.queryByRole('status', { name: 'What it would pick' })).toBeNull();
  });

  it('nothing passed: it says so and offers nothing to take; a failed pick says why', async () => {
    const kept: AutoMethodsRun = { at: 1, from: '2026-10-10', to: '2026-10-16', picked: ['bos'], before: ['bos'], note: 'No method won 90% of 3 trades or more: the list was kept.' };
    const { unmount } = render(<Harness start={{ ...DEFAULT_AUTO_METHODS, on: true }} pickNow={async () => kept} />);
    fireEvent.click(screen.getByRole('button', { name: 'Pick now' }));
    const shown = await screen.findByRole('status', { name: 'What it would pick' });
    expect(shown).toHaveTextContent('the list was kept');
    expect(within(shown).queryByRole('button', { name: 'Use this list' })).toBeNull();
    unmount();
    render(<Harness start={{ ...DEFAULT_AUTO_METHODS, on: true }} pickNow={async () => { throw new Error('the backtest took too long'); }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Pick now' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('the backtest took too long');
  });

  it('the last update is said; a strategy that buys cannot switch it on', () => {
    const last: AutoMethodsRun = { at: Date.parse('2026-10-16T15:30:00Z'), from: '2026-10-10', to: '2026-10-16', picked: ['breakout', 'trap'], before: ['bos'] };
    const { unmount } = render(<Harness start={{ ...DEFAULT_AUTO_METHODS, on: true, last }} />);
    expect(screen.getByLabelText('Last update')).toHaveTextContent(/Last update .*9:00 pm: 2 methods \(was 1\)/i);
    unmount();
    render(<Harness blocked="Picks by the record as options sold: a strategy that buys cannot use it." />);
    expect(screen.getByRole('switch', { name: 'Update the methods every day' })).toBeDisabled();
  });

  it('its settings are checked as the server checks them', () => {
    expect(autoMethodsProblems(DEFAULT_AUTO_METHODS)).toEqual([]);
    expect(autoMethodsProblems({ ...DEFAULT_AUTO_METHODS, at: '', winPct: 0, minTrades: 0, days: 31 })).toHaveLength(4);
  });
});

/*
 * Exclude (owner, 18 Oct 2026: "an exclude option -- what I select there must not be chosen; on and off; on, at
 * least one picked; the methods list below, reused; the same filter and sort").
 */
function ExcludeHarness({ start }: { start: AutoMethods }) {
  const [a, setA] = useState<AutoMethods | null>(start);
  return (
    <>
      <AutoMethodsFields value={a} onChange={setA} onTake={() => {}} nameOf={(id) => names[id] ?? id} error={autoMethodsProblems(a)[0] ?? null}
                         excludeList={(ids, put) => (
                           <ul aria-label="stand-in list">
                             {Object.keys(names).map((id) => (
                               <li key={id}><input type="checkbox" aria-label={`tick ${id}`} checked={ids.includes(id)} onChange={() => put(ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id])} /></li>
                             ))}
                           </ul>
                         )} />
      <output aria-label="saved">{JSON.stringify(a)}</output>
    </>
  );
}

describe('Exclude, in the methods\' daily update (18 Oct 2026)', () => {
  it('[critical] off to begin with, its list hidden; on, the methods list to tick -- and at least one is asked for', () => {
    render(<ExcludeHarness start={{ ...DEFAULT_AUTO_METHODS, on: true }} />);
    const sw = screen.getByRole('switch', { name: 'Exclude methods from the daily pick' });
    expect(sw).toHaveAttribute('aria-checked', 'false');
    expect(screen.queryByRole('list', { name: 'stand-in list' })).toBeNull();
    fireEvent.click(sw);
    expect(saved().exclude).toEqual({ on: true, methods: [] });
    const box = screen.getByRole('region', { name: 'Exclude methods' });
    expect(within(box).getByRole('alert')).toHaveTextContent('Pick at least one method to exclude, or switch Exclude off.');
    // said once, in the box, not again under the settings
    expect(screen.getAllByText('Pick at least one method to exclude, or switch Exclude off.')).toHaveLength(1);
    fireEvent.click(screen.getByLabelText('tick bos'));
    fireEvent.click(screen.getByLabelText('tick trap'));
    expect(saved().exclude).toEqual({ on: true, methods: ['bos', 'trap'] });
    expect(within(box).queryByRole('alert')).toBeNull();
    expect(box).toHaveTextContent('2 methods excluded · never picked, however they did.');
    expect(autoWords(saved())).toMatch(/over the last 7 days, never the 2 excluded methods\. If none do/);
    // each one ticked, by name, taken out in one tap
    fireEvent.click(within(screen.getByRole('list', { name: 'Excluded' })).getByRole('button', { name: 'Stop excluding #6 BOS' }));
    expect(saved().exclude!.methods).toEqual(['trap']);
  });

  it('switched off, the ticks are kept for next time and nothing is excluded', () => {
    render(<ExcludeHarness start={{ ...DEFAULT_AUTO_METHODS, on: true, exclude: { on: true, methods: ['bos'] } }} />);
    fireEvent.click(screen.getByRole('switch', { name: 'Exclude methods from the daily pick' }));
    expect(saved().exclude).toEqual({ on: false, methods: ['bos'] });
    expect(screen.getByRole('region', { name: 'Exclude methods' })).toHaveTextContent('Off · every method can be picked. The 1 ticked are kept for when it is on.');
    expect(autoWords(saved())).not.toMatch(/excluded/);
    expect(autoMethodsProblems({ ...DEFAULT_AUTO_METHODS, exclude: { on: false, methods: [] } })).toEqual([]);
  });

  it('"Pick now" names the excluded ones that passed and were left out', async () => {
    const run: AutoMethodsRun = { at: 1, from: '2026-10-10', to: '2026-10-16', picked: ['breakout'], before: ['breakout'], excluded: ['trap'] };
    render(<Harness start={{ ...DEFAULT_AUTO_METHODS, on: true, exclude: { on: true, methods: ['trap'] } }} pickNow={async () => run} />);
    fireEvent.click(screen.getByRole('button', { name: 'Pick now' }));
    expect(await screen.findByLabelText('Left out, excluded')).toHaveTextContent('Passed but excluded: #9 Trap.');
  });
});
