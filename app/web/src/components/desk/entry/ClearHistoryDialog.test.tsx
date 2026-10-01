import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ClearHistoryDialog, fromIstInput, istInput, rangeOf } from './ClearHistoryDialog';
import type { ClearAnswer } from '@/api/entry';

const previewClear = vi.fn();
const clearHistory = vi.fn();
vi.mock('@/api/entry', async (real) => ({
  ...(await real<typeof import('@/api/entry')>()),
  previewClear: (...a: unknown[]) => previewClear(...a),
  clearHistory: (...a: unknown[]) => clearHistory(...a),
}));

const answer = (signals: number, over: Partial<ClearAnswer> = {}): ClearAnswer => ({
  range: { from: 0, to: 1 }, counts: { signals, trades: 3, waits: signals - 3, setups: 3, alerts: 1 }, recent: [], ...over,
});

beforeEach(() => { vi.clearAllMocks(); previewClear.mockResolvedValue(answer(12)); clearHistory.mockResolvedValue(answer(12)); });

describe('clear data', () => {
  it('[critical] the times are IST whatever the browser zone, to the minute, the To minute included', () => {
    const t = Date.UTC(2026, 9, 1, 4, 30); // 10:00 IST
    expect(istInput(t)).toBe('2026-10-01T10:00');
    expect(fromIstInput('2026-10-01T10:00')).toBe(t);
    expect(fromIstInput('nonsense')).toBeNull();
    expect(rangeOf('2026-10-01T10:00', '2026-10-01T10:30')).toEqual({ from: t, to: t + 31 * 60_000 });
    expect(rangeOf('2026-10-01T10:00', '2026-10-01T10:00')).toEqual({ from: t, to: t + 60_000 }, 'one minute');
    expect(rangeOf('2026-10-01T10:30', '2026-10-01T10:00')).toEqual({ error: 'From must be before To.' });
    expect(rangeOf('', '2026-10-01T10:00')).toEqual({ error: 'Pick both times.' });
  });

  it('[critical] counts first; clears only with the box ticked; says what went', async () => {
    const onCleared = vi.fn();
    render(<ClearHistoryDialog onCleared={onCleared} />);
    fireEvent.click(screen.getByRole('button', { name: 'clear data' }));
    expect(await screen.findByText('12 signals will be cleared')).toBeInTheDocument();
    expect(screen.getByText(/3 TRADEs · 9 WAITs · 3 paper trades · 1 alert$/)).toBeInTheDocument();
    const go = screen.getByRole('button', { name: 'Clear 12 signals' });
    expect(go).toBeDisabled();
    fireEvent.click(go);
    expect(clearHistory).not.toHaveBeenCalled();

    fireEvent.click(screen.getByLabelText('I understand this cannot be undone'));
    expect(go).toBeEnabled();
    fireEvent.click(go);
    await waitFor(() => expect(onCleared).toHaveBeenCalledWith(answer(12).counts));
    expect(clearHistory).toHaveBeenCalledWith(previewClear.mock.lastCall![0]);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('[critical] a new range unticks the box; an empty range cannot be cleared; a failed clear says why and stays open', async () => {
    render(<ClearHistoryDialog onCleared={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'clear data' }));
    await screen.findByText('12 signals will be cleared');
    const box = screen.getByLabelText('I understand this cannot be undone');
    fireEvent.click(box);
    expect(box).toBeChecked();
    previewClear.mockResolvedValue(answer(0));
    fireEvent.change(screen.getByLabelText('from'), { target: { value: '2026-10-01T09:00' } });
    expect(box).not.toBeChecked();
    expect(await screen.findByText('Nothing in this range.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Clear' })).toBeDisabled();

    previewClear.mockResolvedValue(answer(12));
    clearHistory.mockRejectedValue(new Error('From is in the future: nothing to clear.'));
    fireEvent.click(screen.getByRole('button', { name: 'Yesterday' }));
    await screen.findByText('12 signals will be cleared');
    fireEvent.click(screen.getByLabelText('I understand this cannot be undone'));
    fireEvent.click(screen.getByRole('button', { name: 'Clear 12 signals' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not clear: From is in the future');
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('a backwards range is said, and nothing is asked of the server', async () => {
    render(<ClearHistoryDialog onCleared={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'clear data' }));
    await screen.findByText('12 signals will be cleared');
    previewClear.mockClear();
    fireEvent.change(screen.getByLabelText('from'), { target: { value: '2099-01-01T00:00' } });
    expect(screen.getByText('From must be before To.')).toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 300));
    expect(previewClear).not.toHaveBeenCalled();
  });
});
