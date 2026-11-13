import { isDone } from './machine.js';
import { targetHoldOf, type TradeRecord } from './engine.js';
import type { ExchangeOrder } from './types.js';

/**
 * Every open trade's stop and target held against the book Delta last listed (13 Nov 2026).
 *
 * That morning 22 trades on C-BTC-72200 sat with no target on Delta for twenty minutes and more: sellers traded at
 * 5.00-6.00 through targets of 5.20-7.30, Delta's public book showed nothing above 5.10, and not one of them filled. The
 * desk finds a missing order only when its pass comes round to the trade -- 9 to 15 minutes at 250 trades a login --
 * and a lookup Delta refuses for the rate limit then finds nothing at all. The book is already read whole every few
 * seconds and shared by every poll (`DeltaExchange.getRestingOrder`): this compares it with what each trade says it
 * holds, and a trade whose stop or target is not on it is woken at once (`FillWake.nudge`). The poll it gets is the
 * loop's own: it reads the order, writes down why Delta took it off, and puts back what is missing -- or holds a target
 * the position has no room for (`noteTargetChurn`). Nothing here places, edits or cancels an order.
 */

/** How often the book is compared with the trades. */
export const LEG_AUDIT_MS = 5_000;
/**
 * A trade changed this recently is left alone: its new stop or target may be newer than the book read. Measured from the
 * trade's own last change (`state.updatedAt`), so an order just placed, moved or replaced is not called missing.
 */
export const LEG_AUDIT_MIN_AGE_MS = 30_000;
/** A trade woken for a missing leg is not woken again for it sooner than this: its poll is still answering. */
export const LEG_AUDIT_REWAKE_MS = 20_000;
/** The most trades woken in one look: the rest wait for the next, five seconds on. */
export const LEG_AUDIT_MAX_WAKES = 20;
/** Past this share of the login's quota, the look stands aside: the stops and targets' own reads come first. */
export const LEG_AUDIT_QUOTA_PCT = 85;

export type LegAuditDeps = {
  /** The account's resting orders by client id, as the shared read has them; null when it could not be read whole. */
  book: () => Promise<ReadonlyMap<string, ExchangeOrder> | null>;
  /** The open trades. */
  open: () => Promise<readonly TradeRecord[]>;
  /** Wake one trade's poll now. */
  wake: (tradeId: string) => void;
  /** How much of this login's Delta quota is used, in percent. */
  quotaUsedPct: () => number;
  now?: () => number;
};

export type MissingLeg = 'stop_loss' | 'take_profit';

/** What one trade lacks on the book, or null when it holds all it should or is not to be judged now. */
export function missingLegOf(rec: TradeRecord, book: ReadonlyMap<string, ExchangeOrder>, now: number): MissingLeg | null {
  const s = rec.state;
  if (isDone(s) || s.position >= 0) return null;                    // nothing short to protect (a bought one has no exits)
  if (s.phase !== 'protected') return null;                        // entering, closing, or being protected: the poll's own
  if (now - (s.updatedAt ?? 0) < LEG_AUDIT_MIN_AGE_MS) return null;
  // The stop first: it is the leg that protects. No id at all, or an id the book does not list, is missing alike.
  const sl = s.protection.stopLoss;
  if (rec.plan.stopPrice !== null && (!sl || !book.has(sl))) return 'stop_loss';
  const tp = s.protection.takeProfit;
  // A target held off the book is meant to be away (`noteTargetChurn`): not missing.
  if (rec.plan.takeProfitPrice !== null && targetHoldOf(rec).until <= now && (!tp || !book.has(tp))) return 'take_profit';
  return null;
}

export class LegAudit {
  private readonly now: () => number;
  private readonly wokenAt = new Map<string, number>();
  private running = false;
  readonly counts = { looks: 0, quotaWaits: 0, noBook: 0, checked: 0, missingStop: 0, missingTarget: 0, woken: 0, failed: 0 };
  /** The last look's findings, for the metrics route. */
  last: { at: number; checked: number; missing: number; woken: number } | null = null;

  constructor(private readonly d: LegAuditDeps) {
    this.now = d.now ?? Date.now;
  }

  /** One look. Never throws; one at a time. Returns the trades it woke. */
  async look(): Promise<string[]> {
    if (this.running) return [];
    this.running = true;
    try {
      this.counts.looks++;
      let used = 0;
      try { used = this.d.quotaUsedPct(); } catch { used = 0; }
      if (used >= LEG_AUDIT_QUOTA_PCT) { this.counts.quotaWaits++; return []; }
      const open = await this.d.open();
      const short = open.filter((r) => !isDone(r.state) && r.state.position < 0);
      if (!short.length) { this.wokenAt.clear(); return []; }
      const book = await this.d.book();
      if (!book) { this.counts.noBook++; return []; }
      const now = this.now();
      const woke: string[] = [];
      let missing = 0;
      for (const rec of short) {
        const leg = missingLegOf(rec, book, now);
        if (!leg) { this.wokenAt.delete(rec.state.tradeId); continue; }
        missing++;
        if (leg === 'stop_loss') this.counts.missingStop++;
        else this.counts.missingTarget++;
        const id = rec.state.tradeId;
        if (woke.length >= LEG_AUDIT_MAX_WAKES || now - (this.wokenAt.get(id) ?? Number.NEGATIVE_INFINITY) < LEG_AUDIT_REWAKE_MS) continue;
        this.wokenAt.set(id, now);
        woke.push(id);
        try { this.d.wake(id); } catch { /* the next look asks again */ }
      }
      // Trades no longer open are forgotten.
      const live = new Set(short.map((r) => r.state.tradeId));
      for (const id of this.wokenAt.keys()) if (!live.has(id)) this.wokenAt.delete(id);
      this.counts.checked += short.length;
      this.counts.woken += woke.length;
      this.last = { at: now, checked: short.length, missing, woken: woke.length };
      return woke;
    } catch {
      this.counts.failed++;
      return [];
    } finally {
      this.running = false;
    }
  }

  metrics() {
    return { counts: { ...this.counts }, last: this.last, waiting: this.wokenAt.size };
  }
}
