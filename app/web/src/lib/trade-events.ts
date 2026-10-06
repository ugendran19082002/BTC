import type { Trade } from '@/types/trade';
import { isLongTrade } from '@/lib/long-exits';

/**
 * What changed between one reading of the desk's open trades and the next (the phone's live toasts, owner,
 * 6 Oct 2026): an order began waiting, an order filled, a position closed, a waiting order went away unfilled.
 *
 * Pure: two lists in, the events out. The phone reads the status every few seconds, so this is how it notices --
 * no new feed, and nothing the server does not already say. A trade is known by its id and, on "All accounts", its
 * account, since two accounts may each hold a trade on one contract.
 */

export type TradeEventKind = 'waiting' | 'filled' | 'closed' | 'gone';

export type TradeEvent = {
  kind: TradeEventKind;
  tradeId: string;
  /** The trade as last seen: for a close, as it was while still open. */
  trade: Trade;
};

/** An order sent and not filled yet: nothing held, still on its way in. */
export const isWaiting = (t: Pick<Trade, 'position' | 'phase'>): boolean =>
  t.position === 0 && (t.phase === 'precheck' || t.phase === 'entry_pending' || t.phase === 'entry_unknown');

/** A position that is held: running. */
export const isRunning = (t: Pick<Trade, 'position'>): boolean => t.position !== 0;

const keyOf = (t: Trade) => `${t.account?.id ?? ''}|${t.tradeId}`;

export function tradeEvents(prev: readonly Trade[], next: readonly Trade[]): TradeEvent[] {
  const before = new Map(prev.map((t) => [keyOf(t), t]));
  const after = new Map(next.map((t) => [keyOf(t), t]));
  const out: TradeEvent[] = [];
  for (const [k, t] of after) {
    const was = before.get(k);
    if (!was) {
      // New since the last reading: already holding (a fill between two readings), or waiting to fill.
      if (isRunning(t)) out.push({ kind: 'filled', tradeId: t.tradeId, trade: t });
      else if (isWaiting(t)) out.push({ kind: 'waiting', tradeId: t.tradeId, trade: t });
    } else if (!isRunning(was) && isRunning(t)) {
      out.push({ kind: 'filled', tradeId: t.tradeId, trade: t });
    }
  }
  for (const [k, was] of before) {
    if (after.has(k)) continue;
    // No longer open: a position that was held has closed; an order that never filled has gone.
    out.push({ kind: isRunning(was) ? 'closed' : 'gone', tradeId: was.tradeId, trade: was });
  }
  return out;
}

/** "SELL 84,600 PE × 500", for a toast's headline. */
export function tradeWords(t: Trade, contract: (symbol: string) => string): string {
  const qty = Math.abs(t.position) || t.entrySize || t.requestedSize;
  return `${isLongTrade(t) ? 'BUY' : 'SELL'} ${contract(t.symbol)} × ${qty.toLocaleString('en-US')}`;
}
