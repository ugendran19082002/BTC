import { json, post } from './client';

/** A broker account as the server shows it: never the key, never the secret -- the key's last four characters. */
export type BrokerAccount = {
  id: number;
  name: string;
  description: string;
  broker: 'delta-india';
  keyHint: string;
  active: boolean;
  /** The default: the account whose tab opens first. Every account that is switched on trades, default or not. */
  isDefault: boolean;
  /** It is trading: switched on, its key readable, a desk of its own running on the server. */
  trading?: boolean;
  /** False when the server can no longer read its key (the server's master secret changed): remove it and add it again. */
  readable: boolean;
  createdAt: number;
  updatedAt: number;
  lastTest: { at: number; ok: boolean; detail: string } | null;
  /** Why it cannot be removed, when it cannot: the last account, one with trades or strategies on record, the one the desk is live on. */
  keptBecause?: string | null;
};
export type AccountsAnswer = {
  accounts: BrokerAccount[];
  max: number;
  /** False when the server cannot encrypt a key, so none can be added. */
  canStore: boolean;
  mode: 'live' | 'paper';
  /** The server's `.env` still has the key it imported: no longer read, and to be emptied there. */
  envKeyLeft?: boolean;
  /** After a connection test: what Delta said. */
  test?: { id: number; ok: boolean; detail: string };
};

export const getAccounts = () => json<AccountsAnswer>('/api/accounts');

/** One account as Delta has it now, read with its own key: for the account the desk is not trading on. */
export type AccountSummary = {
  id: number;
  wallet: { balance: number; available: number } | null;
  positions: { symbol: string; size: number; entryPrice: number | null; unrealisedPnl: number | null }[];
  /** What the journal holds for it. */
  trades: number;
  strategies: number;
  /** Why there is no wallet to show, when there is none. */
  note: string | null;
};
export const getAccountSummary = (id: number) => json<AccountSummary>(`/api/accounts/${id}/summary`);
/** Save an account. The key and the secret go one way: no answer ever carries them back. */
export const addAccount = (a: { name: string; description: string; apiKey: string; apiSecret: string }) =>
  post<AccountsAnswer>('/api/accounts', { name: a.name, description: a.description, api_key: a.apiKey, api_secret: a.apiSecret });
export const renameAccount = (id: number, a: { name: string; description: string }) => post<AccountsAnswer>(`/api/accounts/${id}`, a);
export const testAccount = (id: number) => post<AccountsAnswer>(`/api/accounts/${id}/test`, {});
export const setAccountActive = (id: number, active: boolean) => post<AccountsAnswer>(`/api/accounts/${id}/active`, { active });
export const makeAccountDefault = (id: number) => post<AccountsAnswer>(`/api/accounts/${id}/default`, {});
/** Remove an account and its key for good. `code`: a fresh 6-digit authenticator code -- the server removes nothing without one. */
export const removeAccount = (id: number, code: string) => post<AccountsAnswer>(`/api/accounts/${id}/remove`, { code });
