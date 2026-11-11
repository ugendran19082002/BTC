import { QUOTA_LADDER } from '../observability/desk-metrics.js';
import { tradeIdOfClientId } from './engine.js';
import { isDone } from './machine.js';
import type { TradeState } from './types.js';

/**
 * A fill heard on Delta's private socket wakes its trade's poll at once (11 Nov 2026, `DELTA_PRIVATE_WS=wake`).
 *
 * The loop polls the open trades one after another, about three seconds each, so with 300 open a trade waited up to
 * fifteen minutes for its turn (10-11 Nov 2026 audit: from Delta filling an entry to its stop and target resting, a
 * median of 15-36 s, one in ten over 8 minutes, 278-375 a day over 5; a target's fill reached the journal a median
 * 3-14 minutes late, once 3 h 11 min, with its stop still resting all that while). The entry watch could not help:
 * it stands aside past half of Delta's quota, and the loop's own polls kept the quota at 62-68%.
 *
 * The socket hears each fill about a second after Delta makes it. Here that becomes one thing only: the trade's own
 * poll, now (`engine.poll` -- the loop's, in the trade's own queue, so it never runs twice at once). The poll reads
 * Delta over REST and does what it always does: puts the stop and target on behind a filled entry, cancels the stop
 * behind a filled target, follows up a close, re-places a stop Delta cancelled. Nothing the socket says is written to
 * a trade; REST is still the record. With the socket down, nothing is heard and the loop carries on as before.
 *
 * Delta sometimes answers a moment after a fill with the order not yet filled. So a fill whose order the poll did not
 * find on the trade is polled again, a little later each time (`FILL_WAKE_RETRY_MS`), and then left to the loop.
 *
 * Held back by the quota, as everything is (`QUOTA_LADDER`): the wakes step aside at the target's line, 85% -- after
 * the entry watch (50%), before the stops (90%, 95%), which are never kept waiting by them. A wake that could not run
 * for a minute is dropped: by then the loop or the entry watch may have done it, and either will.
 */

/** How often the wakes are looked at. */
export const FILL_WAKE_MS = 100;
/** The most polls started on one look: up to twenty a second, the entry burst at the open taking a minute, not fifteen. */
export const FILL_WAKE_PER_LOOK = 2;
/** The most woken polls running at once. */
export const FILL_WAKE_IN_FLIGHT = 6;
/** At and above this share of Delta's quota, the wakes wait (the target's line: below the stops, above the rest). */
export const FILL_WAKE_QUOTA_PCT = QUOTA_LADDER.target;
/** A fill the poll did not find yet is polled again after each of these, then left to the loop. */
export const FILL_WAKE_RETRY_MS = [500, 1_000, 2_000, 4_000, 8_000] as const;
/** A wake not run for this long is dropped: the loop and the entry watch have the trade. */
export const FILL_WAKE_STALE_MS = 60_000;
/** The most trades waiting at once: past it the oldest goes -- the loop still has it. */
export const FILL_WAKE_MAX = 2_000;

export type WakeKind = 'fill' | 'cancelled';
/** What the socket heard, as the desk is told it (`delta/private-events.ts` `SocketOrderEvent`, its fields). */
export type HeardOrder = { kind: WakeKind; symbol: string; orderId: string; clientOrderId: string | null; heardAt: number };

type Wake = {
  tradeId: string;
  /** Delta order ids the trade should show a fill of after its poll. Empty: a cancel, for which one poll is the answer. */
  orders: Set<string>;
  heardAt: number;
  dueAt: number;
  tries: number;
};

export type FillWakeDeps = {
  /** The engine's poll for one trade: its state afterwards, or null when there is no such trade on this desk. */
  poll: (tradeId: string) => Promise<Pick<TradeState, 'phase' | 'fills'> | null>;
  /** How much of this login's Delta quota is used, in percent. */
  quotaUsedPct: () => number;
  /** Told when a woken trade has had what the socket heard: its watches should read it again. */
  onSettled?: (tradeId: string) => void;
  now?: () => number;
};

const median = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return Math.round(s[Math.floor(s.length / 2)]!);
};
const p95 = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return Math.round(s[Math.min(s.length - 1, Math.floor(s.length * 0.95))]!);
};

export class FillWake {
  private readonly waiting = new Map<string, Wake>();
  private readonly busy = new Set<string>();
  private readonly now: () => number;
  /** From the socket hearing it to the poll that had it: the whole point, measured. */
  private readonly took: number[] = [];
  readonly counts = {
    /** Events handed in. */
    heard: 0,
    /** Of those, not one of the desk's own orders (another venue's, the Delta app's, a client id not ours). */
    notOurs: 0,
    /** Merged into a wake already waiting for the same trade. */
    merged: 0,
    /** Polls started. */
    polls: 0,
    /** Wakes done: the poll showed every fill heard, or the trade is over, or it was a cancel. */
    settled: 0,
    /** Of those, on the first poll. */
    firstPoll: 0,
    /** Polled again because a fill heard was not on the trade yet. */
    retries: 0,
    /** Left to the loop after every retry, the fill still not on the trade. */
    unconfirmed: 0,
    /** No such trade on this desk (another account's, or gone). */
    unknown: 0,
    /** Looks that stood aside for the quota. */
    quotaWaits: 0,
    /** Dropped, not run for a minute. */
    stale: 0,
    /** Dropped, too many waiting. */
    overflow: 0,
    /** Polls that threw. */
    failed: 0,
  };

  constructor(private readonly d: FillWakeDeps) {
    this.now = d.now ?? Date.now;
  }

  /** How many trades are waiting for their poll. */
  get size(): number { return this.waiting.size; }

  /**
   * What the socket heard, handed in. Whose it is is read off its client id: one of the desk's own orders names its
   * trade (`tradeIdOfClientId`); anything else is not this desk's to act on. True when a poll is now due.
   */
  hear(e: HeardOrder): boolean {
    this.counts.heard++;
    const tradeId = e.clientOrderId ? tradeIdOfClientId(e.symbol, e.clientOrderId) : null;
    if (!tradeId) { this.counts.notOurs++; return false; }
    const at = this.now();
    const had = this.waiting.get(tradeId);
    if (had) {
      this.counts.merged++;
      if (e.kind === 'fill') had.orders.add(e.orderId);
      had.heardAt = Math.min(had.heardAt, e.heardAt);
      // Something new heard: due again now, with its own retries.
      had.dueAt = Math.min(had.dueAt, at);
      had.tries = 0;
      return true;
    }
    if (this.waiting.size >= FILL_WAKE_MAX) {
      const oldest = this.waiting.keys().next().value as string;
      this.waiting.delete(oldest);
      this.counts.overflow++;
    }
    this.waiting.set(tradeId, { tradeId, orders: new Set(e.kind === 'fill' ? [e.orderId] : []), heardAt: e.heardAt, dueAt: at, tries: 0 });
    return true;
  }

  /** One look. Never throws and never waits. Returns the trades whose poll it started. */
  tick(): string[] {
    if (!this.waiting.size) return [];
    const now = this.now();
    for (const [id, w] of this.waiting) {
      if (!this.busy.has(id) && now - w.heardAt > FILL_WAKE_STALE_MS) { this.waiting.delete(id); this.counts.stale++; }
    }
    if (this.busy.size >= FILL_WAKE_IN_FLIGHT) return [];
    let used = 0;
    try { used = this.d.quotaUsedPct(); } catch { used = 0; }
    if (used >= FILL_WAKE_QUOTA_PCT) { this.counts.quotaWaits++; return []; }
    const started: string[] = [];
    // The earliest heard first: the map keeps the order they came in, and a trade woken again keeps its place.
    for (const w of this.waiting.values()) {
      if (started.length >= FILL_WAKE_PER_LOOK || this.busy.size >= FILL_WAKE_IN_FLIGHT) break;
      if (this.busy.has(w.tradeId) || w.dueAt > now) continue;
      started.push(w.tradeId);
      this.run(w);
    }
    return started;
  }

  private run(w: Wake): void {
    const id = w.tradeId;
    this.busy.add(id);
    this.counts.polls++;
    // What this poll is answering: anything heard while it runs is a new question (`hear` resets `tries`).
    const asked = new Set(w.orders);
    const tries = w.tries;
    void this.d.poll(id)
      .then((state) => {
        const now = this.now();
        const still = this.waiting.get(id);
        if (!still) return;
        if (state === null) { this.waiting.delete(id); this.counts.unknown++; return; }
        const had = new Set(state.fills.map((f) => String(f.orderId)));
        const missing = [...still.orders].filter((o) => !had.has(o));
        const newSince = [...still.orders].some((o) => !asked.has(o));
        if (missing.length === 0 || isDone(state as TradeState)) {
          this.waiting.delete(id);
          this.counts.settled++;
          if (tries === 0 && !newSince) this.counts.firstPoll++;
          this.took.push(now - still.heardAt);
          if (this.took.length > 500) this.took.shift();
          try { this.d.onSettled?.(id); } catch { /* a listener is not the wake's problem */ }
          return;
        }
        // Heard again while the poll ran: due now, its own retries ahead of it.
        if (newSince) { still.dueAt = now; return; }
        if (still.tries >= FILL_WAKE_RETRY_MS.length) {
          this.waiting.delete(id);
          this.counts.unconfirmed++;
          return;
        }
        still.dueAt = now + FILL_WAKE_RETRY_MS[still.tries]!;
        still.tries++;
        this.counts.retries++;
      }, () => {
        this.counts.failed++;
        const still = this.waiting.get(id);
        if (!still) return;
        if (still.tries >= FILL_WAKE_RETRY_MS.length) { this.waiting.delete(id); this.counts.unconfirmed++; return; }
        still.dueAt = this.now() + FILL_WAKE_RETRY_MS[still.tries]!;
        still.tries++;
        this.counts.retries++;
      })
      .finally(() => { this.busy.delete(id); });
  }

  metrics() {
    return {
      waiting: this.waiting.size,
      running: this.busy.size,
      counts: { ...this.counts },
      /** From the socket hearing it to the end of the poll that had it, over the last 500. */
      heardToSettledMs: { n: this.took.length, p50: median(this.took), p95: p95(this.took), max: this.took.length ? Math.round(Math.max(...this.took)) : null },
    };
  }
}
