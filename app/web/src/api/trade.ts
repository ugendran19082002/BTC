import { json, post } from '@/api/client';
import { accountScope } from '@/lib/account-scope';
import { getAccounts } from '@/api/accounts';
import { mergeStatuses } from '@/lib/merge-status';
import type {
  AddDraft, AddPreview, ClosePreview, OrderDraft, OrderHistory, PlaceResult, PrecheckFailure, Preview, Quote, ProductSpec, Trade, TradeStatus,
} from '@/types/trade';

/**
 * The order desk.
 *
 * `preview` and `place` send the same body to the same gates, so what the
 * screen shows before you tap is what the server will decide when you do.
 */

/** One account's desk as it stands: `account` names it; with none, the default account's (the one the stream carries too). */
export const getTradeStatus = (account?: number | null) =>
  json<TradeStatus>(account == null ? '/api/trade/status' : `/api/trade/status?account=${account}`);

/** Several accounts' desks added together (lib/merge-status.ts): each asked for its own status, at once. */
export const getStatusOfAccounts = async (accounts: readonly { id: number; name: string }[]): Promise<TradeStatus | null> =>
  mergeStatuses(await Promise.all(accounts.map(async (a) => ({ account: { id: a.id, name: a.name }, status: await getTradeStatus(a.id) }))));

/**
 * The live figures of what the account tabs are showing: one account's own desk, or -- on "All accounts" --
 * every trading account's added together. Null for an account that is switched off: it has no desk, and asking
 * for its status would answer with the default account's.
 */
export async function getShownStatus(): Promise<TradeStatus | null> {
  const { accounts } = await getAccounts();
  const trading = accounts.filter((a) => a.active && a.trading !== false);
  const scope = accountScope();
  if (scope !== null) return trading.some((a) => a.id === scope) ? getTradeStatus(scope) : null;
  // No accounts at all (a desk from before them), or one: that desk's own answer.
  if (trading.length <= 1) return getTradeStatus(trading[0]?.id);
  return getStatusOfAccounts(trading);
}

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

/** Pull a working order off the book. Refused once anything has filled. */
export const cancelTrade = (tradeId: string) =>
  post<{ ok: true; trade: Trade }>('/api/trade/cancel', { tradeId });

/**
 * Square off everything on the account being shown. Reports per trade, because a partial result is the
 * common one and a single tick would hide a position still on.
 *
 * The account is named (5 Oct 2026): sent with nothing, the server squared off the default account whichever
 * tab the button was on. With no account chosen ("All accounts") the screen shows the default account's
 * positions, and those are what close.
 */
export const closeAllTrades = () =>
  post<{
    ok: boolean;
    cancelled: string[];
    closed: string[];
    failed: { tradeId: string; reason: string }[];
  }>('/api/trade/close-all', accountScope() === null ? {} : { accountId: accountScope() });

/**
 * Square off the accounts named, one after another -- the "All accounts" tab, where every account's positions
 * are on the screen. One account failing does not stop the next; each one's own report is added to the answer.
 */
export async function closeAllOnAccounts(ids: readonly number[]) {
  const out = { ok: true, cancelled: [] as string[], closed: [] as string[], failed: [] as { tradeId: string; reason: string }[] };
  for (const id of ids) {
    try {
      const r = await post<{ ok: boolean; cancelled: string[]; closed: string[]; failed: { tradeId: string; reason: string }[]; error?: string }>(
        '/api/trade/close-all', { accountId: id });
      out.cancelled.push(...(r.cancelled ?? []));
      out.closed.push(...(r.closed ?? []));
      out.failed.push(...(r.failed ?? []));
    } catch (e) {
      out.failed.push({ tradeId: `account ${id}`, reason: (e as Error).message });
    }
  }
  out.ok = out.failed.length === 0;
  return out;
}

/** Move the stop or the target on a position that is already open. */
export const updateExits = (
  tradeId: string,
  ask: {
    takeProfitPct?: number; stopLossPct?: number; takeProfitPoints?: number; stopLossPoints?: number;
    /** The levels themselves, when typed as prices. */
    takeProfitPrice?: number; stopPrice?: number;
  },
) => post<{ ok: true; trade: Trade }>('/api/trade/protection', { tradeId, ...ask });

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
  // The orders of the broker account being shown; with none chosen, every account's.
  if (accountScope() !== null) q.set('account', String(accountScope()));
  return json<OrderHistory>(`/api/trade/history?${q}`);
}

/** One Telegram message the desk tried to send, and what became of it. */
export type TelegramLogEntry = { id: number; at: number; key: string; status: 'sent' | 'failed' | 'repeat'; text: string; error: string | null };
/** The Telegram log, newest first; `status` narrows it. */
export const getTelegramLog = (status?: TelegramLogEntry['status'], limit = 200) =>
  json<{ configured: boolean; on: boolean; entries: TelegramLogEntry[] }>(
    `/api/telegram/log?limit=${limit}${status ? `&status=${status}` : ''}`);
