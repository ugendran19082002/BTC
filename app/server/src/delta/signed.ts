import { createHmac } from 'node:crypto';

/**
 * Signed transport for the user's own Delta Exchange India account.
 *
 * One place signs, one place times out, one place decides what an error means.
 * Everything authenticated -- reading a balance, placing an order, cancelling
 * one -- goes through here, so there is exactly one piece of code that has to
 * be right about the signature and about never echoing a secret.
 */

export const BASE = 'https://api.india.delta.exchange';

export type Creds = { key: string; secret: string };

export function credsFromEnv(): Creds | null {
  const key = process.env.DELTA_API_KEY?.trim();
  const secret = process.env.DELTA_API_SECRET?.trim();
  return key && secret ? { key, secret } : null;
}

export class NotConfigured extends Error {
  constructor() {
    super(
      'No Delta credentials configured. Set DELTA_API_KEY and DELTA_API_SECRET ' +
        'in app/server/.env to enable account endpoints. Market data needs no key.',
    );
  }
}

/** The request left and no answer came back. This is NOT the same as failure. */
export class RequestTimedOut extends Error {
  constructor(readonly path: string) {
    super(`No answer from Delta for ${path}.`);
    this.name = 'RequestTimedOut';
  }
}

/** Delta answered and said no, with a reason. Nothing was created. */
export class DeltaRefused extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = 'DeltaRefused';
  }
}

/** Delta signs method + timestamp + path + query + body with HMAC-SHA256. */
function sign(secret: string, method: string, ts: string, path: string, query: string, body: string) {
  return createHmac('sha256', secret).update(method + ts + path + query + body).digest('hex');
}

export type SignedRequest = {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  path: string;
  /** Including the leading `?`, or empty. */
  query?: string;
  body?: unknown;
  timeoutMs?: number;
};

export async function signed<T>(creds: Creds | null, req: SignedRequest): Promise<T> {
  if (!creds) throw new NotConfigured();
  const { method, path, query = '', body } = req;
  const payload = body === undefined ? '' : JSON.stringify(body);
  const ts = Math.floor(Date.now() / 1000).toString();

  let res: Response;
  try {
    res = await fetch(BASE + path + query, {
      method,
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'api-key': creds.key,
        timestamp: ts,
        signature: sign(creds.secret, method, ts, path, query, payload),
        'User-Agent': 'btc-options-desk/1.0',
      },
      body: payload === '' ? undefined : payload,
      signal: AbortSignal.timeout(req.timeoutMs ?? 20_000),
    });
  } catch (e) {
    // A timeout or a dropped socket says nothing about whether the exchange
    // acted on the request. Callers that write must treat this as "unknown".
    throw new RequestTimedOut(path);
  }

  const parsed = (await res.json().catch(() => null)) as
    | { success?: boolean; result?: T; error?: { code?: string; context?: unknown } }
    | null;

  if (!res.ok || !parsed || parsed.success === false) {
    const code = parsed?.error?.code ?? `http_${res.status}`;
    // Deliberately narrow: an auth error body can echo request material back,
    // and the code is the part a caller can actually branch on.
    throw new DeltaRefused(res.status, code, `Delta refused the request (${code}).`);
  }
  return parsed.result as T;
}
