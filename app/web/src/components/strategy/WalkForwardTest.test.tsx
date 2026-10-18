import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { WalkForwardTest } from '@/components/strategy/WalkForwardTest';
import type { WalkForward, WalkLine } from '@/types/strategy';

/** "Test this rule" (18 Oct 2026): the rule walked forward, the last days held out, beside every method and the list now. */
const line = (net: number, o: Partial<WalkLine> = {}): WalkLine => ({ trades: 10, wins: 6, net, days: 4, upDays: 2, downDays: 2, worstDay: { day: '2026-10-12', net: -3 }, ...o });
const RESULT: WalkForward = {
  from: '2026-10-08', to: '2026-10-17', holdoutFrom: '2026-10-15',
  rule: { winPct: 75, minTrades: 3, days: 7, excluded: 1 },
  days: [
    { day: '2026-10-14', holdout: false, picked: ['a', 'b'], kept: false, rule: { trades: 3, wins: 2, net: 4 }, all: { trades: 9, wins: 3, net: -2 }, current: { trades: 3, wins: 1, net: -1 } },
    { day: '2026-10-15', holdout: true, picked: ['a'], kept: true, rule: { trades: 2, wins: 2, net: 5 }, all: { trades: 9, wins: 3, net: -4 }, current: { trades: 2, wins: 1, net: 0 } },
  ],
  walk: { rule: line(12), all: line(-8), current: line(2) },
  holdout: { rule: line(5, { days: 3 }), all: line(-4, { days: 3 }), current: line(1, { days: 3 }) },
};

describe('Test this rule', () => {
  it('[critical] asks with the days held out, and sets the walk and the holdout apart, each beside its baselines', async () => {
    const run = vi.fn(async () => RESULT);
    render(<WalkForwardTest run={run} nameOf={(id) => `#${id}`} />);
    fireEvent.click(within(screen.getByRole('group', { name: 'Days held out' })).getByRole('button', { name: '5d' }));
    fireEvent.click(screen.getByRole('button', { name: 'Test this rule' }));
    const out = await screen.findByRole('status', { name: 'Walk-forward result' });
    expect(run).toHaveBeenCalledWith({ holdout: 5 });
    expect(out).toHaveTextContent('win ≥75% on 3+ over 7 days · 1 excluded');
    const held = within(screen.getByLabelText('Held-out days'));
    expect(held.getAllByRole('row').slice(1).map((r) => r.querySelector('td')!.textContent)).toEqual(['This rule ★', 'Every method', 'The list now']);
    expect(out).toHaveTextContent('On the held-out days this rule beat both every method and the list now. 3 days is a small sample.');
    fireEvent.click(screen.getByRole('button', { name: 'Each day (2)' }));
    expect(within(screen.getByRole('list', { name: 'Each day of the walk' })).getAllByRole('listitem')[1]).toHaveTextContent(/held out .*1 method \(kept: none passed\)/);
  });

  it('nothing held out is said plainly; a rule that is wrong cannot be tested; a refusal is said', async () => {
    const { unmount } = render(<WalkForwardTest run={async () => ({ ...RESULT, holdout: null, holdoutFrom: null })} nameOf={(id) => id} />);
    fireEvent.click(screen.getByRole('button', { name: 'Test this rule' }));
    expect(await screen.findByText('Nothing held out: every day here could have shaped the rule.')).toBeInTheDocument();
    unmount();
    render(<WalkForwardTest run={async () => { throw new Error('The holdout must leave at least one day to walk.'); }} nameOf={(id) => id} disabled />);
    expect(screen.getByRole('button', { name: 'Test this rule' })).toBeDisabled();
  });
});
