import { json, post } from '@/api/client';
import type { RebalanceLimits, RebalanceRule, Strategy, StrategyConfig, StrategyStatus } from '@/types/strategy';

export const getStrategies = () => json<StrategyStatus>('/api/strategies');

/**
 * Save a strategy. The server validates and answers with what it stored, so
 * the screen shows the desk's answer rather than the number that was typed.
 */
export const saveStrategy = (s: { id?: string; name: string; config: StrategyConfig }) =>
  post<{ ok: true; strategy: Strategy }>('/api/strategies', s);

/** Arm or disarm one. Refused with a reason if its settings do not validate. */
export const setStrategyEnabled = (id: string, enabled: boolean) =>
  post<{ ok: true; strategy: Strategy }>(`/api/strategies/${encodeURIComponent(id)}/enabled`, { enabled });

/** The master switch. Nothing runs on a schedule until this is on. */
export const setScheduler = (on: boolean) =>
  post<{ ok: true; schedulerOn: boolean }>('/api/strategies/scheduler', { on });

export const deleteStrategy = (id: string) =>
  fetch(`/api/strategies/${encodeURIComponent(id)}`, { method: 'DELETE', credentials: 'include' })
    .then((r) => { if (!r.ok) throw new Error('could not delete'); });

/**
 * The desk's rebalance defaults, and the limits a rule is held to.
 *
 * Both are settings rather than numbers in the source: "…n stages" is what
 * somebody types. `ceilings` is what no limit may pass and is not editable.
 */
export type RebalanceSettings = {
  defaults: RebalanceRule;
  limits: RebalanceLimits;
  ceilings: RebalanceLimits;
};

export const getRebalanceSettings = () => json<RebalanceSettings>('/api/strategies/rebalance-settings');
export const setRebalanceSettings = (patch: { defaults?: Partial<RebalanceRule>; limits?: Partial<RebalanceLimits> }) =>
  post<{ ok: true; defaults: RebalanceRule; limits: RebalanceLimits }>('/api/strategies/rebalance-settings', patch);
