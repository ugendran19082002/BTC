import { json, post } from './client';

/** A broker account as the server shows it: never the key, never the secret -- the key's last four characters. */
export type BrokerAccount = {
  id: number;
  name: string;
  description: string;
  broker: 'delta-india';
  keyHint: string;
  active: boolean;
  /** The account the desk trades on. */
  isDefault: boolean;
  /** False when the server can no longer read its key (the server's master secret changed): remove it and add it again. */
  readable: boolean;
  createdAt: number;
  updatedAt: number;
  lastTest: { at: number; ok: boolean; detail: string } | null;
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
/** Save an account. The key and the secret go one way: no answer ever carries them back. */
export const addAccount = (a: { name: string; description: string; apiKey: string; apiSecret: string }) =>
  post<AccountsAnswer>('/api/accounts', { name: a.name, description: a.description, api_key: a.apiKey, api_secret: a.apiSecret });
export const renameAccount = (id: number, a: { name: string; description: string }) => post<AccountsAnswer>(`/api/accounts/${id}`, a);
export const testAccount = (id: number) => post<AccountsAnswer>(`/api/accounts/${id}/test`, {});
export const setAccountActive = (id: number, active: boolean) => post<AccountsAnswer>(`/api/accounts/${id}/active`, { active });
export const makeAccountDefault = (id: number) => post<AccountsAnswer>(`/api/accounts/${id}/default`, {});
export const removeAccount = (id: number) => json<AccountsAnswer>(`/api/accounts/${id}`, { method: 'DELETE' });
