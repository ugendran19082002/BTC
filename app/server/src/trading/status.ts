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

/** One line saying what happened, for the list and for the export. */
export function orderOutcomeOf(state: TradeState, events: TradeEvent[] = []): string {
  const status = orderStatusOf(state, events);
  switch (status) {
    case 'completed':
      return state.position === 0
        ? `sold ${state.entrySize}, bought back at ${state.exitAvgPrice?.toFixed(2) ?? '—'}`
        : `sold ${state.entrySize}, ${Math.abs(state.position)} still open`;
    case 'pending':
      if (state.position === 0) return 'working on the book';
      // One trade is one row, however many pieces it exits in -- so the row says
      // what has already been bought back, not only what is left.
      return state.exitSize > 0
        ? `sold ${state.entrySize}, bought back ${state.exitSize} at ${state.exitAvgPrice?.toFixed(2) ?? '—'}, short ${Math.abs(state.position)}`
        : `short ${Math.abs(state.position)}`;
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
