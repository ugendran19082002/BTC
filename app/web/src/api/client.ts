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
 * When a run of failures on one endpoint counts as broken: at least three in a
 * row, AND failing for at least a minute.
 *
 * A single failed fetch is not evidence of a fault. A phone changing cell does
 * it, and so does a deploy. Counting alone was not enough either: on 10
 * September a laptop's connection dropped for fourteen seconds -- the web
 * server logged that browser abandoning three requests at the same instant --
 * the five-second chain poll failed three times in a row, and a row landed in
 * the log while another user was served normally throughout. A real outage
 * outlasts a hotspot reconnecting, and it is still recorded: the report goes
 * out as soon as the connection is back.
 */
const FAILURES_BEFORE_REPORTING = 3;
const OUTAGE_MS = 60_000;
const consecutive = new Map<string, { runs: number; since: number }>();

/** For tests, and for a page that has just been shown to be reachable again. */
export const forgetNetworkFailures = (): void => consecutive.clear();

/**
 * Whether a failed request right now says anything about the server.
 *
 * A phone that locks, switches apps or drops signal kills the requests in
 * flight, and the browser reports each as "Failed to fetch" -- or, when it cut
 * a reply off half way, as a body that will not parse. That was nearly every
 * row in the live error log on 10 September, and none of them were the desk.
 */
const pageCanReachNetwork = (): boolean =>
  (typeof document === 'undefined' || document.visibilityState !== 'hidden')
  && (typeof navigator === 'undefined' || navigator.onLine !== false);

/**
 * A request that hangs has to fail eventually, or the poll waiting on it never
 * runs again and the screen freezes on its last good answer. Generous, because
 * a cold historical chain legitimately takes a while.
 */
const TIMEOUT_MS = 60_000;

function networkFailure(path: string, url: string, message: string): void {
  if (!pageCanReachNetwork()) return;
  const now = Date.now();
  const prev = consecutive.get(path);
  const streak = { runs: (prev?.runs ?? 0) + 1, since: prev?.since ?? now };
  consecutive.set(path, streak);
  const failingMs = now - streak.since;
  if (streak.runs >= FAILURES_BEFORE_REPORTING && failingMs >= OUTAGE_MS) {
    reportError({
      message: `network: ${message}`,
      where: path,
      code: 'network',
      level: 'warn',
      context: { url, consecutiveFailures: streak.runs, failingForSeconds: Math.round(failingMs / 1000) },
    });
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
  const path = pathOf(url);
  let res: Response;
  try {
    const timeout = !init?.signal && typeof AbortSignal.timeout === 'function'
      ? AbortSignal.timeout(TIMEOUT_MS)
      : undefined;
    res = await fetch(url, { credentials: 'same-origin', ...(timeout ? { signal: timeout } : {}), ...init });
  } catch (e) {
    // The network itself failed. Once is a blip -- a phone changing cell, or
    // this very server restarting under a deploy -- and recording it teaches
    // whoever reads the log to ignore the log. Repeatedly is an outage, and
    // that is invisible unless it is written down.
    networkFailure(path, url, (e as Error).message);
    throw e;
  }
  // Not signed in is a state, not a failure, and it must not fill the log.
  if (res.status === 401) { consecutive.delete(path); throw new NotSignedIn(); }

  // A 200 whose body will not parse is a reply cut off in transit -- the same
  // dropped connection as a failed fetch, one step later -- so it is counted the
  // same way rather than reported the first time. Anything else is the server's.
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    const message = res.ok
      ? `reply cut short — ${res.status} with no readable body`
      : `HTTP ${res.status}`;
    if (res.ok) networkFailure(path, url, message);
    else reportError({ message, where: path, code: String(res.status), context: { url } });
    throw new Error(message);
  }
  // A whole reply arrived: the connection is not the problem.
  consecutive.delete(path);

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
