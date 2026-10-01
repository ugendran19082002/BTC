import { gradeTicks, saveGraded, withGradeLock, workingRows } from './paper.js';

/**
 * The paper log graded live, on the perpetual's own trades (owner, 1 Oct 2026:
 * "everything on the live price, not on the candle close").
 *
 * Every second, each working setup -- waiting for its fill, in the trade, or a
 * runner after TP1 -- is moved on by the trades printed since it was last
 * looked at, through the same rules as a 1m candle (paper.ts `gradeTicks`).
 * A fill, a stop, TP1, TP2, TP3 or a time-out is written the second it
 * prints, at the price it printed, instead of on the next closed minute.
 *
 * The 1m candle grader stays, as the backstop: it grades only the minutes
 * after `graded_to`, and this grader moves `graded_to` past the minutes the
 * tape saw -- the last whole minute, or the minute an event happened in, so
 * a candle never re-plays prices from before a state the tape already took.
 * With the tape stale or reconnected, this grader stands aside and the
 * candles carry on. The two never run at once (`withGradeLock`).
 *
 * Signals themselves stay on closed candles: a signal read from a forming
 * candle appears and vanishes within it, and an alert for it would be wrong.
 */

export type Tape = {
  /** A message within the stale window. */
  fresh(): boolean;
  /** The perpetual's trades at or after `ms`, oldest first. */
  perpSince(ms: number): readonly { at: number; price: number }[];
  /** How many times the socket has reconnected -- a change means a gap in the trades. */
  reconnects(): number;
};

/** Per setup: the time of the last trade graded (ms). */
const cursors = new Map<number, number>();
let lastReconnects: number | null = null;

/** For tests: forget where each setup was. */
export function resetLiveGrade(): void { cursors.clear(); lastReconnects = null; }

/** One pass over every working setup. Returns how many changed status. */
export function gradeLive(tape: Tape | null): Promise<number> {
  if (!tape || !tape.fresh()) return Promise.resolve(0);
  // A reconnect is a gap in the trades: start again from what the candles have graded.
  const rc = tape.reconnects();
  if (lastReconnects !== null && rc !== lastReconnects) cursors.clear();
  lastReconnects = rc;
  return withGradeLock(async () => {
    let moved = 0;
    const seen = new Set<number>();
    for (const { id, ...row } of await workingRows()) {
      seen.add(id);
      const cursor = cursors.get(id);
      // Never back over a minute the candle grader has done, nor a trade from before the setup was seen.
      // But a minute this grader closed itself -- an event's -- it carries on through from its own last
      // trade: until 1 Oct 2026 it jumped to the next minute, and the rest of the event's minute was
      // graded by nobody (a stop seconds after the fill went unseen). A candle still never replays it.
      const ownMinute = cursor !== undefined && Math.floor(cursor / 60_000) * 60 >= row.gradedTo;
      const from = Math.max(row.firstSeen, ownMinute ? cursor + 1 : (row.gradedTo + 60) * 1000, cursor === undefined ? 0 : cursor + 1);
      const prints = tape.perpSince(from);
      if (!prints.length) continue;
      // Resting: the limit was in the market before these trades (a trade, or a graded minute, since it was seen).
      const resting = cursor !== undefined || row.gradedTo * 1000 >= row.firstSeen;
      const { row: after, lastAt } = gradeTicks(row, prints, resting);
      if (lastAt === null) continue;
      cursors.set(id, lastAt);
      const minute = Math.floor(lastAt / 60_000) * 60;
      const changed = after.status !== row.status || after.runner !== row.runner || after.tp2At !== row.tp2At || after.tp3At !== row.tp3At;
      // Whole minutes the tape saw are done; an event's minute is done too -- a candle must not replay it.
      const gradedTo = Math.max(row.gradedTo, changed ? minute : minute - 60);
      if (!changed && gradedTo === row.gradedTo) continue;
      if (after.status !== row.status) moved++;
      await saveGraded(id, { ...after, gradedTo });
    }
    for (const id of cursors.keys()) if (!seen.has(id)) cursors.delete(id);
    return moved;
  });
}
