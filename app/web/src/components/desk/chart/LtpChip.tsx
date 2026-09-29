import { useEffect, useRef, useState } from 'react';

/**
 * The last traded price, where a trader looks for it: beside the chart's
 * controls, green when it ticked up and red when it ticked down (kept until
 * the next change, like the price scale's own label), with the time left in
 * the candle. A trade over a minute old says how old it is instead of
 * pretending to be live.
 */
const STALE_MS = 60_000;

export function LtpChip({ price, at, tfSec }: { price: number; at: number; tfSec: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(id);
  }, []);
  const prev = useRef(price);
  const dir = useRef<'up' | 'down' | ''>('');
  if (price !== prev.current) {
    dir.current = price > prev.current ? 'up' : 'down';
    prev.current = price;
  }
  const age = now - at;
  const left = tfSec - (Math.floor(now / 1000) % tfSec);
  const mmss = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
  const stale = age > STALE_MS;
  return (
    <div className={`pc-ltp ${stale ? 'stale' : dir.current}`} role="status" aria-label="Last traded price"
      title={stale ? 'No trade on the perpetual for a while: the price shown is the last one.' : 'The perpetual\'s last trade, pushed as it prints.'}>
      <span className="pc-ltp-k">LTP</span>
      <b>{price.toLocaleString('en-US', { maximumFractionDigits: 1 })}</b>
      <span className="pc-ltp-t">{stale ? `${Math.round(age / 60_000)}m ago` : mmss}</span>
    </div>
  );
}
