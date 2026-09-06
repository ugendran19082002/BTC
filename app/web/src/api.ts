import type { BacktestResponse, ByYearResponse, ChainResponse, FloorResponse, Params } from './types';

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
  if (!res.ok || (body as { error?: string }).error) {
    throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
  }
  return body as T;
}

export function getChain(at: string, width: number, minPremium: number, hedgeGap: number) {
  const q = new URLSearchParams({
    at,
    width: String(width),
    minPremium: String(minPremium),
    hedgeGap: String(hedgeGap),
  });
  return json<ChainResponse>(`/api/chain?${q}`);
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
