import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { EntryCountdown, countdownText } from '@/components/strategy/EntryCountdown';

/** 22 Sep 2026, 22:35 IST: UG-CE's entry on the list. */
const ENTRY = Date.UTC(2026, 8, 22, 17, 5);

afterEach(() => vi.useRealTimers());

describe('countdownText', () => {
  it('says the time left the way a timer does', () => {
    expect(countdownText(45_000)).toBe('45s');
    expect(countdownText(12 * 60_000 + 34_000)).toBe('12m 34s');
    expect(countdownText(2 * 3_600_000 + 5 * 60_000 + 9_000)).toBe('2h 05m 09s');
    expect(countdownText(27 * 3_600_000)).toBe('1d 3h');
    expect(countdownText(-5_000)).toBe('0s');
  });
});

describe('the entry countdown', () => {
  it('[critical] counts down to the entry, in IST, every second', () => {
    vi.useFakeTimers();
    vi.setSystemTime(ENTRY - (12 * 60_000 + 34_000));
    render(<EntryCountdown nextEntryAt={ENTRY} schedulerOn />);
    expect(screen.getByRole('timer')).toHaveTextContent('Entry in 12m 34s · 10:35 PM IST');
    act(() => { vi.advanceTimersByTime(1_000); });
    expect(screen.getByRole('timer')).toHaveTextContent('Entry in 12m 33s');
  });

  it('[critical] at the entry time it says it is entering', () => {
    render(<EntryCountdown nextEntryAt={ENTRY} schedulerOn now={ENTRY + 2_000} />);
    expect(screen.getByRole('timer')).toHaveTextContent('Entering now…');
  });

  it('[critical] with auto-trading off it says it will not enter, rather than counting down to nothing', () => {
    render(<EntryCountdown nextEntryAt={ENTRY} schedulerOn={false} now={ENTRY - 60_000} />);
    expect(screen.getByRole('status')).toHaveTextContent('Auto-trading is off -- it will not enter at 10:35 PM IST.');
    expect(screen.queryByRole('timer')).toBeNull();
  });

  it('no next entry, no timer', () => {
    const { container } = render(<EntryCountdown nextEntryAt={null} schedulerOn />);
    expect(container).toBeEmptyDOMElement();
  });
});
