import { json, post } from '@/api/client';
import type {
  AddDraft, AddPreview, ClosePreview, OrderDraft, OrderHistory, PlaceResult, PrecheckFailure, PremiumAlert, Preview, Quote, ProductSpec, Trade, TradeStatus,
} from '@/types/trade';

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

/**
 * Ask the server to change mode. It may say no -- while a position is open, the
 * answer is always no -- so the reason comes back with the refusal.
 */
export async function setTradeMode(mode: 'live' | 'paper') {
  const res = await fetch('/api/trade/mode', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode }),
  });
  return (await res.json()) as
    | { ok: true; mode: 'live' | 'paper' }
    | { ok: false; mode: 'live' | 'paper'; reason: string };
}

/**
 * Adding to a position, in the same two steps as the ticket: the preview and
 * the add send the same body to the same gates. Both answer 422 with reasons
 * rather than failing, so the reasons are read, not thrown away.
 */
const refusable = async <T,>(path: string, body: unknown): Promise<T> => {
  const res = await fetch(path, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const out = (await res.json()) as T & { error?: string };
  if (!res.ok && res.status !== 422) throw new Error(out.error ?? `HTTP ${res.status}`);
  return out;
};

export const previewAdd = (draft: AddDraft) => refusable<AddPreview>('/api/trade/add/preview', draft);

/** The second call in the app that can create risk. */
export const addToPosition = (draft: AddDraft) =>
  refusable<
    | { mode: 'live' | 'paper'; ok: true; trade: Trade }
    | { mode: 'live' | 'paper'; ok: false; error: string; failures: PrecheckFailure[] }
  >('/api/trade/add', draft);

/**
 * Buy back at the market. `lots` left out means the whole position -- what
 * this call has always meant, and what the sheet opens on.
 */
export const closeTrade = (tradeId: string, lots?: number) =>
  post<{ ok: true; trade: Trade }>('/api/trade/close', lots === undefined ? { tradeId } : { tradeId, lots });

/** What closing that many would book. Nothing is sent. */
export const previewClose = (tradeId: string, lots?: number) =>
  post<ClosePreview>('/api/trade/close/preview', lots === undefined ? { tradeId } : { tradeId, lots });

/**
 * Stop a working add now, keeping whatever it has already sold.
 *
 * The same path its own window takes when it closes, so a person stopping an
 * add and the clock stopping one leave the same record.
 */
export const cancelAdd = (tradeId: string) =>
  post<{ ok: true; trade: Trade }>('/api/trade/add/cancel', { tradeId });

/**
 * Fill alerts on or off.
 *
 * Nothing about the trading engine changes: positions still open, protect and
 * close exactly as before. Only the messages stop.
 */
export const setAlerts = (on: boolean) =>
  post<{ ok: true; alerts: { configured: boolean; on: boolean } }>('/api/trade/alerts', { on });

/** The premium alerts set in the last day, fired or not, and whether Telegram will carry them. */
export const getPremiumAlerts = () =>
  json<{ alerts: PremiumAlert[]; telegram: { configured: boolean; on: boolean } }>('/api/trade/premium-alerts');

/** "Tell me when this strike's bid reaches `threshold`." Fires once, over Telegram. */
export const addPremiumAlert = (symbol: string, threshold: number) =>
  post<{ ok: true; alert: PremiumAlert }>('/api/trade/premium-alerts', { symbol, threshold });

export const deletePremiumAlert = (id: number) =>
  json<{ ok: true }>(`/api/trade/premium-alerts/${id}`, { method: 'DELETE' });

/** Pull a working order off the book. Refused once anything has filled. */
export const cancelTrade = (tradeId: string) =>
  post<{ ok: true; trade: Trade }>('/api/trade/cancel', { tradeId });

/**
 * Square off everything. Reports per trade, because a partial result is the
 * common one and a single tick would hide a position still on.
 */
export const closeAllTrades = () =>
  post<{
    ok: boolean;
    cancelled: string[];
    closed: string[];
    failed: { tradeId: string; reason: string }[];
  }>('/api/trade/close-all', {});

/** Move the stop or the target on a position that is already open. */
export const updateExits = (tradeId: string, pct: { takeProfitPct?: number; stopLossPct?: number }) =>
  post<{ ok: true; trade: Trade }>('/api/trade/protection', { tradeId, ...pct });

export const reconcileTrade = (tradeId: string) =>
  post<{ ok: true; trade: Trade }>('/api/trade/reconcile', { tradeId });

/**
 * The order book over a date range.
 *
 * Both dates are IST calendar days and both default to today on the server, so
 * calling it with nothing is the common case rather than a special one.
 */
export function getOrderHistory(opts: { from?: string; to?: string; status?: string } = {}) {
  const q = new URLSearchParams();
  if (opts.from) q.set('from', opts.from);
  if (opts.to) q.set('to', opts.to);
  if (opts.status) q.set('status', opts.status);
  return json<OrderHistory>(`/api/trade/history?${q}`);
}
