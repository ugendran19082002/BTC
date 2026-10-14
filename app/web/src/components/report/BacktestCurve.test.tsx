import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { BacktestCurve, curveOf } from '@/components/report/BacktestCurve';
import { rulesThenWords } from '@/components/report/LiveCheck';

const day = (d: string, net: number, n = 3) => ({ day: d, net, n });

describe('the backtest\'s running total (14 Oct 2026)', () => {
  it('[critical] adds the days up, and finds the deepest fall from a high to a later low', () => {
    const r = curveOf([day('2026-10-01', -5), day('2026-10-02', 10), day('2026-10-03', -20), day('2026-10-04', 3)]);
    expect(r.cum).toEqual([-5, 5, -15, -12]);
    expect(r.drop).toEqual({ usd: 20, from: '2026-10-02', to: '2026-10-03' });
  });

  it('a total that never stood above nothing falls from the start; one that only rises does not fall', () => {
    expect(curveOf([day('2026-10-01', -5), day('2026-10-02', -2)]).drop).toEqual({ usd: 7, from: null, to: '2026-10-02' });
    expect(curveOf([day('2026-10-01', 5), day('2026-10-02', 2)]).drop).toBeNull();
  });

  it('[critical] a day under the finger is read out: its own money, its trades, and the total so far', () => {
    render(<BacktestCurve days={[day('2026-10-01', 0.5, 2), day('2026-10-02', -0.25, 1_234), day('2026-10-03', 0.1)]} />);
    const svg = screen.getByRole('img', { name: /Running total over 3 expiry days/ });
    svg.getBoundingClientRect = () => ({ left: 0, width: 640, top: 0, height: 180, right: 640, bottom: 180, x: 0, y: 0, toJSON: () => ({}) });
    fireEvent.pointerMove(svg, { clientX: 351 });
    const tip = screen.getByRole('status');
    expect(tip).toHaveTextContent('Fri 2 Oct');
    expect(tip).toHaveTextContent('1,234 trades');
    expect(tip).toHaveTextContent(/Running total \+₹\d/);
    fireEvent.pointerLeave(svg);
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.getByText(/worst fall from a high/)).toBeInTheDocument();
  });

  it('one day is not a curve', () => {
    const { container } = render(<BacktestCurve days={[day('2026-10-01', 1)]} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe('the live check says when the desk traded other settings (14 Oct 2026 audit)', () => {
  it('[critical] the lots and the option stop then, beside the strategy\'s now', () => {
    expect(rulesThenWords({ lots: [12, 16], stopPct: [3], orders: 30, now: { lots: 2, stopPct: 1.6 } }))
      .toBe('The desk\'s 30 orders were sold with 12 or 16 lots and an option stop of +300%; this backtest uses the strategy as it is now: 2 lots, option stop +160%. Its money is by today\'s settings, not what the desk made.');
    expect(rulesThenWords({ lots: [1, 3, 12], stopPct: [0, 1.6, 3], orders: 1, now: { lots: 1, stopPct: 0 } }))
      .toBe('The desk\'s 1 order was sold with 1 to 12 lots and an option stop of none, +160% or +300%; this backtest uses the strategy as it is now: 1 lot, option stop none. Its money is by today\'s settings, not what the desk made.');
  });
});
