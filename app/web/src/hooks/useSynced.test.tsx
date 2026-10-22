import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { WRITE_AFTER_MS, forgetSynced, useSynced } from '@/hooks/useSynced';

/**
 * A choice the desk keeps for every screen (22 Oct 2026, owner: "keep it on the database side"; "collapse and expand
 * the same"): the newer of the browser's and the desk's wins, a change is kept a moment later, nothing set is lost.
 */
const fetchMock = vi.fn();
let kept: Record<string, { value: unknown; updatedAt: number }> = {};
const puts = () => fetchMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === 'PUT').map(([, init]) => JSON.parse(String((init as RequestInit).body)));
beforeEach(() => {
  kept = {};
  localStorage.clear();
  forgetSynced();
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (_url: string, init?: RequestInit) => {
    if (!init?.method) return new Response(JSON.stringify({ settings: kept }), { status: 200 });
    if (init.method === 'PUT') { const b = JSON.parse(String(init.body)); return new Response(JSON.stringify({ ok: true, key: b.key, value: b.value, updatedAt: b.at }), { status: 200 }); }
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  });
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('useSynced', () => {
  it('[critical] the desk\'s newer choice wins over this browser\'s, and is kept here too', async () => {
    localStorage.setItem('btc-desk:k', JSON.stringify('old'));
    localStorage.setItem('btc-desk:at:k', '1000');
    kept = { k: { value: 'set on the phone', updatedAt: 2000 } };
    const { result } = renderHook(() => useSynced('k', 'default'));
    expect(result.current[0]).toBe('old');                         // at once, from the browser's copy
    await waitFor(() => expect(result.current[0]).toBe('set on the phone'));
    expect(JSON.parse(localStorage.getItem('btc-desk:k')!)).toBe('set on the phone');
    expect(puts()).toEqual([]);
  });

  it('[critical] a choice this browser had before the desk kept any is handed to it -- nothing set is lost', async () => {
    localStorage.setItem('btc-desk:params', JSON.stringify({ deskMax: 111 }));
    const { result } = renderHook(() => useSynced('params', { deskMax: 0 }));
    await waitFor(() => expect(puts().length).toBe(1), { timeout: WRITE_AFTER_MS + 1_000 });
    expect(puts()[0]).toMatchObject({ key: 'params', value: { deskMax: 111 } });
    expect(result.current[0]).toEqual({ deskMax: 111 });
  });

  it('[critical] a change is kept by the desk a moment later -- one write for a burst -- and survives another screen', async () => {
    const { result } = renderHook(() => useSynced<string[]>('shut', []));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    act(() => result.current[1](['Filters']));
    act(() => result.current[1]((prev) => [...prev, 'Exits']));
    expect(result.current[0]).toEqual(['Filters', 'Exits']);
    await waitFor(() => expect(puts().length).toBe(1), { timeout: WRITE_AFTER_MS + 1_000 });
    expect(puts()[0]).toMatchObject({ key: 'shut', value: ['Filters', 'Exits'] });
    expect(typeof puts()[0].at).toBe('number');
  });

  it('a change made before the desk answered is not undone by its older copy', async () => {
    kept = { m: { value: 'single', updatedAt: Date.now() - 60_000 } };
    let answer!: (r: Response) => void;
    fetchMock.mockImplementationOnce(() => new Promise<Response>((r) => { answer = r; }));
    const { result } = renderHook(() => useSynced('m', 'single'));
    act(() => result.current[1]('portfolio'));
    answer(new Response(JSON.stringify({ settings: kept }), { status: 200 }));
    await new Promise((r) => setTimeout(r, 50));
    expect(result.current[0]).toBe('portfolio');
  });

  it('the desk not answering: the browser\'s copy carries on, nothing thrown', async () => {
    fetchMock.mockImplementation(async () => { throw new Error('offline'); });
    localStorage.setItem('btc-desk:x', JSON.stringify(5));
    const { result } = renderHook(() => useSynced('x', 1));
    expect(result.current[0]).toBe(5);
    act(() => result.current[1](6));
    expect(result.current[0]).toBe(6);
  });

  it('reset: back to the default here and at the desk', async () => {
    localStorage.setItem('btc-desk:r', JSON.stringify('mine'));
    const { result } = renderHook(() => useSynced('r', 'default'));
    act(() => result.current[2]());
    expect(result.current[0]).toBe('default');
    expect(localStorage.getItem('btc-desk:r')).toBeNull();
    await waitFor(() => expect(fetchMock.mock.calls.some(([u, i]) => String(u) === '/api/ui-settings/r' && (i as RequestInit).method === 'DELETE')).toBe(true));
  });
});
