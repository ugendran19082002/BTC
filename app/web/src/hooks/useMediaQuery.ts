import { useEffect, useState } from 'react';

/**
 * Whether a CSS media query matches, following it as the window changes.
 *
 * False wherever there is no `matchMedia` (a test, a server render), so the
 * wide-screen layout is what renders when nobody can say.
 */
export function useMediaQuery(query: string): boolean {
  const read = () => typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    && window.matchMedia(query).matches;
  const [matches, setMatches] = useState(read);
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia(query);
    const on = () => setMatches(mq.matches);
    on();
    mq.addEventListener?.('change', on);
    return () => mq.removeEventListener?.('change', on);
  }, [query]);
  return matches;
}
