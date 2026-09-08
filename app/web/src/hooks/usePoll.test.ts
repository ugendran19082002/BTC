import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { usePoll } from '@/hooks/usePoll';
import { usePersisted } from '@/hooks/usePersisted';

beforeEach(() => { vi.useFakeTimers({ shouldAdvanceTime: true }); });
afterEach(() => { vi.useRealTimers(); });

describe('usePoll', () => {
  it('fetches straight away rather than waiting out the first interval', async () => {
    const fetcher = vi.fn().mockResolvedValue('first');
    const { result } = renderHook(() => usePoll(fetcher, 1000));
    await waitFor(() => expect(result.current.data).toBe('first'));
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('keeps going on the interval', async () => {
    const fetcher = vi.fn().mockResolvedValue('x');
    renderHook(() => usePoll(fetcher, 1000));
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    await act(async () => { await vi.advanceTimersByTimeAsync(2100); });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('does not stack a second call on a slow one', async () => {
    let release: (v: string) => void = () => {};
    const fetcher = vi.fn(() => new Promise<string>((r) => { release = r; }));
    renderHook(() => usePoll(fetcher, 100));
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));

    // five intervals go by while the first request is still out
    await act(async () => { await vi.advanceTimersByTimeAsync(520); });
    expect(fetcher).toHaveBeenCalledTimes(1);

    await act(async () => { release('done'); });
    await act(async () => { await vi.advanceTimersByTimeAsync(110); });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('keeps the last good answer when a poll fails', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce('good')
      .mockRejectedValue(new Error('network'));
    const { result } = renderHook(() => usePoll(fetcher, 100));
    await waitFor(() => expect(result.current.data).toBe('good'));

    await act(async () => { await vi.advanceTimersByTimeAsync(110); });
    await waitFor(() => expect(result.current.error?.message).toBe('network'));
    // a trading screen that blanks for a second is worse than a stale one
    expect(result.current.data).toBe('good');
  });

  it('clears the error once a poll succeeds again', async () => {
    const fetcher = vi.fn()
      .mockRejectedValueOnce(new Error('down'))
      .mockResolvedValue('back');
    const { result } = renderHook(() => usePoll(fetcher, 100));
    await waitFor(() => expect(result.current.error).toBeTruthy());
    await act(async () => { await vi.advanceTimersByTimeAsync(110); });
    await waitFor(() => expect(result.current.error).toBeNull());
    expect(result.current.data).toBe('back');
  });

  it('does nothing at all while disabled', async () => {
    const fetcher = vi.fn().mockResolvedValue('x');
    renderHook(() => usePoll(fetcher, 100, { enabled: false }));
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('stops polling when it goes away', async () => {
    const fetcher = vi.fn().mockResolvedValue('x');
    const { unmount } = renderHook(() => usePoll(fetcher, 100));
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    unmount();
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('stamps when the data last arrived', async () => {
    const { result } = renderHook(() => usePoll(() => Promise.resolve(1), 1000));
    await waitFor(() => expect(result.current.updatedAt).toBeTypeOf('number'));
  });
});

describe('usePersisted', () => {
  beforeEach(() => localStorage.clear());

  it('starts from the initial value and remembers the next one', () => {
    const { result, unmount } = renderHook(() => usePersisted('lots', 1));
    expect(result.current[0]).toBe(1);
    act(() => result.current[1](7));
    expect(result.current[0]).toBe(7);
    unmount();

    const again = renderHook(() => usePersisted('lots', 1));
    expect(again.result.current[0]).toBe(7);
  });

  it('falls back to the initial value when what is stored is not readable', () => {
    localStorage.setItem('btc-desk:lots', '{not json');
    const { result } = renderHook(() => usePersisted('lots', 3));
    expect(result.current[0]).toBe(3);
  });

  it('accepts an updater, so two changes in a row do not lose one', () => {
    const { result } = renderHook(() => usePersisted('n', 0));
    act(() => {
      result.current[1]((n) => n + 1);
      result.current[1]((n) => n + 1);
    });
    expect(result.current[0]).toBe(2);
  });
});
