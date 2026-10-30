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
export type Ledger = {
  from: string; to: string; account: number | null; accounts: { id: number; name: string }[]; busy: boolean; lastAutoAt: number | null;
  toleranceUsd: number; days: LedgerDay[];
  totals: { desk: Omit<DeskDay, 'open'>; delta: WalletDay | null; days: number; checked: number; matched: number; mismatched: number };
};

export const getLedger = (from: string, to: string, account: number | null) =>
  json<Ledger>(`/api/ledger?from=${from}&to=${to}${account === null ? '' : `&account=${account}`}`);

/** Check a day now: today without one, every account without one. */
export const syncLedger = (day: string | null, account: number | null) =>
  post<{ day: string; rows: unknown[] }>('/api/ledger/sync', { ...(day ? { day } : {}), ...(account === null ? {} : { accountId: account }) });
