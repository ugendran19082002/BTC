/**
 * When Delta's own reading was taken, not when it reached the desk (22 Oct 2026).
 *
 * Delta's public REST answers are cached by its CDN for up to five seconds (`cache-control: public,max-age=5`;
 * CloudFront answered "Hit" to requests carrying an api-key and a signature alike), and a ticker is a second or more
 * behind on top of that: on 22 Oct a stop's quote, read through `/v2/tickers/{symbol}`, was 2.4 to 6 s old while the
 * desk stamped it with the moment it arrived and called it fresh. Every ticker carries `timestamp`, microseconds, the
 * board's snapshot time (one value for all 540 BTC options at once, so not a last-trade time that would age on a quiet
 * strike). That is the reading's time; and a query no request has made before is never answered from the cache.
 */

/** The reading's own time, in epoch ms: Delta's `timestamp` (µs), never later than it arrived; when absent, when it arrived. */
export function venueAt(timestampUs: unknown, receivedAt: number): number {
  const us = Number(timestampUs);
  if (timestampUs === null || timestampUs === undefined || !Number.isFinite(us) || us <= 0) return receivedAt;
  const ms = Math.floor(us / 1_000);
  // Stamped after it reached us: the two clocks disagree, and the desk's is the one every gate is measured on.
  return ms > receivedAt ? receivedAt : ms;
}

/** A query part no request has used before, so Delta's CDN asks Delta itself. */
export const uncached = (now = Date.now()): string => `_=${now}`;
