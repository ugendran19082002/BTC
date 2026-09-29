/**
 * One answer per key for `ms`: the chart's pollers, from however many tabs,
 * share a read instead of each making it. The promise itself is held, so
 * requests that arrive while a read is in flight wait for that read rather
 * than starting another. A failed read is not kept -- the next request tries
 * again. Keys past their time are swept once the map grows.
 */
export function ttlCache<T>(ms: number, now: () => number = Date.now) {
  const held = new Map<string, { at: number; value: Promise<T> }>();
  return (key: string, load: () => Promise<T>): Promise<T> => {
    const t = now();
    const hit = held.get(key);
    if (hit && t - hit.at < ms) return hit.value;
    const value = load();
    held.set(key, { at: t, value });
    value.catch(() => { if (held.get(key)?.value === value) held.delete(key); });
    if (held.size > 64) for (const [k, v] of held) if (t - v.at >= ms) held.delete(k);
    return value;
  };
}
