import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { DayPicker, describeDay } from '@/components/ui/day-picker';

/**
 * One IST day on a calendar (the P&L's minute-by-minute line, 2 Oct 2026):
 * only the days with a line can be picked, and the arrows step through them.
 * The clock is pinned -- 10:00 IST, Fri 2 Oct 2026 -- with only Date faked.
 */
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(Date.UTC(2026, 9, 2, 4, 30)); });
afterEach(() => vi.useRealTimers());

const LINES = ['2026-09-28', '2026-09-30', '2026-10-01'];

describe('what the button says', () => {
  it('names today and yesterday, and gives the weekday', () => {
    expect(describeDay('2026-10-02')).toBe('Today · Fri 2 Oct');
    expect(describeDay('2026-10-01')).toBe('Yesterday · Thu 1 Oct');
    expect(describeDay('2026-09-28')).toBe('Mon 28 Sept');
    expect(describeDay('2025-12-31')).toBe('Wed 31 Dec 2025');
  });
});

describe('the day picker', () => {
  it('[critical] the arrows step to the previous and next day that has a line -- skipping the empty ones', () => {
    const onChange = vi.fn();
    const { rerender } = render(<DayPicker value="2026-10-01" available={LINES} onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: /previous day with a line/ }));
    expect(onChange).toHaveBeenLastCalledWith('2026-09-30');
    rerender(<DayPicker value="2026-09-30" available={LINES} onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: /previous day with a line/ }));
    expect(onChange).toHaveBeenLastCalledWith('2026-09-28'); // the 29th has no line
    fireEvent.click(screen.getByRole('button', { name: /next day with a line/ }));
    expect(onChange).toHaveBeenLastCalledWith('2026-10-01');
  });

  it('at either end the arrow is off; today is always there', () => {
    const { rerender } = render(<DayPicker value="2026-09-28" available={LINES} onChange={() => {}} />);
    expect(screen.getByRole('button', { name: 'no earlier day' })).toBeDisabled();
    rerender(<DayPicker value="2026-10-02" available={LINES} onChange={() => {}} />);
    expect(screen.getByRole('button', { name: 'no later day' })).toBeDisabled();
    expect(screen.getByRole('button', { name: /previous day with a line: Yesterday/ })).toBeEnabled();
  });

  it('[critical] on the calendar, only the days with a line can be picked -- and none in the future', () => {
    const onChange = vi.fn();
    render(<DayPicker value="2026-10-01" available={LINES} onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: /which day: Yesterday/ }));
    const day = (n: number) => screen.getAllByRole('gridcell').find((c) => c.textContent === String(n) && !c.className.includes('outside'))!;
    expect(day(29)).toBeDisabled();   // no line on the 29th
    expect(day(3)).toBeDisabled();    // tomorrow
    fireEvent.click(day(30));
    expect(onChange).toHaveBeenCalledWith('2026-09-30');
  });

  it('the presets: today, always; yesterday when it has a line', () => {
    const onChange = vi.fn();
    render(<DayPicker value="2026-09-30" available={['2026-09-30']} onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: /which day/ }));
    expect(screen.getByRole('button', { name: 'yesterday' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'today' }));
    expect(onChange).toHaveBeenCalledWith('2026-10-02');
  });
});
