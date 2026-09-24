import { json, post } from '@/api/client';
import type { Strategy, StrategyConfig, StrategyStatus } from '@/types/strategy';

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
