import type { TradeRecord } from './engine.js';

/**
 * The trades that cannot wait for the loop: an entry order still working, and
 * a position that has no target resting yet.
 *
 * The loop polls every open trade in turn, about once a second and slower as
 * the book grows. For a protected trade that is plenty -- its target rests at
 * Delta and its SL and TGT are watched off the tape. For these two it is the
 * whole delay: a fill is only known when the trade is next polled, and the
 * target only goes on after that (and Delta, asked a moment after a fill,
 * sometimes does not show the position yet, which costs another turn). These
 * are polled on their own, several times a second.
 *
 * It asks nothing new of the engine: `poll` is the loop's own poll, queued per
 * trade, so a trade is never polled twice at once. And it is held back by
 * Delta's quota -- at most a couple of trades a look, and none at all while
 * the desk has used half of its five-minute allowance.
 */

/** How often the urgent trades are looked at. */
export const ENTRY_WATCH_MS = 250;
/** The most trades polled on one look: each poll is up to three lookups at Delta. */
export const ENTRY_WATCH_PER_LOOK = 2;
/** Above this share of Delta's quota, the urgent polls stop and the loop alone carries on. */
export const ENTRY_WATCH_QUOTA_PCT = 50;

/** A working entry, or a position without its target on the book. */
export const isUrgent = (r: Pick<TradeRecord, 'state'>): boolean =>
  r.state.phase === 'entry_pending' || r.state.phase === 'position_open' || r.state.phase === 'unprotected';

export type EntryWatchDeps = {
  /** The engine's poll for one trade: its state afterwards, or null. */
  poll: (tradeId: string) => Promise<{ phase: string } | null>;
  /** How much of Delta's five-minute quota the desk has used, in percent. */
  quotaUsedPct: () => number;
  /** Told when a trade stops being urgent -- filled and protected, or gone -- so whoever watches its exits can read again. */
  onSettled?: (tradeId: string) => void;
};

export class EntryWatch {
  private ids: string[] = [];
  private readonly busy = new Set<string>();
  private next = 0;

  constructor(private readonly d: EntryWatchDeps) {}

  /** The loop's own read of the open trades: which of them are urgent now. */
  note(records: readonly Pick<TradeRecord, 'state'>[]): void {
    this.ids = records.filter(isUrgent).map((r) => r.state.tradeId);
  }

  /** A trade just placed: urgent from this moment, without waiting for the loop to read it. */
  add(tradeId: string): void {
    if (!this.ids.includes(tradeId)) this.ids.push(tradeId);
  }

  /** How many trades are being watched. */
  get size(): number { return this.ids.length; }

  /** One look. Never throws; returns the trades polled on it. */
  tick(): string[] {
    if (!this.ids.length) return [];
    let used = 0;
    try { used = this.d.quotaUsedPct(); } catch { used = 0; }
    if (used >= ENTRY_WATCH_QUOTA_PCT) return [];
    const polled: string[] = [];
    // In turn, so one slow trade cannot keep the others from being looked at.
    for (let i = 0; i < this.ids.length && polled.length < ENTRY_WATCH_PER_LOOK; i++) {
      const id = this.ids[(this.next + i) % this.ids.length]!;
      if (this.busy.has(id)) continue;
      polled.push(id);
      this.busy.add(id);
      void this.d.poll(id)
        .then((state) => {
          if (state && (state.phase === 'entry_pending' || state.phase === 'position_open' || state.phase === 'unprotected')) return;
          this.ids = this.ids.filter((x) => x !== id);
          try { this.d.onSettled?.(id); } catch { /* a listener is not the watch's problem */ }
        }, () => {})
        .finally(() => { this.busy.delete(id); });
    }
    this.next = this.ids.length ? (this.next + polled.length) % this.ids.length : 0;
    return polled;
  }
}
