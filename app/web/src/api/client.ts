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
    // The network itself failed. Worth a row: it is invisible otherwise.
    reportError({ message: `network: ${(e as Error).message}`, where: url, code: 'network' });
    throw e;
  }
  // Not signed in is a state, not a failure, and it must not fill the log.
  if (res.status === 401) throw new NotSignedIn();
  const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
  if (!res.ok || (body as { error?: string }).error) {
    const message = (body as { error?: string }).error ?? `HTTP ${res.status}`;
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
