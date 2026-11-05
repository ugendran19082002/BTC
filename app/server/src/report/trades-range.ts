import { rows } from '../db/pool.js';
import { journal } from '../trading/service.js';
import type { TradeRecord } from '../trading/engine.js';

/**
 * The journal's trades over a range of days, for the reports -- every one of them, and quickly (owner, 4 Nov 2026: "fix
 * all, best practice").
 *
 * The P&L calendar, its spreadsheet and the trade statistics (P&L, Home, Strategies' 30 days) read the trades saved in
 * the range and two days either side, at most 5,000, newest first. That held while the desk traded a few hundred a day;
 * by November it was 1,000-2,600 a day across four accounts -- 18,368 in 32 days -- so a week silently lost its older
 * half and thirty days three quarters, while today, the newest, read right. And each read took 0.5-1.2 s (the slow log,
 * 92 in a day), every trade's plan and state parsed, on the screens' polls.
 *
 * Now every trade, up to `RANGE_MAX` -- the ceiling `/api/trade/closed` has, said as `truncated` -- read a day at a
 * time by when it was last saved. A day before yesterday is kept once read: nothing on it changes but by being saved
 * again, which stamps it today. Each read checks the days it keeps against the journal in one small query -- how many
 * trades each day holds, and the sum of their save times -- and reads again any that moved: a trade saved since, one
 * deleted, a restore. Today and yesterday are read every time. At most `HELD_MAX` trades kept, the least recently asked
 * for let go first.
 */

/** The most trades one range reads: as `/api/trade/closed` (`CLOSED_MAX`). */
export const RANGE_MAX = 100_000;
/** The most trades kept between reads, across every day and account: ~1.7 KB of JSON each, so a few hundred MB at most. */
export const HELD_MAX = 30_000;
const DAY_MS = 86_400_000;
const IST_MS = 5.5 * 3_600_000;
/** The IST midnight on or before a moment. */
const dayOf = (ms: number) => Math.floor((ms + IST_MS) / DAY_MS) * DAY_MS - IST_MS;

type Day = { size: number; savedSum: number; records: TradeRecord[]; truncated: boolean };
const held = new Map<string, Day>();
let heldCount = 0;
const keyOf = (account: number | null, day: number) => `${account ?? 'all'}|${day}`;

export type RangeDeps = {
  /** The journal's trades saved in [from, to), newest first, at most `limit` (`TradeStore.between`, no events). */
  read: (fromMs: number, toMs: number, limit: number, account: number | null) => Promise<TradeRecord[]>;
  /** Each IST day's count and sum of save times in [from, to): what a kept day is checked against. */
  fingerprints: (fromMs: number, toMs: number, account: number | null) => Promise<Map<number, { size: number; savedSum: number }>>;
};

const defaultDeps: RangeDeps = {
  // Each trade's state and plan, never its journal of events: not read (10 Oct 2026, half a 30-day report's time).
  read: (from, to, limit, account) => journal().between(from, to, limit, account, { events: false }),
  fingerprints: async (from, to, account) => {
    const found = await rows<{ day: string; n: string; s: string }>(
      // The save times within their day, summed: a day's sum of whole epoch times would pass 2^53 in Number.
      `SELECT floor((updated_at + $3) / $4) * $4 - $3 AS day, count(*) AS n, sum((updated_at + $3) % $4) AS s FROM trades
        WHERE updated_at >= $1 AND updated_at < $2 AND ($5::bigint IS NULL OR broker_account_id = $5) GROUP BY 1`,
      [from, to, IST_MS, DAY_MS, account]);
    return new Map(found.map((r) => [Number(r.day), { size: Number(r.n), savedSum: Number(r.s) }]));
  },
};

/** Forget every kept day: a test that empties the journal, or a restore. */
export function clearTradesRange(): void { held.clear(); heldCount = 0; }

/**
 * Every trade saved in [from, to) -- of one account, or all of them with none -- newest day first, and whether any
 * day held more than `RANGE_MAX`.
 */
export async function tradesSavedBetween(fromMs: number, toMs: number, account: number | null, now = Date.now(), deps: RangeDeps = defaultDeps): Promise<{ records: TradeRecord[]; truncated: boolean }> {
  // Kept: whole days that ended before yesterday began. Everything from yesterday on is read as it is now.
  const keepBefore = Math.min(toMs, dayOf(now) - DAY_MS);
  const days: number[] = [];
  for (let d = dayOf(fromMs); d + DAY_MS <= keepBefore; d += DAY_MS) if (d >= fromMs) days.push(d);
  // A part day at the front of the range is read as it is, not kept: only whole days are. No whole day: all of it is.
  const keptFrom = days.length ? days[0]! : fromMs;
  const liveFrom = days.length ? days[days.length - 1]! + DAY_MS : fromMs;

  const kept: Day[] = [];
  if (days.length) {
    const marks = await deps.fingerprints(days[0]!, days[days.length - 1]! + DAY_MS, account);
    for (const d of days) {
      const key = keyOf(account, d);
      const mark = marks.get(d) ?? { size: 0, savedSum: 0 };
      let day = held.get(key);
      if (!day || day.size !== mark.size || day.savedSum !== mark.savedSum) {
        if (day) { heldCount -= day.records.length; held.delete(key); }
        const records = mark.size === 0 ? [] : await deps.read(d, d + DAY_MS, RANGE_MAX, account);
        // Marked with what was asked: a trade saved between the two reads makes the next read read the day again.
        day = { size: mark.size, savedSum: mark.savedSum, records, truncated: records.length >= RANGE_MAX };
        heldCount += records.length;
      } else {
        held.delete(key); // to the back of the line: the most recently asked for is let go last
      }
      held.set(key, day);
      kept.push(day);
    }
    for (const [k, d] of held) {
      if (heldCount <= HELD_MAX) break;
      if (days.some((x) => keyOf(account, x) === k)) continue;
      held.delete(k); heldCount -= d.records.length;
    }
  }
  const live = fromMs < keptFrom ? await deps.read(fromMs, keptFrom, RANGE_MAX, account) : [];
  const recent = liveFrom < toMs ? await deps.read(liveFrom, toMs, RANGE_MAX, account) : [];
  // Newest first, as the journal answers: the days from yesterday on, then the kept days newest first, then any part day.
  const records = [...recent];
  for (let i = kept.length - 1; i >= 0; i--) records.push(...kept[i]!.records);
  records.push(...live);
  return { records, truncated: recent.length >= RANGE_MAX || live.length >= RANGE_MAX || kept.some((d) => d.truncated) };
}
