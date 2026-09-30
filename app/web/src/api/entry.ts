import { json, post } from './client';
import type { EntryAlerts, EntryBoard, EntryGateSetting, EntryMode, EntryRecordResponse, EntrySignalPage, EntryTf } from '@/types/entry';

/** The 24 reads: with the timeframe chain (entry on 5m), and without it on `tf`. */
export const getEntryBoard = (tf: EntryTf = '5m') => json<EntryBoard>(`/api/entry/board?tf=${tf}`);

/** Each method's paper record, with the chain and without it, and the latest setups. */
export const getEntryRecord = () => json<EntryRecordResponse>('/api/entry/record');

/** The hard gates' switches. */
export const getEntryGates = () => json<{ gates: EntryGateSetting[] }>('/api/entry/gates');

/** Switch one gate on or off; answers with the whole list as it now stands. Data fresh is refused (422). */
export const setEntryGate = (key: string, enabled: boolean) =>
  post<{ gates: EntryGateSetting[] }>(`/api/entry/gates/${encodeURIComponent(key)}`, { enabled });

/** Telegram alerts for each way's TRADEs, and whether Telegram is set up on the server. */
export const getEntryAlerts = () => json<EntryAlerts>('/api/entry/alerts');

/** Switch one way's alerts on or off; without the chain, `tfs` chooses the timeframes it alerts on. */
export const setEntryAlert = (mode: EntryMode, enabled: boolean, tfs?: EntryTf[]) =>
  post<EntryAlerts>(`/api/entry/alerts/${mode}`, tfs ? { enabled, tfs } : { enabled });

/** Send a test message now (409 when Telegram is not set up). */
export const sendEntryAlertTest = () => post<{ ok: true }>('/api/entry/alerts/test', {});

/** One page of the signal history, the total matching, and the summary over all of it. */
export type SignalFilter = {
  mode?: EntryMode; tf?: EntryTf; state?: 'WAIT' | 'TRADE'; dir?: 1 | -1; since?: number;
  limit?: number; offset?: number; sort?: 'time' | 'score' | 'rr'; asc?: boolean;
};
export function getEntrySignals(q: SignalFilter = {}) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) if (v !== undefined) p.set(k, String(v));
  return json<EntrySignalPage>(`/api/entry/signals${p.size ? `?${p}` : ''}`);
}
