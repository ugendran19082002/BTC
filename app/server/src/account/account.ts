import { createHmac } from 'node:crypto';

/**
 * Optional authenticated access to the user's own Delta account.
 *
 * Read-only, and entirely opt-in: with no credentials in the environment every
 * call here refuses instead of guessing. Credentials are read from
 * DELTA_API_KEY / DELTA_API_SECRET at startup and are never logged, echoed in a
 * response, or written to disk. Nothing in this file can place or cancel an
 * order -- the desk only ever reads.
 */

const BASE = 'https://api.india.delta.exchange';

export type Creds = { key: string; secret: string };

export function credsFromEnv(): Creds | null {
  const key = process.env.DELTA_API_KEY?.trim();
  const secret = process.env.DELTA_API_SECRET?.trim();
  return key && secret ? { key, secret } : null;
}

/** Delta signs method + timestamp + path + query + body with HMAC-SHA256. */
function sign(secret: string, method: string, ts: string, path: string, query: string, body: string) {
  return createHmac('sha256', secret).update(method + ts + path + query + body).digest('hex');
}

export class NotConfigured extends Error {
  constructor() {
    super(
      'No Delta credentials configured. Set DELTA_API_KEY and DELTA_API_SECRET ' +
        'in app/server/.env to enable account endpoints. Market data needs no key.',
    );
  }
}

async function authed<T>(creds: Creds | null, path: string, query = ''): Promise<T> {
  if (!creds) throw new NotConfigured();
  const ts = Math.floor(Date.now() / 1000).toString();
  const res = await fetch(BASE + path + query, {
    method: 'GET',
    headers: {
      Accept: 'application/json',
      'api-key': creds.key,
      timestamp: ts,
      signature: sign(creds.secret, 'GET', ts, path, query, ''),
      'User-Agent': 'btc-options-desk/1.0',
    },
    signal: AbortSignal.timeout(20_000),
  });
  const body = (await res.json().catch(() => null)) as { success?: boolean; result?: T; error?: unknown } | null;
  if (!res.ok || !body || body.success === false) {
    // deliberately vague: an auth error body can echo request material back
    throw new Error(`Delta rejected the authenticated request (HTTP ${res.status})`);
  }
  return body.result as T;
}

export type Balance = { asset_symbol?: string; balance?: string; available_balance?: string };
export type Position = {
  product_symbol?: string;
  size?: number;
  entry_price?: string;
  realized_pnl?: string;
  unrealized_pnl?: string;
};

export const getBalances = (c: Creds | null) => authed<Balance[]>(c, '/v2/wallet/balances');
export const getPositions = (c: Creds | null) => authed<Position[]>(c, '/v2/positions/margined');
