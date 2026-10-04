import { underlyingHit, type TradeRecord } from './engine.js';

/**
 * The fast watch on a signal trade's stop and target.
 *
 * A signal's SL and TGT are levels on the BTC perpetual. The engine judges them
 * inside its poll, and the service polls the open trades one after another,
 * each poll three round trips to the exchange -- so the check on one trade
 * waited behind the polls of all the others. This looks at nothing but the
 * perp's last trade, which is already in memory off the tape, against every
 * open trade's levels, ten times a second; a trade through its level is
 * handed to the engine at once.
 *
 * What it deliberately is not:
 *
 *   - **Not a second judge.** It asks the engine's own question
 *     (`underlyingHit`) and then calls the engine's own exit, which checks
 *     again under the trade's queue. A hit seen here and gone a moment later
 *     closes nothing.
 *   - **Not a replacement for the poll.** The loop still judges the same
 *     levels on every pass: if this stops, the desk is as it was before.
 *   - **Not a reader of the exchange, nor -- while the loop is quick -- of the
 *     database.** The loop hands over the open trades it has just read; the
 *     watch reads them itself only when that list has gone stale.
 *
 * Trades on one contract are closed one after another, as the loop closed
 * them; trades on different contracts at the same time.
 */

export type WatchedTrade = {
  tradeId: string;
  symbol: string;
  underlying: { dir: 1 | -1; stop: number | null; target: number | null };
};

/** How often the perp's last trade is held against the levels: as often as the screen is sent it. */
export const UNDERLYING_WATCH_MS = 100;
/** How old the list of open trades may get before the watch reads it itself. */
export const WATCH_LIST_MAX_AGE_MS = 2_000;
/** A perp price older than this is not acted on (the engine's own rule). */
export const WATCH_PRICE_STALE_MS = 15_000;
/** How long before a trade already handed to the engine is handed over again. */
export const WATCH_RETRY_MS = 5_000;

/** The open trades the watch has anything to do for: a position, and a perp level to hold it against. */
export function watchedOf(records: readonly TradeRecord[]): WatchedTrade[] {
  const out: WatchedTrade[] = [];
  for (const r of records) {
    const u = r.plan.underlying;
    if (!u || (u.stop === null && u.target === null)) continue;
    if (r.state.position === 0 || r.state.phase === 'exit_pending' || r.state.phase === 'entry_unknown') continue;
    out.push({ tradeId: r.state.tradeId, symbol: r.plan.symbol, underlying: { dir: u.dir, stop: u.stop, target: u.target } });
  }
  return out;
}

export type UnderlyingWatchDeps = {
  /** The open trades, from the journal. Asked only when the list has gone stale. */
  open: () => Promise<WatchedTrade[]>;
  /** The perp's last trade and when it printed, or null. */
  price: () => { price: number; at: number } | null;
  /** The engine's exit on the underlying for one trade. */
  exit: (tradeId: string) => Promise<unknown>;
  now?: () => number;
};

export class UnderlyingWatch {
  private list: WatchedTrade[] = [];
  private listAt = 0;
  private reading: Promise<void> | null = null;
  /** When each trade was last handed to the engine. */
  private readonly fired = new Map<string, number>();
  /** One chain of closes per contract. */
  private readonly bySymbol = new Map<string, Promise<void>>();
  private readonly now: () => number;

  constructor(private readonly d: UnderlyingWatchDeps) {
    this.now = d.now ?? Date.now;
  }

  /** The loop's own read of the open trades, handed over so the watch need not read. */
  note(trades: WatchedTrade[]): void {
    this.list = trades;
    this.listAt = this.now();
    for (const id of this.fired.keys()) {
      if (!trades.some((t) => t.tradeId === id)) this.fired.delete(id);
    }
  }

  /**
   * One look. Never throws and never waits: it is called from a timer several
   * times a second. Returns the trades handed to the engine on this look.
   */
  tick(): string[] {
    const now = this.now();
    if (now - this.listAt > WATCH_LIST_MAX_AGE_MS) void this.refresh();
    let px: { price: number; at: number } | null = null;
    try { px = this.d.price(); } catch { return []; }
    if (!px || !(px.price > 0) || now - px.at > WATCH_PRICE_STALE_MS) return [];
    const handed: string[] = [];
    for (const t of this.list) {
      if (underlyingHit(t.underlying, px.price) === null) continue;
      const last = this.fired.get(t.tradeId);
      if (last !== undefined && now - last < WATCH_RETRY_MS) continue;
      this.fired.set(t.tradeId, now);
      handed.push(t.tradeId);
      this.hand(t);
    }
    return handed;
  }

  private hand(t: WatchedTrade): void {
    const before = this.bySymbol.get(t.symbol) ?? Promise.resolve();
    const next = before
      .then(() => this.d.exit(t.tradeId))
      // A close that failed is the engine's to write down, and the loop's to try again.
      .then(() => {}, () => {})
      // Whatever happened, the list is out of date now.
      .then(() => { this.listAt = 0; });
    this.bySymbol.set(t.symbol, next);
  }

  private refresh(): Promise<void> {
    this.reading ??= this.d.open()
      .then((trades) => this.note(trades), () => {})
      .finally(() => { this.reading = null; });
    return this.reading;
  }

  /** The open trades have changed -- a fill, a close: read them again on the next look. */
  stale(): void { this.listAt = 0; }

  /** Everything handed over has been tried, and any read has finished. For shutdown and for tests. */
  async settle(): Promise<void> {
    await Promise.all([...this.bySymbol.values()]);
    if (this.reading) await this.reading;
  }
}
