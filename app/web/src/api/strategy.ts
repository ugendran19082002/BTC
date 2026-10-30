import { json, post } from '@/api/client';
import type { MethodUpdate, MethodUpdateSource, MomentumGuard, SignalTf, SignalTrade, Strategy, StrategyConfig, StrategyGroup, StrategyStatus } from '@/types/strategy';
import { accountScope, withAccount } from '@/lib/account-scope';

/** The strategies of the broker account being shown (lib/account-scope.ts); with none chosen, every account's. */
export const getStrategies = () => json<StrategyStatus>(withAccount('/api/strategies'));

/**
 * Save a strategy. The server validates and answers with what it stored, so
 * the screen shows the desk's answer rather than the number that was typed.
 */
export const saveStrategy = (s: { id?: string; name: string; config: StrategyConfig; groupId?: string | null }) =>
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
 * One side's own limit under "at most open": per cent of it, for calls or for puts -- each on its own, the other not
 * touched. One account's, as the cap is.
 */
/** The most open on one strike, the shown account's: per cent of "at most open", 1 to 100; null back to the default. */
export const setStrikeMax = (pct: number | null) =>
  post<{ ok: true; signalStrikeMaxPct: number }>(
    '/api/strategies/strike-max', accountScope() === null ? { pct } : { pct, accountId: accountScope() });

/** What a signal does at a full strike, the shown account's: the next strike out, or skip. */
export const setStrikeFull = (mode: 'next' | 'skip') =>
  post<{ ok: true; signalStrikeFull: 'next' | 'skip' }>(
    '/api/strategies/strike-full', accountScope() === null ? { mode } : { mode, accountId: accountScope() });

/** The fill window, the shown account's: seconds by time frame, only those not at their default; null, all back to it. */
export const setZoneFresh = (seconds: Partial<Record<SignalTf, number>> | null) =>
  post<{ ok: true; signalZoneFreshS: Record<SignalTf, number> }>(
    '/api/strategies/zone-fresh', accountScope() === null ? { seconds } : { seconds, accountId: accountScope() });

/** The momentum guard, the shown account's: on or off and its points; null, back to the default (off). */
export const setMomentumGuard = (guard: MomentumGuard | null) =>
  post<{ ok: true; signalMomentumGuard: MomentumGuard }>(
    '/api/strategies/momentum-guard', accountScope() === null ? { guard } : { guard, accountId: accountScope() });

export const setSideMax = (side: 'CE' | 'PE', pct: number) =>
  post<{ ok: true; signalSideMaxPct: { CE: number; PE: number } }>(
    '/api/strategies/side-max', accountScope() === null ? { side, pct } : { side, pct, accountId: accountScope() });

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

/**
 * Groups (owner, 10 Oct 2026). A group is one account's: made for the account being shown, its strategies made in it
 * and moved between that account's groups. Its switch sets each strategy's own -- each by the same check as its own
 * switch -- and a clone copies every strategy switched off, live orders off, to this account or another.
 */
export const createGroup = (name: string, accountId: number | null) =>
  // No account (a server from before accounts): the desk's own.
  post<{ ok: true; group: StrategyGroup }>('/api/strategy-groups', accountId === null ? { name } : { name, accountId });

export const renameGroup = (id: string, name: string) =>
  post<{ ok: true; group: StrategyGroup }>(`/api/strategy-groups/${encodeURIComponent(id)}`, { name });

/** Every strategy in it on or off; one whose settings do not pass is left off, named in `leftOff` with why. */
export const setGroupEnabled = (id: string, enabled: boolean) =>
  post<{ ok: true; group: StrategyGroup; changed: string[]; leftOff: { id: string; name: string; problems: string[] }[] }>(
    `/api/strategy-groups/${encodeURIComponent(id)}/enabled`, { enabled });

/** A new group with a copy of each strategy, all switched off; no account: the group's own. */
export const cloneGroup = (id: string, to: { name?: string; accountId?: number }) =>
  post<{ ok: true; group: StrategyGroup; strategies: Strategy[] }>(`/api/strategy-groups/${encodeURIComponent(id)}/clone`, to);

/**
 * Every account's strategies and groups, whichever account is being shown -- for picking what to copy from another
 * account. The light read: the signal journal and trade history are left out.
 */
export const getAllStrategies = () => json<StrategyStatus>('/api/strategies?lite=1');

/**
 * Strategies of any account and group copied into one group: one that exists, or a new one made for them. All or
 * nothing; each copy switched off with live orders off, named as it was unless the account has that name already.
 */
export const copyIntoGroup = (strategyIds: string[], to: { groupId: string } | { newGroup: { name: string; accountId: number | null } }) =>
  post<{ ok: true; group: StrategyGroup; strategies: Strategy[] }>('/api/strategy-groups/copy-in', {
    strategyIds,
    ...('groupId' in to ? { groupId: to.groupId }
      : { newGroup: to.newGroup.accountId === null ? { name: to.newGroup.name } : to.newGroup }),
  });

/** The display order of a group's strategies: all of them, in the order wanted. Display only. */
export const orderGroup = (id: string, strategyIds: string[]) =>
  post<{ ok: true }>(`/api/strategy-groups/${encodeURIComponent(id)}/order`, { strategyIds });

/** The display order of one account's groups: all of them, in the order wanted. */
export const orderGroups = (accountId: number | null, groupIds: string[]) =>
  post<{ ok: true }>('/api/strategy-groups/order', accountId === null ? { groupIds } : { accountId, groupIds });

/** The group goes; its strategies stay, as they were, in no group. */
export const deleteGroup = (id: string, withStrategies = false) =>
  // `withStrategies`: its strategies go with it -- all of them, and only if every one is switched off.
  json<{ ok: true; ungrouped: number; deleted: number }>(
    `/api/strategy-groups/${encodeURIComponent(id)}${withStrategies ? '?strategies=delete' : ''}`, { method: 'DELETE' });

/** Several strategies removed together -- all or none, each switched off. Their trades and history stay. */
export const deleteStrategies = (strategyIds: string[]) =>
  post<{ ok: true; deleted: number }>('/api/strategies/delete-many', { strategyIds });

/** Several strategies put in one group of their account together. */
export const takeIntoGroup = (groupId: string, strategyIds: string[]) =>
  post<{ ok: true; group: StrategyGroup; moved: number }>(`/api/strategy-groups/${encodeURIComponent(groupId)}/take`, { strategyIds });

/** Into another of its account's groups, or out of any (null). */
export const moveToGroup = (strategyId: string, groupId: string | null) =>
  post<{ ok: true; strategy: Strategy }>(`/api/strategies/${encodeURIComponent(strategyId)}/group`, { groupId });

export const deleteStrategy = (id: string) =>
  fetch(`/api/strategies/${encodeURIComponent(id)}`, { method: 'DELETE', credentials: 'same-origin' })
    .then((r) => { if (!r.ok) throw new Error('could not delete'); });

/** The signal strategies' trade history for IST days (YYYY-MM-DD); null range: the latest. */
export const getSignalTrades = (range: { from: string; to: string } | null) =>
  json<{ from: string | null; to: string | null; trades: SignalTrade[] }>(
    withAccount(`/api/strategies/signal-trades${range ? `?from=${range.from}&to=${range.to}` : ''}`));

/**
 * Every change to the signal strategies' methods, newest first: the daily updates and the form's saves -- of every
 * account, or the one given. Not the account the desk's tabs show (25 Oct 2026): the Logs tab has no account tabs, so
 * a choice made on Strategy hid the other accounts' changes there; the screen has its own account chips.
 */
export const getMethodUpdates = (o: { source?: MethodUpdateSource | null; strategy?: string | null; from?: string; to?: string; limit?: number; account?: number | null } = {}) => {
  const q = new URLSearchParams();
  if (o.from) q.set('from', o.from);
  if (o.to) q.set('to', o.to);
  if (o.source) q.set('source', o.source);
  if (o.strategy) q.set('strategy', o.strategy);
  if (o.limit) q.set('limit', String(o.limit));
  if (o.account != null) q.set('account', String(o.account));
  const qs = q.toString();
  return json<{ updates: MethodUpdate[] }>(`/api/strategies/method-updates${qs ? `?${qs}` : ''}`);
};

/** A pick of the methods asked for now: running, or done -- how many strategies it took and saved. */
export type PickNowRun = { running: boolean; at: number; strategies: number; updated: number; doneAt: number | null; error: string | null };

const pickUrl = (account: number | null) => `/api/strategies/auto-methods/run${account === null ? '' : `?account=${account}`}`;

/** The methods' daily update, now (25 Oct 2026): every strategy with it on -- of one account, or the one strategy given. */
export const runMethodPicks = (o: { strategyId?: string | null; account?: number | null } = {}) =>
  post<PickNowRun>(pickUrl(o.account ?? null), o.strategyId ? { strategyId: o.strategyId } : {});

/** The last pick asked for now, and how many strategies one would take -- of every account, or the one given. */
export const getMethodPicks = (account: number | null = null) => json<{ last: PickNowRun | null; strategies: number }>(pickUrl(account));
