import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Call something on a timer and keep the last good answer.
 *
 * Two things it does that a bare `setInterval` does not: a slow response never
 * stacks a second call on top of the first, and a failed poll leaves the last
 * good data on screen with an error beside it rather than blanking the page.
 * A trading screen that goes empty for a second is worse than one that says
 * "as of eight seconds ago".
 */
export function usePoll<T>(
  fetcher: () => Promise<T>,
  intervalMs: number,
  opts: { enabled?: boolean; deps?: unknown[] } = {},
) {
  const { enabled = true } = opts;
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
    if (!enabled) return;
    void refresh();
    const id = setInterval(() => { void refresh(); }, intervalMs);
    return () => {
      alive.current = false;
      clearInterval(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, intervalMs, refresh, ...(opts.deps ?? [])]);

  return { data, error, loading, updatedAt, refresh };
}
