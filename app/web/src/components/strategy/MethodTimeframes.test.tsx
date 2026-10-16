import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { MethodTimeframes, byTimeframe, tfWords } from '@/components/strategy/MethodTimeframes';
import type { MethodUpdate } from '@/types/strategy';

const ist = (s: string) => Date.parse(`${s}+05:30`);
let id = 0;
const u = (o: Partial<MethodUpdate>): MethodUpdate => ({
  id: ++id, at: ist('2026-10-15T21:00:00'), strategyId: '15m-a', strategyName: '15m time', accountId: 1, source: 'daily', tf: '15m',
  rule: { winPct: 75, minTrades: 3, days: 7 }, from: null, to: null, before: [], after: [], added: [], dropped: [], records: [], note: null, ...o,
});
const range = { from: '2026-10-14', to: '2026-10-16' };
// 15m on two accounts: on the 15th one takes trap in and lets bos go; on the 16th the other lets breakout go.
const LOG = [
  u({ before: ['breakout', 'bos'], after: ['breakout', 'trap'], added: ['trap'], dropped: ['bos'],
      records: [{ method: 'trap', trades: 5, wins: 4, net: 0.3 }, { method: 'breakout', trades: 4, wins: 3, net: 0.1 }] }),
  u({ at: ist('2026-10-16T21:00:00'), strategyId: '15m-b', strategyName: '15m time', accountId: 2, before: ['breakout'], after: [], dropped: ['breakout'], note: null }),
  u({ at: ist('2026-10-16T21:00:00'), strategyId: 'chain', strategyName: 'All Chain 5m', tf: 'chain', before: ['mss'], after: ['mss'] }),
  u({ at: ist('2026-10-16T09:00:00'), strategyId: 'old', strategyName: 'gone', tf: null, source: 'manual', rule: null, before: [], after: ['nr7'], added: ['nr7'] }),
];
const names: Record<string, string> = { breakout: '#1 Breakout', bos: '#6 BOS', trap: '#9 Trap', mss: '#40 MSS', nr7: '#39 NR7' };

beforeEach(() => window.localStorage.clear());

describe('the method updates by time frame, day by day (16 Oct 2026)', () => {
  it('[critical] each time frame: its strategies, what came in and went out each day, what each method was every day, held carried forward', () => {
    const { days, groups } = byTimeframe(LOG, range);
    expect(days).toEqual(['2026-10-14', '2026-10-15', '2026-10-16']);
    expect(groups.map((g) => g.tf)).toEqual(['15m', 'chain', 'other']);
    const g = groups[0]!;
    expect([g.strategies.length, g.in, g.out, g.now]).toEqual([2, 1, 2, 2]);         // breakout and trap held now, by the first
    expect(g.days).toEqual([{ in: 0, out: 0 }, { in: 1, out: 1 }, { in: 0, out: 1 }]);
    const m = new Map(g.methods.map((x) => [x.method, x]));
    // breakout: held by both on the 14th and 15th, let go by the second on the 16th
    expect(m.get('breakout')!.cells).toEqual([{ in: 0, out: 0, held: 2 }, { in: 0, out: 0, held: 2 }, { in: 0, out: 1, held: 1 }]);
    expect(m.get('trap')!.cells).toEqual([{ in: 0, out: 0, held: 0 }, { in: 1, out: 0, held: 1 }, { in: 0, out: 0, held: 1 }]);
    expect(m.get('bos')!.cells.map((c) => c.held)).toEqual([1, 0, 0]);
    expect([m.get('trap')!.nowIn, m.get('bos')!.nowIn, m.get('breakout')!.nowIn]).toEqual([1, 0, 1]);
    expect(m.get('trap')!.record).toEqual({ method: 'trap', trades: 5, wins: 4, net: 0.3 });
    expect(tfWords('15m+1h')).toBe('15m + 1h');
    expect(tfWords('chain')).toBe('With the chain');
  });

  it('[critical] a time frame opens to its grid: + in, − out, ● held -- each cell said in words; a method a tap from its changes', () => {
    const onMethod = vi.fn();
    render(<MethodTimeframes updates={LOG} range={range} today="2026-10-16" nameOf={(x) => names[x] ?? x} accountOf={(a) => (a === 1 ? 'Savings' : 'Expenses')} onMethod={onMethod} />);
    const tf = screen.getByRole('region', { name: 'Time frame 15m' });
    const head = within(tf).getByRole('button', { expanded: false });
    expect(head).toHaveTextContent('15m+1 in · −2 out · 2 methods now');
    expect(head).toHaveTextContent('15m time (Savings) · 15m time (Expenses)');
    fireEvent.click(head);
    const grid = within(tf).getByRole('table', { name: '15m: methods day by day' });
    expect(within(grid).getByRole('img', { name: '#9 Trap, Thu 15 Oct: came in (1)' })).toHaveTextContent('+');
    expect(within(grid).getByRole('img', { name: '#6 BOS, Thu 15 Oct: went out (1)' })).toHaveTextContent('−');
    expect(within(grid).getByRole('img', { name: '#1 Breakout, Wed 14 Oct: in the list (2)' })).toHaveTextContent('●');
    expect(within(grid).getByRole('img', { name: '#9 Trap, Wed 14 Oct: not in the list' })).toHaveTextContent('');
    // the row ends with how many of the time frame's strategies hold it now, and its record
    expect(within(grid).getByRole('row', { name: /#9 Trap/ })).toHaveTextContent(/1\/280% · 5$/);
    fireEvent.click(within(grid).getByRole('button', { name: '#6 BOS' }));
    expect(onMethod).toHaveBeenCalledWith('bos');
    // remembered open in this browser
    expect(Object.entries(window.localStorage).some(([k, v]) => k.endsWith('method-log:tf-open') && v.includes('15m'))).toBe(true);
    expect(screen.getByRole('region', { name: 'Time frame Time frame not known' })).toBeInTheDocument();
  });
});
