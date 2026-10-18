import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { PerpVsOptions, agree } from '@/components/report/PerpVsOptions';
import type { BtRow, BtTot } from '@/types/signal-backtest';

/** The perp and the options apart, on the same trades (18 Oct 2026): a good perp line is not a good options one. */
const tot = (o: Partial<BtTot>): BtTot => ({ n: 10, wins: 6, losses: 4, net: 12, won: 20, lost: 8, perpPts: 900, perpWins: 4, perpNetPts: -100, perpR: 3, perpRNet: -2, charges: 1, exits: {}, ...o });
const row = (key: string, o: Partial<BtTot>): BtRow => ({ key, name: `#${key}`, ...tot(o) });

describe('Perp vs options', () => {
  it('[critical] the two totals side by side, the perp after its fees in points and R; and the methods that point opposite ways', () => {
    render(<PerpVsOptions total={tot({})} rows={[row('a', { net: 8, perpNetPts: -200 }), row('b', { net: 4, perpNetPts: 100 }), row('c', { n: 0 })]} />);
    const totals = screen.getByLabelText('Perp and options, the totals');
    expect(totals).toHaveTextContent('6 won · 4 lost · 60% won');
    expect(totals).toHaveTextContent('charges −₹');
    expect(totals).toHaveTextContent('4 won · 6 lost · 40% won');
    expect(totals).toHaveTextContent('-0.20R a trade (+0.30R before fees)');
    expect(screen.getByText(/of 2 methods point opposite ways/)).toHaveTextContent('1 of 2 methods point opposite ways');
    fireEvent.click(screen.getByRole('button', { name: 'Only where they differ (1)' }));
    const rows = within(screen.getByRole('table', { name: 'Perp vs options by method' })).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveTextContent(/#a\s*differ/);
  });

  it('agreeing, said so; an older server without the perp figures shows nothing', () => {
    expect(agree({ net: 5, perpNetPts: 10 })).toBe(true);
    expect(agree({ net: 5, perpNetPts: -10 })).toBe(false);
    const { container, unmount } = render(<PerpVsOptions total={tot({ perpNetPts: undefined })} rows={[]} />);
    expect(container).toBeEmptyDOMElement();
    unmount();
    render(<PerpVsOptions total={tot({ net: 3, perpNetPts: 30 })} rows={[row('a', { net: 3, perpNetPts: 30 })]} />);
    expect(screen.getByText(/Every method points the same way on both/)).toBeInTheDocument();
  });
});

describe('Perp vs options by time frame', () => {
  it('[critical] every time frame side by side; one chosen, its total and its own methods -- won, lost and charges on each', () => {
    const tf = (key: string, o: Partial<BtTot>): BtRow => ({ key, name: key, ...tot(o) });
    render(<PerpVsOptions total={tot({})}
      rows={[row('a', { net: 8, perpNetPts: -200 })]}
      byTf={[tf('5m', { n: 6, wins: 4, net: 10, charges: 0.5, perpWins: 3, perpNetPts: 50 }), tf('chain', { n: 4, wins: 2, net: 2, perpWins: 1, perpNetPts: -150 })]}
      pairs={[row('a|single|5m', { n: 6, wins: 4, net: 10, perpNetPts: 50 }), row('a|mtf|5m', { n: 4, wins: 2, net: 2, perpNetPts: -150 })]} />);
    const byTf = within(screen.getByRole('table', { name: 'Perp vs options by time frame' }));
    expect(byTf.getAllByRole('row').slice(1).map((r) => r.querySelector('th')!.textContent)).toEqual(['5m', 'TF chaindiffer']);
    fireEvent.click(within(screen.getByRole('group', { name: 'Perp vs options, time frame' })).getByRole('button', { name: 'TF chain' }));
    expect(screen.getByLabelText('Perp and options, the totals')).toHaveTextContent('2 won · 2 lost');
    expect(screen.queryByRole('table', { name: 'Perp vs options by time frame' })).toBeNull();
    const methods = within(screen.getByRole('table', { name: 'Perp vs options by method' })).getAllByRole('row').slice(1);
    expect(methods).toHaveLength(1);
    expect(methods[0]).toHaveTextContent(/#a\|mtf\|5m/);
    expect(methods[0]).toHaveTextContent('charges');
  });
});
