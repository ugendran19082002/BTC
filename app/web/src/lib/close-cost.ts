import type { Trade } from '@/types/trade';

/**
 * Home's "Today's P&L" and Positions' "Total P&L", side by side (owner, 4 Nov 2026: "morning start aakum pothu home pnl
 * amount and position pnl match aakutha ilaya doubt iruku").
 *
 * They answer two questions. Home's is the day at the mark: what was booked today, the open trades at the mark, less the
 * day's charges (server `todayFigures`). Positions' is what closing every open trade now would leave: bought back at the
 * ask (a bought one sold at the bid), less every charge the trade paid and the charges to close (`netIfClosedAt`). The
 * difference on each open trade is the cost of leaving -- the spread from the mark to the ask, and the charges to close.
 * Measured on 4 Nov 2026 at 07:10 IST, four accounts: Home −₹0.65 to −₹1.79, Positions −₹4.87 to −₹8.04, every gap
 * that spread and those charges within a paisa's rounding. Said on both screens, so neither looks wrong beside the other.
 */

/** A trade at the mark, after what it has paid: booked so far, open at the mark, less its charges. Null without a mark. */
export function atMarkUsd(t: Pick<Trade, 'realisedPnl' | 'live' | 'charges'>): number | null {
  const open = t.live?.unrealisedPnl;
  if (open === null || open === undefined || !t.charges) return null;
  return t.realisedPnl + open - t.charges.paidUsd;
}

/** What closing a trade now costs over its mark: the spread to the price it closes at, and the charges to close. */
export function closeCostUsd(t: Pick<Trade, 'realisedPnl' | 'live' | 'charges'>): number | null {
  const mark = atMarkUsd(t);
  const closed = t.live?.netIfClosedUsd;
  return mark === null || closed === null || closed === undefined ? null : mark - closed;
}

/** Every open trade together: at the mark, closed now, and the cost between them -- over those with both figures. */
export function closeAll(trades: readonly Pick<Trade, 'realisedPnl' | 'live' | 'charges'>[]): { atMarkUsd: number; closedUsd: number; costUsd: number; priced: number } {
  let mark = 0, closed = 0, priced = 0;
  for (const t of trades) {
    const m = atMarkUsd(t), c = t.live?.netIfClosedUsd;
    if (m === null || c === null || c === undefined) continue;
    mark += m; closed += c; priced++;
  }
  return { atMarkUsd: mark, closedUsd: closed, costUsd: mark - closed, priced };
}
