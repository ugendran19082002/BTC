import type { Candle } from '@/types/desk';

/**
 * The forming bar, carried to the last traded price.
 *
 * Delta's candle endpoint returns the bar that is still forming, but only as it
 * stood when the request was made -- so between polls the newest candle sits
 * still while the price moves, and on a 1-hour chart it can sit still for
 * minutes at a time. The last traded price arrives every second (the ticker
 * socket, or `/api/spot` behind it), so the bar can be finished off locally
 * instead of waiting.
 *
 * ## What this may and may not be used for
 *
 * **Display, marks and distances: yes.** How far a strike is, what the position
 * is worth, where price sits against a level -- all of those want the newest
 * price, and a screen showing a price from forty seconds ago while the ticker
 * says otherwise is simply wrong.
 *
 * **Signal calculation: no.** `domain/momentum-signal.ts` and
 * `domain/market-state.ts` deliberately read **closed bars only**, and the
 * measured records behind them were taken at bar closes. A bar still forming
 * can un-break: price crosses a level, the card says CONFIRMED, price falls
 * back before the close, and the call never existed -- except that the journal
 * now holds it and the hit rate is computed from it. Feeding a live tick into
 * those rules would produce signals the replay never graded, and the net-R
 * figure on screen would no longer describe the thing on screen.
 *
 * So this function exists on the **web** side, is applied to the chart's bars
 * only, and the server keeps deciding signals from closes. Anything provisional
 * must be labelled provisional.
 */

/** Bar length in seconds, per chart timeframe. */
export const TF_SECONDS: Record<string, number> = {
  '1m': 60,
  '3m': 180,
  '5m': 300,
  '15m': 900,
  '30m': 1_800,
  '1h': 3_600,
  '2h': 7_200,
  '4h': 14_400,
  '6h': 21_600,
  '12h': 43_200,
  '1d': 86_400,
};

/** True when `bar` is the one still forming at `nowMs` — its period contains now. */
export function isForming(bar: Candle, tfSeconds: number, nowMs: number): boolean {
  if (!(tfSeconds > 0)) return false;
  const nowSec = Math.floor(nowMs / 1000);
  return nowSec >= bar.time && nowSec < bar.time + tfSeconds;
}

/**
 * Return `bars` with the forming bar carried to `ltp`.
 *
 * The array is only copied when something actually changes, so a render with
 * no new tick keeps the same reference and the chart's effects do not re-run.
 *
 * Rules, in order:
 *
 *  - No `ltp`, no bars, or a non-finite price: the bars are returned untouched.
 *  - The newest bar has already closed: **a new bar is not invented.** The
 *    venue opens bars, not this function; guessing one would draw a candle that
 *    does not exist and would shift every index the chart's markers use.
 *  - Otherwise: `close` becomes the tick, and `high`/`low` stretch to include
 *    it. `open` and `volume` are never touched -- the open is history, and a
 *    volume this function cannot know must not be implied.
 */
export function withLtp(
  bars: readonly Candle[],
  ltp: number | null | undefined,
  tfSeconds: number,
  nowMs: number = Date.now(),
): readonly Candle[] {
  if (!bars.length || ltp == null || !Number.isFinite(ltp) || ltp <= 0) return bars;
  const last = bars[bars.length - 1]!;
  if (!isForming(last, tfSeconds, nowMs)) return bars;
  if (last.close === ltp && last.high >= ltp && last.low <= ltp) return bars;
  const updated: Candle = {
    ...last,
    close: ltp,
    high: Math.max(last.high, ltp),
    low: Math.min(last.low, ltp),
  };
  return [...bars.slice(0, -1), updated];
}

/**
 * Return `bars` with the candle in progress taken from the tape: `live` is
 * built by the server from the perpetual's own trades (the stream's `ltp`),
 * so unlike `withLtp` it is the chart's own instrument, every trade, with its
 * volume.
 *
 *  - Same candle as the newest bar: `high` / `low` widen to the tape's,
 *    `close` is the last trade, `volume` whichever saw more (the socket may
 *    have joined late). `open` stays the exchange's.
 *  - The next candle, not listed yet: added. It is not a guess -- every value
 *    in it traded -- and it does not move an index: the bars before it are
 *    untouched.
 *  - A live candle that is over, older than the newest bar, or further ahead
 *    than the next one changes nothing.
 */
export function withLiveBar(
  bars: readonly Candle[],
  live: Candle | null | undefined,
  tfSeconds: number,
  nowMs: number = Date.now(),
): readonly Candle[] {
  if (!live || !bars.length || !(tfSeconds > 0) || !isForming(live, tfSeconds, nowMs)) return bars;
  const last = bars[bars.length - 1]!;
  if (live.time === last.time) {
    const merged: Candle = {
      ...last,
      high: Math.max(last.high, live.high),
      low: Math.min(last.low, live.low),
      close: live.close,
      volume: Math.max(last.volume, live.volume),
    };
    const same = merged.high === last.high && merged.low === last.low && merged.close === last.close && merged.volume === last.volume;
    return same ? bars : [...bars.slice(0, -1), merged];
  }
  if (live.time === last.time + tfSeconds) return [...bars, { ...live }];
  return bars;
}

/**
 * How stale the newest bar is, in seconds — or null when it is still forming.
 *
 * A chart whose newest bar closed eleven minutes ago is not a live chart, and
 * the difference between "quiet" and "the feed stopped" is the one thing a
 * price screen must never blur. Used to label the chart rather than to change
 * the data.
 */
export function barAgeSec(
  bars: readonly Candle[],
  tfSeconds: number,
  nowMs: number = Date.now(),
): number | null {
  const last = bars[bars.length - 1];
  if (!last) return null;
  if (isForming(last, tfSeconds, nowMs)) return null;
  return Math.max(0, Math.floor(nowMs / 1000) - (last.time + tfSeconds));
}
