import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
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

/**
 * Five rows, and the rest a click away.
 *
 * The log answers "what did it do today" almost every time it is read, and
 * fifteen rows of it twice on one screen was a page you scrolled past to reach
 * anything else. What must not happen is a page control that loses rows, or
 * one that leaves you looking at nothing when the log gets shorter.
 */
describe('paging the log', () => {
  const many = (n: number): LogRow[] =>
    Array.from({ length: n }, (_, i) => row({ id: i, who: `Run ${i + 1}` }));

  it('shows five and says how many there are', () => {
    render(<LogTable rows={many(12)} label="recent runs" />);
    expect(screen.getAllByRole('row')).toHaveLength(6);      // header + five
    expect(screen.getByText('1–5 of 12')).toBeInTheDocument();
  });

  it('[critical] keeps the newest first — the order it was handed', () => {
    render(<LogTable rows={many(12)} label="recent runs" />);
    expect(screen.getByText('Run 1')).toBeInTheDocument();
    expect(screen.queryByText('Run 6')).not.toBeInTheDocument();
  });

  it('walks back through the older rows', () => {
    render(<LogTable rows={many(12)} label="recent runs" />);
    fireEvent.click(screen.getByRole('button', { name: 'older' }));
    expect(screen.getByText('6–10 of 12')).toBeInTheDocument();
    expect(screen.getByText('Run 6')).toBeInTheDocument();
  });

  it('stops at both ends rather than running off them', () => {
    render(<LogTable rows={many(12)} label="recent runs" />);
    expect(screen.getByRole('button', { name: 'newer' })).toBeDisabled();

    const older = screen.getByRole('button', { name: 'older' });
    fireEvent.click(older);
    fireEvent.click(older);
    expect(screen.getByText('11–12 of 12')).toBeInTheDocument();
    expect(older).toBeDisabled();
  });

  it('offers no page control at all when everything fits', () => {
    render(<LogTable rows={many(4)} label="recent runs" />);
    expect(screen.queryByRole('button', { name: 'older' })).not.toBeInTheDocument();
  });

  it('[critical] a shorter log does not leave you looking at nothing', () => {
    const { rerender } = render(<LogTable rows={many(12)} label="recent runs" />);
    fireEvent.click(screen.getByRole('button', { name: 'older' }));
    fireEvent.click(screen.getByRole('button', { name: 'older' }));
    expect(screen.getByText('11–12 of 12')).toBeInTheDocument();

    // the log shrinks — a strategy deleted, a filter changed
    rerender(<LogTable rows={many(6)} label="recent runs" />);
    expect(screen.getAllByRole('row').length).toBeGreaterThan(1);
    expect(screen.getByText('6–6 of 6')).toBeInTheDocument();
  });

  it('takes a different page size when asked', () => {
    render(<LogTable rows={many(12)} label="recent runs" pageSize={10} />);
    expect(screen.getByText('1–10 of 12')).toBeInTheDocument();
  });
});
