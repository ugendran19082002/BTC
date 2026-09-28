import { runSmc } from './engine';
import type { Bar, Dir, SetupState, SmcState } from './types';

/**
 * The multi-timeframe context, read with the same no-lookahead rule as the
 * engine: a higher-timeframe candle counts only once it has closed.
 *
 *   1H = regime · 30M = bias · 15M = structure · 5M = setup · 1M = trigger
 */

/** Only candles that have finished: a candle opened at t closes at t + tfSec. */
export function closedBars<T extends { time: number }>(bars: readonly T[], tfSec: number, nowSec: number): T[] {
  let n = bars.length;
  while (n > 0 && bars[n - 1]!.time + tfSec > nowSec) n--;
  return bars.slice(0, n);
}

/**
 * Candles of one timeframe folded into a longer one, bucketed by UTC time.
 * A bucket is kept only when every candle in it is there -- a half-built hour
 * is not an hour.
 */
export function aggregate(bars: readonly Bar[], fromSec: number, toSec: number): Bar[] {
  const per = toSec / fromSec;
  if (!Number.isInteger(per) || per < 1) throw new Error(`cannot fold ${fromSec}s candles into ${toSec}s`);
  const out: Bar[] = [];
  let cur: Bar | null = null;
  let count = 0;
  for (const b of bars) {
    const bucket = Math.floor(b.time / toSec) * toSec;
    if (!cur || cur.time !== bucket) {
      if (cur && count === per) out.push(cur);
      cur = { time: bucket, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume };
      count = 1;
    } else {
      cur.high = Math.max(cur.high, b.high);
      cur.low = Math.min(cur.low, b.low);
      cur.close = b.close;
      cur.volume += b.volume;
      count += 1;
    }
  }
  if (cur && count === per) out.push(cur);
  return out;
}

/**
 * The trend as it was known at any moment: the direction of the last
 * structure break whose candle had *closed* by then.
 */
export function trendTimeline(st: SmcState, bars: readonly Bar[], tfSec: number): (unixSec: number) => Dir | null {
  const changes = st.breaks.map((b) => ({ at: bars[b.known]!.time + tfSec, dir: b.dir }));
  return (unixSec) => {
    let lo = 0;
    let hi = changes.length - 1;
    let found: Dir | null = null;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (changes[mid]!.at <= unixSec) { found = changes[mid]!.dir; lo = mid + 1; } else hi = mid - 1;
    }
    return found;
  };
}

export type TfRole = 'Regime' | 'Bias' | 'Structure' | 'Setup' | 'Trigger';

export type TfRead = {
  tf: string;
  role: TfRole;
  trend: Dir | null;
  /** The last break on that timeframe, with how many of its candles ago. */
  last: { kind: 'BOS' | 'CHoCH'; dir: Dir; barsAgo: number } | null;
  /** The setup in progress there, if any. */
  setup: { dir: Dir; state: SetupState } | null;
};

export function readTf(tf: string, role: TfRole, bars: readonly Bar[], tfSec: number): TfRead {
  const st = runSmc(bars, { tfSec });
  const brk = st.breaks[st.breaks.length - 1];
  const live = [...st.setups].reverse().find((s) => s.closedAt === null) ?? null;
  return {
    tf, role, trend: st.trend,
    last: brk ? { kind: brk.kind, dir: brk.dir, barsAgo: bars.length - 1 - brk.at } : null,
    setup: live ? { dir: live.dir, state: live.state } : null,
  };
}
