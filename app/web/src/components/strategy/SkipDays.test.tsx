import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';

/**
 * The days every pick skips, beside Pick now (owner, 9 Nov 2026: "skip Nov 4 and so on, many dates chosen, saved on the
 * DB side; the pick runs skipping them").
 */
const getSkipDays = vi.fn();
const saveSkipDays = vi.fn();
vi.mock('@/api/strategy', () => ({ getSkipDays: (...a: unknown[]) => getSkipDays(...a), saveSkipDays: (...a: unknown[]) => saveSkipDays(...a) }));
const { SkipDays } = await import('@/components/strategy/SkipDays');

beforeEach(() => {
  getSkipDays.mockReset().mockResolvedValue({ days: ['2026-11-04', '2026-10-13'] });
  saveSkipDays.mockReset().mockImplementation(async (days: string[]) => ({ days: [...days].sort().reverse() }));
});

describe('SkipDays', () => {
  it('[critical] shows the saved days; a day added is saved at once with the others', async () => {
    render(<SkipDays />);
    const box = within(screen.getByRole('group', { name: 'Days every pick skips' }));
    expect(await box.findByText('4 Nov')).toBeInTheDocument();
    expect(box.getByText('13 Oct')).toBeInTheDocument();
    fireEvent.click(box.getByRole('button', { name: /Add day/ }));
    fireEvent.change(box.getByLabelText('Day to skip'), { target: { value: '2026-11-09' } });
    await waitFor(() => expect(saveSkipDays).toHaveBeenCalledWith(['2026-11-04', '2026-10-13', '2026-11-09']));
    expect(await box.findByText('9 Nov')).toBeInTheDocument();
  });

  it('[critical] a day taken out is saved at once; with none left it says every day counts', async () => {
    getSkipDays.mockResolvedValue({ days: ['2026-11-04'] });
    render(<SkipDays />);
    fireEvent.click(await screen.findByRole('button', { name: 'Stop skipping 4 Nov' }));
    await waitFor(() => expect(saveSkipDays).toHaveBeenCalledWith([]));
    expect(await screen.findByText('none, every day counts')).toBeInTheDocument();
  });

  it('a day already in the list is not added twice; a refusal is said in words and the list stays', async () => {
    render(<SkipDays />);
    await screen.findByText('4 Nov');
    fireEvent.click(screen.getByRole('button', { name: /Add day/ }));
    fireEvent.change(screen.getByLabelText('Day to skip'), { target: { value: '2026-11-04' } });
    expect(saveSkipDays).not.toHaveBeenCalled();
    saveSkipDays.mockRejectedValueOnce(new Error('A day still to come has no record to skip.'));
    fireEvent.click(screen.getByRole('button', { name: /Add day/ }));
    fireEvent.change(screen.getByLabelText('Day to skip'), { target: { value: '2026-11-08' } });
    expect(await screen.findByRole('alert')).toHaveTextContent('A day still to come has no record to skip.');
    expect(screen.getByText('4 Nov')).toBeInTheDocument();
  });
});
