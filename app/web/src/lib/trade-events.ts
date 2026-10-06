import type { Trade } from '@/types/trade';
import { isLongTrade } from '@/lib/long-exits';

/**
 * What changed between one reading of the desk's open trades and the next (the phone's live toasts, owner,
 * 6 Oct 2026): an order began waiting, an order filled, a position closed, a waiting order went away unfilled.
 *
 * Pure: two lists in, the events out. The phone reads the status every few seconds, so this is how it notices --
 * no new feed, and nothing the server does not already say. A trade is known by its id and, on "All accounts", its
 * account, since two accounts may each hold a trade on one contract.
 *
 * A trade is in one of three states while it is listed, and each step forward is said once:
 *
 *   waiting  -- sent, nothing held yet
 *   running  -- a position is held
 *   done     -- it held one and holds none now, though the desk still lists it for a moment (the exit has filled
 *               and the other exit is being taken off the book)
 *
 * That last state is why a close is told from the fills and not only from the position: read as "position 0, then
 * gone", a trade that had closed at its target was announced as "Order not filled" (review, 6 Oct 2026).
 */

export type TradeEventKind = 'waiting' | 'filled' | 'closed' | 'gone';

export type TradeEvent = {
  kind: TradeEventKind;
  tradeId: string;
  /** The trade as last seen holding or waiting: for a close, as it was while still open. */
  trade: Trade;
};

type State = 'waiting' | 'running' | 'done' | 'other';

/** It has held a position at some point: an entry filled. */
const hasFilled = (t: Pick<Trade, 'entrySize' | 'exitSize'>) => t.entrySize > 0 || t.exitSize > 0;

export function stateOf(t: Pick<Trade, 'position' | 'phase' | 'entrySize' | 'exitSize'>): State {
  if (t.position !== 0) return 'running';
  if (hasFilled(t)) return 'done';
  if (t.phase === 'precheck' || t.phase === 'entry_pending' || t.phase === 'entry_unknown') return 'waiting';
  return 'other';
}

/** An order sent and not filled yet: nothing held, still on its way in. */
export const isWaiting = (t: Pick<Trade, 'position' | 'phase' | 'entrySize' | 'exitSize'>): boolean => stateOf(t) === 'waiting';

/** A position that is held: running. */
export const isRunning = (t: Pick<Trade, 'position'>): boolean => t.position !== 0;

const keyOf = (t: Trade) => `${t.account?.id ?? ''}|${t.tradeId}`;

export function tradeEvents(prev: readonly Trade[], next: readonly Trade[]): TradeEvent[] {
  const before = new Map(prev.map((t) => [keyOf(t), t]));
  const after = new Map(next.map((t) => [keyOf(t), t]));
  const out: TradeEvent[] = [];
  for (const [k, t] of after) {
    const was = before.get(k);
    const from = was ? stateOf(was) : null;
    const to = stateOf(t);
    if (to === from) continue;
    if (to === 'waiting' && from === null) out.push({ kind: 'waiting', tradeId: t.tradeId, trade: t });
    // Filled: from nothing or from waiting. A fill between two readings is a fill, not a wait.
    else if (to === 'running' && from !== 'done') out.push({ kind: 'filled', tradeId: t.tradeId, trade: t });
    // Closed while still listed: said now, with the trade as it was while it held, and not again when it leaves.
    else if (to === 'done' && from === 'running') out.push({ kind: 'closed', tradeId: t.tradeId, trade: was! });
    // New and already closed (opened and closed between two readings): one close, nothing else to show it by.
    else if (to === 'done' && from === null) out.push({ kind: 'closed', tradeId: t.tradeId, trade: t });
  }
  for (const [k, was] of before) {
    if (after.has(k)) continue;
    const from = stateOf(was);
    // No longer listed: a position that was held has closed; an order that never filled has gone. One already
    // done was announced when it closed.
    if (from === 'running') out.push({ kind: 'closed', tradeId: was.tradeId, trade: was });
    else if (from === 'waiting') out.push({ kind: 'gone', tradeId: was.tradeId, trade: was });
  }
  return out;
}

/** "SELL 84,600 PE × 500", for a toast's headline. */
export function tradeWords(t: Trade, contract: (symbol: string) => string): string {
  const qty = Math.abs(t.position) || t.entrySize || t.requestedSize;
  return `${isLongTrade(t) ? 'BUY' : 'SELL'} ${contract(t.symbol)} × ${qty.toLocaleString('en-US')}`;
}
