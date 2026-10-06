/**
 * The phone's reads beyond the glance (Level 2, 6 Oct 2026): one trade's journal, the strategies' activity, and
 * the closed trades' statistics. Every one a GET -- the phone's session can send nothing else -- and each asks for
 * one broker account by `account`, or every account with none.
 */
import { json } from '@/api/client';
import type { OrderHistory, OrderStatus, Trade } from '@/types/trade';
import type { StrategyStatus } from '@/types/strategy';
import type { DaysReport } from '@/types/report';
import type { EntryMethodInfo } from '@/api/entry';

const withAcct = (url: string, account: number | null) =>
  account === null ? url : `${url}${url.includes('?') ? '&' : '?'}account=${account}`;

/** One event of a trade's journal as the server keeps it (trading/types.ts `TradeEvent`): `t` says which. */
export type JournalEvent = { t: string; at: number } & Record<string, unknown>;

export type TradeDetail = { trade: Trade; events: JournalEvent[] };

export const getTradeDetail = (tradeId: string) =>
  json<TradeDetail>(`/api/trade/${encodeURIComponent(tradeId)}`);

/** Today's strategy runs, the signals the signal strategies saw, and the strategies' names. */
export const getActivity = (account: number | null) => json<StrategyStatus>(withAcct('/api/strategies', account));

/** One group of closed trades (server: trading/pnl-history.ts `TradeStatsGroup`), named for the screen. */
export type StatsGroup = {
  key: string; name?: string; trades: number; wins: number; losses: number; winRate: number | null;
  grossProfitUsd: number; grossLossUsd: number; profitFactor: number | null;
  avgWinUsd: number | null; avgLossUsd: number | null; netUsd: number; bestUsd: number | null; worstUsd: number | null;
};
export type Stats = {
  mode: 'live' | 'paper'; from: string; to: string; overall: StatsGroup;
  byStrategy: StatsGroup[]; byAccount: StatsGroup[];
  /** CE / PE, sold / bought, and a signal trade's entry method. Absent from an older server. */
  byOption?: StatsGroup[]; byAction?: StatsGroup[]; byMethod?: StatsGroup[];
};

export const getStats = (from: string, to: string, account: number | null) =>
  json<Stats>(withAcct(`/api/report/stats?from=${from}&to=${to}`, account));

export const getDaysFor = (from: string, to: string, account: number | null) =>
  json<DaysReport>(withAcct(`/api/report/days?from=${from}&to=${to}`, account));

/** The entry methods' names by id, read once: a signal is shown by name, not by its id. */
let methods: Promise<Map<string, EntryMethodInfo>> | null = null;
export function methodNames(): Promise<Map<string, EntryMethodInfo>> {
  methods ??= json<{ methods: EntryMethodInfo[] }>('/api/entry/methods')
    .then((r) => new Map(r.methods.map((m) => [m.id, m])))
    .catch((e) => { methods = null; throw e; });
  return methods;
}

/** The order book, looking backwards, for IST days: every trade opened in them, with its status and outcome. */
export const getOrders = (from: string, to: string, account: number | null, status: OrderStatus | null = null) =>
  json<OrderHistory>(withAcct(`/api/trade/history?from=${from}&to=${to}${status ? `&status=${status}` : ''}`, account));

/** What the desk tried to send to Telegram: sent, failed, or held back as a repeat. */
export type TelegramEntry = { id: number; at: number; key: string; status: 'sent' | 'failed' | 'repeat'; text: string; error: string | null };
export const getTelegramLog = (limit = 30) =>
  json<{ configured: boolean; on: boolean; entries: TelegramEntry[] }>(`/api/telegram/log?limit=${limit}`);
