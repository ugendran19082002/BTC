import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { LogTable, type LogRow } from '@/components/strategy/LogTable';

/**
 * A log of what the desk did.
 *
 * Both logs on the strategy screen were fifteen bordered blocks each, carrying
 * a name, a time, an outcome and a sentence. Thirty of those is a page you
 * scroll rather than read, when what a person is doing is scanning one column
 * for the day that went wrong.
 *
 * The sentence is the part worth reading, so the thing that must not happen is
 * it being dropped or truncated to fit — the tests below pin that it is in the
 * row whole.
 */

const row = (over: Partial<LogRow> = {}): LogRow => ({
  id: 1,
  at: '2026-09-13 05:31',
  who: 'Double one-sided',
  outcome: 'traded',
  tone: 'ok',
  detail: 'Sold CE 79,600 × 5 at 18.00 and PE 74,000 × 5 at 13.70.',
  ...over,
});

describe('the run log', () => {
  it('puts every field of a row on the row', () => {
    render(<LogTable rows={[row()]} label="recent runs" />);
    const tr = screen.getByText('Double one-sided').closest('tr')!;
    expect(within(tr).getByText('2026-09-13 05:31')).toBeInTheDocument();
    expect(within(tr).getByText('traded')).toBeInTheDocument();
  });

  it('[critical] carries the sentence whole — it is the part worth reading', () => {
    const detail = 'Stood aside: daily RSI is 74, outside the 30–70 band this does best in.';
    render(<LogTable rows={[row({ detail, outcome: 'stood aside', tone: 'quiet' })]} label="recent runs" />);
    expect(screen.getByText(detail)).toBeInTheDocument();
  });

  it('colours the outcome without making it the only thing that says it', () => {
    render(<LogTable rows={[row({ outcome: 'failed', tone: 'bad' })]} label="recent runs" />);
    const cell = screen.getByText('failed');
    expect(cell).toHaveClass('text-[var(--down)]');
    expect(cell).toHaveTextContent('failed');
  });

  it('draws nothing at all rather than an empty table', () => {
    const { container } = render(<LogTable rows={[]} label="recent runs" />);
    expect(container).toBeEmptyDOMElement();
  });

  it('leaves out the middle column when no row has one', () => {
    render(<LogTable rows={[row()]} label="recent runs" />);
    expect(screen.getAllByRole('columnheader')).toHaveLength(4);
  });

  it('adds the middle column, headed, when the rows carry one', () => {
    render(
      <LogTable
        label="adds"
        extraHead="From"
        rows={[row({ extra: 'CE × 5' })]}
      />,
    );
    expect(screen.getByRole('columnheader', { name: 'From' })).toBeInTheDocument();
    expect(screen.getByText('CE × 5')).toBeInTheDocument();
  });

  it('dashes a row that has no middle value while its neighbours do', () => {
    render(
      <LogTable
        label="adds"
        extraHead="From"
        rows={[row({ id: 1, extra: 'CE × 5' }), row({ id: 2, who: 'Sunday' })]}
      />,
    );
    const second = screen.getByText('Sunday').closest('tr')!;
    expect(within(second).getByText('—')).toBeInTheDocument();
  });

  it('keeps the rows in the order it was given them', () => {
    render(
      <LogTable
        label="recent runs"
        rows={[row({ id: 1, who: 'First' }), row({ id: 2, who: 'Second' })]}
      />,
    );
    const names = screen.getAllByRole('row').slice(1)
      .map((tr) => within(tr).getByText(/First|Second/).textContent);
    expect(names).toEqual(['First', 'Second']);
  });

  it('names itself for a screen reader', () => {
    render(<LogTable rows={[row()]} label="adds" />);
    expect(screen.getByRole('table', { name: 'adds' })).toBeInTheDocument();
  });
});
