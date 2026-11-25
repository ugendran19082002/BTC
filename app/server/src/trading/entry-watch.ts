import { QUOTA_LADDER } from '../observability/desk-metrics.js';
import { CLOSE_FOLLOW_UP_MS, type TradeRecord } from './engine.js';

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
/**
 * The most closes polled on one look, apart from the others' two (22 Nov 2026). At 14:05 IST that day BTC ran +1.1% in
 * seven minutes into same-day calls a strike or two out, and dozens of stops closed at once. The two places a look were
 * shared by every close, due or not, round in turn: a close whose limit had not filled waited 12 s for its follow-up at
 * the market where it was owed one at 1.5 s (`CLOSE_FOLLOW_UP_MS`) -- the 60,400 CE judged at an offer of 103 bought
 * back at 218. 65 closes needed that follow-up that day and filled 41% over the offer they were judged on. Only closes
 * that are due are looked at, oldest first, so this many a look is spent on those alone.
 */
export const CLOSE_WATCH_PER_LOOK = 6;
/**
 * A position with no stop on (25 Nov 2026): polled ahead of the others and on up to the stops' share of the quota, as a
 * close is -- it is a stop's business. At 14:02 IST that day 37 positions whose BTC-move closes met the rate limit sat
 * "unprotected" for over twenty minutes: every login was past the others' 50%, so nothing looked at them but the loop.
 * Each at most once every `BARE_RETRY_MS`, this many a look: putting a stop back is two or three calls.
 */
export const BARE_WATCH_PER_LOOK = 2;
export const BARE_RETRY_MS = 2_000;
/** Above this share of Delta's quota, the urgent polls stop and the loop alone carries on. */
export const ENTRY_WATCH_QUOTA_PCT = QUOTA_LADDER.others;
/** A close is a stop's own exit: polled on up to the stops' share of the quota, as the stop watch is (`QUOTA_LADDER`). */
export const CLOSE_WATCH_QUOTA_PCT = QUOTA_LADDER.stop;

type Urgency = { phase: string; position?: number; closing?: { submittedAt?: number } | null | unknown };

/** When a close is owed its next look: its follow-up's moment (`CLOSE_FOLLOW_UP_MS` after it was sent); unknown: now. */
const dueOf = (s: Urgency, now: number): number => {
  const at = (s.closing as { submittedAt?: unknown } | null | undefined)?.submittedAt;
  return typeof at === 'number' && Number.isFinite(at) ? at + CLOSE_FOLLOW_UP_MS : now;
};

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
  /** The clock; the real one when not given. */
  now?: () => number;
};

export class EntryWatch {
  private ids: string[] = [];
  /** Of `ids`, the closes: looked at first, and on past the quota at which the others wait. */
  private closes = new Set<string>();
  /** Each close's next moment to be looked at: its follow-up's (`dueOf`). A close not due yet is not polled. */
  private readonly due = new Map<string, number>();
  /** Of `ids`, the positions with no stop on (`phase` "unprotected"), and when each is next looked at. */
  private bare = new Set<string>();
  private readonly bareDue = new Map<string, number>();
  private readonly busy = new Set<string>();
  private next = 0;

  constructor(private readonly d: EntryWatchDeps) {}

  /** The loop's own read of the open trades: which of them are urgent now. */
  note(records: readonly Pick<TradeRecord, 'state'>[]): void {
    const now = this.now();
    this.ids = records.filter(isUrgent).map((r) => r.state.tradeId);
    const closing = records.filter((r) => isClosing(r.state));
    this.closes = new Set(closing.map((r) => r.state.tradeId));
    for (const id of [...this.due.keys()]) if (!this.closes.has(id)) this.due.delete(id);
    for (const r of closing) this.due.set(r.state.tradeId, dueOf(r.state, now));
    this.bare = new Set(records.filter((r) => r.state.phase === 'unprotected').map((r) => r.state.tradeId));
    for (const id of [...this.bareDue.keys()]) if (!this.bare.has(id)) this.bareDue.delete(id);
  }

  /**
   * A trade just placed, or a close just sent: urgent from this moment, without waiting for the loop to read it. A close
   * is due its follow-up `CLOSE_FOLLOW_UP_MS` after `submittedAt` (now when not given).
   */
  add(tradeId: string, closing = false, submittedAt?: number): void {
    if (!this.ids.includes(tradeId)) this.ids.push(tradeId);
    if (closing) {
      this.closes.add(tradeId);
      this.due.set(tradeId, (submittedAt ?? this.now()) + CLOSE_FOLLOW_UP_MS);
    }
  }

  private now(): number { return this.d.now ? this.d.now() : Date.now(); }

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
          if (state && urgentState(state)) {
            if (isClosing(state)) {
              this.closes.add(id);
              // Still working after its look: due again at its (new) follow-up's moment -- never sooner than a beat on.
              this.due.set(id, Math.max(dueOf(state, this.now()), this.now() + ENTRY_WATCH_MS));
            } else { this.closes.delete(id); this.due.delete(id); }
            if (state.phase === 'unprotected') { this.bare.add(id); this.bareDue.set(id, this.now() + BARE_RETRY_MS); }
            else { this.bare.delete(id); this.bareDue.delete(id); }
            return;
          }
          this.ids = this.ids.filter((x) => x !== id);
          this.closes.delete(id);
          this.due.delete(id);
          this.bare.delete(id);
          this.bareDue.delete(id);
          try { this.d.onSettled?.(id); } catch { /* a listener is not the watch's problem */ }
        }, () => {})
        .finally(() => { this.busy.delete(id); });
    };
    // The closes first, with places of their own: a stop's buy-back is money moving now. Only those due -- a close's
    // follow-up comes `CLOSE_FOLLOW_UP_MS` after it was sent, and a look before that only spends the quota -- the
    // longest overdue first.
    const now = this.now();
    const dueCloses = this.ids
      .filter((id) => this.closes.has(id) && !this.busy.has(id) && (this.due.get(id) ?? now) <= now)
      .sort((a, b) => (this.due.get(a) ?? now) - (this.due.get(b) ?? now));
    for (const id of dueCloses.slice(0, CLOSE_WATCH_PER_LOOK)) look(id);
    // Then the positions with no stop on, due ones first (`BARE_RETRY_MS`), up to the stops' share as the closes are.
    const dueBare = this.ids
      .filter((id) => this.bare.has(id) && !this.closes.has(id) && !this.busy.has(id) && (this.bareDue.get(id) ?? now) <= now)
      .sort((a, b) => (this.bareDue.get(a) ?? now) - (this.bareDue.get(b) ?? now));
    for (const id of dueBare.slice(0, BARE_WATCH_PER_LOOK)) { this.bareDue.set(id, now + BARE_RETRY_MS); look(id); }
    // The others in turn, so one slow trade cannot keep the rest from being looked at.
    const turn = this.ids.map((_, i) => this.ids[(this.next + i) % this.ids.length]!);
    let others = 0;
    for (const id of othersToo ? turn : []) {
      if (others >= ENTRY_WATCH_PER_LOOK) break;
      if (!this.closes.has(id) && !this.bare.has(id) && !this.busy.has(id)) { look(id); others++; }
    }
    this.next = this.ids.length ? (this.next + others) % this.ids.length : 0;
    return polled;
  }
}
