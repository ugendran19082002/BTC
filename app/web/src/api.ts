import type { AccountResponse, BacktestResponse, ByYearResponse, ChainResponse, ExpiryOption, FloorResponse, Params } from './types';

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
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
) {
  const q = new URLSearchParams({
    at,
    width: String(width),
    minPremium: String(minPremium),
    hedgeGap: String(hedgeGap),
    lots: String(lots),
  });
  if (expiry) q.set('expiry', expiry);
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
