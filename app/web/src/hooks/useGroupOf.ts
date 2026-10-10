import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { getGroupIndex, type GroupIndex } from '@/api/strategy-groups';

/**
 * A strategy's group, for the tag beside its name on every screen (owner, 10 Oct 2026).
 *
 * One index for the page, however many rows show a tag: read when the first tag appears, again at most once a
 * minute while any is on screen, and at once after a group is changed here (`refreshGroupIndex`). Nothing is read
 * while no tag is shown.
 */
const EVERY_MS = 60_000;
let index: GroupIndex | null = null;
let readAt = 0;
let reading: Promise<void> | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
const listeners = new Set<() => void>();

function read(force = false): void {
  if (reading || (!force && Date.now() - readAt < EVERY_MS)) return;
  reading = getGroupIndex()
    .then((d) => {
      readAt = Date.now();
      if (d && JSON.stringify(d) !== JSON.stringify(index)) { index = d; listeners.forEach((l) => l()); }
    })
    .finally(() => { reading = null; });
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  if (listeners.size === 1) timer = setInterval(() => read(), EVERY_MS);
  return () => {
    listeners.delete(l);
    if (listeners.size === 0 && timer) { clearInterval(timer); timer = null; }
  };
}

/** Read the index again now: after a group is made, renamed, removed, or a strategy moved or copied. */
export function refreshGroupIndex(): void { read(true); }

/** For tests: the index as given, as if just read. */
export function setGroupIndexForTest(d: GroupIndex | null): void {
  index = d; readAt = d ? Date.now() : 0; listeners.forEach((l) => l());
}

export type GroupOf = { id: string; name: string; accountName: string | null };

/** `groupOf(strategyId)`: the group it is in, or null -- none, unknown, or not read yet. */
export function useGroupOf(): (strategyId: string | null | undefined) => GroupOf | null {
  const d = useSyncExternalStore(subscribe, () => index, () => null);
  useEffect(() => { read(); }, []);
  return useCallback((strategyId) => {
    const gid = strategyId ? d?.of[strategyId] : undefined;
    const g = gid ? d?.groups.find((x) => x.id === gid) : undefined;
    return g ? { id: g.id, name: g.name, accountName: g.accountName } : null;
  }, [d]);
}
