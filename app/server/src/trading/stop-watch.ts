import type { TradeRecord } from './engine.js';

/**
 * The fast watch on a sold option's own stop (13 Oct 2026).
 *
 * The stop the trader set is judged by the desk on the offer: reached when the
 * offer has been at or above it for fifteen seconds running (engine.ts
 * `stopIfReached`). The engine looked at it inside its poll, and the service
 * polls the open trades one after another -- so with fifty open, a trade was
 * looked at once every half minute or more, and "fifteen seconds" was however
 * long two of its turns were apart. On 13 Oct an 83,200 call's stop at 164 was
 * closed after 46 seconds; over that session sixteen such stops took a median
 * 35 seconds and 83 at worst, and filled about 5% past the stop.
 *
 * This looks at the board the desk already holds in memory -- every option's
 * offer, off the ticker socket, refreshed each second -- against every open
 * short's stop, once a second. A trade whose offer is at its stop is handed to
 * the engine's own check at once, and again every few seconds while it stays
 * there, so the fifteen seconds are counted from the first look and acted on
 * at the first look after them.
 *
 * What it deliberately is not (the same as `underlying-watch.ts`):
 *
 *   - **Not a second judge.** The board in memory only decides who is looked
 *     at. The engine reads the exchange's own quote and counts its own fifteen
 *     seconds; an offer that is back under the stop when the engine looks
 *     closes nothing.
 *   - **Not a replacement for the poll.** The loop still judges the same stop
 *     on every pass: if this stops, or the board in memory goes stale, the
 *     desk is as it was before.
 *   - **Not a reader of the exchange for trades with nothing to do.** One
 *     quote is read per contract at its stop, however many trades hold it.
 *
 * A trade that was at its stop and is not any more is handed over once more,
 * so the engine sees the offer back under and forgets its count: the fifteen
 * seconds must run unbroken.
 */

export type StopWatched = { tradeId: string; symbol: string; stop: number };

/** How often the board in memory is held against the stops: as often as it is refreshed. */
export const STOP_WATCH_MS = 1_000;
/** How often the engine is asked again about a trade whose offer is still at its stop. */
export const STOP_WATCH_RECHECK_MS = 3_000;
/** A board in memory older than this decides nothing: the loop alone carries on. */
export const STOP_WATCH_BOARD_STALE_MS = 10_000;
/** Above this share of Delta's five-minute quota the watch reads no quotes; the loop alone carries on. */
export const STOP_WATCH_QUOTA_PCT = 75;

/**
 * The open trades the watch has anything to do for: a short holding contracts, with a stop of its own that is
 * judged on the offer (one watched on the candle's close is the poll's alone), and not already closing.
 */
export function stopWatchedOf(records: readonly TradeRecord[]): StopWatched[] {
  const out: StopWatched[] = [];
  for (const r of records) {
    const stop = r.plan.stopPrice;
    if (stop === null || stop === undefined || !(stop > 0) || r.plan.monitorOn === 'close') continue;
    if (!(r.state.position < 0) || r.state.phase === 'exit_pending' || r.state.phase === 'entry_unknown') continue;
    out.push({ tradeId: r.state.tradeId, symbol: r.plan.symbol, stop });
  }
  return out;
}

export type StopWatchDeps = {
  /** The offers the desk holds in memory for these contracts, and when that board was last refreshed. Null with none. */
  asks: (symbols: readonly string[]) => { at: number; asks: ReadonlyMap<string, number> } | null;
  /**
   * The engine's own stop check for the trades of one contract: one quote read, each trade judged in its own queue.
   * It answers with the trades that are over -- closed, closing or gone -- which are watched no more.
   */
  check: (symbol: string, tradeIds: readonly string[]) => Promise<readonly string[]>;
  /** How much of Delta's five-minute quota the desk has used, in percent. */
  quotaUsedPct: () => number;
  now?: () => number;
};

export class OptionStopWatch {
  private list: StopWatched[] = [];
  /** When each trade at its stop was last handed to the engine. */
  private readonly handed = new Map<string, number>();
  /** Contracts with a check still running: not asked again until it has answered. */
  private readonly busy = new Map<string, Promise<void>>();
  private readonly now: () => number;

  constructor(private readonly d: StopWatchDeps) {
    this.now = d.now ?? Date.now;
  }

  /** The loop's own read of the open trades. A trade no longer in it is forgotten. */
  note(trades: StopWatched[]): void {
    this.list = trades;
    for (const id of this.handed.keys()) if (!trades.some((t) => t.tradeId === id)) this.handed.delete(id);
  }

  /** How many trades are being watched. */
  get size(): number { return this.list.length; }

  /**
   * One look. Never throws and never waits: it is called from a timer once a second. Returns the trades handed to
   * the engine on this look.
   */
  tick(): string[] {
    if (this.list.length === 0) return [];
    const now = this.now();
    let board: ReturnType<StopWatchDeps['asks']> = null;
    try { board = this.d.asks([...new Set(this.list.map((t) => t.symbol))]); } catch { return []; }
    if (!board || now - board.at > STOP_WATCH_BOARD_STALE_MS) return [];
    let used = 0;
    try { used = this.d.quotaUsedPct(); } catch { used = 0; }
    if (used >= STOP_WATCH_QUOTA_PCT) return [];

    const due = new Map<string, string[]>();
    for (const t of this.list) {
      const ask = board.asks.get(t.symbol);
      const last = this.handed.get(t.tradeId);
      if (ask !== undefined && ask > 0 && ask >= t.stop) {
        if (last !== undefined && now - last < STOP_WATCH_RECHECK_MS) continue;
      } else if (last === undefined) {
        continue;                                   // under its stop, and the engine was never asked: nothing to do
      }
      // At its stop and due a look -- or back under it after being handed over, and due the one look that clears the count.
      const ids = due.get(t.symbol);
      if (ids) ids.push(t.tradeId); else due.set(t.symbol, [t.tradeId]);
    }

    const out: string[] = [];
    for (const [symbol, ids] of due) {
      if (this.busy.has(symbol)) continue;
      for (const id of ids) {
        const t = this.list.find((x) => x.tradeId === id)!;
        const ask = board.asks.get(symbol);
        if (ask !== undefined && ask >= t.stop) this.handed.set(id, now); else this.handed.delete(id);
      }
      out.push(...ids);
      let work: Promise<readonly string[]>;
      try { work = this.d.check(symbol, ids); } catch { continue; }
      const done = work
        // Closed by this look, or already over: not asked about again while the loop's list still names it.
        .then((over) => { if (over.length) { this.list = this.list.filter((t) => !over.includes(t.tradeId)); for (const id of over) this.handed.delete(id); } },
          // A check that failed is the engine's to write down, and the loop's to try again.
          () => {})
        .finally(() => { this.busy.delete(symbol); });
      this.busy.set(symbol, done);
    }
    return out;
  }

  /** Every check handed over has answered. For shutdown and for tests. */
  async settle(): Promise<void> {
    await Promise.all([...this.busy.values()]);
  }
}
