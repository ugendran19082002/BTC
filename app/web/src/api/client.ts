import { reportError } from '@/lib/report-error';

export class NotSignedIn extends Error {
  constructor() {
    super('not signed in');
  }
}

/**
 * One place that knows how to talk to the API.
 *
 * A 401 becomes NotSignedIn rather than a generic failure, because the screen
 * has to tell those apart: one shows the login page, the other shows an error.
 */
export async function json<T>(url: string, init?: RequestInit): Promise<T> {
  // same origin, but be explicit: the session cookie is the only thing
  // standing between this page and anyone who knows the address
  let res: Response;
  try {
    res = await fetch(url, { credentials: 'same-origin', ...init });
  } catch (e) {
    // The network itself failed. A phone changing cell or wifi does this
    // several times a day, so it is a warning rather than an error -- but it
    // is still recorded, because it is invisible otherwise.
    reportError({ message: `network: ${(e as Error).message}`, where: url, code: 'network', level: 'warn' });
    throw e;
  }
  // Not signed in is a state, not a failure, and it must not fill the log.
  if (res.status === 401) throw new NotSignedIn();

  // A 200 whose body will not parse is a truncated response, not an error the
  // server chose to send. Saying "HTTP 200" hid that; naming it does not.
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    const message = res.ok
      ? `reply cut short — ${res.status} with no readable body`
      : `HTTP ${res.status}`;
    reportError({ message, where: url, code: String(res.status) });
    throw new Error(message);
  }

  const err = (body as { error?: string } | null)?.error;
  if (!res.ok || err) {
    const message = err ?? `HTTP ${res.status}`;
    // The server logs its own 5xx; this catches the ones it answers politely.
    if (res.ok || res.status >= 500) {
      reportError({ message, where: url, code: String(res.status), level: res.ok ? 'warn' : 'error' });
    }
    throw new Error(message);
  }
  return body as T;
}

export const post = <T>(url: string, payload: unknown) =>
  json<T>(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
