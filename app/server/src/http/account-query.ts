import { brokerAccounts } from '../delta/accounts.js';

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
