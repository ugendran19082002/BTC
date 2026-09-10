import { useCallback, useEffect, useRef, useState } from 'react';
import { usePageVisible } from '@/hooks/usePageVisible';

/**
 * Call something on a timer and keep the last good answer.
 *
 * Three things it does that a bare `setInterval` does not: a slow response never
 * stacks a second call on top of the first; a failed poll leaves the last good
 * data on screen with an error beside it rather than blanking the page; and it
 * stops while the page is hidden. A phone in a pocket polling once a second
 * spends battery and server time on a screen nobody sees, and every request the
 * phone kills on the way to sleep used to land in the error log as a failure.
 * It asks again the moment the page is back.
 */
export function usePoll<T>(
  fetcher: () => Promise<T>,
  intervalMs: number,
  opts: { enabled?: boolean; deps?: unknown[] } = {},
) {
  const { enabled = true } = opts;
  const visible = usePageVisible();
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(false);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const inFlight = useRef(false);
  const alive = useRef(true);
  const fn = useRef(fetcher);
  fn.current = fetcher;

  const refresh = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setLoading(true);
    try {
      const next = await fn.current();
      if (!alive.current) return;
      setData(next);
      setUpdatedAt(Date.now());
      setError(null);
    } catch (e) {
      if (alive.current) setError(e as Error);
    } finally {
      inFlight.current = false;
      if (alive.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    if (!enabled || !visible) return;
    void refresh();
    const id = setInterval(() => { void refresh(); }, intervalMs);
    return () => {
      alive.current = false;
      clearInterval(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, visible, intervalMs, refresh, ...(opts.deps ?? [])]);

  return { data, error, loading, updatedAt, refresh };
}
