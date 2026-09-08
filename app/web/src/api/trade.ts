import { json, post } from '@/api/client';
import type { OrderDraft, PlaceResult, Preview, Quote, ProductSpec, Trade, TradeStatus } from '@/types/trade';

/**
 * The order desk.
 *
 * `preview` and `place` send the same body to the same gates, so what the
 * screen shows before you tap is what the server will decide when you do.
 */

export const getTradeStatus = () => json<TradeStatus>('/api/trade/status');

export const getTradeQuote = (symbol: string) =>
  json<{ quote: Quote | null; product: ProductSpec | null }>(
    `/api/trade/quote?symbol=${encodeURIComponent(symbol)}`,
  );

export const previewOrder = (draft: OrderDraft) => post<Preview>('/api/trade/preview', draft);

/** The only call in the app that can create risk. */
export async function placeOrder(draft: OrderDraft): Promise<PlaceResult> {
  const res = await fetch('/api/trade/place', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(draft),
  });
  // 422 is a refusal with reasons, not a failure to communicate: the body is
  // the thing worth showing, so it is not thrown away as an error.
  const body = (await res.json()) as PlaceResult & { error?: string };
  if (!res.ok && res.status !== 422) throw new Error(body.error ?? `HTTP ${res.status}`);
  return body;
}

export const closeTrade = (tradeId: string) => post<{ ok: true; trade: Trade }>('/api/trade/close', { tradeId });

export const reconcileTrade = (tradeId: string) =>
  post<{ ok: true; trade: Trade }>('/api/trade/reconcile', { tradeId });

export const getTradeHistory = (limit = 50) =>
  json<{ trades: Trade[] }>(`/api/trade/history?limit=${limit}`);
