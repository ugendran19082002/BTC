import { useEffect, useState } from 'react';

/**
 * False while the tab is hidden or the phone is locked, so polls stop -- a
 * pocketed phone stops spending battery and filling the error log.
 */

const isVisible = () => typeof document === 'undefined' || document.visibilityState !== 'hidden';

/** False while the tab is in the background or the phone is locked. */
export function usePageVisible(): boolean {
  const [visible, setVisible] = useState(isVisible);
  useEffect(() => {
    const update = () => setVisible(isVisible());
    document.addEventListener('visibilitychange', update);
    return () => document.removeEventListener('visibilitychange', update);
  }, []);
  return visible;
}
