import { useEffect, useState } from 'react';

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
