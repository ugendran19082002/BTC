import type { TradeEvent, TradeState } from './types.js';

/**
 * What a trade looks like in a list of orders.
 *
 * The engine's phases describe where a trade is in its machinery -- entry
 * pending, protected, exit pending. That is the right vocabulary for the engine
 * and the wrong one for a person looking back over the day, who is asking a
 * simpler question: did it happen, is it still going, or did it not happen, and
 * if not, whose decision was that.
 *
 * Four answers, and the distinction that matters is the last two. **Rejected**
 * means something refused it -- our own gates or the exchange -- and is worth
 * investigating. **Cancelled** means somebody took it back, which is not.
 * Collapsing them into "failed" loses exactly the part you would want to read.
 */
export type OrderStatus = 'completed' | 'pending' | 'rejected' | 'cancelled';

export const ORDER_STATUSES: readonly OrderStatus[] = ['completed', 'pending', 'rejected', 'cancelled'];

export function orderStatusOf(state: TradeState, events: TradeEvent[] = []): OrderStatus {
  // Anything still moving is pending, whatever else is true of it.
  if (state.phase !== 'flat' && state.phase !== 'aborted') return 'pending';

  // It traded and it is finished.
  if (state.entrySize > 0) return 'completed';

  // It never traded. Which of the two reasons was it?
  const refused = events.some((e) => e.t === 'precheck_failed' || e.t === 'entry_rejected');
  if (refused) return 'rejected';

  const withdrawn = events.some((e) => e.t === 'entry_cancelled' || e.t === 'aborted');
  if (withdrawn) return 'cancelled';

  // Aborted with no event saying why. Rare, and closer to a refusal than to a
  // decision, so it is reported as one rather than quietly filed away.
  return 'rejected';
}

/**
 * An order that waited out its time and was cancelled with nothing filled (owner, 14 Oct 2026: "is an order that
 * waited and expired shown -- desk and phone?"). It was, as "Cancelled" -- the same word as an order taken off by
 * hand, with "entry cancelled unfilled" under it and nothing to say its time ran out. Null unless it is one; else
 * how long it had waited, from the journal: the entry sent, to the timeout.
 */
export function expiredAfterMs(state: TradeState, events: TradeEvent[] = []): number | null {
  if (orderStatusOf(state, events) !== 'cancelled') return null;
  let timeout: number | null = null, sent: number | null = null;
  for (const e of events) {
    if (e.t === 'entry_submitted' && timeout === null) sent = e.at;
    if (e.t === 'entry_timeout') timeout = e.at;
  }
  if (timeout === null) return null;
  return sent === null ? 0 : Math.max(0, timeout - sent);
}

/** A wait in words: "5 minutes", "45 seconds", "1 hour 30 minutes". */
function waitWords(ms: number): string {
  const s = Math.round(ms / 1_000);
  const unit = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
  if (s < 60) return unit(s, 'second');
  const m = Math.round(s / 60);
  if (m < 60) return unit(m, 'minute');
  return m % 60 === 0 ? unit(m / 60, 'hour') : `${unit(Math.floor(m / 60), 'hour')} ${unit(m % 60, 'minute')}`;
}

/** One line saying what happened, for the list and for the export. */
export function orderOutcomeOf(state: TradeState, events: TradeEvent[] = []): string {
  const status = orderStatusOf(state, events);
  const expired = expiredAfterMs(state, events);
  if (expired !== null) return `expired: not filled in ${expired > 0 ? waitWords(expired) : 'its time'} — cancelled unfilled, no position taken`;
  switch (status) {
    case 'completed': {
      // Bought to open, the words turn over: bought, then sold back.
      const long = state.fills.find((f) => f.role === 'entry')?.side === 'buy';
      const [opened, closed] = long ? ['bought', 'sold back'] : ['sold', 'bought back'];
      return state.position === 0
        ? `${opened} ${state.entrySize}, ${closed} at ${state.exitAvgPrice?.toFixed(2) ?? '—'}`
        : `${opened} ${state.entrySize}, ${Math.abs(state.position)} still open`;
    }
    case 'pending': {
      if (state.position === 0) return 'working on the book';
      const long = state.position > 0;
      const [opened, closed, held] = long ? ['bought', 'sold back', 'long'] : ['sold', 'bought back', 'short'];
      // One trade is one row, however many pieces it exits in -- so the row says
      // what has already been closed, not only what is left.
      return state.exitSize > 0
        ? `${opened} ${state.entrySize}, ${closed} ${state.exitSize} at ${state.exitAvgPrice?.toFixed(2) ?? '—'}, ${held} ${Math.abs(state.position)}`
        : `${held} ${Math.abs(state.position)}`;
    }
    case 'rejected':
    case 'cancelled':
      return state.note ?? status;
  }
}

/**
 * The start of an IST calendar day, in epoch milliseconds.
 *
 * Calendar days, not the 05:30 trading day the loss budget uses. A date filter
 * is read by a person who means "the 8th", and answering with 05:30-to-05:30
 * would quietly drop the evening of the day they asked for.
 */
export const IST_OFFSET_MS = 5.5 * 3600_000;

export function istDayStart(iso: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso.trim());
  if (!m) return null;
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) - IST_OFFSET_MS;
}

/** Exclusive end: the first millisecond of the following IST day. */
export function istDayEnd(iso: string): number | null {
  const start = istDayStart(iso);
  return start === null ? null : start + 86_400_000;
}

/** Today in IST, as YYYY-MM-DD — the default both ends of the filter start at. */
export function istToday(now = Date.now()): string {
  return new Date(now + IST_OFFSET_MS).toISOString().slice(0, 10);
}
