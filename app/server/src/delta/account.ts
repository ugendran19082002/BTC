import { signed, type Creds } from './signed.js';

/**
 * Read-only access to the user's own Delta account.
 *
 * Balances and positions, nothing else. The order path lives in
 * trading/exchange/delta.ts and is switched off unless it is turned on
 * deliberately, so importing this file cannot move money.
 */

export { credsFromEnv, NotConfigured, type Creds } from './signed.js';

export type Balance = { asset_symbol?: string; balance?: string; available_balance?: string };
export type Position = {
  product_symbol?: string;
  size?: number;
  entry_price?: string;
  realized_pnl?: string;
  unrealized_pnl?: string;
};

export const getBalances = (c: Creds | null) =>
  signed<Balance[]>(c, { method: 'GET', path: '/v2/wallet/balances' });

export const getPositions = (c: Creds | null) =>
  signed<Position[]>(c, { method: 'GET', path: '/v2/positions/margined' });
