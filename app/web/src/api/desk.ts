import type { ChainResponse, ExpiryOption } from '@/types/desk';
import { json, post } from '@/api/client';

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

export function getHealth() {
  return json<{ ok: boolean; days: number; now: string }>('/api/health');
}

/** Just the price. Tiny, so it can be polled every second. */
export const getSpot = () => json<{ spot: number; at: number }>('/api/spot');

/**
 * The total-short cap: what is in force, what the margin would allow, and what
 * the desk was asked to hold itself to.
 *
 * `ceiling` is null until the server has seen both a spot and a balance.
 */
export type ShortCap = { inForce: number; ceiling: number | null; chosen: number | null };

export const getSettings = () =>
  json<{ settings: Record<string, string | null>; shortCap: ShortCap }>('/api/settings');

/**
 * Ask the desk to hold itself to a smaller total short.
 *
 * The server decides -- it refuses anything above what the margin covers -- so
 * the answer, not the request, is what the screen shows afterwards.
 */
export const setShortCap = (contracts: number) =>
  post<{ ok: true; key: string; value: string; shortCap: ShortCap }>('/api/settings', {
    key: 'max_short_contracts',
    value: String(contracts),
  });
