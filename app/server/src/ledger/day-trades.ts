import { journal, tradingService } from '../trading/service.js';
import { fillChargesUsd } from '../trading/charges.js';
import { isExit, isLong, recompute } from '../trading/machine.js';
import { daysReport } from '../trading/pnl-history.js';
import { exitByOf } from '../strategy/store.js';
import { forScreens } from '../http/routes/trade.routes.js';
import { brokerAccounts } from '../delta/accounts.js';
import { dayBounds, type DeskDay } from './ledger.js';

/**
 * One ledger day's trades, each on its own line (owner, 30 Oct 2026: "the entries under a day, a tap opens them: entry,
 * exit, charges, P&L, the strike, PE or CE, entry time, exit time -- mobile friendly, best practice"). From the desk's
 * own journal -- every fill the desk recorded and Delta confirmed, kept in `trades` -- worked out with the P&L calendar's
 * very arithmetic (`daysReport`): a fill's charges by Delta's formula, an exit's profit or loss against the entry, so the
 * day's lines add up to the day's row and to nothing else.
 *
 * A trade is the day's when any of its fills is: one entered the evening before and closed after midnight is on both
 * days, said as such (`spans`), its figures the whole trade's; the day's own total (`desk`) counts only the day's fills.
 */

export type DayTrade = {
  tradeId: string; symbol: string; strike: number | null; optionSide: 'CE' | 'PE'; action: 'sell' | 'buy'; contracts: number;
  /** First entry fill and last exit fill, ms; `exitAt` null while it is still open. */
  entryAt: number | null; exitAt: number | null;
  entryPrice: number | null; exitPrice: number | null;
  /** The whole trade's, in dollars: Delta's charges on every fill, what the exits booked, and the two together. */
  chargesUsd: number; grossUsd: number; netUsd: number;
  exitBy: ReturnType<typeof exitByOf> | null;
  open: boolean;
  /** Some of its fills fell on another IST day. */
  spans: boolean;
  strategy: string | null;
  account: { id: number; name: string } | null;
  /** Delta's order ids its fills came from: what Delta's own order history finds it by. */
  orderIds: string[];
};

const strikeOf = (symbol: string) => { const n = Number(symbol.split('-')[2]); return Number.isFinite(n) ? n : null; };

export async function dayTrades(accountId: number | null, day: string): Promise<{ desk: DeskDay; trades: DayTrade[] }> {
  const { from, to } = dayBounds(day);
  // A trade with a fill in the day was last changed at or after it, and by the day after its expiry at the latest.
  const recs = await forScreens(await journal().between(from, to + 2 * 86_400_000, 200_000, accountId, { events: false }));
  const spot = tradingService().spot;
  const names = new Map<number, string>();
  try { for (const a of brokerAccounts().list()) names.set(a.id, a.name); } catch { /* no accounts loaded */ }

  const mine = recs.filter((r) => r.state.fills.some((f) => f.ts >= from && f.ts < to));
  const trades = mine.map((r): DayTrade => {
    const s = recompute(r.state);
    const cv = s.contractValue ?? 0.001;
    const long = isLong(s);
    const entries = s.fills.filter((f) => !isExit(f.role));
    const exits = s.fills.filter((f) => isExit(f.role));
    const chargesUsd = s.fills.reduce((n, f) => n + fillChargesUsd({ price: f.price, contracts: f.size, contractValue: cv, spot }).totalUsd, 0);
    const grossUsd = s.entryAvgPrice === null ? 0
      : exits.reduce((n, f) => n + (long ? f.price - s.entryAvgPrice! : s.entryAvgPrice! - f.price) * f.size * cv, 0);
    const open = s.position !== 0;
    const id = r.plan.accountId ?? null;
    return {
      tradeId: s.tradeId, symbol: s.symbol, strike: strikeOf(s.symbol), optionSide: s.optionSide, action: long ? 'buy' : 'sell',
      contracts: s.entrySize,
      entryAt: entries.length ? Math.min(...entries.map((f) => f.ts)) : null,
      exitAt: !open && exits.length ? Math.max(...exits.map((f) => f.ts)) : null,
      entryPrice: s.entryAvgPrice, exitPrice: exits.length ? s.exitAvgPrice : null,
      chargesUsd, grossUsd, netUsd: grossUsd - chargesUsd,
      exitBy: !open && exits.length ? exitByOf(s.exitReason ?? null, s.exitWinner ?? null) : null,
      open, spans: s.fills.some((f) => f.ts < from || f.ts >= to),
      strategy: r.plan.strategyName ?? r.plan.strategyId ?? null,
      account: id === null ? null : { id, name: names.get(id) ?? `Account ${id}` },
      orderIds: [...new Set(s.fills.map((f) => f.orderId).filter(Boolean))],
    };
  }).sort((a, b) => (b.exitAt ?? b.entryAt ?? 0) - (a.exitAt ?? a.entryAt ?? 0));

  // The day's own figures, the ledger row's: only its fills, by the same sums.
  const row = daysReport(mine, { from: day, to: day, spot }).days[0];
  const desk: DeskDay = row
    ? { realisedUsd: row.realisedUsd, profitUsd: row.profitUsd, lossUsd: row.lossUsd, chargesUsd: row.chargesUsd, netUsd: row.netUsd, trades: row.trades, open: trades.filter((t) => t.open).length }
    : { realisedUsd: 0, profitUsd: 0, lossUsd: 0, chargesUsd: 0, netUsd: 0, trades: 0, open: 0 };
  return { desk, trades };
}
