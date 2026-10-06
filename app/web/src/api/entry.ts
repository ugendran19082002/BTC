import { json, post } from './client';
import type { EntryAlerts, EntryBoard, EntryGateSetting, EntryMode, EntryRecordResponse, EntrySignalPage, EntryTf, MethodOrderSide, MethodReportResponse } from '@/types/entry';

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
/** Every column of the history the server sorts by (app/server/src/entry/signals.ts SORT_SQL). */
export type SignalSort = 'time' | 'method' | 'way' | 'signal' | 'ltp' | 'entry' | 'sl' | 'tp1' | 'tp2' | 'tp3' | 'fill' | 'exit' | 'result' | 'score' | 'stood' | 'rr';
export type SignalFilter = {
  mode?: EntryMode; tf?: EntryTf; state?: 'WAIT' | 'TRADE'; dir?: 1 | -1; since?: number;
  /** Only these methods: their ids, comma-separated in the desk's order. Absent, every method. */
  methods?: string;
  /** Only TRADEs still in play: waiting at the zone or filled, not yet out. */
  live?: boolean;
  /** Only TRADEs that ended one way: TGT1 hit, stopped, timed out, or expired (never filled). */
  outcome?: 'tp1' | 'stop' | 'timeout' | 'expired';
  limit?: number; offset?: number; sort?: SignalSort; asc?: boolean;
};
const queryOf = (q: SignalFilter) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) if (v !== undefined) p.set(k, String(v));
  return p.size ? `?${p}` : '';
};
export function getEntrySignals(q: SignalFilter = {}) {
  return json<EntrySignalPage>(`/api/entry/signals${queryOf(q)}`);
}
/** The history as a spreadsheet: every row the filters match, in the table's order (the server builds it). */
export const entrySignalsCsvUrl = (q: Omit<SignalFilter, 'limit' | 'offset'>) => `/api/entry/signals.csv${queryOf(q)}`;

/** Clearing the history by hand: signals first seen from `from` up to (not incl.) `to`, epoch ms. */
export type ClearRange = { from: number; to: number };
export type ClearCounts = { signals: number; trades: number; waits: number; setups: number; alerts: number };
export type HistoryClear = ClearRange & { at: number; signals: number; setups: number; alerts: number };
export type ClearAnswer = { range: ClearRange; counts: ClearCounts; recent: HistoryClear[] };
/** What clearing the range would take, and the last clears -- nothing goes. */
export const previewClear = (r: ClearRange) => json<ClearAnswer>(`/api/entry/signals/clear?from=${r.from}&to=${r.to}`);
/** Clear it: the signals, their paper trades and alerts. Cannot be undone. */
export const clearHistory = (r: ClearRange) => post<ClearAnswer>('/api/entry/signals/clear', r);

/**
 * The Methods report: every method with the timeframe chain and without it; `tf` narrows the section without it.
 * Every signal counts, as in the history; `everyGate` keeps only those taken with every hard gate on; `range`, the IST days.
 */
export function getMethodReport(tf: EntryTf | null = null, everyGate = false, range: { from: string; to: string } | null = null) {
  const p = new URLSearchParams();
  if (tf) p.set('tf', tf);
  if (everyGate) p.set('gates', 'on');
  // IST days, YYYY-MM-DD: the signals first seen on them. Absent: every signal.
  if (range) { p.set('from', range.from); p.set('to', range.to); }
  return json<MethodReportResponse>(`/api/entry/report${p.size ? `?${p}` : ''}`);
}

/** The 81 methods, each with its number, name, family and one line: the signal strategy's picker. */
export type EntryMethodInfo = {
  id: string; n: number; name: string; group: 'breakout' | 'pullback' | 'reversal' | 'flow'; summary: string;
  /** The method's order side in the owner's list: a label, not the direction of any one signal. */
  orderSide?: MethodOrderSide;
  /** Where its stop goes, in words, before the 0.25 ATR buffer. */
  sl: string;
};
export const getEntryMethods = () => json<{ methods: EntryMethodInfo[] }>('/api/entry/methods');
