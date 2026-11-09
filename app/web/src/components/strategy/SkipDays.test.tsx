import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';

/**
 * The days every pick skips, beside Pick now (owner, 9 Nov 2026: "skip Nov 4 and so on, many dates chosen, saved on the
 * DB side; the pick runs skipping them"; then "use the date picker component"): the desk's own calendar, many days.
 */
const getSkipDays = vi.fn();
const saveSkipDays = vi.fn();
vi.mock('@/api/strategy', () => ({ getSkipDays: (...a: unknown[]) => getSkipDays(...a), saveSkipDays: (...a: unknown[]) => saveSkipDays(...a) }));
const { SkipDays } = await import('@/components/strategy/SkipDays');

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-09T12:00:00+05:30'));
  getSkipDays.mockReset().mockResolvedValue({ days: ['2026-11-04', '2026-10-13'] });
  saveSkipDays.mockReset().mockImplementation(async (days: string[]) => ({ days: [...days].sort().reverse() }));
});
afterEach(() => { vi.useRealTimers(); });

/** A day of the month shown, not one spilling in from the next or last. */
const day = (n: number) => screen.getAllByRole('gridcell').find((c) => c.textContent === String(n) && !c.className.includes('outside'))!;
const open = async () => {
  fireEvent.click(await screen.findByRole('button', { name: /Choose days/ }));
  return within(await screen.findByRole('dialog'));
};

describe('SkipDays', () => {
  it('[critical] the saved days as chips, and marked on the calendar; many days clicked are saved together', async () => {
    render(<SkipDays />);
    const box = within(screen.getByRole('group', { name: 'Days every pick skips' }));
    expect(await box.findByText('4 Nov')).toBeInTheDocument();
    expect(box.getByText('13 Oct')).toBeInTheDocument();
    const cal = await open();
    expect(day(4)).toHaveAttribute('aria-selected', 'true');
    expect(cal.getByText('2 days skipped')).toBeInTheDocument();
    fireEvent.click(day(2));
    fireEvent.click(day(6));
    fireEvent.click(day(4)); // counted again
    expect(cal.getByText('3 days skipped')).toBeInTheDocument();
    expect(saveSkipDays).not.toHaveBeenCalled();
    fireEvent.click(cal.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(saveSkipDays).toHaveBeenCalledTimes(1));
    expect([...saveSkipDays.mock.calls[0]![0]].sort()).toEqual(['2026-10-13', '2026-11-02', '2026-11-06']);
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(box.getByText('6 Nov')).toBeInTheDocument();
    expect(box.queryByText('4 Nov')).not.toBeInTheDocument();
  });

  it('a day to come cannot be chosen; Save waits for a change; Clear empties the draft', async () => {
    render(<SkipDays />);
    await screen.findByText('4 Nov');
    const cal = await open();
    expect(day(10)).toBeDisabled();
    expect(cal.getByRole('button', { name: 'Save' })).toBeDisabled();
    fireEvent.click(cal.getByRole('button', { name: 'Clear' }));
    expect(cal.getByText('No day skipped')).toBeInTheDocument();
    fireEvent.click(cal.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(saveSkipDays).toHaveBeenCalledWith([]));
    expect(await screen.findByText('none, every day counts')).toBeInTheDocument();
  });

  it('[critical] the × on a chip takes one day out at once; a refusal is said in words and the list stays', async () => {
    render(<SkipDays />);
    fireEvent.click(await screen.findByRole('button', { name: 'Stop skipping 13 Oct' }));
    await waitFor(() => expect(saveSkipDays).toHaveBeenCalledWith(['2026-11-04']));
    await waitFor(() => expect(screen.queryByText('13 Oct')).not.toBeInTheDocument());
    saveSkipDays.mockRejectedValueOnce(new Error('At most 60 days can be skipped.'));
    fireEvent.click(screen.getByRole('button', { name: 'Stop skipping 4 Nov' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('At most 60 days can be skipped.');
    expect(screen.getByText('4 Nov')).toBeInTheDocument();
  });
});
