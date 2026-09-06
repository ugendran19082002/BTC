import { useCallback, useEffect, useState } from 'react';

const PREFIX = 'btc-desk:';

/**
 * State that survives a reload, kept in localStorage.
 *
 * Every access is wrapped: a private window, cleared site data or a browser set
 * to block storage all make these throw or return nothing, and none of that
 * should stop the page rendering. The stored value is a convenience, never
 * something the desk depends on.
 */
export function usePersisted<T>(key: string, initial: T) {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(PREFIX + key);
      return raw === null ? initial : (JSON.parse(raw) as T);
    } catch {
      return initial;
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem(PREFIX + key, JSON.stringify(value));
    } catch {
      /* storage unavailable or full; the session still works */
    }
  }, [key, value]);

  const reset = useCallback(() => {
    try {
      localStorage.removeItem(PREFIX + key);
    } catch {
      /* nothing to do */
    }
    setValue(initial);
  }, [key, initial]);

  return [value, setValue, reset] as const;
}
