import { json, post } from '@/api/client';

/**
 * The ledger (server: ledger/ledger.ts, http/routes/ledger.routes.ts): each IST day as the desk booked it and as
 * Delta's wallet has it, judged -- checked by itself at 11:59 PM, and by hand from here.
 */

export type LedgerStatus = 'match' | 'mismatch' | 'open' | 'unread' | 'paper' | 'unchecked' | 'partial';
/** The desk's own day, in dollars: what the exits booked (profit, loss), what Delta charged on the fills, the net. */
export type DeskDay = { realisedUsd: number; profitUsd: number; lossUsd: number; chargesUsd: number; netUsd: number; trades: number; open: number };
/** Delta's wallet for the day, in dollars. `chargesUsd` is negative for money paid; `netUsd` = trading + charges + funding. */
export type WalletDay = {
  netUsd: number; tradingUsd: number; chargesUsd: number; fundingUsd: number; othersUsd: number; transfersUsd: number;
  openingUsd: number | null; closingUsd: number | null; entries: number; byType: Record<string, { n: number; usd: number }>;
  unknownTypes: string[]; otherAssets: number; complete: boolean;
};
export type LedgerDay = {
  day: string; desk: DeskDay; status: LedgerStatus; diffUsd: number | null; detail: string; delta: WalletDay | null;
  checkedDeskUsd: number | null; changed: boolean; checkedAt: number | null; how: 'auto' | 'manual' | null;
  perAccount?: { accountId: number; name: string; status: LedgerStatus; diffUsd: number | null }[];
};
/**
 * A sync asked for by hand, as the server keeps it (`ledger_syncs`): its days newest first, how many done, the one being
 * read; running, done, or failed with why. One runs at a time, whoever asked.
 */
export type LedgerSync = {
  id: number; accountId: number | null; days: string[]; total: number; done: number; day: string | null;
  status: 'running' | 'done' | 'failed'; error: string | null; resumed: number; startedAt: number; finishedAt: number | null;
};
export type Ledger = {
  from: string; to: string; account: number | null; accounts: { id: number; name: string }[]; busy: boolean; lastAutoAt: number | null;
  /** The sync running now, or the newest one; absent from an older server. */
  sync?: LedgerSync | null;
  toleranceUsd: number; days: LedgerDay[];
  totals: { desk: Omit<DeskDay, 'open'>; delta: WalletDay | null; days: number; checked: number; matched: number; mismatched: number };
};

export const getLedger = (from: string, to: string, account: number | null) =>
  json<Ledger>(`/api/ledger?from=${from}&to=${to}${account === null ? '' : `&account=${account}`}`);

/** What a sync asked for answers: the job, and `already` when one was running and that one is answered instead. */
export type SyncStarted = { sync: LedgerSync; already: boolean };

/** Sync a day: today without one, every account without one. A job, answered at once and followed on `getLedger`. */
export const syncLedger = (day: string | null, account: number | null) =>
  post<SyncStarted>('/api/ledger/sync', { ...(day ? { day } : {}), ...(account === null ? {} : { accountId: account }) });

/** Sync every day from `from` to `to` (30 Oct 2026, owner: "7 days chosen, sync all seven"): one job, newest day first. */
export const syncLedgerRange = (from: string, to: string, account: number | null) =>
  post<SyncStarted>('/api/ledger/sync', { from, to, ...(account === null ? {} : { accountId: account }) });

/** One trade of a ledger day (server: ledger/day-trades.ts): the whole trade's figures, in dollars. */
export type DayTrade = {
  tradeId: string; symbol: string; strike: number | null; optionSide: 'CE' | 'PE'; action: 'sell' | 'buy'; contracts: number;
  entryAt: number | null; exitAt: number | null; entryPrice: number | null; exitPrice: number | null;
  chargesUsd: number; grossUsd: number; netUsd: number;
  exitBy: 'perp-sl' | 'perp-tgt' | 'option-tgt' | 'option-sl' | 'window-end' | 'manual' | null;
  open: boolean; spans: boolean; strategy: string | null; account: { id: number; name: string } | null; orderIds: string[];
};
/** A ledger day's trades, newest exit first, and the day's own figures -- the ledger row's. */
export const getLedgerDay = (day: string, account: number | null) =>
  json<{ day: string; account: number | null; desk: DeskDay; trades: DayTrade[] }>(`/api/ledger/day?day=${day}${account === null ? '' : `&account=${account}`}`);
