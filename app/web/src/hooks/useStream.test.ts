import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { QUIET_MS, useStream, type EventSourceLike } from '@/hooks/useStream';

/**
 * The pushed desk, from the page's side.
 *
 * What matters is when `live` is true, because the polls stand down on it.
 * A stream that claims to be live while nothing arrives would leave the
 * screen frozen with no poll to save it; so live is earned by frames and
 * lost by silence.
 */

function fakeSource() {
  const listeners = new Map<string, ((ev: { data?: string }) => void)[]>();
  const es: EventSourceLike & { emit(type: string, data?: unknown): void; closed: boolean } = {
    closed: false,
    addEventListener: (type, cb) => { listeners.set(type, [...(listeners.get(type) ?? []), cb]); },
    close: () => { es.closed = true; },
    emit: (type, data) => {
      for (const cb of listeners.get(type) ?? []) cb(data === undefined ? {} : { data: JSON.stringify(data) });
    },
  };
  return es;
}

beforeEach(() => { vi.useFakeTimers({ shouldAdvanceTime: true }); });
afterEach(() => { vi.useRealTimers(); });

describe('useStream', () => {
  it('[critical] is not live until a frame has arrived', () => {
    const es = fakeSource();
    const factory = () => es;
    const { result } = renderHook(() => useStream(true, factory));
    expect(result.current.live).toBe(false);
    act(() => es.emit('open'));
    expect(result.current.live).toBe(true);
  });

  it('[critical] turns frames into the status, the price and the board, each with its time', () => {
    const es = fakeSource();
    const factory = () => es;
    const { result } = renderHook(() => useStream(true, factory));
    act(() => es.emit('status', { mode: 'paper', open: [] }));
    act(() => es.emit('spot', { spot: 77_010.5 }));
    act(() => es.emit('board', { at: 123, source: 'socket' }));
    expect(result.current.status).toEqual({ mode: 'paper', open: [] });
    expect(result.current.statusAt).not.toBeNull();
    expect(result.current.spot).toBe(77_010.5);
    expect(result.current.board).toEqual({ at: 123, source: 'socket' });
    expect(result.current.live).toBe(true);
  });

  it('[critical] an error from the browser means not live, so the polls take over', () => {
    const es = fakeSource();
    const factory = () => es;
    const { result } = renderHook(() => useStream(true, factory));
    act(() => es.emit('open'));
    expect(result.current.live).toBe(true);
    act(() => es.emit('error'));
    expect(result.current.live).toBe(false);
    // the last facts are kept: a reconnect is not a blank screen
    act(() => es.emit('spot', { spot: 1 }));
    expect(result.current.live).toBe(true);
  });

  it('[critical] silence is not live either, and a ping is enough to keep it', async () => {
    const es = fakeSource();
    const factory = () => es;
    const { result } = renderHook(() => useStream(true, factory));
    act(() => es.emit('open'));
    await act(async () => { await vi.advanceTimersByTimeAsync(QUIET_MS / 2); });
    act(() => es.emit('ping', { at: 1 }));
    await act(async () => { await vi.advanceTimersByTimeAsync(QUIET_MS / 2 + 1_000); });
    expect(result.current.live).toBe(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(QUIET_MS + 3_000); });
    expect(result.current.live).toBe(false);
  });

  it('opens nothing while disabled, and closes the connection when disabled', () => {
    const sources: ReturnType<typeof fakeSource>[] = [];
    const factory = () => { const es = fakeSource(); sources.push(es); return es; };
    const { rerender } = renderHook(({ on }) => useStream(on, factory), { initialProps: { on: false } });
    expect(sources.length).toBe(0);
    rerender({ on: true });
    expect(sources.length).toBe(1);
    rerender({ on: false });
    expect(sources[0].closed).toBe(true);
  });

  it('a frame that is not JSON is ignored rather than crashing the page', () => {
    const es = fakeSource();
    const factory = () => es;
    const { result } = renderHook(() => useStream(true, factory));
    act(() => es.emit('status', undefined));
    expect(result.current.status).toBeNull();
  });
});
