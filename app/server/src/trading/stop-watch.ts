import { STOP_RUN_SHARE, backstopOf, type TradeRecord } from './engine.js';

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

export type StopWatched = {
  tradeId: string; symbol: string; stop: number;
  /** The offer at which the stop is a run (`stopIfReached`: half way to the backstop) -- closed at the first look. */
  run?: number | null;
};

/** How often the board in memory is held against the stops: as often as it is refreshed. */
export const STOP_WATCH_MS = 1_000;
/** How often the engine is asked again about a trade whose offer is still at its stop. */
export const STOP_WATCH_RECHECK_MS = 3_000;
/** A board in memory older than this decides nothing: the loop alone carries on. */
export const STOP_WATCH_BOARD_STALE_MS = 10_000;
/**
 * Above this share of Delta's five-minute quota the watch reads quotes only for a stop in a run (19 Oct 2026); at
 * `STOP_WATCH_QUOTA_HARD_PCT`, none -- the loop alone carries on.
 *
 * Until 19 Oct it read none above 75%. A busy market is when the quota fills and when stops run: at 3:52 PM the
 * P-82400's offer was 75.9 against eight stops at 42-48, and nothing closed them until Delta's own backstops at 70-80
 * filled sixteen seconds later at 58-76 -- while the watch said nothing about why. A run's look is one ticker read
 * (3 of Delta's 20,000 units a five minutes) every few seconds per contract, and it closes at once.
 *
 * And from 21 Oct 2026 the soft line is 90%, not 75%. At 2:19:49 PM the quota passed 75% and the watch stepped back
 * from every stop at its level; eleven seconds later the C-BTC-83600's offer went from 64 to 192, through some fifty
 * stops at 77-105, and Delta's backstops closed them at 144-188. A stop's look is the cheapest call the desk makes --
 * the quota is better saved anywhere else.
 */
export const STOP_WATCH_QUOTA_PCT = 90;
export const STOP_WATCH_QUOTA_HARD_PCT = 95;

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
    const backstop = backstopOf(r);
    const run = backstop !== null && backstop > stop ? stop + (backstop - stop) * STOP_RUN_SHARE : null;
    out.push({ tradeId: r.state.tradeId, symbol: r.plan.symbol, stop, run });
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
  /**
   * The watch stepping aside while a stop may need it (19 Oct 2026): its board too old, or Delta's quota past
   * `STOP_WATCH_QUOTA_PCT` with a trade at its stop not looked at. Once an episode, for the error log.
   */
  onStandDown?: (why: { kind: 'board' | 'quota'; watched: number; atStop: number; usedPct: number | null; boardAgeMs: number | null }) => void;
  now?: () => number;
};

export class OptionStopWatch {
  private list: StopWatched[] = [];
  /** When each trade at its stop was last handed to the engine. */
  private readonly handed = new Map<string, number>();
  /** Contracts with a check still running: not asked again until it has answered. */
  private readonly busy = new Map<string, Promise<void>>();
  /** The stand-down being had, said once (`onStandDown`); null while the watch is working. */
  private down: 'board' | 'quota' | null = null;
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
    if (!board || now - board.at > STOP_WATCH_BOARD_STALE_MS) {
      this.standDown({ kind: 'board', watched: this.list.length, atStop: 0, usedPct: null, boardAgeMs: board ? now - board.at : null });
      return [];
    }
    let used = 0;
    try { used = this.d.quotaUsedPct(); } catch { used = 0; }
    const asks = board.asks;
    if (used >= STOP_WATCH_QUOTA_HARD_PCT) {
      const n = this.list.filter((t) => (asks.get(t.symbol) ?? 0) >= t.stop).length;
      if (n > 0) this.standDown({ kind: 'quota', watched: this.list.length, atStop: n, usedPct: used, boardAgeMs: now - board.at });
      return [];
    }
    // Past the soft line: only a stop in a run is looked at, and closed at once; the rest wait for the loop.
    const onlyRuns = used >= STOP_WATCH_QUOTA_PCT;
    let passedOver = 0;

    const due = new Map<string, string[]>();
    for (const t of this.list) {
      const ask = board.asks.get(t.symbol);
      const last = this.handed.get(t.tradeId);
      if (ask !== undefined && ask > 0 && ask >= t.stop) {
        if (onlyRuns && !(t.run != null && ask >= t.run)) { passedOver++; continue; }
        if (last !== undefined && now - last < STOP_WATCH_RECHECK_MS) continue;
      } else if (last === undefined || onlyRuns) {
        continue;                                   // under its stop, and the engine was never asked: nothing to do
      }
      // At its stop and due a look -- or back under it after being handed over, and due the one look that clears the count.
      const ids = due.get(t.symbol);
      if (ids) ids.push(t.tradeId); else due.set(t.symbol, [t.tradeId]);
    }

    if (passedOver > 0) this.standDown({ kind: 'quota', watched: this.list.length, atStop: passedOver, usedPct: used, boardAgeMs: now - board.at });
    else this.down = null;
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

  private standDown(why: Parameters<NonNullable<StopWatchDeps['onStandDown']>>[0]): void {
    if (this.down === why.kind) return;
    this.down = why.kind;
    try { this.d.onStandDown?.(why); } catch { /* said or not, the watch goes on */ }
  }

  /** Every check handed over has answered. For shutdown and for tests. */
  async settle(): Promise<void> {
    await Promise.all([...this.busy.values()]);
  }
}
