import { useEffect, useRef, useState } from 'react';

/**
 * Spot, ticking.
 *
 * A number that changes every five seconds without saying so looks like a
 * number that is stuck. This colours each change for a moment -- green up, red
 * down -- and shows how far it has come since the page was opened, which is the
 * question you are actually asking when you glance at it.
 */
export function LivePrice({ spot, live }: { spot: number; live: boolean }) {
  const [dir, setDir] = useState<'up' | 'down' | null>(null);
  const prev = useRef(spot);
  const opened = useRef(spot);

  useEffect(() => {
    if (spot === prev.current) return;
    setDir(spot > prev.current ? 'up' : 'down');
    prev.current = spot;
    // long enough to notice, short enough that the next tick is not fighting it
    const t = setTimeout(() => setDir(null), 900);
    return () => clearTimeout(t);
  }, [spot]);

  const since = spot - opened.current;

  return (
    <span className={`liveprice${dir ? ' flash-' + dir : ''}`}>
      <i className={live ? 'dot on' : 'dot'} aria-hidden />
      <b>{spot.toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 })}</b>
      {Math.abs(since) >= 1 && (
        <span className={since >= 0 ? 'up' : 'down'}>
          {since >= 0 ? '+' : '−'}${Math.abs(since).toFixed(0)}
        </span>
      )}
    </span>
  );
}
