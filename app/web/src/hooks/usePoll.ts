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
 *
 * When `deps` change (a filter, a page), it asks at once even with a call in
 * flight, and an answer to the old question is dropped: the screen never shows
 * the last tab's rows under the new tab, nor waits a whole interval for them.
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
  // Each run of the effect -- a deps change, a hide, an unmount -- is a new generation;
  // only the current one's answer is kept, and only a call of the same one is not stacked.
  const gen = useRef(0);
  const inFlight = useRef<number | null>(null);
  const fn = useRef(fetcher);
  fn.current = fetcher;

  const refresh = useCallback(async () => {
    const mine = gen.current;
    if (inFlight.current === mine) return;
    inFlight.current = mine;
    setLoading(true);
    try {
      const next = await fn.current();
      if (gen.current !== mine) return; // the answer to an old question
      setData(next);
      setUpdatedAt(Date.now());
      setError(null);
    } catch (e) {
      if (gen.current === mine) setError(e as Error);
    } finally {
      if (inFlight.current === mine) {
        inFlight.current = null;
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    gen.current += 1;
    if (!enabled || !visible) return () => { gen.current += 1; };
    void refresh();
    const id = setInterval(() => { void refresh(); }, intervalMs);
    return () => {
      gen.current += 1;
      clearInterval(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, visible, intervalMs, refresh, ...(opts.deps ?? [])]);

  return { data, error, loading, updatedAt, refresh };
}
