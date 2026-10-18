import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import type { EntryMethodInfo } from '@/api/entry';
import { MethodList, type MethodRecord } from '@/components/strategy/MethodList';

/**
 * The methods list, one for the strategy's own methods and the daily update's excluded ones (owner, 18 Oct 2026:
 * "the methods list below, reused; the same filter and sort for exclude").
 */
const m = (id: string, n: number, group: EntryMethodInfo['group']): EntryMethodInfo => ({ id, n, name: id, group, summary: '', sl: '' });
const METHODS = [m('alpha', 1, 'breakout'), m('beta', 2, 'pullback'), m('gamma', 3, 'flow'), m('delta', 4, 'flow')];
const rec = (trades: number, wins: number, net: number): MethodRecord => ({ trades, wins, winPct: (wins / trades) * 100, net });
const RECORDS = new Map<string, MethodRecord>([['alpha', rec(10, 9, 50)], ['beta', rec(4, 1, -20)], ['gamma', rec(20, 12, 90)]]);

function Harness({ name, tagOf }: { name?: string; tagOf?: (id: string) => string | null }) {
  const [ids, setIds] = useState<string[]>([]);
  return (
    <>
      <MethodList name={name} methods={METHODS} value={ids} onChange={setIds} recordOf={RECORDS} byTf={new Map()} netWords={(n) => `$${n}`}
                  minTrades={3} keys={{ result: `t:${name}:result`, win: `t:${name}:win`, sort: `t:${name}:sort` }} tagOf={tagOf} />
      <output aria-label="ticked">{ids.join(',')}</output>
    </>
  );
}
const order = (list: string) => within(screen.getByRole('list', { name: list })).getAllByRole('checkbox').map((c) => c.getAttribute('aria-label'));

describe('the methods list, reused for Exclude', () => {
  it('[critical] filtered by result, with counts, and sorted -- under its own labels', () => {
    localStorage.clear();
    render(<Harness name="exclude" tagOf={(id) => (id === 'gamma' ? 'in the list now' : null)} />);
    const results = screen.getByRole('group', { name: 'methods by result (exclude)' });
    expect(within(results).getAllByRole('button').map((b) => b.textContent)).toEqual(['All 4', 'Profit 2', 'Loss 1', 'No trades 1', 'Win ≥30% 2']);
    fireEvent.click(within(results).getByRole('button', { name: /^Profit/ }));
    expect(order('methods (exclude)')).toEqual(['exclude: #1 alpha', 'exclude: #3 gamma']);
    fireEvent.click(within(screen.getByRole('group', { name: 'Sort (exclude)' })).getByRole('button', { name: 'Most trades' }));
    expect(order('methods (exclude)')).toEqual(['exclude: #3 gamma', 'exclude: #1 alpha']);
    expect(screen.getByText('in the list now')).toBeInTheDocument();
    // ticked, one by one or all shown
    fireEvent.click(screen.getByLabelText('exclude: #1 alpha'));
    expect(screen.getByLabelText('ticked')).toHaveTextContent(/^alpha$/);
    fireEvent.click(screen.getByRole('button', { name: 'Pick all shown (2)' }));
    expect(screen.getByLabelText('ticked')).toHaveTextContent(/^alpha,gamma$/);
    // searched and by family
    fireEvent.click(within(results).getByRole('button', { name: /^All/ }));
    fireEvent.change(screen.getByLabelText('search methods (exclude)'), { target: { value: 'del' } });
    expect(order('methods (exclude)')).toEqual(['exclude: #4 delta']);
  });

  it('the strategy\'s own list keeps its labels', () => {
    render(<Harness />);
    expect(screen.getByLabelText('search methods')).toBeInTheDocument();
    expect(screen.getByRole('list', { name: 'methods' })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Sort' })).toBeInTheDocument();
    expect(screen.getByLabelText('#1 alpha')).toBeInTheDocument();
  });
});
