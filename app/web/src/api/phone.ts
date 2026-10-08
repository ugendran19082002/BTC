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

/**
 * What the phone's filters keep: strategies by id (`manual` for trades by hand), entry methods by id, and the
 * timeframes a signal trade was read on (`15m`; `chain` for the timeframe chain). None of any is every trade.
 */
export type TradeFilter = { strategies?: readonly string[]; methods?: readonly string[]; timeframes?: readonly string[] };
const listed = (name: string, keys: readonly string[] | undefined) => (keys && keys.length ? `&${name}=${keys.map(encodeURIComponent).join(',')}` : '');
/** `&strategy=a,b&method=c&tf=15m,chain` for what is chosen; nothing for nothing chosen. */
const filtered = (f: TradeFilter | undefined) => listed('strategy', f?.strategies) + listed('method', f?.methods) + listed('tf', f?.timeframes);

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
  /** A signal trade's entry method on the timeframe it was read on (`15m`, `5m + TF chain`), best first. Absent from an older server. */
  byPair?: (StatsGroup & { tf: string })[];
  /**
   * The strategies there are to choose from (8 Oct 2026): every one with a trade closed in the range, whatever was
   * asked for, and any asked for that has none. `manual` is the trades nobody scheduled. Absent from an older
   * server, which does not filter either -- so the phone offers no filter there.
   */
  strategies?: { key: string; name: string; trades: number; netUsd: number }[];
  /** The entry methods to choose from, the same way: those of the strategies chosen, not narrowed by the methods chosen. */
  methods?: { key: string; name: string; trades: number; netUsd: number }[];
  /** The timeframes to choose from, the same way, in the desk's order: `15m`, `1h` ... and `chain`, "With timeframe chain", last. */
  timeframes?: { key: string; name: string; trades: number; netUsd: number }[];
};

/** `filter`: only the trades of the strategies and the entry methods it names. Absent or empty: every trade. */
export const getStats = (from: string, to: string, account: number | null, filter?: TradeFilter) =>
  json<Stats>(withAcct(`/api/report/stats?from=${from}&to=${to}${filtered(filter)}`, account));

export const getDaysFor = (from: string, to: string, account: number | null, filter?: TradeFilter) =>
  json<DaysReport>(withAcct(`/api/report/days?from=${from}&to=${to}${filtered(filter)}`, account));

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
