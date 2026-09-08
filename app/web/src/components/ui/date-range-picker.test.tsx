import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { DateRangePicker, describeRange, istToday } from '@/components/ui/date-range-picker';

/**
 * Dates are handled as `YYYY-MM-DD` strings the whole way through, because a
 * `Date` carries a time and a zone and both are ways for "the 8th" to quietly
 * become the 7th. These check that nothing on the path from a click to a query
 * string reintroduces one.
 */

const TODAY = '2026-09-08';

/**
 * The component reads the clock to work out what "today" means, so the clock is
 * pinned. Without this the suite passed until midnight IST and then started
 * failing on its own, which is a test that reports the time rather than the
 * code.
 */
beforeEach(() => vi.setSystemTime(Date.UTC(2026, 8, 8, 15, 30)));   // 21:00 IST
afterEach(() => vi.useRealTimers());

describe('istToday', () => {
  it('is the evening’s date in Chennai, not the UTC one', () => {
    // 21:00 IST on the 8th is 15:30 UTC on the 8th
    expect(istToday(Date.UTC(2026, 8, 8, 15, 30))).toBe('2026-09-08');
    // 01:00 IST on the 9th is 19:30 UTC on the 8th — still the 9th where the desk is
    expect(istToday(Date.UTC(2026, 8, 8, 19, 30))).toBe('2026-09-09');
  });
});

describe('what the button says', () => {
  it('names a preset rather than spelling out its dates', () => {
    expect(describeRange({ from: TODAY, to: TODAY }, TODAY)).toBe('today');
    expect(describeRange({ from: '2026-09-07', to: '2026-09-07' }, TODAY)).toBe('yesterday');
    expect(describeRange({ from: '2026-09-02', to: TODAY }, TODAY)).toBe('last 7 days');
  });

  it('shows one date for one day', () => {
    expect(describeRange({ from: '2026-09-03', to: '2026-09-03' }, TODAY)).toBe('3 Sept');
  });

  it('shows both for a span', () => {
    expect(describeRange({ from: '2026-09-01', to: '2026-09-05' }, TODAY)).toBe('1 Sept – 5 Sept');
  });

  it('adds the year only when it is not this one', () => {
    expect(describeRange({ from: '2025-12-30', to: '2025-12-31' }, TODAY)).toContain('2025');
    expect(describeRange({ from: '2026-09-01', to: '2026-09-02' }, TODAY)).not.toContain('2026');
  });
});

describe('choosing a range', () => {
  const show = (value = { from: TODAY, to: TODAY }, onChange = vi.fn()) => {
    render(<DateRangePicker value={value} onChange={onChange} />);
    return onChange;
  };

  it('opens on the button and offers the presets', () => {
    show();
    fireEvent.click(screen.getByRole('button', { name: /today/i }));
    const panel = screen.getByRole('dialog');
    for (const label of ['today', 'yesterday', 'last 7 days', 'last 30 days', 'this month']) {
      expect(within(panel).getByRole('button', { name: label })).toBeInTheDocument();
    }
  });

  it('hands back both ends when a preset is chosen', () => {
    const onChange = show();
    fireEvent.click(screen.getByRole('button', { name: /today/i }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'yesterday' }));
    expect(onChange).toHaveBeenCalledTimes(1);
    const [range] = onChange.mock.calls[0]!;
    expect(range.from).toBe(range.to);
    expect(range.from).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('closes once a range is settled', () => {
    show();
    fireEvent.click(screen.getByRole('button', { name: /today/i }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'this month' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('marks the preset that is already in force', () => {
    show({ from: '2026-09-02', to: istToday() });
    fireEvent.click(screen.getByRole('button', { name: /last 7 days/i }));
    // it opened, which means the label matched the preset rather than the dates
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });
});
