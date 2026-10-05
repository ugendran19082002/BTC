import type { FastifyRequest } from 'fastify';
import { brokerAccounts } from '../delta/accounts.js';
import { one } from '../db/pool.js';
import { tradingServiceFor, type TradingService } from '../trading/service.js';

/**
 * `?account=<id>` on the screens that are read by broker account -- orders, P&L, strategies.
 *
 * A whole number that names a saved account is that account; anything else -- absent, "all", a number no
 * account has -- is every account, which is what each of those routes answered before there were accounts.
 */
export function accountOf(query: unknown): number | null {
  const raw = (query as { account?: unknown } | null | undefined)?.account;
  const id = typeof raw === 'string' && /^\d{1,15}$/.test(raw) ? Number(raw) : null;
  if (id === null) return null;
  try { return brokerAccounts().get(id) ? id : null; } catch { return null; }
}

/**
 * The desk a request is for, or null for the default account's.
 *
 * In order: the account it names (`?account=`, or `accountId` in the body), then the account of the trade it
 * acts on (`tradeId` in the path or the body -- one read by primary key). An account that is not trading has
 * no desk: the request then falls to the default account's, whose journal does not hold that account's trades,
 * so an act on one is "no such trade" rather than an act on the wrong exchange.
 */
export async function deskOfRequest(req: FastifyRequest): Promise<TradingService | null> {
  if (!req.url.startsWith('/api/')) return null;
  try {
    const body = (req.body ?? {}) as { accountId?: unknown; tradeId?: unknown };
    const named = accountOf(req.query) ?? accountOf({ account: typeof body.accountId === 'number' ? String(body.accountId) : body.accountId });
    if (named !== null) return tradingServiceFor(named);
    const tradeId = (req.params as { tradeId?: unknown } | undefined)?.tradeId ?? body.tradeId;
    if (typeof tradeId === 'string' && tradeId) {
      const row = await one<{ broker_account_id: string | null }>('SELECT broker_account_id FROM trades WHERE trade_id = $1', [tradeId]);
      if (row?.broker_account_id != null) return tradingServiceFor(Number(row.broker_account_id));
    }
  } catch { /* a desk that is not built yet, a table that is not there: the default desk answers */ }
  return null;
}
