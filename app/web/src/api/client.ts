import { reportError } from '@/lib/report-error';

export class NotSignedIn extends Error {
  constructor() {
    super('not signed in');
  }
}

/**
 * The path without its query string.
 *
 * The chain is polled with eight parameters in the URL, so using the whole
 * thing to say *where* a failure happened made a separate row in the error log
 * for every combination of width, expiry and premium floor anyone had ever
 * looked at. It is one endpoint. The parameters are worth keeping, but as
 * context on the row rather than as part of its identity.
 */
export const pathOf = (url: string): string => url.split('?')[0] ?? url;

/**
 * How many times in a row a request has to fail before it counts as broken.
 *
 * A single failed fetch is not evidence of a fault. A phone changing cell does
 * it, and so does a deploy: the four `Failed to fetch` rows in the live log
 * were the poll running while the container restarted, which is the desk
 * working exactly as intended. Waiting for a third consecutive failure is still
 * only a few seconds at a one-second poll, so a real outage is recorded while a
 * blip is not.
 */
const FAILURES_BEFORE_REPORTING = 3;
const consecutive = new Map<string, number>();

/** For tests, and for a page that has just been shown to be reachable again. */
export const forgetNetworkFailures = (): void => consecutive.clear();

/**
 * One place that knows how to talk to the API.
 *
 * A 401 becomes NotSignedIn rather than a generic failure, because the screen
 * has to tell those apart: one shows the login page, the other shows an error.
 */
export async function json<T>(url: string, init?: RequestInit): Promise<T> {
  // same origin, but be explicit: the session cookie is the only thing
  // standing between this page and anyone who knows the address
  const path = pathOf(url);
  let res: Response;
  try {
    res = await fetch(url, { credentials: 'same-origin', ...init });
  } catch (e) {
    // The network itself failed. Once is a blip -- a phone changing cell, or
    // this very server restarting under a deploy -- and recording it teaches
    // whoever reads the log to ignore the log. Repeatedly is an outage, and
    // that is invisible unless it is written down.
    const runs = (consecutive.get(path) ?? 0) + 1;
    consecutive.set(path, runs);
    if (runs >= FAILURES_BEFORE_REPORTING) {
      reportError({
        message: `network: ${(e as Error).message}`,
        where: path,
        code: 'network',
        level: 'warn',
        context: { url, consecutiveFailures: runs },
      });
    }
    throw e;
  }
  // It answered, whatever it answered: the connection is not the problem.
  consecutive.delete(path);
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
    reportError({ message, where: path, code: String(res.status), context: { url } });
    throw new Error(message);
  }

  const err = (body as { error?: string } | null)?.error;
  if (!res.ok || err) {
    const message = err ?? `HTTP ${res.status}`;
    // The server logs its own 5xx; this catches the ones it answers politely.
    if (res.ok || res.status >= 500) {
      reportError({
        message, where: path, code: String(res.status),
        level: res.ok ? 'warn' : 'error', context: { url },
      });
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
