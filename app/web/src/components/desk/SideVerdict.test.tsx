import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { SideVerdict } from '@/components/desk/SideVerdict';
import type { Containment, DirectionVerdict } from '@/types/desk';

/**
 * The card that says whether there is a side today.
 *
 * The thing it must never do is look decisive when it is not. Most mornings the
 * honest answer is "no side", and a card that names a direction every day has
 * not measured anything — so the tests that matter are the ones about a mixed
 * board and about a gate nobody could read.
 */

const verdict = (over: Partial<DirectionVerdict> = {}): DirectionVerdict => ({
  score: 0.12,
  side: null,
  inputs: [
    { key: 'return24h', label: '24-hour return', value: 0.13, why: '+0.25% against the 2% mark' },
    { key: 'daily', label: 'Daily trend', value: 1, why: 'EMA stack rising' },
    { key: 'oneHour', label: '1-hour trend', value: -1, why: 'EMA stack falling' },
    { key: 'vwap', label: 'Against VWAP', value: null, why: 'no VWAP to read' },
  ],
  gates: [
    { key: 'direction', label: 'Market direction', pass: false, why: 'score +0.12 against the 0.45 bar' },
    { key: 'timeframes', label: 'Timeframes agree', pass: false, why: '2 of 4 — 1D up, 4H up, 1H down, 15m down' },
    { key: 'expectedMove', label: 'Strikes clear the expected move', pass: true, why: 'nearest short is 1.88× the expected move away, against 1.00×' },
    { key: 'structure', label: 'Option structure', pass: null, why: 'no pair of strikes to judge' },
    { key: 'execution', label: 'Execution and hedge', pass: true, why: 'worst spread 2.0% against 7%' },
  ],
  passed: 2,
  readable: 4,
  confirmed: false,
  summary: 'No side: the tape has not said (+0.12)',
  ...over,
});

const corridor: Containment = {
  low: 73_600, high: 81_600, probability: 0.962, lowBuffer: 2.91, highBuffer: 7.65,
};

describe('today’s side', () => {
  it('[critical] a mixed board says no side, and says so plainly', () => {
    render(<SideVerdict direction={verdict()} containment={null} />);
    expect(screen.getByText('No side')).toBeInTheDocument();
    expect(screen.getByText(/the tape has not said/)).toBeInTheDocument();
    expect(screen.getByLabelText('direction score')).toHaveTextContent('+0.12');
    expect(screen.getByText('2/5 gates')).toBeInTheDocument();
  });

  it('[critical] a confirmed side is marked as confirmed, not merely named', () => {
    render(
      <SideVerdict
        direction={verdict({ score: 0.72, side: 'bullish', confirmed: true, passed: 5, summary: 'Bullish side confirmed — 5 of 5 gates' })}
        containment={null}
      />,
    );
    const badge = screen.getByText('Bullish').closest('span')!;
    expect(badge.className).toContain('up');
    expect(within(badge).getByText('confirmed')).toBeInTheDocument();
  });

  it('a bearish side is coloured as a fall', () => {
    render(<SideVerdict direction={verdict({ score: -0.6, side: 'bearish' })} containment={null} />);
    expect(screen.getByText('Bearish').closest('span')!.className).toContain('down');
  });

  it('[critical] every input is shown with its own reading, so the score can be argued with', () => {
    render(<SideVerdict direction={verdict()} containment={null} />);
    const list = within(screen.getByLabelText('what the score is made of'));
    expect(list.getByText('Daily trend')).toBeInTheDocument();
    expect(list.getByText('EMA stack falling')).toBeInTheDocument();
    expect(list.getByText('+0.13')).toBeInTheDocument();
    expect(list.getByText('−1.00').textContent).toBe('−1.00');
  });

  it('[critical] an input with nothing to read shows a dash, not a zero', () => {
    render(<SideVerdict direction={verdict()} containment={null} />);
    const list = within(screen.getByLabelText('what the score is made of'));
    expect(list.getByText('no VWAP to read')).toBeInTheDocument();
    expect(list.getAllByText('—').length).toBeGreaterThan(0);
  });

  it('[critical] a gate with nothing to read says so, and is not shown as passed', () => {
    render(<SideVerdict direction={verdict()} containment={null} />);
    const gates = within(screen.getByLabelText('gates'));
    const unread = gates.getByText('Option structure').closest('li')!;
    expect(unread.className).not.toContain('ok');
    expect(unread.className).not.toContain('no');
    expect(within(unread).getByText(/nothing to read, so not a pass/)).toBeInTheDocument();
    expect(gates.getByText('Market direction').closest('li')!.className).toContain('no');
    expect(gates.getByText('Execution and hedge').closest('li')!.className).toContain('ok');
  });

  it('[critical] the corridor is the number a two-sided seller is betting on', () => {
    render(<SideVerdict direction={verdict()} containment={corridor} />);
    const band = within(screen.getByLabelText('containment'));
    expect(band.getByText('96.2%')).toBeInTheDocument();
    expect(band.getByText(/chance BTC settles between/)).toHaveTextContent('73,600');
    expect(band.getByText(/chance BTC settles between/)).toHaveTextContent('81,600');
    expect(band.getByText(/2\.91× and 7\.65× the expected move away/)).toBeInTheDocument();
  });

  it('says nothing about a corridor when there is no pair of strikes', () => {
    render(<SideVerdict direction={verdict()} containment={null} />);
    expect(screen.queryByLabelText('containment')).toBeNull();
  });

  it('a corridor with no volatility to price it shows a dash rather than a number', () => {
    render(<SideVerdict direction={verdict()} containment={{ ...corridor, probability: null }} />);
    expect(within(screen.getByLabelText('containment')).getByText('—')).toBeInTheDocument();
  });

  it('[critical] says it decides nothing, and which inputs it does not have', () => {
    // The card sits above the recommendation; without this line it reads as the
    // thing that chose the lots, and it is not.
    render(<SideVerdict direction={verdict()} containment={null} />);
    expect(screen.getByText(/70\/30 skew is the rule with\s+733 days behind it/)).toBeInTheDocument();
    expect(screen.getByText(/Cumulative delta and funding are not in this score/)).toBeInTheDocument();
  });
});
