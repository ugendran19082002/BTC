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

/**
 * Delta said we are asking too often.
 *
 * Kept apart from an ordinary refusal because the response is different: an
 * ordinary refusal means stop, this one means wait. The header says how long.
 */
export class RateLimited extends Error {
  constructor(readonly retryAfterMs: number) {
    super(`Delta rate limit reached; ${Math.ceil(retryAfterMs / 1000)}s until it resets.`);
    this.name = 'RateLimited';
  }
}

/** Delta answered and said no, with a reason. Nothing was created. */
export class DeltaRefused extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    /** Delta's own detail: which field it disliked, and why. */
    readonly detail: string | null = null,
  ) {
    super(message);
    this.name = 'DeltaRefused';
  }
}

/**
 * Delta answered with a success status, and the answer could not be read: a
 * body that is not JSON, or one cut off on the way.
 *
 * Not a refusal. On 10 September a 3.7 MB product list arrived as HTTP 200 and
 * would not parse, and the log called it "Delta refused the request (http_200)",
 * which sends whoever reads it looking for a field Delta disliked. For a read it
 * is worth asking again; for a write it means what silence means: unknown.
 */
export class UnreadableReply extends Error {
  constructor(readonly path: string, readonly status: number) {
    super(`Delta's reply to ${path} could not be read (HTTP ${status}).`);
    this.name = 'UnreadableReply';
  }
}

/**
 * Turn Delta's error context into one readable line.
 *
 * A bare "bad_schema" is almost useless -- it says the request was wrong
 * without saying which part. The context names the field, and a field name is
 * not a secret: it is something we sent. Values are dropped anyway, because a
 * rejected auth attempt can echo request material back.
 */
function describe(context: unknown): string | null {
  if (!context || typeof context !== 'object') return null;
  const c = context as Record<string, unknown>;
  const fields = c.error_fields ?? c.fields ?? c.schema_errors ?? null;
  if (Array.isArray(fields) && fields.length) {
    return fields
      .map((f) => (typeof f === 'string' ? f : (f as { field?: string })?.field ?? null))
      .filter(Boolean)
      .join(', ') || null;
  }
  if (typeof fields === 'object' && fields !== null) return Object.keys(fields).join(', ') || null;
  return null;
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

  // The quota is 20,000 per five minutes and this desk polls well inside it,
  // but a burst -- a reconnect, several tabs, a retry storm -- can still land
  // on it, and the header says exactly how long to wait.
  if (res.status === 429) {
    const reset = Number(res.headers.get('X-RATE-LIMIT-RESET') ?? 0);
    throw new RateLimited(Number.isFinite(reset) && reset > 0 ? reset : 5_000);
  }

  const parsed = (await res.json().catch(() => null)) as
    | { success?: boolean; result?: T; error?: { code?: string; context?: unknown } }
    | null;

  // A success status whose body will not parse is not Delta saying no.
  if (res.ok && !parsed) throw new UnreadableReply(path, res.status);

  if (!res.ok || !parsed || parsed.success === false) {
    const code = parsed?.error?.code ?? `http_${res.status}`;
    const detail = describe(parsed?.error?.context);
    // The code is what a caller branches on; the field names are what a person
    // needs to fix it. Values are still left out.
    throw new DeltaRefused(
      res.status,
      code,
      detail ? `Delta refused the request (${code}: ${detail}).` : `Delta refused the request (${code}).`,
      detail,
    );
  }
  return parsed.result as T;
}
