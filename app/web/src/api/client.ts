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
  const res = await fetch(url, { credentials: 'same-origin', ...init });
  if (res.status === 401) throw new NotSignedIn();
  const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
  if (!res.ok || (body as { error?: string }).error) {
    throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
  }
  return body as T;
}

export const post = <T>(url: string, payload: unknown) =>
  json<T>(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
