import { json, post } from '@/api/client';
import type { SignalTrade, Strategy, StrategyConfig, StrategyStatus } from '@/types/strategy';
import { accountScope, withAccount } from '@/lib/account-scope';

/** The strategies of the broker account being shown (lib/account-scope.ts); with none chosen, every account's. */
export const getStrategies = () => json<StrategyStatus>(withAccount('/api/strategies'));

/**
 * Save a strategy. The server validates and answers with what it stored, so
 * the screen shows the desk's answer rather than the number that was typed.
 */
export const saveStrategy = (s: { id?: string; name: string; config: StrategyConfig }) =>
  // A new strategy is made for the account being shown; a saved one keeps its own (the server never moves it).
  post<{ ok: true; strategy: Strategy }>('/api/strategies', accountScope() === null ? s : { ...s, accountId: accountScope() });

/** Arm or disarm one. Refused with a reason if its settings do not validate. */
export const setStrategyEnabled = (id: string, enabled: boolean) =>
  post<{ ok: true; strategy: Strategy }>(`/api/strategies/${encodeURIComponent(id)}/enabled`, { enabled });

/** The master switch. Nothing runs on a schedule until this is on. */
export const setScheduler = (on: boolean) =>
  post<{ ok: true; schedulerOn: boolean }>('/api/strategies/scheduler', { on });

/**
 * The desk-wide "at most open at once": one number over every strategy, counted
 * against every open position and working order. 0 takes the cap off.
 */
export const setSignalMaxOpen = (max: number) =>
  // One account's cap: the one being shown, else the one the desk is trading on.
  post<{ ok: true; signalMaxOpen: number }>('/api/strategies/max-open', accountScope() === null ? { max } : { max, accountId: accountScope() });

/**
 * Copy one, settings and all, as a new draft.
 *
 * The desk's strategies differ by a field or two, and building the second by
 * hand from the first is how one gets missed. The copy is never armed,
 * whatever the original was: the operator asked for a draft, not a second live
 * rule taking its own position.
 */
export const cloneStrategy = (id: string, name?: string) =>
  post<{ ok: true; strategy: Strategy }>(`/api/strategies/${encodeURIComponent(id)}/clone`, { name });

export const deleteStrategy = (id: string) =>
  fetch(`/api/strategies/${encodeURIComponent(id)}`, { method: 'DELETE', credentials: 'include' })
    .then((r) => { if (!r.ok) throw new Error('could not delete'); });

/** The signal strategies' trade history for IST days (YYYY-MM-DD); null range: the latest. */
export const getSignalTrades = (range: { from: string; to: string } | null) =>
  json<{ from: string | null; to: string | null; trades: SignalTrade[] }>(
    withAccount(`/api/strategies/signal-trades${range ? `?from=${range.from}&to=${range.to}` : ''}`));
