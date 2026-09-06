import type { AccountResponse, BacktestResponse, ByYearResponse, ChainResponse, ExpiryOption, FloorResponse, Params } from './types';

export class NotSignedIn extends Error {
  constructor() {
    super('not signed in');
  }
}

async function json<T>(url: string, init?: RequestInit): Promise<T> {
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

export function getChain(
  at: string,
  width: number,
  minPremium: number,
  hedgeGap: number,
  lots: number,
  expiry?: string,
  requireHedge = false,
  mode: 'premium' | 'safety' = 'premium',
  safetyBar = 0.99,
) {
  const q = new URLSearchParams({
    at,
    width: String(width),
    minPremium: String(minPremium),
    hedgeGap: String(hedgeGap),
    lots: String(lots),
  });
  if (expiry) q.set('expiry', expiry);
  if (requireHedge) q.set('requireHedge', '1');
  if (mode === 'safety') {
    q.set('mode', 'safety');
    q.set('safetyBar', String(safetyBar));
  }
  return json<ChainResponse>(`/api/chain?${q}`);
}

export function getExpiries() {
  return json<{ expiries: ExpiryOption[] }>('/api/expiries');
}

export function runBacktest(params: Partial<Params>) {
  return json<BacktestResponse>('/api/backtest', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
}

export function runByYear(params: Partial<Params>) {
  return json<ByYearResponse>('/api/backtest/byyear', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
}

export function getHealth() {
  return json<{ ok: boolean; days: number; now: string }>('/api/health');
}

export function runFloors(params: Partial<Params> & { floors?: number[] }) {
  return json<FloorResponse>('/api/floors', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
}

/** 501 here is not an error: it is the server saying no key is configured. */
export async function getAccount(): Promise<AccountResponse> {
  const res = await fetch('/api/account');
  return (await res.json()) as AccountResponse;
}

export function getMe() {
  return json<{ required: boolean; signedIn: boolean; username: string | null }>('/api/me');
}

export async function login(username: string, password: string) {
  const res = await fetch('/api/login', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  const body = (await res.json().catch(() => ({}))) as { error?: string; username?: string };
  if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
  return body;
}

export function logout() {
  return fetch('/api/logout', { method: 'POST', credentials: 'same-origin' });
}
