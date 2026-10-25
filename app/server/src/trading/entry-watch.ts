import { QUOTA_LADDER } from '../observability/desk-metrics.js';
import type { TradeRecord } from './engine.js';

/**
 * The trades that cannot wait for the loop: an entry order still working,
 * a position that has no target resting yet, and a close of the desk's own
 * still working (25 Oct 2026).
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
export const ENTRY_WATCH_QUOTA_PCT = QUOTA_LADDER.others;
/** A close is a stop's own exit: polled on up to the stops' share of the quota, as the stop watch is (`QUOTA_LADDER`). */
export const CLOSE_WATCH_QUOTA_PCT = QUOTA_LADDER.stop;

type Urgency = { phase: string; position?: number; closing?: unknown };

/**
 * A close of the desk's own still working: sent, and the position not yet bought back. Its follow-up -- what is
 * left resting cancelled and sent again at the market once it has had `CLOSE_FOLLOW_UP_MS` -- runs in the poll, and
 * waiting for the loop it came 22 and 33 s late on 25 Oct 2026 at 14:43 (44 trades open): two P-80200 stops at 84,
 * judged on time at an offer of 89, bought back at 118 and 129.
 */
export const isClosing = (s: Urgency): boolean => s.phase === 'exit_pending' && s.position !== 0 && !!s.closing;
const urgentState = (s: Urgency): boolean =>
  s.phase === 'entry_pending' || s.phase === 'position_open' || s.phase === 'unprotected' || isClosing(s);

/** A working entry, a position without its target on the book, or a close still working. */
export const isUrgent = (r: Pick<TradeRecord, 'state'>): boolean => urgentState(r.state);

export type EntryWatchDeps = {
  /** The engine's poll for one trade: its state afterwards, or null. */
  poll: (tradeId: string) => Promise<Urgency | null>;
  /** How much of Delta's five-minute quota the desk has used, in percent. */
  quotaUsedPct: () => number;
  /** Told when a trade stops being urgent -- filled and protected, or gone -- so whoever watches its exits can read again. */
  onSettled?: (tradeId: string) => void;
};

export class EntryWatch {
  private ids: string[] = [];
  /** Of `ids`, the closes: looked at first, and on past the quota at which the others wait. */
  private closes = new Set<string>();
  private readonly busy = new Set<string>();
  private next = 0;

  constructor(private readonly d: EntryWatchDeps) {}

  /** The loop's own read of the open trades: which of them are urgent now. */
  note(records: readonly Pick<TradeRecord, 'state'>[]): void {
    this.ids = records.filter(isUrgent).map((r) => r.state.tradeId);
    this.closes = new Set(records.filter((r) => isClosing(r.state)).map((r) => r.state.tradeId));
  }

  /** A trade just placed, or a close just sent: urgent from this moment, without waiting for the loop to read it. */
  add(tradeId: string, closing = false): void {
    if (!this.ids.includes(tradeId)) this.ids.push(tradeId);
    if (closing) this.closes.add(tradeId);
  }

  /** How many trades are being watched. */
  get size(): number { return this.ids.length; }

  /** One look. Never throws; returns the trades polled on it. */
  tick(): string[] {
    if (!this.ids.length) return [];
    let used = 0;
    try { used = this.d.quotaUsedPct(); } catch { used = 0; }
    if (used >= CLOSE_WATCH_QUOTA_PCT) return [];
    const othersToo = used < ENTRY_WATCH_QUOTA_PCT;
    const polled: string[] = [];
    const look = (id: string) => {
      polled.push(id);
      this.busy.add(id);
      void this.d.poll(id)
        .then((state) => {
          if (state && urgentState(state)) { if (isClosing(state)) this.closes.add(id); else this.closes.delete(id); return; }
          this.ids = this.ids.filter((x) => x !== id);
          this.closes.delete(id);
          try { this.d.onSettled?.(id); } catch { /* a listener is not the watch's problem */ }
        }, () => {})
        .finally(() => { this.busy.delete(id); });
    };
    // In turn, so one slow trade cannot keep the others from being looked at -- and the closes first: a stop's
    // buy-back is money moving now.
    const turn = this.ids.map((_, i) => this.ids[(this.next + i) % this.ids.length]!);
    for (const id of turn) {
      if (polled.length >= ENTRY_WATCH_PER_LOOK) break;
      if (this.closes.has(id) && !this.busy.has(id)) look(id);
    }
    for (const id of othersToo ? turn : []) {
      if (polled.length >= ENTRY_WATCH_PER_LOOK) break;
      if (!this.closes.has(id) && !this.busy.has(id)) look(id);
    }
    this.next = this.ids.length ? (this.next + polled.length) % this.ids.length : 0;
    return polled;
  }
}
